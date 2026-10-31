// Chief-of-Staff process engine.
//
// Each task has one engineer: a session that does the work itself, step by step, and hires reviewers.
// The engineer tailors the task's route from four kinds of step:
//
//   plan      design the change before making it         (skill grove-plan)
//   research  find things out and report                 (skill grove-research)
//   execute   carry the work out                         (skill grove-execute)
//   verify    prove it works with visual evidence        (skill grove-verify)
//
// Any step can have reviewers. A route is an ordered list of steps (see TEMPLATES for the common ones),
// which the engineer can extend, replace or redo after seeing results. The engineer submits each step's
// output (grove_submit), which is checked against the step's contract. A step with reviewers opens a forum:
// approval must be unanimous; otherwise the engineer revises and a new round opens, up to MAX_ROUNDS; after
// that the task is escalated to the human. When the steps are done, the engineer delivers the result and
// the human signs off (or asks for more, which goes back to the same engineer).
//
// Tasks live on a shared board (see board.mjs). Each task has one owner session: the Chief of Staff until
// its engineer claims it. Only the owner mutates a task; every other session just reads it. In the code,
// the engineer is the task's `lead` (its owning session; LEAD as a ticket dispatcher).
//
// Reviewers are sessions (chats) nested in the engineer's session, not subagents. A task keeps one reviewer
// session per specialty and sends it each new round, so a reviewer remembers its earlier points, and a
// failed hire is retried in the same chat. Reviewers report through result files; the engineer's session
// applies them.

import path from 'node:path';
import crypto from 'node:crypto';
import { taskName, taskLabel } from './names.mjs';
import { destination, committedSnapshot, reviewerMatches, observePlacement } from './placement.mjs';

export const MAX_ROUNDS = 3;
// Review rounds on one step before it always goes to the human, however often they send it back.
export const MAX_STEP_ROUNDS = 6;
// A hire that hit the host's message limit waits this long before it is offered again.
export const RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
export const MAX_BLOCKS = 2;
export const MAX_STEPS = 24;
// How many decision outcomes a task keeps, so the Chief and the inbox can say what became of each one.
export const DECISION_RESULTS = 30;
// A dispatched hire whose session never picks it up, or a running one whose session stops reporting, fails.
export const CLAIM_TIMEOUT_MS = 5 * 60 * 1000;
export const HEARTBEAT_TIMEOUT_MS = 4 * 60 * 1000;
export const LEAD = 'lead';

export const STEP_KINDS = Object.freeze(['plan', 'research', 'execute', 'verify']);
export const DECISIONS = Object.freeze(['approve', 'changes', 'note', 'question', 'hold', 'resume', 'retry', 'merge', 'cancel', 'shelve', 'unshelve']);
// The skill the engineer loads for each kind of step.
export const KIND_SKILLS = Object.freeze({ plan: 'grove-plan', research: 'grove-research', execute: 'grove-execute', verify: 'grove-verify' });
// What the human says the task is about; it picks the engineer's model.
export const TASK_KINDS = Object.freeze(['code', 'research', 'other']);
export const KIND_LABELS = Object.freeze({ plan: 'Plan', research: 'Research', execute: 'Execute', verify: 'Verify' });
const DEFAULT_TITLES = Object.freeze({ plan: 'Plan the work', research: 'Research', execute: 'Carry out the work', verify: 'Verify with visual evidence' });
const NAME = /^[a-z][a-z0-9-]{1,19}$/;

// Reviewer specialties with their own persona. Any other name uses the generic reviewer with the engineer's focus.
export const REVIEWER_FOCUS = Object.freeze({
  security: 'Security: threat model, input validation, injection, secrets, authn/authz, unsafe filesystem/network/process use, dependency risk, data exposure, least privilege.',
  tests: 'Tests: is every acceptance criterion verifiable? Test strategy and coverage, edge cases, failure paths, regressions, and whether the visual verification will actually prove the change.',
  code: 'Code: correctness, clarity, error handling, consistency with the codebase conventions, dead code, performance pitfalls, and whether the diff matches the approved plan.',
  architecture: 'Architecture: fit with the existing design, module boundaries, data flow, coupling, extensibility, migration/compat concerns, and whether the approach is the simplest that works.',
  accuracy: 'Accuracy: independently re-derive the key numbers and facts (re-run the queries, re-open the sources), check definitions, filters and time windows, and flag anything unsupported, ambiguous or missing.',
});
const PERSONA_REVIEWERS = new Set(['security', 'tests', 'code', 'architecture']);

// Common routes. The engineer may use one, extend it, or write its own.
export const TEMPLATES = Object.freeze({
  'code-change': [
    { kind: 'plan', reviewers: ['security', 'tests', 'architecture'] },
    { kind: 'execute', title: 'Implement the plan', reviewers: ['security', 'tests', 'code', 'architecture'] },
    { kind: 'verify', reviewers: ['tests'] },
  ],
  research: [
    { kind: 'research', reviewers: ['accuracy'] },
  ],
});

export const ENGINEER_AGENT = 'grove-engineer';
export const AGENT_TYPES = Object.freeze({
  reviewer: (s) => (PERSONA_REVIEWERS.has(s) ? `grove-reviewer-${s}` : 'grove-reviewer'),
});

export const STAGE_LABELS = Object.freeze({
  routing: 'Choosing next steps', working: 'Working', reviewing: 'In review',
  'awaiting-approval': 'Awaiting your sign-off', escalated: 'Escalated to you', blocked: 'Blocked on you',
  'on-hold': 'On hold', watching: 'Watching the PR', 'ready-to-merge': 'Ready to merge', shelved: 'On the shelf',
  done: 'Done', cancelled: 'Cancelled',
});
const TERMINAL = new Set(['done', 'cancelled']);
// Steps that get an evidence folder: verify must fill it; research and execute may.
const EVIDENCE_KINDS = new Set(['research', 'execute', 'verify']);
// Shipping phases in which Grove (not the human) is moving the PR along.
const SHIP_ACTIVE = new Set(['publish', 'watch', 'merge']);
// Stages where the human has to act; the Chief of Staff brings each to them.
export const WAITING_STAGES = new Set(['awaiting-approval', 'escalated', 'blocked', 'ready-to-merge']);
// Stages where nothing runs: no hires, no reviews, no wake-ups.
export const PAUSED_STAGES = new Set(['on-hold', 'blocked']);
// After a code change is approved, the engineer ships it: it publishes the PR and Grove watches it until it's merged.
export const SHIPPING_STAGES = new Set(['watching', 'ready-to-merge']);
const HOLDABLE = new Set(['routing', 'working', 'reviewing', 'watching', 'ready-to-merge']);
// The human can set a task that waits on them aside for later: it leaves their inbox, the engineer rests, and
// it comes back (from the shelf, or when its PR needs work) exactly where it was.
export const SHELVABLE = WAITING_STAGES;
// While shelved, the human's other decisions apply as if it were still in the stage it was shelved from.
const SHELF_PASSTHROUGH = new Set(['approve', 'changes', 'note', 'question', 'retry', 'merge']);
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/;

// Briefs for the steps Grove adds itself once a code change is approved.
const AGENT_COMMENTS = 'Start any comment you write on GitHub with 🤖, so people can tell it came from an agent.';
export const SHIP_BRIEFS = Object.freeze({
  draft: `The work is done and goes to the human for sign-off next. Open a **draft** pull request with it, so they can review the change itself:
1. Commit the change on the task's branch, in the same worktree or folder you worked in. Don't include unrelated files.
2. Push the branch and open a draft PR with \`gh pr create --draft\`: a clear title, and a description of what changed, why, and how it was verified, with \`Closes #<n>\` (or the issue URL) for every issue it fixes. Use the repository's PR template if it has one.
3. Don't mark it ready for review and don't merge it: the human decides that.
${AGENT_COMMENTS}
End what you submit with a line \`PR: <url of the draft pull request>\`. If this work can't go in a pull request (it isn't in a git repository, there's no remote, or nothing changed in files), end with a line \`NO PR: <why>\` instead.`,
  ready: `The human approved the change. Publish the draft pull request:
1. Push any commits that aren't on the PR yet, and update its description if the change moved since it was opened.
2. Mark it ready for review with \`gh pr ready\`.
3. Do anything else the human asked for in the feedback below (for example closing a superseded PR, with a comment saying why).
4. Don't merge, and don't wait for checks: Grove watches the PR from here and comes back to you if checks fail or reviewers ask for changes.
${AGENT_COMMENTS}
End what you submit with a line \`PR: <url of the pull request>\`.`,
  publish: `The human approved this change. Publish it:
1. Commit the approved change on the task's branch, in the same worktree or folder you worked in. Don't include unrelated files.
2. Push the branch and open a pull request with \`gh pr create\`: a clear title and description (what changed, why, how it was verified), and \`Closes #<n>\` (or the issue URL) for every issue it fixes. Use the repository's PR template if it has one.
3. Do anything else the human asked for in the feedback below (for example closing a superseded PR, with a comment saying why).
4. Don't merge, and don't wait for checks: Grove watches the PR from here and comes back to you if checks fail or reviewers ask for changes.
${AGENT_COMMENTS}
End what you submit with a line \`PR: <url of the pull request>\`.`,
  merge: `The human asked to merge the pull request. Check that its head is still the one that passed checks and review (\`gh pr view\`), then merge it the way the repository expects (its merge settings and CONTRIBUTING notes; \`gh pr merge\`). Never bypass branch protection, required checks or reviews: if the PR can't be merged as is, say why and stop. Delete the branch only if the repository does that by default.
${AGENT_COMMENTS}
End what you submit with a line \`PR: <url of the pull request>\`.`,
});
const MARKER = /\[grove:(T\d+-[a-z0-9-]+)\]/i;
// One reviewer session per specialty per task, kept across every review it sits on.
export function memberKey(ticket) {
  return `reviewer-${ticket.specialty}`;
}

const cap = (s) => `${s[0].toUpperCase()}${s.slice(1)}`;

export function memberTitle(ticket) {
  return `${cap(ticket.specialty)} reviewer`;
}

export function stepLabel(step) {
  return `${step.id} · ${KIND_LABELS[step.kind]}${step.title && step.title !== DEFAULT_TITLES[step.kind] ? `: ${step.title}` : ''}`;
}

