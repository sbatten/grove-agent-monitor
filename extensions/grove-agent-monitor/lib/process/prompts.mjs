// Texts Grove writes for agents:
// - the engineer's brief (Grove expands the hand-off marker into it), the assignment for each step, and the
//   context Grove adds to the engineer's turns;
// - reviewer briefs (authoritative: the hook expands the hire marker into them, so each reviewer always gets
//   the task, the output under review, the forum and the verdict contract its gate checks);
// - the hand-off messages sessions send each other with send_message (reports, notices, decisions), and
//   Grove's own fallback notices when one of those doesn't arrive.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_ROUNDS, memberTitle, stepLabel, stageLabel, KIND_LABELS, KIND_SKILLS, TEMPLATES, REVIEWER_FOCUS, ENGINEER_AGENT, prLine, currentStep } from './engine.mjs';
import { memberModel } from './models.mjs';
import { taskLabel, taskTag } from './names.mjs';
import { reviewerPlacement, confirmationForm } from './placement.mjs';

function placementBrief(task, ticket) {
  if (!task.destination) return '\n## Workspace\nLegacy task: retain the current attachment; recovery needs an explicit structured destination.\n';
  if (ticket) return `\n## Workspace and revision\n${ticket.worktree ? 'Separate worktree explicitly requested. Grove prepares a clean detached checkout of the pinned commit, when present; host default branch is not revision proof.' : 'Share the engineer attachment; do not create another worktree.'}
Expected engineer directory: ${task.placement?.directory ?? 'unknown'}.
${ticket.snapshot ? `Pinned submission v${ticket.version}: ${ticket.snapshot}. Actual reviewer HEAD must match before review and verdict acceptance.` : 'No isolated code snapshot is required for this ticket.'}
Per-chat hook cwd is authoritative; session-level metadata is not proof. Unknown/mismatched placement blocks work. Do not modify code or repair attachment yourself.\n`;
  return `\n## Workspace\nStructured destination: ${JSON.stringify(task.destination)}.
Actual attachment: ${JSON.stringify(task.placement ?? { status: 'unknown' })}.
Never infer destinations from prose, shell cd, or the Chief's scratch directory. New repository tasks use managed isolation; continuation uses the exact verified existing checkout. Independent creation with worktree:false may redirect an existing worktree to its primary root: verify actual placement, never silently work there.
${task.workspaceRepair ? `The human authorized this owner's repair. Use ask_user with message "Confirm the authorized workspace repair." and requestedSchema.properties.workspaceConfirmation=${JSON.stringify(confirmationForm(task.workspaceRepair.target))}. Only an affirmative response permits set_workspace with ${JSON.stringify(task.workspaceRepair.target)} as the immediately next and final tool call. Host confirmation/approval still applies.` : 'Do not change attachment. If repair is needed, block and have the Chief record an explicit human workspaceRepair decision; a placement failure is not authorization.'}\n`;
}

// Standing instructions live in the plugin's agent files and skills. Sessions aren't started as custom
// agents (create_session can't pick one), so Grove puts the instructions in each brief.
const PLUGIN_DIR = fileURLToPath(new URL('../../../../', import.meta.url));
const textCache = new Map();
function bodyOf(file) {
  if (!textCache.has(file)) {
    let body = '';
    try {
      body = fs.readFileSync(file, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    } catch {
      /* missing: the brief still carries the role and contract */
    }
    textCache.set(file, body);
  }
  return textCache.get(file);
}

export function personaInstructions(agentType) {
  const name = String(agentType ?? '').replace(/^[^:]+:/, '');
  return /^grove-[a-z-]+$/.test(name) ? bodyOf(path.join(PLUGIN_DIR, 'agents', `${name}.agent.md`)) : '';
}

export function skillInstructions(name) {
  return /^grove-[a-z-]+$/.test(name) ? bodyOf(path.join(PLUGIN_DIR, 'skills', name, 'SKILL.md')) : '';
}

const TRANSCRIPT_BUDGET = 24000;
const EARLIER_BUDGET = 24000;

function criteriaBlock(task) {
  return task.criteria.length ? task.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n') : '(none given; the first step should pin them down)';
}

export function forumTranscript(step, budget = TRANSCRIPT_BUDGET) {
  const f = step.forum;
  if (!f.posts.length) return '(no posts yet)';
  const lines = f.posts.map((p) => {
    const vote = p.verdict ? ` — ${p.verdict === 'approve' ? 'APPROVE' : 'CHANGES'}` : '';
    return `### Round ${Math.max(1, p.round - f.windowStart)} · ${p.author}${vote}\n${p.text}`;
  });
  let out = lines.join('\n\n');
  // Keep the newest discussion intact; trim the oldest posts first.
  while (out.length > budget && lines.length > 1) {
    lines.shift();
    out = `(earlier posts omitted)\n\n${lines.join('\n\n')}`;
  }
  return out.length > budget ? `${out.slice(-budget)}` : out;
}

const FEEDBACK_FROM = { engineer: 'the engineer', human: 'the human', github: 'GitHub (the pull request)', verification: 'verification' };

function feedbackBlock(task, title = 'Feedback to take into account') {
  const items = task.feedback.slice(-6);
  if (!items.length) return '';
  return `\n## ${title}\n${items.map((f) => `- From ${FEEDBACK_FROM[f.from] ?? f.from}:\n${indent(f.text)}`).join('\n')}\n`;
}

function indent(t) {
  return String(t).split('\n').map((l) => `  ${l}`).join('\n');
}

// What earlier steps produced, newest in full and older ones trimmed, so a reviewer has the context it needs
// (the approved plan when reviewing code, and so on), and an engineer that took over can catch up.
function earlierResults(task, step) {
  const before = task.steps.slice(0, task.steps.indexOf(step)).filter((s) => s.status === 'done' && s.output);
  if (!before.length) return '';
  let budget = EARLIER_BUDGET;
  const blocks = [];
  for (const s of before.reverse()) {
    const room = Math.max(1500, Math.min(budget, blocks.length ? 6000 : 16000));
    const text = s.output.length > room ? `${s.output.slice(0, room - 1)}…` : s.output;
    budget -= text.length;
    blocks.unshift(`### ${stepLabel(s)} (v${s.version})\n${text}`);
    if (budget <= 0) break;
  }
  return `\n## Results of earlier steps\n${blocks.join('\n\n')}\n`;
}

// Any reviewer can stop for something only the human can do.
const BLOCKED_CLAUSE = '\n\nIf you can\'t review without something only the human can do (sign in, grant access, provide a file), stop: don\'t retry the same failing thing or work around it. Explain what failed, and make the last line `BLOCKED: <exactly what the human must do>`. Grove pauses the task, the Chief of Staff asks the human, and you continue here once it\'s done. Don\'t message the Chief of Staff yourself.';

export function briefFor(task, ticket) {
  const step = task.steps.find((s) => s.id === ticket.step);
  const persona = personaInstructions(ticket.agentType);
  const shared = skillInstructions('grove-review');
  const head = `[grove:${ticket.id}]
# Grove review ${ticket.id}

You are the **${memberTitle(ticket)}** on task **${taskLabel(task)}: ${task.title}** (${stageLabel(task)}). This chat is your desk for the whole task: every review you do for it arrives here, so you remember what you said before.
${persona ? `\n## Your standing instructions\n${persona}\n` : ''}${shared ? `\n## How Grove reviews work\n${shared}\n` : ''}
## Goal
${task.goal}

## Acceptance criteria
${criteriaBlock(task)}
${placementBrief(task, ticket)}
`;
  if (!step) return head + BLOCKED_CLAUSE;
  const f = step.forum;
  const round = ticket.round - f.windowStart;
  const r = step.reviewers.find((x) => x.name === ticket.specialty);
  const mine = f.posts.filter((p) => p.kind === 'review' && p.role === ticket.specialty && p.round < ticket.round);
  const again = mine.length ? `\nYou reviewed an earlier version in this chat (your last verdict: ${mine.at(-1).verdict === 'approve' ? 'APPROVE' : 'CHANGES'}). First check whether each point you raised was addressed, then look for anything new the revision introduced. Don't raise new objections to parts you already accepted unless the revision changed them.\n` : '';
  const inspect = step.kind === 'execute' ? '\nInspect the actual changes yourself (for example `git status` and `git diff`, or the systems the step touched). Do not modify anything.\n'
    : step.kind === 'research' ? '\nCheck the findings yourself: re-run queries, re-open sources, and look for what is missing. Do not modify anything.\n'
      : step.kind === 'verify' ? `\nOpen the evidence yourself${step.verification?.dir ? ` (in ${step.verification.dir})` : ''} and check that each acceptance criterion is really shown, not just claimed. Do not modify anything.\n` : '';
  return `${head}${earlierResults(task, step)}
## Your role: ${ticket.specialty} reviewer of ${stepLabel(step)} (round ${round} of at most ${MAX_ROUNDS})
${r?.focus ?? ''}
${again}
${step.reviewers.length > 1 ? `The review is a shared forum: the ${step.reviewers.map((x) => x.name).join(', ')} reviewers and the engineer. ` : ''}Approval must be **unanimous**. ${step.reviewers.length > 1 ? 'Read the discussion, respond to the other reviewers where you agree or disagree, and only' : 'Only'} raise objections that genuinely block approval. Non-blocking suggestions are welcome but must not stop you from approving.

## Under review: ${stepLabel(step)} (v${step.version})
${step.brief ? `What the step was asked to do: ${step.brief}\n\n` : ''}${step.output}
${inspect}
## Discussion so far
${forumTranscript(step)}
${feedbackBlock(task)}
## Output contract
Your final message is your review: findings with severity, responses to other participants, and required changes (if any). The last line must be exactly one of:
VERDICT: APPROVE
VERDICT: CHANGES${BLOCKED_CLAUSE}`;
}

// The task's pull request, for work on a change that already has one.
function prBlock(task) {
  const pr = task.ship?.pr;
  if (!pr) return '';
  const draft = task.ship.phase === 'draft';
  return `\n## Pull request\n${draft ? 'The change has a draft pull request' : 'The change is in a pull request'}: ${pr.url}. Push further changes to its branch (the same worktree or folder), so it stays up to date.\n`;
}

// Optional visual evidence: it leads the human's report.
const EVIDENCE_IDEAS = {
  research: 'a screenshot of the query and its results, a chart, or the page you found the answer on',
  execute: 'before and after screenshots, or a short screen recording of the change working',
};
function evidenceBlock(what, dir) {
  return `\n## Visual evidence (optional, but the human looks at it first)
If a picture shows your result better than words (${what}), save it in: ${dir}
Then write ${dir}/evidence.json:
{ "summary": "one sentence", "items": [ { "file": "name.png", "caption": "what this shows", "criterion": "which acceptance criterion it supports (optional)" } ] }
Allowed files: .png .jpg .jpeg .gif .webp .svg .mp4 .webm (25 MB max each). Skip this if there's nothing worth showing.
`;
}

export const LEAD_MARKER = /\[grove-engineer:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(T\d{1,6})\/([a-f0-9]{8,64})\]/;

const templateLine = (name) => TEMPLATES[name].map((st) => `${KIND_LABELS[st.kind]}${st.reviewers?.length ? ` (reviewed by ${st.reviewers.join(', ')})` : ''}`).join(' → ');
const KIND_WORDS = { code: 'a code change', research: 'research', other: 'other work' };

// The first prompt of an engineer session, as the Chief passes it to create_session. The marker binds the
// session to the task on the shared board; Grove expands it into the full brief (engineerBrief).
export function engineerHandoff(task, { boardId, token }) {
  return `[grove-engineer:${boardId}/${task.id}/${token}] Grove task ${taskLabel(task)}: ${task.title}. Grove fills in your brief.`;
}

export function engineerBrief(task, { boardId, token }) {
  const persona = personaInstructions(ENGINEER_AGENT);
  return `[grove-engineer:${boardId}/${task.id}/${token}]
# Grove engineer · ${taskLabel(task)}: ${task.title}
${task.name ? `\nThe human calls this task **${task.name}**; use that name when you write about it.\n` : ''}
The Chief of Staff handed this task to you so that they stay free for the human. You are its **engineer**: you do the work yourself, step by step, hire reviewers where a step needs an independent opinion, and deliver the result for the human's sign-off. The Chief of Staff marked it as ${KIND_WORDS[task.kind] ?? 'work'}.
${persona ? `\n${persona}\n` : ''}
## Goal
${task.goal}

## Acceptance criteria
${criteriaBlock(task)}
${placementBrief(task)}

## Steps
Each step is one of four kinds, and any step can have reviewers:

| Kind | Skill to load | For |
| --- | --- | --- |
${Object.entries(KIND_SKILLS).map(([k, sk]) => `| ${k} | \`${sk}\` | ${{ plan: 'designing a change before making it', research: 'finding things out: data, issues, code, docs, the web', execute: 'making a change: code, or other actions', verify: 'proving it works, with screenshots, recordings or other visual evidence' }[k]} |`).join('\n')}
| *reviewers* | | each a nested chat that checks a step's output; approval must be unanimous |