// A short label for the task's current state, e.g. "S2 Research · review R1".
export function stageLabel(task) {
  const n = task.ship?.pr?.number;
  if (task.stage === 'watching' && n) return `Watching PR #${n}`;
  if (task.stage === 'ready-to-merge' && n) return `PR #${n} ready to merge`;
  const step = currentStep(task);
  if ((task.stage === 'working' || task.stage === 'reviewing') && step) {
    const f = step.forum;
    return task.stage === 'reviewing' ? `${step.id} ${KIND_LABELS[step.kind]} · review R${f.round - f.windowStart}` : `${step.id} ${KIND_LABELS[step.kind]}`;
  }
  return STAGE_LABELS[task.stage] ?? task.stage;
}

export function currentStep(task) {
  return task.steps?.find((s) => s.status === 'working' || s.status === 'reviewing') ?? null;
}

export class ProcessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function now() {
  return Date.now();
}

function clip(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function markerOf(text) {
  const m = MARKER.exec(String(text ?? ''));
  return m ? m[1] : null;
}

// The contract puts the verdict on the last line; take the last marker so quoted earlier verdicts don't count.
function lastMarker(text, re) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = re.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

export function parseVerdict(text) {
  const v = lastMarker(text, /^[\s>*_`#-]*VERDICT\s*[:=-]\s*\**\s*(APPROVE|APPROVED|CHANGES|REQUEST[\s_-]*CHANGES|CHANGES[\s_-]*REQUESTED)\b/i);
  return v ? (/^APPROV/i.test(v) ? 'approve' : 'changes') : null;
}

// A member that can't go on without the human ends with "BLOCKED: <what the human must do>".
export function parseBlocked(text) {
  return lastMarker(text, /^[\s>*_`#-]*BLOCKED\s*[:=-]\s*\**\s*(\S.{2,})$/i)?.replace(/[*_`\s]+$/, '') ?? null;
}

// A draft PR step whose work can't go in a pull request ends with "NO PR: <why>".
export function parseNoPr(text) {
  return lastMarker(text, /^[\s>*_`#-]*NO\s+PR\s*[:=-]\s*\**\s*(\S.{2,})$/i)?.replace(/[*_`\s]+$/, '') ?? null;
}

export function parsePr(text) {
  const all = [...String(text ?? '').matchAll(new RegExp(PR_URL.source, 'g'))];
  const m = all.at(-1);
  return m ? { url: m[0], repo: `${m[1]}/${m[2]}`, number: Number(m[3]) } : null;
}

// Summarise \`gh pr view --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,url,number\`.
const CHECK_FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
export function prSummary(s) {
  const checks = { passed: 0, skipped: 0, pending: 0, failed: [] };
  for (const c of Array.isArray(s?.statusCheckRollup) ? s.statusCheckRollup : []) {
    const name = String(c?.name ?? c?.context ?? 'check');
    const done = c?.status ? c.status === 'COMPLETED' : !['PENDING', 'EXPECTED', undefined, null, ''].includes(c?.state);
    const outcome = String(c?.conclusion ?? c?.state ?? '').toUpperCase();
    if (!done) checks.pending += 1;
    else if (CHECK_FAILED.has(outcome)) checks.failed.push({ name: clip(name, 80), url: String(c?.detailsUrl ?? c?.targetUrl ?? '') || null });
    else if (outcome === 'SKIPPED' || outcome === 'NEUTRAL' || outcome === 'CANCELLED' || outcome === 'STALE') checks.skipped += 1;
    else checks.passed += 1;
  }
  return {
    state: String(s?.state ?? 'OPEN').toUpperCase(),
    draft: !!s?.isDraft,
    mergeable: String(s?.mergeable ?? 'UNKNOWN').toUpperCase(),
    mergeState: String(s?.mergeStateStatus ?? 'UNKNOWN').toUpperCase(),
    review: String(s?.reviewDecision ?? '').toUpperCase(),
    head: String(s?.headRefOid ?? ''),
    checks,
  };
}

// One line describing where a PR stands.
export function prLine(pr) {
  if (!pr) return '';
  const c = pr.checks;
  const parts = [];
  if (pr.state && pr.state !== 'OPEN') parts.push(pr.state.toLowerCase());
  if (c) parts.push(`checks: ${c.passed} passed${c.failed.length ? `, ${c.failed.length} failing (${c.failed.map((f) => f.name).join(', ')})` : ''}${c.pending ? `, ${c.pending} running` : ''}${c.skipped ? `, ${c.skipped} skipped` : ''}`);
  if (pr.review) parts.push(`review: ${pr.review.toLowerCase().replace(/_/g, ' ')}`);
  if (pr.mergeable === 'CONFLICTING') parts.push('merge conflicts');
  if (pr.draft) parts.push('draft');
  return `PR #${pr.number}${parts.length ? ` (${parts.join('; ')})` : ''}`;
}

export function parseResult(text) {
  const v = lastMarker(text, /^[\s>*_`#-]*RESULT\s*[:=-]\s*\**\s*(PASS|PASSED|FAIL|FAILED)\b/i);
  return v ? (/^PASS/i.test(v) ? 'pass' : 'fail') : null;
}

// Validate and normalise the engineer's step list (template first, then its own steps).
export function normalizeSteps({ template, steps }) {
  const out = [];
  if (template !== undefined) {
    if (!TEMPLATES[template]) throw new ProcessError('invalid_input', `Unknown template "${template}". Use one of: ${Object.keys(TEMPLATES).join(', ')}.`);
    out.push(...TEMPLATES[template].map((s) => ({ ...s })));
  }
  if (steps !== undefined) {
    if (!Array.isArray(steps)) throw new ProcessError('invalid_input', 'steps must be an array.');
    out.push(...steps);
  }
  return out.map((s, i) => {
    if (!s || typeof s !== 'object') throw new ProcessError('invalid_input', `Step ${i + 1} must be an object.`);
    if (!STEP_KINDS.includes(s.kind)) throw new ProcessError('invalid_input', `Step ${i + 1}: kind must be one of ${STEP_KINDS.join(', ')}. Reviews are attached to a step with "reviewers".`);
    if (s.title !== undefined && typeof s.title !== 'string') throw new ProcessError('invalid_input', `Step ${i + 1}: title must be a string.`);
    if (s.brief !== undefined && typeof s.brief !== 'string') throw new ProcessError('invalid_input', `Step ${i + 1}: brief must be a string.`);
    const reviewers = s.reviewers ?? [];
    if (!Array.isArray(reviewers)) throw new ProcessError('invalid_input', `Step ${i + 1}: reviewers must be an array.`);
    const seen = new Set();
    const rs = reviewers.map((r) => {
      const name = typeof r === 'string' ? r : r?.name;
      const focus = typeof r === 'object' && r ? r.focus : undefined;
      const worktree = typeof r === 'object' && r ? r.worktree : undefined;
      if (typeof name !== 'string' || !NAME.test(name)) throw new ProcessError('invalid_input', `Step ${i + 1}: reviewer names are short lowercase words (for example "accuracy"), got ${JSON.stringify(name)}.`);
      if (seen.has(name)) throw new ProcessError('invalid_input', `Step ${i + 1}: reviewer "${name}" is listed twice.`);
      seen.add(name);
      if (focus !== undefined && typeof focus !== 'string') throw new ProcessError('invalid_input', `Step ${i + 1}: reviewer focus must be a string.`);
      if (worktree !== undefined && typeof worktree !== 'boolean') throw new ProcessError('invalid_input', `Step ${i + 1}: reviewer worktree must be boolean.`);
      if (!REVIEWER_FOCUS[name] && !focus?.trim()) throw new ProcessError('invalid_input', `Step ${i + 1}: "${name}" is not a built-in reviewer (${Object.keys(REVIEWER_FOCUS).join(', ')}); give it a focus: { "name": "${name}", "focus": "what to check" }.`);
      return { name, focus: clip(focus?.trim() || REVIEWER_FOCUS[name], 600), ...(worktree !== undefined ? { worktree } : {}) };
    });
    if (rs.length > 6) throw new ProcessError('invalid_input', `Step ${i + 1}: at most 6 reviewers.`);
    return { kind: s.kind, title: clip(s.title?.trim() || DEFAULT_TITLES[s.kind], 80), brief: clip(s.brief?.trim() ?? '', 4000), reviewers: rs };
  });
}

export class ProcessEngine {
  constructor({ board, selfId, onChange = () => {}, log = () => {}, validateEvidence }) {
    this.board = board;
    this.root = board.root;
    this.selfId = selfId;
    this.onChange = onChange;
    this.log = log;
    this.validateEvidence = validateEvidence;
    this.state = { tasks: [], updatedAt: now() };
    this.byToolCall = new Map();
    this.claimingFrom = new Map();
  }

  owns(task) {
    return task.owner === this.selfId;
  }

  // Tasks this session may change.
  mine() {
    return this.state.tasks.filter((t) => this.owns(t));
  }

  // Load every task on the board. Hires in flight keep running in their own sessions and report through
  // result files, so nothing is reissued here.
  async load() {
    this.state.tasks = await this.board.readTasks();
    for (const t of this.state.tasks) normalizeTask(t, this.board.id);
    this.state.updatedAt = now();
  }

  // Re-read tasks owned by other sessions. Tasks this session owns stay authoritative in memory unless
  // another session has taken them over. Returns { changed, lost } task ids.
  async refresh() {
    const fresh = await this.board.readTasks();
    const changed = [];
    const lost = [];
    const byId = new Map(this.state.tasks.map((t) => [t.id, t]));
    const next = [];
    for (const f of fresh) {
      normalizeTask(f, this.board.id);
      const local = byId.get(f.id);
      if (local && this.owns(local)) {
        if (f.owner === this.selfId) {
          next.push(local);
          continue;
        }
        lost.push(f.id);
      }
      if (!local || local.updatedAt !== f.updatedAt || local.owner !== f.owner) changed.push(f.id);
      next.push(f);
    }
    // Keep owned tasks whose file has not been written yet.
    for (const t of this.state.tasks) if (this.owns(t) && !fresh.some((f) => f.id === t.id)) next.push(t);
    next.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    this.state.tasks = next;
    if (changed.length) this.state.updatedAt = now();
    return { changed, lost };
  }

  changed(task, line) {
    if (task && line) {
      task.history.push({ at: now(), text: line });
      if (task.history.length > 200) task.history.splice(0, task.history.length - 200);
    }
    if (task) {
      task.updatedAt = now();
      // During a decision batch the task is saved once, when the batch ends.
      if (this.holding?.has(task.id)) {}
      else if (this.owns(task)) {
        const from = this.claimingFrom.get(task.id);
        this.board.saveTask(task, from ?? this.selfId).then(() => {
          if (from !== undefined && this.claimingFrom.get(task.id) === from) this.claimingFrom.delete(task.id);
        }).catch((err) => this.log(`Grove could not save ${task.id}: ${err.message}`, 'error'));
      }
      else this.log(`Grove: ${task.id} is owned by another session; not saving.`, 'warning');
    }
    this.state.updatedAt = now();
    this.onChange();
  }

  flush() {
    return this.board.flush();
  }

  // ---------- queries ----------

  task(id) {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) {
      const known = this.activeTasks().map(taskLabel).join(', ');
      throw new ProcessError('not_found', `No task "${id}".${known ? ` Open tasks: ${known}.` : ''} Use grove_status to list tasks.`);
    }
    return t;
  }

  step(task, id) {
    const s = task.steps.find((x) => x.id === id);
    if (!s) throw new ProcessError('not_found', `${task.id} has no step "${id}". Steps: ${task.steps.map((x) => x.id).join(', ') || 'none yet'}.`);
    return s;
  }

  activeTasks() {
    return this.state.tasks.filter((t) => !TERMINAL.has(t.stage));
  }

  findTicket(id) {
    for (const t of this.state.tasks) {
      const k = t.tickets.find((x) => x.id === id);
      if (k) return { task: t, ticket: k };
    }
    return null;
  }

  evidenceDir(task, attempt) {
    return path.join(this.root, task.id, 'evidence', `attempt-${attempt}`);
  }

  // The latest passing verification, if any step verified the work.
  latestEvidence(task) {
    for (let i = task.steps.length - 1; i >= 0; i--) {
      const v = task.steps[i].verification;
      if (task.steps[i].status === 'done' && v?.result === 'pass') return v;
    }
    return null;
  }

  // The output the human receives: the last finished research, execute or plan step.
  latestResult(task) {
    const done = task.steps.filter((s) => s.status === 'done' && s.output && s.kind !== 'verify' && !s.ship);
    return done.at(-1) ?? null;
  }

  // Decisions only the human can make. The Chief of Staff presents these in its chat.
  humanActions(tasks = this.state.tasks) {
    const out = [];
    for (const t of tasks) {
      if (t.stage === 'awaiting-approval' && t.delivery) {
        const v = this.latestEvidence(t);
        const result = this.latestResult(t);
        out.push({
          taskId: t.id,
          title: t.title,
          name: t.name ?? null,
          kind: 'approve-result',
          text: `${taskLabel(t)} "${t.title}" is finished. The human reviews the result and signs off, or asks for more.`,
          criteria: t.criteria,
          summary: t.delivery.summary,
          steps: t.steps.filter((s) => s.status === 'done').map((s) => ({ step: stepLabel(s), reviewed: s.reviewers.length ? `approved by ${s.reviewers.map((r) => r.name).join(', ')}` : 'not reviewed' })),
          result: result ? { step: stepLabel(result), text: clip(result.output, 8000) } : null,
          evidence: this.evidenceGroups(t).flatMap((g) => g.items.map((it) => ({ path: path.join(g.dir, it.file), caption: it.caption, criterion: it.criterion }))),
          verification: v ? clip(v.summary, 2000) : null,
          ask: t.delivery.ask || null,
          pr: t.ship?.pr ? { url: t.ship.pr.url, number: t.ship.pr.number, draft: t.ship.phase === 'draft' } : null,
          noPr: t.ship?.noPr ?? null,
        });
      }
      if (t.stage === 'blocked' && t.pause) {
        out.push({
          taskId: t.id,
          title: t.title,
          name: t.name ?? null,
          kind: 'unblock',
          text: `${taskLabel(t)} "${t.title}" is blocked: ${t.pause.need}`,
          need: t.pause.need,
          by: t.pause.by,
          detail: t.pause.detail ?? '',
        });
      }
      if (t.stage === 'ready-to-merge' && t.ship?.pr) {
        out.push({
          taskId: t.id,
          title: t.title,
          name: t.name ?? null,
          kind: 'merge',
          text: `${taskLabel(t)} "${t.title}": ${prLine(t.ship.pr)} is ready to merge.`,
          pr: t.ship.pr,
        });
      }
      if (t.stage === 'escalated' && t.escalation) {
        const step = t.steps.find((s) => s.id === t.escalation.step);
        const last = new Map();
        for (const p of step?.forum.posts ?? []) if (p.kind === 'review') last.set(p.role, p);
        out.push({
          taskId: t.id,
          title: t.title,
          name: t.name ?? null,
          kind: 'resolve-escalation',
          step: step ? stepLabel(step) : t.escalation.step,
          text: `${step ? stepLabel(step) : 'A step'} of ${taskLabel(t)} "${t.title}" is stuck: ${t.escalation.reason}`,
          positions: [...last.values()].map((p) => ({ reviewer: p.author, verdict: p.verdict, post: clip(p.text, 1500) })),
        });
      }
    }
    return out;
  }

  // ---------- task lifecycle ----------

  // Called by the Chief of Staff, who owns the task until its engineer claims it. The engineer chooses its steps.
  createTask({ id, name, title, goal, criteria = [], kind = 'code', destination: intent, chiefDirectory }) {
    if (!TASK_KINDS.includes(kind)) throw new ProcessError('invalid_input', `kind must be one of ${TASK_KINDS.join(', ')}.`);
    const t = {
      id,
      ...(name ? { name } : {}),
      kind,
      ...(intent ? { destination: destination(intent) } : {}),
      ...(chiefDirectory ? { chiefDirectory } : {}),
      owner: this.selfId,
      lead: null,
      members: {},
      decisionsApplied: 0,
      title: clip(title, 80),
      goal: clip(goal, 4000),
      criteria: criteria.map((c) => clip(c, 300)).filter(Boolean).slice(0, 20),
      stage: 'routing',
      routingSince: now(),
      createdAt: now(),
      updatedAt: now(),
      steps: [],
      stepSeq: 0,
      evidenceSeq: 0,
      deliveries: 0,
      delivery: null,
      feedback: [],
      escalation: null,
      tickets: [],
      history: [],
      updates: [],
      questions: [],
      pause: null,
      ship: null,
      shelf: null,
      seq: 0,
    };
    this.state.tasks.push(t);
    this.changed(t, `Task created: ${t.title}`);
    return t;
  }

  // The engineer's session takes ownership. Reviews in flight keep running in their reviewers' sessions.
  // `token` is the hand-off token; each one can be claimed once.
  claim(id, token) {
    const t = this.task(id);
    if (TERMINAL.has(t.stage)) throw new ProcessError('invalid_state', `${id} is already ${t.stage}.`);
    if (t.lead?.token === token) {
      if (t.lead.sessionId === this.selfId) return t;
      throw new ProcessError('stale_handoff', `This hand-off for ${id} was already used by another session.`);
    }
    const previous = t.lead?.sessionId;
    this.claimingFrom.set(id, t.owner);
    t.owner = this.selfId;
    t.lead = { sessionId: this.selfId, claimedAt: now(), token };
    delete t.workspaceRepair;
    this.changed(t, previous ? 'A new engineer took over.' : 'Engineer started.');
    return t;
  }

  // Apply the human's decisions (recorded by the Chief) that this owner has not applied yet. A cancel in the
  // batch wins: the earlier decisions it overtook (other than notes and questions) are superseded, so a
  // queued approve never ships a task the human has since dismissed. Each outcome is kept on the task.
  applyDecisions(task, items) {
    const applied = [];
    const pending = items.filter((d) => d.seq > (task.decisionsApplied ?? 0)).sort((a, b) => a.seq - b.seq);
    const cancelAt = pending.find((d) => d.action === 'cancel')?.seq;
    if (!pending.length) return applied;
    // The transitions, the cursor and each outcome are saved together in one snapshot, so a restart never
    // finds a decision counted as applied without its outcome.
    this.holding ??= new Set();
    const outer = this.holding.has(task.id);
    if (!outer) this.holding.add(task.id);
    try {
      this.applyPending(task, pending, cancelAt, applied);
    } finally {
      if (!outer) {
        this.holding.delete(task.id);
        this.changed(task, null);
      }
    }
    return applied;
  }

  applyPending(task, pending, cancelAt, applied) {
    for (const d of pending) {
      task.decisionsApplied = d.seq;
      if (cancelAt !== undefined && d.seq < cancelAt && !['note', 'question'].includes(d.action)) {
        this.noteDecision(task, d, 'superseded', `overtaken by cancel #${cancelAt}`, cancelAt);
        this.changed(task, `Decision #${d.seq} "${d.action}" skipped: the human cancelled the task after it.`);
        continue;
      }
      try {
        this.humanDecision({ taskId: task.id, action: d.action, note: d.note ?? '', ship: typeof d.ship === 'boolean' ? d.ship : undefined });
        if (d.workspaceRepair && d.seq > (task.repairInvalidatedThrough ?? 0)
          && d.workspaceRepair.sessionId === this.selfId && ['retry', 'note'].includes(d.action)) {
          task.workspaceRepair = { ...d.workspaceRepair, seq: d.seq };
          this.changed(task, 'The human authorized workspace repair; immediate host confirmation is still required.');
        }
        this.noteDecision(task, d, 'applied');
        applied.push(d);
      } catch (err) {
        if (!(err instanceof ProcessError)) throw err;
        this.noteDecision(task, d, 'rejected', err.message);
        this.changed(task, `Decision "${d.action}" not applied: ${err.message}`);
      }
    }
  }

  noteDecision(task, d, result, reason, by) {
    task.decisionResults = [...(task.decisionResults ?? []), {
      seq: d.seq, action: d.action, result, at: now(), ...(reason ? { reason: clip(reason, 200) } : {}), ...(by ? { by } : {}),
    }].slice(-DECISION_RESULTS);
  }

  decisionResult(task, seq) {
    return (task.decisionResults ?? []).find((r) => r.seq === seq) ?? null;
  }

  cancelTask(id, reason = '') {
    const t = this.task(id);
    if (TERMINAL.has(t.stage)) throw new ProcessError('invalid_state', `${id} is already ${t.stage}.`);
    cancelOpenTickets(t);
    for (const s of t.steps) if (s.status !== 'done') s.status = 'skipped';
    t.stage = 'cancelled';
    this.changed(t, `Cancelled${reason ? `: ${clip(reason, 200)}` : ''}`);
    return t;
  }

  // ---------- route ----------

  // The engineer sets or changes the route. `replace` drops steps that haven't started; `redoFrom` runs a finished
  // step (and every finished step after it) again, with `note` as feedback for the members.
  planSteps(taskId, { template, steps, replace = false, redoFrom, note = '' }) {
    const t = this.task(taskId);
    if (TERMINAL.has(t.stage)) throw new ProcessError('invalid_state', `${taskId} is ${t.stage}.`);
    if (t.stage === 'awaiting-approval' || t.stage === 'escalated') throw new ProcessError('invalid_state', `${taskId} is waiting on the human; their decision comes first.`);
    const fresh = normalizeSteps({ template, steps });
    let redo = [];
    if (redoFrom !== undefined) {
      const from = this.step(t, redoFrom);
      if (from.status !== 'done') throw new ProcessError('invalid_input', `${from.id} hasn't finished; only finished steps can be redone.`);
      if (from.ship) throw new ProcessError('invalid_input', `${from.id} is Grove's pull request step; redo the work before it instead.`);
      const start = t.steps.indexOf(from);
      // Grove's own PR steps aren't redone: the PR is reused, and Grove adds what's needed when the engineer delivers.
      redo = t.steps.slice(start).filter((s) => s.status === 'done' && !s.ship).map((s) => ({ kind: s.kind, title: s.title, brief: s.brief, reviewers: s.reviewers, redoOf: s.id }));
    }
    if (!fresh.length && !redo.length && !replace) throw new ProcessError('invalid_input', 'Give a template, steps, or redoFrom.');
    const msg = clip(note, 4000);
    if (msg) t.feedback.push({ from: 'engineer', at: now(), text: msg });
    const dropped = replace ? t.steps.filter((s) => s.status === 'pending') : [];
    if (replace) for (const s of dropped) s.status = 'skipped';
    const pending = t.steps.filter((s) => s.status === 'pending');
    const added = [...redo, ...fresh];
    if (t.steps.filter((s) => s.status !== 'skipped').length + added.length > MAX_STEPS) throw new ProcessError('invalid_input', `A task can have at most ${MAX_STEPS} steps.`);
    // Redone steps run before the steps still waiting; new steps run after them.
    const made = added.map((s) => newStep(t, s));
    const redoMade = made.slice(0, redo.length);
    const freshMade = made.slice(redo.length);
    t.steps = [...t.steps.filter((s) => s.status !== 'pending'), ...redoMade, ...pending, ...freshMade];
    const parts = [];
    if (dropped.length) parts.push(`dropped ${dropped.map((s) => s.id).join(', ')}`);
    if (redoMade.length) parts.push(`redo ${redoMade.map((s) => `${s.id} (${s.redoOf})`).join(', ')}`);
    if (freshMade.length) parts.push(`added ${freshMade.map((s) => stepLabel(s)).join('; ')}`);
    this.changed(t, `Route: ${parts.join('; ') || 'no change'}${msg ? ` (${clip(msg, 120)})` : ''}.`);
    if (t.stage === 'routing') this.advance(t);
    return t;
  }

  // Start the next pending step, or wait for the engineer to deliver or add steps.
  advance(task) {
    const next = task.steps.find((s) => s.status === 'pending');
    // The draft PR is up (or can't be): the delivered result goes to the human.
    if (!next && task.ship?.phase === 'draft' && task.delivery) {
      task.stage = 'awaiting-approval';
      this.changed(task, task.ship.pr ? `Draft ${prLine(task.ship.pr)} is up; the result awaits your sign-off.` : `No pull request (${task.ship.noPr ?? 'none possible'}); the result awaits your sign-off.`);
      return;
    }
    // While a change ships, finished steps (publishing, fixes) hand back to watching the PR.
    if (!next && task.ship?.pr && SHIP_ACTIVE.has(task.ship.phase)) {
      task.stage = 'watching';
      task.ship.attention = null;
      this.changed(task, `Watching ${prLine(task.ship.pr)}.`);
      return;
    }
    if (!next) {
      task.stage = 'routing';
      task.routingSince = now();
      this.changed(task, task.steps.length ? 'All planned steps are done; the engineer delivers the result or adds steps.' : null);
      return;
    }
    this.startStep(task, next);
    this.changed(task, `${stepLabel(next)} started.`);
  }

  // The engineer works on the step in its own chat (again, when revising). A step that may leave evidence
  // gets a fresh evidence folder each time.
  startStep(task, step) {
    step.status = 'working';
    step.startedAt = now();
    step.skills = [];
    task.stage = 'working';
    if (task.lead) delete task.lead.phase;
    if (EVIDENCE_KINDS.has(step.kind) && !step.ship) step.evidenceAttempt = ++task.evidenceSeq;
    else delete step.evidenceAttempt;
  }

  // The skills the engineer loaded show where it is: a phase skill for another kind of step sends its sprite
  // to that station until the next step starts (or another skill loads). Returns true when something changed.
  noteSkill(task, name) {
    const step = currentStep(task);
    const kind = Object.keys(KIND_SKILLS).find((k) => KIND_SKILLS[k] === String(name ?? '').replace(/^[^:]+:/, ''));
    if (!kind || !step || step.status !== 'working' || !task.lead) return false;
    step.skills ??= [];
    const fresh = !step.skills.includes(KIND_SKILLS[kind]);
    if (fresh) step.skills.push(KIND_SKILLS[kind]);
    const detour = kind === step.kind ? null : { kind, step: step.id, at: now() };
    const moved = (task.lead.phase?.kind ?? null) !== (detour?.kind ?? null);
    if (detour) task.lead.phase = detour;
    else delete task.lead.phase;
    if (fresh || moved) this.changed(task, moved && detour ? `The engineer turned to ${KIND_LABELS[kind].toLowerCase()} during ${step.id}.` : null);
    return fresh || moved;
  }

  // Where the engineer's step keeps its evidence, if it has a folder.
  stepEvidenceDir(task, step) {
    return step?.evidenceAttempt ? this.evidenceDir(task, step.evidenceAttempt) : null;
  }

  // The engineer hands the result to the human (through the Chief). Steps not started are skipped.
  deliver(taskId, summary, { decisions = [], ship, ask = '' } = {}) {
    const t = this.task(taskId);
    this.requirePlacement(t);
    if (t.stage !== 'routing') throw new ProcessError('invalid_state', `${taskId} is "${stageLabel(t)}"; deliver once the current step is done.`);
    // Shipping: the human already approved. Delivering hands back to watching the PR.
    if (t.ship?.pr && SHIP_ACTIVE.has(t.ship.phase)) {
      const text = clip(summary, 1000);
      if (text) this.postUpdate(taskId, text);
      for (const s of t.steps) if (s.status === 'pending') s.status = 'skipped';
      this.advance(t);
      return t;
    }
    if (!t.steps.some((s) => s.status === 'done')) throw new ProcessError('invalid_state', `${taskId} has no finished steps to deliver yet. Plan steps first.`);
    const text = clip(summary, 4000);
    if (text.length < 20) throw new ProcessError('invalid_input', 'Write a short summary for the human: what was found or done, and anything they should know.');
    for (const s of t.steps) if (s.status === 'pending') s.status = 'skipped';
    t.deliveries += 1;
    const keyDecisions = (Array.isArray(decisions) ? decisions : []).map((d) => clip(d, 400)).filter(Boolean).slice(0, 12);
    // An approved code change goes on to a pull request unless the engineer says it isn't one.
    const shipIt = typeof ship === 'boolean' ? ship : t.steps.some((s) => s.kind === 'execute' && s.status === 'done');
    t.delivery = { summary: text, decisions: keyDecisions, ask: clip(ask, 600), ship: shipIt, at: now(), n: t.deliveries };
    // A code change goes to the human with a draft PR, so they can review the change itself.
    if (shipIt && !t.ship?.pr) {
      t.ship = { phase: 'draft', startedAt: now(), pr: null, attention: null, noPr: null };
      t.steps.push(newStep(t, { kind: 'execute', title: 'Open a draft pull request', brief: SHIP_BRIEFS.draft, ship: 'draft' }));
      this.changed(t, 'Result ready; the engineer opens a draft pull request before your sign-off.');
      this.advance(t);
      return t;
    }
    t.stage = 'awaiting-approval';
    this.changed(t, 'Result delivered; awaiting your sign-off.');
    return t;
  }

  // ---------- the engineer's work ----------

  // The engineer submits a step's output (grove_submit). It's checked against the step's contract before
  // anything is recorded, so a bad submission comes straight back as an error saying what to fix.
  async submit(taskId, stepId, raw) {
    const task = this.task(taskId);
    this.requirePlacement(task);
    const step = currentStep(task);
    if (!step || task.stage !== 'working') {
      throw new ProcessError('invalid_state', `${taskId} is "${stageLabel(task)}"; there's no step to submit right now. Call grove_next.`);
    }
    if (stepId && stepId !== step.id) throw new ProcessError('invalid_input', `The step in progress is ${step.id}, not ${stepId}.`);
    const text = String(raw ?? '').trim();
    const checked = await this.checkStep(task, step, text);
    if (!checked.ok) throw new ProcessError('invalid_output', checked.reason);
    if (task.destination && step.reviewers.some((r) => r.worktree)) {
      if (!task.placement.repository) throw new ProcessError('invalid_state', 'Separate reviewers require a repository attachment.');
      step.snapshot = ['execute', 'verify'].includes(step.kind) ? await committedSnapshot(task.placement.directory) : null;
    }
    this.recordStepOutput(task, step, text, checked);
    return { task, step };
  }

  // A step's output against its kind's contract. Returns { ok, reason?, ev?, noPr? }.
  async checkStep(task, step, text) {
    if (parseBlocked(text)) return { ok: false, reason: 'If only the human can unblock this step, call grove_blocked with exactly what they must do, instead of submitting.' };
    if (step.ship) {
      const noPr = step.ship === 'draft' ? parseNoPr(text) : null;
      if (noPr) return { ok: true, noPr };
      if (!parsePr(text)) return { ok: false, reason: `End the output with a line "PR: <url>" giving the pull request (https://github.com/<owner>/<repo>/pull/<n>).${step.ship === 'draft' ? ' If the work can\'t go in a pull request, end with "NO PR: <why>".' : ''}` };
      return { ok: true };
    }
    const dir = this.stepEvidenceDir(task, step);
    switch (step.kind) {
      case 'plan':
        return text.length < 200 ? { ok: false, reason: 'Submit the complete plan: overview, steps, what changes (files, components, systems), risks, acceptance criteria, and how it will be verified.' } : { ok: true };
      case 'verify': {
        if (!parseResult(text)) return { ok: false, reason: 'End the verification report with a line exactly "RESULT: PASS" or "RESULT: FAIL".' };
        const ev = await this.validateEvidence(dir);
        return ev.ok ? { ok: true, ev } : { ok: false, reason: `Visual evidence is required: ${ev.reason} Save the files and evidence.json in ${dir}.` };
      }
      default: {
        const base = text.length >= 80 ? { ok: true }
          : step.kind === 'research'
            ? { ok: false, reason: 'Submit your findings: the answer, how you got it (queries, sources, file paths), and what is uncertain.' }
            : { ok: false, reason: 'Submit a summary of what you did: files or things changed, the effect, how to inspect it, build and test results, and anything left undone.' };
        if (!base.ok || !dir) return base;
        // Research and execute may leave visual evidence; if they do, it has to be valid.
        const ev = await this.validateEvidence(dir);
        if (!ev.ok && !ev.missing) return { ok: false, reason: `Your evidence in ${dir} isn't valid: ${ev.reason} Fix evidence.json (or remove it) and submit again.` };
        return ev.ok ? { ok: true, ev } : base;
      }
    }
  }

  // ---------- reviewer tickets ----------

  issue(task, { specialty, step, round = 0 }) {
    const n = ++task.seq;
    const submission = task.steps.find((s) => s.id === step);
    const worktree = submission?.reviewers.find((r) => r.name === specialty)?.worktree === true;
    const ticket = {
      id: `${task.id}-rev-${specialty}-${n}`,
      role: 'reviewer', specialty, step, round,
      worktree, snapshot: worktree ? submission?.snapshot ?? null : null, version: submission?.version ?? 0,
      forum: step,
      agentType: AGENT_TYPES.reviewer(specialty),
      status: 'issued',
      dispatcher: LEAD,
      attempt: 1,
      token: crypto.randomBytes(8).toString('hex'),
      issuedAt: now(),
      dispatchedAt: null,
      startedAt: null,
      endedAt: null,
    };
    ticket.member = memberKey(ticket);
    task.tickets.push(ticket);
    return ticket;
  }

  // ---------- hire lifecycle (sessions) ----------

  member(task, ticket) {
    return task.members[ticket.member] ?? null;
  }

  // How the engineer should deliver a ticket: message the reviewer's existing session (it keeps its
  // transcript), or start a new session when that specialty has none yet or its session was lost.
  route(task, ticket) {
    const m = this.member(task, ticket);
    return m?.link && m.status !== 'lost' && !!m.worktree === !!ticket.worktree
      ? { tool: 'send_message', session: m.link } : { tool: 'create_session' };
  }

  // Called before create_session / send_message runs. Returns { task, ticket } or throws ProcessError.
  authorizeHire({ marker, tool, target }) {
    const found = this.findTicket(marker);
    if (!found) throw new ProcessError('unknown_ticket', `Ticket ${marker} does not exist. Call grove_next for valid hires.`);
    const { task, ticket } = found;
    this.requirePlacement(task);
    if (!this.owns(task)) throw new ProcessError('not_owner', `Ticket ${marker} belongs to another task's engineer.`);
    if (TERMINAL.has(task.stage)) throw new ProcessError('invalid_state', `${task.id} is ${task.stage}; this hire is no longer needed.`);
    if (ticket.status !== 'issued') throw new ProcessError('ticket_used', `Ticket ${marker} is ${ticket.status}. Call grove_next for current hires.`);
    const route = this.route(task, ticket);
    if (tool === 'send_message') {
      const m = this.member(task, ticket);
      if (!m?.link) throw new ProcessError('wrong_route', `Ticket ${marker} needs a new session: use create_session.`);
      if (!!m.worktree !== !!ticket.worktree) throw new ProcessError('wrong_route', 'Reviewer isolation changed; create a compatible new reviewer.');
      if (target && !sameChat(target, m.link)) throw new ProcessError('wrong_route', `Ticket ${marker} goes to the ${memberTitle(ticket)} session ${m.link}.`);
    } else if (route.tool === 'send_message') {
      // Starting a fresh session for a role that has one is allowed (for example if its chat was closed).
      this.log(`Grove: ${ticket.id} starts a new ${memberTitle(ticket)} session instead of reusing ${route.session}.`, 'info');
    }
    ticket.status = 'dispatched';
    ticket.via = tool;
    ticket.dispatchedAt = now();
    this.changed(task, `Hired ${this.describe(task, ticket)}${tool === 'send_message' ? ' (same session)' : ''}`);
    return found;
  }

  bindToolCall(toolCallId, marker) {
    if (toolCallId && marker) this.byToolCall.set(toolCallId, marker);
  }

  rememberMember(task, ticket, link) {
    this.learnLeadLink(task, link);
    task.members[ticket.member] = { ...(task.members[ticket.member] ?? {}), key: ticket.member, title: memberTitle(ticket), role: ticket.role, specialty: ticket.specialty, worktree: !!ticket.worktree, link, status: 'alive', since: now() };
    ticket.link = link;
  }

  // create_session / send_message finished. A new session's link becomes the role's member session.
  dispatchEnded({ toolCallId, success, link, error }) {
    const marker = this.byToolCall.get(toolCallId);
    this.byToolCall.delete(toolCallId);
    const found = marker && this.findTicket(marker);
    if (!found || !this.owns(found.task)) return;
    const { task, ticket } = found;
    if (!success) {
      const m = this.member(task, ticket);
      if (ticket.via === 'send_message' && m && chatGone(error)) m.status = 'lost';
      if (ticket.status === 'dispatched') this.failTicket(task, ticket, `could not reach the session: ${clip(error || 'tool failed', 160)}`, { retryAt: rateLimited(error) ? now() + RATE_LIMIT_BACKOFF_MS : null });
      return;
    }
    // Only create_session returns the new chat's own link (send_message reports the parent session).
    if (link && ticket.via === 'create_session') {
      this.rememberMember(task, ticket, link);
      this.changed(task, null);
    }
  }

  // Reviewers are nested chats in the engineer's session, so a reviewer's link names the engineer's own chat.
  learnLeadLink(task, memberLink) {
    const base = String(memberLink).split('?')[0];
    if (task.lead && !task.lead.link && /^agent-host-session:\/\//.test(base)) {
      task.lead.link = base;
      task.lead.linkSource = 'member';
    }
  }

  // Check a reviewer's final message against its contract. Returns { ok, reason?, blocked? }.
  async checkOutput(task, ticket, raw) {
    const text = String(raw ?? '').trim();
    const need = parseBlocked(text);
    if (need) return { ok: true, blocked: need };
    return parseVerdict(text) ? { ok: true } : { ok: false, reason: 'End your review with a line exactly "VERDICT: APPROVE" or "VERDICT: CHANGES".' };
  }

  // Apply a reviewer session's report (results/<ticket>.json). Owner only.
  async applyResult(result) {
    const found = this.findTicket(result?.ticket);
    if (!found || !this.owns(found.task)) return false;
    const { task, ticket } = found;
    if (result.token !== ticket.token) return false;
    if (ticket.status === 'done' || ticket.status === 'failed' || ticket.status === 'cancelled') return false;
    if (TERMINAL.has(task.stage) || task.stage === 'escalated' || task.stage === 'awaiting-approval' || PAUSED_STAGES.has(task.stage)) return false;
    const m = task.members[ticket.member];
    if (m && result.sessionId) m.sessionId = result.sessionId;
    if (m) { m.status = 'alive'; m.seenAt = now(); }
    if (result.status === 'running') {
      ticket.placement = result.placement;
      if (ticket.status === 'running' && ticket.heartbeatAt === result.heartbeat) return false;
      const first = ticket.status !== 'running';
      ticket.status = 'running';
      ticket.startedAt ??= now();
      ticket.heartbeatAt = result.heartbeat ?? now();
      ticket.sessionId = result.sessionId;
      // The reviewer's session reports errors it hits (model or host failures) in its heartbeats, until a
      // turn goes through again.
      const err = sessionErrorOf(result.sessionError);
      const was = ticket.sessionError?.message;
      ticket.sessionError = err;
      let line = first ? `${this.describe(task, ticket)} started work` : null;
      if (err && err.message !== was) line = `${this.describe(task, ticket)} hit an error: ${err.message}`;
      this.changed(task, line);
      return true;
    }
    if (result.status === 'failed') {
      this.failTicket(task, ticket, clip(result.error || 'the session gave up', 200));
      return true;
    }
    if (result.status === 'done') {
      if (task.destination && (result.submissionVersion !== ticket.version
        || task.steps.find((s) => s.id === ticket.step)?.version !== ticket.version)) {
        this.failTicket(task, ticket, 'Reviewer submission version is mismatched; report rejected.');
        return true;
      }
      const checked = await this.checkOutput(task, ticket, result.text);
      if (!checked.ok) {
        this.failTicket(task, ticket, `report rejected: ${checked.reason}`);
        return true;
      }
      if (checked.blocked) {
        this.blockOn(task, ticket, checked.blocked, String(result.text ?? ''));
        return true;
      }
      const placement = task.destination && ticket.worktree && result.placement?.status === 'verified'
        ? await observePlacement(task, result.placement.directory, { reviewer: ticket, sessionId: result.sessionId })
        : result.placement;
      if (!reviewerMatches(task, ticket, placement)) {
        this.failTicket(task, ticket, 'Reviewer attachment/revision is unknown or mismatched; report rejected.');
        return true;
      }
      this.acceptReview(task, ticket, String(result.text ?? '').trim());
      return true;
    }
    return false;
  }

  acceptReview(task, ticket, text) {
    this.completeTicket(ticket);
    const step = task.steps.find((s) => s.id === ticket.step);
    if (step) this.recordReview(task, step, ticket, text, parseVerdict(text));
  }

  requirePlacement(task) {
    if (task.destination && task.placement?.status !== 'verified') {
      throw new ProcessError('invalid_state', task.placement?.error ?? 'Actual attachment is unknown; inspect placement before working.');
    }
  }

  // Fail hires whose session never picked them up or stopped reporting. Owner only; called on each poll.
  sweep(at = now()) {
    let n = 0;
    for (const t of this.mine()) {
      if (TERMINAL.has(t.stage)) continue;
      for (const k of t.tickets) {
        if (k.status === 'dispatched' && at - k.dispatchedAt > CLAIM_TIMEOUT_MS) {
          const m = t.members[k.member];
          if (m) m.status = 'lost';
          this.failTicket(t, k, 'its session never started the work');
          n += 1;
        } else if (k.status === 'running' && at - (k.heartbeatAt ?? k.startedAt) > HEARTBEAT_TIMEOUT_MS) {
          this.failTicket(t, k, 'its session stopped responding');
          n += 1;
        }
      }
    }
    return n;
  }

  completeTicket(ticket) {
    ticket.status = 'done';
    ticket.endedAt = now();
  }

  // A failed hire is retried in the same reviewer session when it still exists (the session keeps its
  // transcript, so the work so far is not lost), or in a new one otherwise.
  failTicket(task, ticket, why, { retryAt = null } = {}) {
    ticket.status = 'failed';
    ticket.endedAt = now();
    ticket.failure = why;
    if (TERMINAL.has(task.stage) || task.stage === 'escalated') {
      this.changed(task, `${this.describe(task, ticket)} ended: ${why}`);
      return;
    }
    // Hitting the host's message limit isn't the reviewer failing: wait, then try the same chat again.
    if (!retryAt && ticket.attempt >= MAX_ATTEMPTS) {
      this.escalate(task, ticket.step, `${this.describe(task, ticket)} failed ${MAX_ATTEMPTS} times (last: ${why}).`);
      return;
    }
    const code = ticket.id.split('-').slice(1, -1).join('-');
    const retry = {
      ...ticket, id: `${task.id}-${code}-${++task.seq}`, status: 'issued', attempt: retryAt ? ticket.attempt : ticket.attempt + 1, blocks: 0, retryAt,
      token: crypto.randomBytes(8).toString('hex'), issuedAt: now(), dispatchedAt: null, startedAt: null, endedAt: null,
      heartbeatAt: undefined, failure: undefined, via: undefined, link: undefined, sessionId: undefined,
      sessionError: undefined, previousFailure: why,
    };
    task.tickets.push(retry);
    const where = this.route(task, retry).tool === 'send_message' ? 'in the same session' : 'in a new session';
    const when = retryAt ? ` after ${new Date(retryAt).toISOString().slice(11, 16)} UTC` : '';
    this.changed(task, `${this.describe(task, ticket)} failed (${why}); retrying ${where}${when} as ${retry.id}.`);
  }

  // ---------- step transitions ----------

  post(step, entry) {
    const f = step.forum;
    f.posts.push({ round: f.round, at: now(), ...entry, text: clip(entry.text, 12000) });
  }

  // A step's work is in: verification records its evidence; otherwise the review opens, or the step is done.
  recordStepOutput(task, step, text, checked) {
    // A revision identical to the version the reviewers just rejected would only repeat the review.
    const same = (a) => String(a ?? '').replace(/\s+/g, ' ').trim();
    if (step.forum.round > 0 && step.version > 0 && step.reviewers.length && same(text) === same(step.output)) {
      this.escalate(task, step.id, `The engineer submitted the same ${KIND_LABELS[step.kind].toLowerCase()} after the reviewers asked for changes, so another review round would repeat itself.`);
      return;
    }
    if (task.ship && step.kind === 'execute') {
      const pr = parsePr(text);
      if (pr && (!task.ship.pr || task.ship.pr.url !== pr.url)) {
        task.ship.pr = { ...pr, openedAt: now() };
        task.ship.noPr = null;
      }
      if (pr && task.ship.phase === 'publish') task.ship.phase = 'watch';
      if (step.ship === 'draft' && checked.noPr) task.ship.noPr = clip(checked.noPr, 300);
    }
    step.version += 1;
    if (checked.ev && step.kind !== 'verify') {
      step.evidence = { attempt: step.evidenceAttempt, summary: clip(checked.ev.summary, 4000), items: checked.ev.items, dir: checked.ev.dir, at: now() };
    }
    step.output = clip(text, 20000);
    step.submittedAt = now();
    if (task.lead) delete task.lead.phase;
    if (step.kind === 'verify') {
      const result = parseResult(text);
      const ev = checked.ev;
      step.verification = { attempt: step.evidenceAttempt, result, summary: clip(ev.summary || text, 4000), items: ev.items, dir: ev.dir, at: now() };
      if (result === 'fail') {
        step.status = 'done';
        task.feedback.push({ from: 'verification', at: now(), text: clip(text, 6000) });
        for (const s of task.steps) if (s.status === 'pending') s.status = 'skipped';
        task.stage = 'routing';
        task.routingSince = now();
        this.changed(task, `${stepLabel(step)} FAILED; the engineer decides what to redo.`);
        return;
      }
    }
    if (!step.reviewers.length) {
      step.status = 'done';
      this.changed(task, `${stepLabel(step)} done (v${step.version}).`);
      this.advance(task);
      return;
    }
    this.openRound(task, step, text);
  }

  openRound(task, step, text) {
    const f = step.forum;
    f.round += 1;
    const response = /^#+\s*response to (the )?(forum|review(ers)?)\b[\s\S]*$/im.exec(text)?.[0];
    this.post(step, { author: 'Engineer', role: 'author', kind: 'author', verdict: null, text: response ?? `Submitted ${KIND_LABELS[step.kind].toLowerCase()} v${step.version}.` });
    step.status = 'reviewing';
    task.stage = 'reviewing';
    for (const r of step.reviewers) this.issue(task, { specialty: r.name, step: step.id, round: f.round });
    this.changed(task, `${stepLabel(step)} v${step.version} is in; review round ${f.round - f.windowStart} opened.`);
  }

  recordReview(task, step, ticket, text, verdict) {
    const f = step.forum;
    this.post(step, { author: memberTitle(ticket), role: ticket.specialty, kind: 'review', verdict, text, round: ticket.round });
    this.changed(task, `${ticket.specialty} reviewer voted ${verdict === 'approve' ? 'APPROVE' : 'CHANGES'} on ${step.id} (round ${ticket.round - f.windowStart}).`);
    if (ticket.round !== f.round || step.status !== 'reviewing') return;
    const votes = new Map();
    for (const p of f.posts) if (p.kind === 'review' && p.round === f.round) votes.set(p.role, p.verdict);
    if (!step.reviewers.every((r) => votes.has(r.name))) return;
    this.closeRound(task, step, step.reviewers.every((r) => votes.get(r.name) === 'approve'));
  }

  closeRound(task, step, unanimous) {
    const f = step.forum;
    const n = f.round - f.windowStart;
    if (unanimous) {
      this.post(step, { author: 'Grove', role: 'system', kind: 'system', verdict: 'approve', text: `Unanimous approval in round ${n}.` });
      step.status = 'done';
      this.changed(task, `${stepLabel(step)} approved unanimously.`);
      this.advance(task);
      return;
    }
    if (f.round >= MAX_STEP_ROUNDS) {
      this.escalate(task, step.id, `No unanimous agreement after ${f.round} review rounds on this step (the most Grove runs without you).`);
      return;
    }
    if (n >= MAX_ROUNDS) {
      this.escalate(task, step.id, `No unanimous agreement after ${MAX_ROUNDS} rounds.`);
      return;
    }
    this.post(step, { author: 'Grove', role: 'system', kind: 'system', verdict: 'changes', text: `Round ${n} closed without unanimity; the engineer revises and round ${n + 1} follows.` });
    this.startStep(task, step);
    this.changed(task, `${stepLabel(step)}: review round ${n} requested changes.`);
  }

  escalate(task, stepId, reason) {
    cancelOpenTickets(task);
    task.stage = 'escalated';
    task.escalation = { step: stepId, reason, at: now() };
    const step = task.steps.find((s) => s.id === stepId);
    if (step) this.post(step, { author: 'Grove', role: 'system', kind: 'system', verdict: null, text: `Escalated to the human: ${reason}` });
    this.changed(task, `Escalated: ${reason}`);
  }

  // ---------- human decisions ----------

  // Why a decision can't apply to the task as it stands, or null. The Chief checks before recording one.
  decisionError(task, action, note = '', { ship } = {}) {
    if (task.stage === 'shelved') {
      if (action === 'unshelve' || action === 'cancel') return null;
      if (action === 'shelve') return `${task.id} is already on the shelf.`;
      if (!SHELF_PASSTHROUGH.has(action)) return `${task.id} is on the shelf; "${action}" doesn't apply. Record "unshelve" to put it back in the human's inbox.`;
      return this.decisionError(shelfView(task), action, note, { ship });
    }
    const msg = String(note ?? '').trim();
    const st = task.stage;
    const label = stageLabel(task);
    if (!DECISIONS.includes(action)) return `decision must be one of ${DECISIONS.join(', ')}.`;
    if (action === 'shelve') return SHELVABLE.has(st) ? null : `${task.id} is "${label}"; only a task waiting on the human can be shelved.`;
    if (action === 'unshelve') return `${task.id} isn't on the shelf.`;
    if (st === 'cancelled') return `${task.id} is cancelled.`;
    if (st === 'done' && action !== 'changes') return `${task.id} is done. To reopen it, record "changes" with what the human wants.`;
    if (ship !== undefined && action !== 'approve') return 'ship only applies to "approve".';
    switch (action) {
      case 'cancel': return null;
      case 'approve': return ['awaiting-approval', 'escalated', 'ready-to-merge'].includes(st) ? null : `${task.id} is "${label}"; there is nothing to approve. Use "note" to pass on what they said.`;
      case 'changes':
        if (!msg) return 'Pass the human\'s words as note: what they want changed or added.';
        return ['awaiting-approval', 'escalated', 'watching', 'ready-to-merge', 'done'].includes(st) ? null : `${task.id} is "${label}"; the engineer is working. Use "note" to pass on what they want.`;
      case 'note': case 'question':
        if (!msg) return `Pass the human's words as note.`;
        return null;
      case 'hold': return HOLDABLE.has(st) || st === 'blocked' ? null : `${task.id} is "${label}"; only a task in progress can be put on hold.`;
      case 'resume': return PAUSED_STAGES.has(st) ? null : `${task.id} is "${label}"; it isn't on hold or blocked.`;
      case 'retry': return st === 'blocked' ? null : `${task.id} is "${label}"; it isn't blocked.`;
      case 'merge': return ['ready-to-merge', 'watching'].includes(st) && task.ship?.pr ? null : `${task.id} has no open pull request to merge (it is "${label}").`;
      default: return null;
    }
  }

  humanDecision({ taskId, action, note = '', ship }) {
    const task = this.task(taskId);
    const msg = clip(note, 4000);
    const err = this.decisionError(task, action, msg, { ship });
    if (err) throw new ProcessError('invalid_state', err);
    if (action === 'cancel') {
      task.shelf = null;
      return this.cancelTask(taskId, msg || 'Cancelled by you.');
    }
    if (action === 'shelve') {
      task.shelf = { from: task.stage, at: now(), note: msg };
      task.stage = 'shelved';
      this.changed(task, `You put the task on the shelf${msg ? `: ${clip(msg, 200)}` : ''}. It waits there until you bring it back.`);
      return task;
    }
    if (action === 'unshelve') {
      this.unshelve(task, `You took the task off the shelf${msg ? `: ${clip(msg, 200)}` : ''}.`);
      return task;
    }
    // Answering a shelved task takes it off the shelf first, then applies the answer as usual.
    if (task.stage === 'shelved') this.unshelve(task, null);
    if (action === 'question') {
      const q = { seq: task.questions.length + 1, at: now(), text: msg, answer: null, answeredAt: null };
      task.questions.push(q);
      this.changed(task, `You asked: ${clip(msg, 200)}`);
      return task;
    }
    if (action === 'hold') {
      if (task.stage === 'blocked') task.pause.kind = 'hold';
      else this.pause(task, 'hold', { note: msg });
      task.stage = 'on-hold';
      this.changed(task, `You put the task on hold${msg ? `: ${clip(msg, 200)}` : ''}. Everyone stops until you resume it.`);
      return task;
    }
    if (action === 'resume' || action === 'retry') {
      if (msg) task.feedback.push({ from: 'human', at: now(), text: msg });
      this.unpause(task, action === 'retry' ? `You unblocked the task${msg ? `: ${clip(msg, 200)}` : ''}.` : `You resumed the task${msg ? `: ${clip(msg, 200)}` : ''}.`);
      return task;
    }
    if (action === 'merge' || (action === 'approve' && task.stage === 'ready-to-merge')) {
      if (msg) task.feedback.push({ from: 'human', at: now(), text: msg });
      task.ship.phase = 'merge';
      for (const st of task.steps) if (st.status === 'pending') st.status = 'skipped';
      task.steps.push(newStep(task, { kind: 'execute', title: `Merge PR #${task.ship.pr.number}`, brief: `${SHIP_BRIEFS.merge}\n\nPull request: ${task.ship.pr.url}`, ship: 'merge' }));
      this.changed(task, `You asked to merge ${prLine(task.ship.pr)}.`);
      this.advance(task);
      return task;
    }
    if (action === 'changes' && (task.stage === 'done' || SHIPPING_STAGES.has(task.stage))) {
      const reopened = task.stage === 'done';
      task.feedback.push({ from: 'human', at: now(), text: msg });
      if (reopened) {
        task.delivery = null;
        if (task.ship?.phase === 'merged') task.ship = null;
      }
      if (task.ship) task.ship.attention = { at: now(), sig: `human-${now()}`, problems: [`The human asked for changes: "${clip(msg, 600)}"`] };
      task.stage = 'routing';
      task.routingSince = now();
      this.changed(task, `${reopened ? 'You reopened the task' : 'You asked for changes to the PR'}: ${clip(msg, 200)}`);
      return task;
    }
    // A note passes the human's words to the engineer without changing the stage.
    if (action === 'note') {
      if (TERMINAL.has(task.stage)) throw new ProcessError('invalid_state', `${task.id} is already ${task.stage}.`);
      if (!msg) throw new ProcessError('invalid_input', 'A note needs the human\'s words.');
      task.feedback.push({ from: 'human', at: now(), text: msg });
      this.changed(task, `You added a note: ${clip(msg, 200)}`);
      return task;
    }
    if (task.stage === 'awaiting-approval') {
      if (action === 'approve') {
        const said = msg ? `: ${clip(msg, 200).replace(/[.!?\s]+$/, '')}` : '';
        // An approved code change ships: the engineer publishes the PR and Grove watches it through to merge.
        if (task.delivery?.ship && ship !== false && !(task.ship?.phase === 'draft' && !task.ship.pr)) {
          if (msg) task.feedback.push({ from: 'human', at: now(), text: msg });
          const draft = task.ship?.pr;
          task.ship = { ...(task.ship ?? {}), phase: 'publish', startedAt: task.ship?.startedAt ?? now(), pr: draft ?? null, attention: null };
          task.steps.push(draft
            ? newStep(task, { kind: 'execute', title: `Publish: mark PR #${draft.number} ready for review`, brief: `${SHIP_BRIEFS.ready}\n\nPull request: ${draft.url}`, ship: 'publish' })
            : newStep(task, { kind: 'execute', title: 'Publish: open the pull request', brief: SHIP_BRIEFS.publish, ship: 'publish' }));
          this.changed(task, `You approved the change${said}. ${draft ? `The engineer marks PR #${draft.number} ready for review next.` : 'The engineer opens a pull request next.'}`);
          this.advance(task);
          return task;
        }
        task.stage = 'done';
        this.changed(task, `You signed off${said}. Task done.`);
        return task;
      }
      if (action === 'changes') {
        if (!msg) throw new ProcessError('invalid_input', 'Say what you want changed or added.');
        task.feedback.push({ from: 'human', at: now(), text: msg });
        task.delivery = null;
        task.stage = 'routing';
        task.routingSince = now();
        this.changed(task, `You asked for more: ${clip(msg, 200)}`);
        return task;
      }
    }
    if (task.stage === 'escalated') {
      const step = task.steps.find((s) => s.id === task.escalation?.step);
      if (action === 'approve') {
        task.escalation = null;
        if (step) {
          this.post(step, { author: 'You', role: 'human', kind: 'human', verdict: 'approve', text: msg || 'Accepted despite the open objections.' });
          step.status = 'done';
        }
        this.changed(task, `You accepted ${step ? step.id : 'the step'} and resolved the escalation.`);
        this.advance(task);
        return task;
      }
      if (action === 'changes') {
        if (!msg) throw new ProcessError('invalid_input', 'Give direction for the revision.');
        task.escalation = null;
        task.feedback.push({ from: 'human', at: now(), text: msg });
        if (!step) {
          task.stage = 'routing';
          task.routingSince = now();
          this.changed(task, 'You sent the task back to its engineer.');
          return task;
        }
        this.post(step, { author: 'You', role: 'human', kind: 'human', verdict: 'changes', text: msg });
        step.forum.windowStart = step.forum.round;
        this.startStep(task, step);
        this.changed(task, `You sent ${step.id} back for revision.`);
        return task;
      }
    }
    throw new ProcessError('invalid_state', `${task.id} is "${stageLabel(task)}"; "${action}" does not apply.`);
  }

  // ---------- pause, block, shelf, updates, answers ----------

  // Back where it was when it was shelved.
  unshelve(task, line) {
    task.stage = task.shelf?.from ?? 'awaiting-approval';
    task.shelf = null;
    this.changed(task, line);
  }

  // Everyone stops: open hires are cancelled (reviewers' chats keep their transcripts) and nothing new starts
  // until the human resumes the task through the Chief of Staff.
  pause(task, kind, info = {}) {
    const step = currentStep(task);
    task.pause = { kind, at: now(), from: task.stage, step: step?.id ?? null, stepStatus: step?.status ?? null, ...info };
    cancelOpenTickets(task);
    task.stage = kind === 'hold' ? 'on-hold' : 'blocked';
  }

  // Pick up where the task stopped: the engineer carries on with its step, or the missing reviewers get their
  // work again in the same chats; a shipping task goes back to watching its PR.
  unpause(task, line) {
    const p = task.pause ?? {};
    task.pause = null;
    const step = p.step ? task.steps.find((s) => s.id === p.step) : null;
    if (step?.status === 'working') {
      task.stage = 'working';
    } else if (step?.status === 'reviewing') {
      const f = step.forum;
      const voted = new Set(f.posts.filter((x) => x.kind === 'review' && x.round === f.round).map((x) => x.role));
      task.stage = 'reviewing';
      for (const r of step.reviewers) if (!voted.has(r.name)) this.issue(task, { specialty: r.name, step: step.id, round: f.round });
    } else if (task.ship?.pr && SHIP_ACTIVE.has(task.ship.phase) && SHIPPING_STAGES.has(p.from)) {
      task.stage = 'watching';
    } else {
      task.stage = 'routing';
      task.routingSince = now();
    }
    this.changed(task, line);
  }

  // A reviewer can't go on without the human (credentials, access, a decision only they can make).
  blockOn(task, ticket, need, text) {
    ticket.status = 'blocked';
    ticket.endedAt = now();
    ticket.blocked = clip(need, 600);
    this.pause(task, 'blocked', { need: clip(need, 600), detail: clip(text, 4000), by: memberTitle(ticket), ticket: ticket.id });
    this.changed(task, `${this.describe(task, ticket)} is blocked: ${clip(need, 200)}`);
  }

  // The engineer reports a blocker only the human can clear.
  block(taskId, { need, reason = '' }) {
    const t = this.task(taskId);
    if (!HOLDABLE.has(t.stage)) throw new ProcessError('invalid_state', `${taskId} is "${stageLabel(t)}"; only a task in progress can be blocked.`);
    const n = clip(need, 600);
    if (n.length < 8) throw new ProcessError('invalid_input', 'Say exactly what the human must do, for example "Run az login --tenant <id>, then tell the Chief of Staff".');
    this.pause(t, 'blocked', { need: n, detail: clip(reason, 4000), by: 'Engineer' });
    this.changed(t, `Blocked: ${clip(n, 200)}`);
    return t;
  }

  // The engineer's status board: progress the human can read in the grove, the task view and the report.
  postUpdate(taskId, text) {
    const t = this.task(taskId);
    const msg = clip(text, 1500);
    if (!msg) throw new ProcessError('invalid_input', 'Write the update.');
    t.updates.push({ at: now(), text: msg });
    if (t.updates.length > 100) t.updates.splice(0, t.updates.length - 100);
    this.changed(t, `Update: ${clip(msg, 160)}`);
    return t;
  }

  answer(taskId, text) {
    const t = this.task(taskId);
    const q = t.questions.find((x) => !x.answer);
    if (!q) throw new ProcessError('invalid_state', `${taskId} has no open question from the human. Post progress with grove_update instead.`);
    const msg = clip(text, 6000);
    if (msg.length < 2) throw new ProcessError('invalid_input', 'Write the answer.');
    q.answer = msg;
    q.answeredAt = now();
    this.changed(t, `Answered: ${clip(q.text, 120)}`);
    return { task: t, question: q };
  }

  openQuestion(task) {
    return task.questions.find((x) => !x.answer) ?? null;
  }

  // ---------- shipping ----------

  // Apply what GitHub says about the task's PR (the engineer's Grove polls it while watching). Returns true when
  // the task changed.
  applyPrStatus(task, status) {
    // A shelved PR is still watched: it stays shelved while it's fine, and comes back to the engineer (and so
    // eventually to the human) if it needs work.
    const shelved = task.stage === 'shelved';
    const stage = shelved ? task.shelf?.from : task.stage;
    if (!task.ship?.pr || !SHIPPING_STAGES.has(stage)) return false;
    const setStage = (st) => { if (shelved) task.shelf.from = st; else task.stage = st; };
    const offShelf = () => { if (shelved) task.shelf = null; };
    const pr = task.ship.pr;
    const sum = prSummary(status);
    const before = JSON.stringify([pr.state, pr.draft, pr.mergeable, pr.mergeState, pr.review, pr.head, pr.checks, pr.error]);
    Object.assign(pr, sum, { checkedAt: now(), error: null });
    if (status?.url && PR_URL.test(status.url)) pr.url = status.url;
    const moved = before !== JSON.stringify([pr.state, pr.draft, pr.mergeable, pr.mergeState, pr.review, pr.head, pr.checks, pr.error]);
    if (pr.state === 'MERGED') {
      task.ship.phase = 'merged';
      task.ship.mergedAt = now();
      offShelf();
      task.stage = 'done';
      this.changed(task, `PR #${pr.number} merged. Task done.`);
      return true;
    }
    if (pr.state === 'CLOSED') {
      offShelf();
      this.escalate(task, null, `PR #${pr.number} was closed without being merged.`);
      return true;
    }
    const problems = [];
    if (pr.checks.failed.length) problems.push(`Checks failing: ${pr.checks.failed.map((c) => `${c.name}${c.url ? ` (${c.url})` : ''}`).join(', ')}`);
    if (pr.review === 'CHANGES_REQUESTED') problems.push('A reviewer requested changes; read the review comments on the PR');
    if (pr.mergeable === 'CONFLICTING') problems.push('The branch has merge conflicts with its base');
    if (problems.length) {
      // The same problems on the same commit are raised once, even if the engineer decided nothing needs changing.
      const sig = `${pr.head}|${problems.join('|')}`;
      if (task.ship.raised === sig) {
        if (moved) this.changed(task, null);
        return moved;
      }
      task.ship.raised = sig;
      task.ship.attention = { at: now(), sig, problems };
      task.feedback.push({ from: 'github', at: now(), text: `PR ${pr.url} needs work:\n- ${problems.join('\n- ')}` });
      offShelf();
      task.stage = 'routing';
      task.routingSince = now();
      this.changed(task, `PR #${pr.number} needs work${shelved ? ', so it came off the shelf' : ''}: ${clip(problems.join('; '), 300)}`);
      return true;
    }
    task.ship.raised = null;
    const ready = !pr.draft && pr.checks.pending === 0 && pr.mergeable === 'MERGEABLE'
      && (pr.review === 'APPROVED' || (!pr.review && pr.mergeState === 'CLEAN'))
      && !['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT', 'UNKNOWN'].includes(pr.mergeState);
    if (ready && stage === 'watching') {
      setStage('ready-to-merge');
      task.ship.readyAt = now();
      this.changed(task, `${prLine(pr)} is ready to merge.`);
      return true;
    }
    if (!ready && stage === 'ready-to-merge') {
      setStage('watching');
      this.changed(task, `${prLine(pr)} is no longer ready to merge; watching again.`);
      return true;
    }
    if (moved) this.changed(task, null);
    return moved;
  }

  // A draft PR waiting on the human's sign-off: record its checks for the report, without moving the task.
  observePr(task, status) {
    if (!task.ship?.pr || task.ship.phase !== 'draft' || ['awaiting-approval', 'shelved'].indexOf(task.stage) < 0) return false;
    const pr = task.ship.pr;
    const before = JSON.stringify([pr.state, pr.draft, pr.checks, pr.review, pr.mergeable]);
    Object.assign(pr, prSummary(status), { checkedAt: now(), error: null });
    if (before === JSON.stringify([pr.state, pr.draft, pr.checks, pr.review, pr.mergeable])) return false;
    this.changed(task, null);
    return true;
  }

  // Every piece of visual evidence the human should see: the latest verification, then evidence from other
  // steps, newest first. Steps that were redone are left out (their redo replaces them).
  evidenceGroups(task) {
    const done = task.steps.filter((s) => s.status === 'done');
    const redone = new Set(done.map((s) => s.redoOf).filter(Boolean));
    const groups = [];
    for (const s of [...done].reverse()) {
      if (redone.has(s.id)) continue;
      const ev = s.kind === 'verify' ? s.verification : s.evidence;
      if (!ev?.items?.length) continue;
      if (s.kind === 'verify' && groups.some((g) => g.kind === 'verify')) continue;
      groups.push({ step: s.id, label: stepLabel(s), kind: s.kind, result: s.kind === 'verify' ? ev.result : null, summary: ev.summary ?? '', dir: ev.dir, items: ev.items });
    }
    return groups.sort((a, b) => (a.kind === 'verify' ? 0 : 1) - (b.kind === 'verify' ? 0 : 1));
  }

  // The PR couldn't be read (gh missing, not signed in, network). Shown on the engineer until it works again.
  prError(task, message) {
    if (!task.ship?.pr) return;
    const msg = clip(message, 240);
    if (task.ship.pr.error === msg) return;
    task.ship.pr.error = msg;
    this.changed(task, `Can't read PR #${task.ship.pr.number}: ${msg}`);
  }

  // ---------- presentation ----------

  describe(task, ticket) {
    const step = task?.steps?.find((s) => s.id === ticket.step);
    return `${ticket.specialty} reviewer${step ? ` on ${step.id}` : ''}`;
  }

  // Tickets waiting to be delivered, optionally only those a given dispatcher delivers.
  issuedTickets(tasks = this.activeTasks(), dispatcher = null) {
    const out = [];
    for (const t of tasks) {
      if (TERMINAL.has(t.stage)) continue;
      if (PAUSED_STAGES.has(t.stage)) continue;
      for (const k of t.tickets) if (k.status === 'issued' && !(k.retryAt > now()) && (!dispatcher || (k.dispatcher ?? LEAD) === dispatcher)) out.push({ task: t, ticket: k });
    }
    return out;
  }

  snapshot() {
    return this.state;
  }
}

// Fill in fields a task written by an earlier 0.x of this board format may lack.
function normalizeTask(t, boardId) {
  t.kind ??= 'code';
  // Names follow from the board and task number, so tasks made before names existed get the same one everywhere.
  if (!t.name && /^T\d+$/.test(t.id)) t.name = taskName(boardId, Number(t.id.slice(1)));
  t.members ??= {};
  t.updates ??= [];
  t.questions ??= [];
  t.pause ??= null;
  t.ship ??= null;
  t.shelf ??= null;
  t.steps ??= [];
  for (const k of t.tickets) {
    k.dispatcher ??= LEAD;
    k.member ??= memberKey(k);
  }
  // Ticket ids end in the task's sequence number; never reuse one.
  t.seq = Math.max(t.seq ?? 0, ...t.tickets.map((k) => Number(/-(\d+)$/.exec(k.id)?.[1] ?? 0)));
  return t;
}

// The task as it was before it was shelved, for checking a decision against.
function shelfView(task) {
  return { ...task, stage: task.shelf?.from ?? 'awaiting-approval', shelf: null };
}

function newStep(task, s) {
  return {
    id: `S${++task.stepSeq}`, kind: s.kind, title: s.title, brief: s.brief ?? '', reviewers: s.reviewers ?? [], redoOf: s.redoOf ?? null,
    ...(s.ship ? { ship: s.ship } : {}),
    status: 'pending', version: 0, output: '', forum: { round: 0, windowStart: 0, posts: [] }, verification: null,
  };
}

// The host refuses messages when a session sends too many; the chat itself is fine.
function rateLimited(error) {
  return /allowed in the last|rate[ -]?limit|too many (messages|requests)/i.test(String(error ?? ''));
}

// Only these mean the reviewer's chat is gone and a new one is needed.
function chatGone(error) {
  return /unknown chat|no such (chat|session)|not found|no longer exists|was deleted|has been closed/i.test(String(error ?? ''));
}

// A session error as reported in a reviewer's heartbeat: { message, at, count }, or null.
export function sessionErrorOf(e) {
  if (!e || typeof e !== 'object' || typeof e.message !== 'string' || !e.message.trim()) return null;
  return { message: clip(e.message, 240), at: Number.isFinite(e.at) ? e.at : now(), count: Number.isInteger(e.count) && e.count > 0 ? Math.min(e.count, 9999) : 1 };
}

// Stop every hire that hasn't finished; late reports for them are ignored.
function cancelOpenTickets(task) {
  for (const k of task.tickets) {
    if (k.status === 'issued' || k.status === 'dispatched' || k.status === 'running') {
      k.status = 'cancelled';
      k.endedAt = now();
    }
  }
}

// Two agent-host links name the same chat when their session and chat ids match.
function sameChat(a, b) {
  const norm = (x) => String(x ?? '').trim().replace(/\/+$/, '');
  return norm(a) === norm(b);
}