Built-in reviewers: ${Object.keys(REVIEWER_FOCUS).join(', ')}. Any other name needs a focus, for example \`{ "name": "ux", "focus": "is it clear to a first-time user?" }\`.

Templates:
- \`code-change\`: ${templateLine('code-change')}.
- \`research\`: ${templateLine('research')}.

Use only what the task needs. A question about data, or collecting issues that match some criteria, is usually one research step reviewed by \`accuracy\`. A code change is usually the \`code-change\` template.`;
}

// The engineer's assignment for the step in progress, as grove_next returns it.
export function stepAssignment(task, step, { evidenceDir } = {}) {
  const skill = KIND_SKILLS[step.kind];
  const f = step.forum;
  const revising = step.version > 0 && !step.ship;
  const redoOf = step.redoOf ? task.steps.find((s) => s.id === step.redoOf) : null;
  const lastRound = revising ? { ...step, forum: { ...f, posts: f.posts.filter((p) => p.round === f.round || p.kind === 'human') } } : null;
  const contract = step.ship ? 'the brief above says how to end it.'
    : {
      plan: 'the complete plan, in Markdown: overview, concrete steps, what changes (files, components, systems), risks and mitigations, acceptance criteria (refine the ones above), and how the result will be verified.',
      research: 'your report, in Markdown: the answer first, then how you got it (queries, sources, file paths, links) so it can be checked, and what is uncertain or assumed.',
      execute: 'a summary: what you changed or did (files, systems), the effect, how reviewers can inspect it (for example which `git diff` paths), build and test results, and anything not done.',
      verify: 'the verification report (each criterion → its evidence → the result). The last line must be exactly `RESULT: PASS` or `RESULT: FAIL`.',
    }[step.kind];
  let evidence = '';
  if (step.kind === 'verify' && evidenceDir) {
    evidence = `
## Evidence (required; in session data, not the workspace)
Save every artifact in: ${evidenceDir}
Then write ${evidenceDir}/evidence.json:
{ "summary": "one paragraph", "items": [ { "file": "name.png", "caption": "what this shows", "criterion": "which acceptance criterion it proves" } ] }
Allowed files: .png .jpg .jpeg .gif .webp .svg .mp4 .webm (at least one image or video; each 25 MB max). File names are relative to that folder. Grove won't accept the report until evidence.json and its files exist.
`;
  } else if (evidenceDir && EVIDENCE_IDEAS[step.kind]) {
    evidence = evidenceBlock(EVIDENCE_IDEAS[step.kind], evidenceDir);
  }
  return `## Your step: ${stepLabel(step)}
${step.ship ? '' : `Load the \`${skill}\` skill now, even if you loaded it earlier: it has the instructions for this kind of step.\n\n`}${step.brief || 'Do what this kind of step calls for, guided by the goal.'}
${placementBrief(task)}${redoOf ? `\nThis step re-runs ${redoOf.id}, whose result needs another pass. Use the feedback below.\n` : ''}${revising ? `
## Revising v${step.version}
The reviewers asked for changes. Address every blocking point, and argue any you disagree with. Your output must change: resubmitting the same text escalates the step to the human.

### This round's discussion
${forumTranscript(lastRound)}
` : ''}${feedbackBlock(task)}${prBlock(task)}${evidence}
## When you're done
Call \`grove_submit\` with the step's output: ${contract}${revising && step.reviewers.length ? ' End it with a section "## Response to reviewers" answering each reviewer by name.' : ''} Grove checks it right away and tells you what to fix if it doesn't meet that.${step.reviewers.length ? ` Then the ${step.reviewers.map((r) => r.name).join(', ')} reviewer${step.reviewers.length > 1 ? 's' : ''} check${step.reviewers.length > 1 ? '' : 's'} it: grove_submit returns their hires.` : ''}`;
}

// Context Grove adds to each of the engineer's turns.
export function engineerContext(task, { initial }) {
  if (initial) return `Grove: this chat is the engineer for ${taskLabel(task)} "${task.title}". Start by choosing the steps with grove_plan_steps (find Grove's tools with tool search if they aren't loaded), then call grove_next.`;
  const step = currentStep(task);
  const now = step?.status === 'working' && task.stage === 'working'
    ? ` You're on ${step.id} (${KIND_LABELS[step.kind]}): ${step.ship ? '' : `load the ${KIND_SKILLS[step.kind]} skill if it isn't loaded, `}do the work, and submit it with grove_submit. Call grove_next if you need the assignment again.`
    : step?.status === 'reviewing' ? ` ${step.id} is with its reviewers. If you haven't made their hires, call grove_next; otherwise end your turn: they report back to this chat.`
      : task.stage === 'routing' ? ' No step is in progress: call grove_next and decide what comes next.' : ' Call grove_next to see what to do.';
  return `Grove: this chat is the engineer for ${taskLabel(task)} "${task.title}" (${stageLabel(task)}).${now} Post progress with grove_update rather than messaging the Chief of Staff; use grove_blocked for anything only the human can fix and grove_answer for their questions. Don't ask the human here; their decisions reach you from the Chief of Staff.`;
}

// Messages sessions send each other with the host's send_message tool, so every hand-off is a visible
// turn in VS Code. The marker tells the receiving session's Grove what the message is about.
export const RELAY_MARKER = /\[grove-(report|notice|decision):([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([A-Za-z0-9:._-]{1,80})\]/;

const firstLine = (t, n = 160) => {
  const line = String(t ?? '').split('\n').map((l) => l.replace(/^[#>*\s-]+/, '').trim()).find(Boolean) ?? '';
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

// Reviewer → engineer: its review is in.
export function reportMessage(boardId, task, ticket, { status, text }) {
  const what = status === 'done' ? `finished ${ticket.id}` : `could not finish ${ticket.id}`;
  return `[grove-report:${boardId}/${ticket.id}] ${memberTitle(ticket)} ${what} for ${taskLabel(task)}: ${firstLine(text) || '(see my chat)'}`;
}

// Engineer → Chief: the task needs the human.
export function noticeMessage(boardId, task, key) {
  const what = key.startsWith('answer-') ? 'has an answer to the human\'s question'
    : key.startsWith('blocked-') ? `is blocked until the human does something: ${clip(task.pause?.need, 200)}`
      : key.startsWith('merge-') ? `has ${prLine(task.ship?.pr)} ready to merge`
        : task.stage === 'escalated' ? 'is stuck and escalated: a review could not agree' : 'is finished and needs the human\'s sign-off';
  return `[grove-notice:${boardId}/${task.id}:${key}] ${taskLabel(task)} "${task.title}" ${what}.`;
}

const DECISION_WORDS = {
  approve: 'approved', changes: 'requested changes', note: 'sent a note', question: 'asked a question', hold: 'put the task on hold',
  resume: 'resumed the task', retry: 'unblocked the task', merge: 'asked to merge the pull request', cancel: 'cancelled the task',
};

// Chief → engineer: the human decided.
export function decisionMessage(boardId, task, item) {
  const words = DECISION_WORDS[item.action] ?? item.action;
  return `[grove-decision:${boardId}/${task.id}:${item.seq}] The human ${words} for ${taskLabel(task)}.${item.note ? ` They said: "${String(item.note).slice(0, 300)}"` : ''}`;
}

export const MEMBER_MARKER = /\[grove-hire:([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/(T\d{1,6}-[a-z0-9-]{1,40})\/([a-f0-9]{8,64})\]/;

// Reminder Grove adds to a reviewer's later turns.
export function memberContext(task, ticket) {
  return `Grove: this chat is the ${memberTitle(ticket)} for ${taskLabel(task)} "${task.title}", working on ${ticket.id}. Finish with your review, ending in the verdict line from your brief; Grove checks your final message and sends it back if it doesn't end that way.`;
}

export function memberRevive(ticket, why) {
  return `[Grove] Your work on ${ticket.id} ${why}. Pick up where you left off: your transcript above has everything so far. Finish with the output contract from your brief.`;
}


export function engineerWake(task, decision) {
  const said = decision.note ? ` They said: "${clip(decision.note, 1500)}"` : '';
  const from = decision.via === 'grove' ? 'in the Grove inbox' : 'relayed by the Chief of Staff';
  const next = decision.action === 'note' ? ' Take it into account: change the steps with grove_plan_steps if it changes the plan, then call grove_next.'
    : decision.action === 'question' ? ' Call grove_next: answer their question with grove_answer (find out what you need first).'
      : decision.action === 'hold' ? ' Everyone has stopped. Do nothing more; end your turn.'
        : ' Call grove_next and continue.';
  return `[Grove] The human ${DECISION_WORDS[decision.action] ?? decision.action} for ${taskLabel(task)} (${from}).${said}\nThe task is now "${stageLabel(task)}".${next}`;
}

// Posted into the Chief of Staff's session when a task needs the human.
export function chiefNotice(item) {
  if (item.kind === 'unblock') {
    return `[Grove → Chief of Staff] ${item.taskId} "${item.title}" is blocked until the human does this: ${item.need}
${reportLine(item)}
Reported by the ${item.by ?? 'team'}.${item.detail ? `\n\nDetails:\n${clip(item.detail, 1500)}` : ''}

Tell the human exactly what they need to do (keep commands as code). Everyone on the task has stopped until then. End your turn. When they say it's done, record "retry" with grove_record_decision (or "cancel" / "hold" if they say so) and send the message it returns to the engineer.`;
  }
  if (item.kind === 'merge') {
    return `[Grove → Chief of Staff] ${item.taskId} "${item.title}": ${prLine(item.pr)} is ready to merge: checks passed and the review is approved.
PR: ${item.pr.url}
${reportLine(item)}
Tell the human it's ready and link the PR; ask whether to merge. End your turn. If they say merge, record "merge" with grove_record_decision and send the message it returns to the engineer (who merges it). They can also click Merge in the Grove inbox.`;
  }
  if (item.kind === 'approve-result') {
    const evidence = item.evidence.map((e) => `- [${e.caption || path.basename(e.path)}](${e.path})${e.criterion ? ` (proves: ${e.criterion})` : ''}`).join('\n');
    const pr = item.pr ? `\n${item.pr.draft ? 'Draft pull request' : 'Pull request'} (link it right after the report): [PR #${item.pr.number}](${item.pr.url})\n` : item.noPr ? `\nNo pull request: ${item.noPr}\n` : '';
    const ask = item.ask ? `\nWhat the engineer needs from the human: ${clip(item.ask, 600)}\n` : '';
    return `[Grove → Chief of Staff] ${item.taskId} "${item.title}" is finished and needs the human's sign-off.
${reportLine(item)}${pr}${ask}
The engineer's summary: ${clip(item.summary, 2000)}

Steps: ${item.steps.map((s) => `${s.step} (${s.reviewed})`).join('; ')}

Acceptance criteria:
${item.criteria.length ? item.criteria.map((c, i) => `${i + 1}. ${c}`).join('\n') : '(none given)'}
${item.result ? `\nResult (${item.result.step}):\n${item.result.text}\n` : ''}${evidence ? `\nEvidence (absolute paths):\n${evidence}\n` : ''}
Give the human the result: ${item.report ? 'the report link first, then ' : ''}${item.pr ? 'the PR link, then ' : ''}${item.ask ? 'what the engineer needs from them, then ' : ''}the answer or outcome in plain language, keeping the key details (numbers, lists, links)${evidence ? ', and the evidence as the Markdown links above with their captions' : ''}. Then ask whether they're happy with it or want more; they can also answer from the Grove inbox (click the Chief of Staff). End your turn. When they answer, record it with grove_record_decision: "approve" if they're satisfied, "changes" with their words if they want something changed or added, "shelve" if they want to come back to it later.`;
  }
  const positions = item.positions.map((p) => `- **${p.reviewer}** (${p.verdict === 'approve' ? 'APPROVE' : 'CHANGES'}): ${clip(p.post, 600)}`).join('\n');
  return `[Grove → Chief of Staff] ${item.taskId} "${item.title}" is escalated: ${item.text}
${reportLine(item)}
Reviewer positions:
${positions || '(none recorded)'}

${item.report ? 'Give the human the report link first. Then summarize' : 'Summarize'} each position, and ask them to choose: accept the step as is, send it back with direction, or cancel the task. Then end your turn. When they answer, record it with grove_record_decision.`;
}

// Posted into the Chief's session when the engineer answers the human's question.
export function chiefAnswer(task, q) {
  return `[Grove → Chief of Staff] ${taskLabel(task)} "${task.title}": the engineer answered the human's question.

They asked: ${clip(q.text, 600)}

Answer:
${clip(q.answer, 6000)}

Give the human the answer in plain language, keeping the key details. Nothing is recorded; if they decide something from it, record that as usual. End your turn.`;
}

// The task's HTML report, written by Grove for the human.
function reportLine(item) {
  if (!item.report) return '';
  const target = /\s/.test(item.report) ? `<${item.report}>` : item.report;
  return `\nReport for the human (link it first, as a Markdown link to this absolute path): [${item.taskId} report](${target})\n`;
}

function clip(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// The text the engineer passes to create_session / send_message. Grove expands the marker into the full
// brief inside the reviewer's chat, so the engineer never has to copy outputs or transcripts.
export function hireMarker(boardId, ticket) {
  return `[grove-hire:${boardId}/${ticket.id}/${ticket.token}]`;
}

export function hireInstruction(task, ticket, { boardId, route }) {
  const role = `${ticket.specialty} reviewer of ${ticket.step}`;
  const text = `${hireMarker(boardId, ticket)} Grove assignment ${ticket.id} for ${taskLabel(task)} (${role}). Grove fills in your full brief.`;
  const base = { ticket: ticket.id, task: task.id, role, attempt: ticket.attempt };
  if (route.tool === 'send_message') return { ...base, tool: 'send_message', session: route.session, message: text };
  const model = memberModel(task, ticket);
  return { ...base, tool: 'create_session', title: `${taskTag(task)} · ${memberTitle(ticket)}`, prompt: text,
    relationship: 'currentSession', ...reviewerPlacement(task, ticket), ...(model ? { model } : {}) };
}
