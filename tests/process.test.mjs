// Run: node tests/process.test.mjs
// Simulates the Chief of Staff, each task's engineer and its reviewer sessions. Each session gets its own
// GroveProcess (as each chat runs its own extension process); they share one board on disk. Sessions talk
// the way the host lets them: create_session and send_message, routed here by session link.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const tmp = path.join(os.tmpdir(), `grove-process-test-${process.pid}`);
await fs.rm(tmp, { recursive: true, force: true });
await fs.mkdir(tmp, { recursive: true });
const tmpReal = await fs.realpath(tmp); // members open the board through its canonical path
process.env.COPILOT_HOME = path.join(tmp, 'home');
const { GroveProcess } = await import('../extensions/grove-agent-monitor/lib/process/integration.mjs');

const all = [];
// What \`gh pr view\` returns in these tests.
let ghState = null;
// The host: every chat has a link; send_message reaches the chat behind it (with its history).
const links = new Map();
const groupOf = (s) => s.link.split('?')[0];

// A fake session: event listeners plus a record of what Grove posted into it with session.send (the
// fallback path; visible hand-offs go through send_message instead). Fallback wakes are off by default.
async function startSession(id, { link, workingDirectory = path.join(tmp, id, 'cwd'), graceMs = 10 * 60 * 1000 } = {}) {
  const listeners = [];
  const sent = [];
  await fs.mkdir(workingDirectory, { recursive: true });
  const session = { sessionId: id, workingDirectory, workspacePath: path.join(tmp, id), on: (fn) => listeners.push(fn), send: async (m) => { sent.push(typeof m === 'string' ? m : m.prompt); return `m${sent.length}`; } };
  const proc = new GroveProcess({ log: () => {}, onChange: () => {}, pollMs: 0, graceMs, prPollMs: 0, prStatus: async () => { if (ghState instanceof Error) throw ghState; return ghState; } });
  const tools = Object.fromEntries(proc.tools().map((t) => [t.name, t]));
  const hooks = proc.hooks();
  await proc.attach(session);
  const call = async (name, args = {}) => {
    const r = await tools[name].handler(args);
    return { ok: r.resultType === 'success', data: r.resultType === 'success' ? JSON.parse(r.textResultForLlm) : r.textResultForLlm };
  };
  const emit = (ev) => listeners.forEach((fn) => fn(ev));
  const s = { id, proc, tools, hooks, call, emit, sent, session, link: link ?? `agent-host-session://ahp-session/G-${id}` };
  links.set(s.link, s);
  all.push(s);
  return s;
}
const settle = async (...s) => { for (const x of s) await x.proc.board?.flush(); };
const sync = async (...s) => { await settle(...s); for (const x of s) await x.proc.poll(); };

let tc = 0;
let nchat = 0;
const models = new Map(); // member chat title → model Grove started it on

// `from` calls send_message: the hook may refuse it; otherwise the target chat gets the message.
// Matches the host's order: tool.execution_start, then the preToolUse hook, then completion.
async function send(from, session, message) {
  const args = { session, message };
  const toolCallId = `tc${++tc}`;
  from.emit({ type: 'tool.execution_start', data: { toolCallId, toolName: 'send_message', arguments: args } });
  const pre = await from.hooks.onPreToolUse({ toolName: 'send_message', toolArgs: args, sessionId: from.id });
  if (pre?.permissionDecision === 'deny') {
    from.emit({ type: 'tool.execution_complete', data: { toolCallId, success: false, error: { message: `Denied by preToolUse hook: ${pre.permissionDecisionReason}`, code: 'denied' } } });
    return { denied: pre.permissionDecisionReason };
  }
  assert.equal(pre, undefined, 'send_message passes through unchanged');
  const target = links.get(session);
  assert.ok(target, `send_message targets a known chat (${session})`);
  from.emit({ type: 'tool.execution_complete', data: { toolCallId, success: true, result: { content: `{"action":"started","openLink":"${groupOf(target)}"}` } } });
  const up = await target.hooks.onUserPromptSubmitted({ prompt: message, sessionId: target.id });
  return { target, brief: up?.modifiedPrompt ?? '', context: up?.additionalContext ?? '' };
}

// The engineer makes one reviewer hire from grove_submit / grove_next. Returns the reviewer session and the
// brief Grove expanded the marker into.
async function dispatch(from, h, { fail = false } = {}) {
  if (h.tool === 'send_message') {
    const r = await send(from, h.session, h.message);
    if (r.denied) return r;
    return { member: r.target, link: h.session, brief: r.brief, context: r.context };
  }
  // A careless caller drops the model and adds a workspace; Grove fixes both.
  const args = { title: h.title, prompt: h.prompt, relationship: h.relationship, workspace: '/elsewhere', model: 'claude-haiku-5.5' };
  const toolCallId = `tc${++tc}`;
  from.emit({ type: 'tool.execution_start', data: { toolCallId, toolName: 'create_session', arguments: args } });
  const pre = await from.hooks.onPreToolUse({ toolName: 'create_session', toolArgs: args, sessionId: from.id });
  if (pre?.permissionDecision === 'deny') {
    from.emit({ type: 'tool.execution_complete', data: { toolCallId, success: false, error: { message: `Denied by preToolUse hook: ${pre.permissionDecisionReason}`, code: 'denied' } } });
    return { denied: pre.permissionDecisionReason };
  }
  // Reviewers are always nested chats in the engineer's session; Grove strips any other placement.
  assert.ok(h.model, `every new member has a model: ${h.title}`);
  assert.deepEqual(pre?.modifiedArgs, { title: h.title, prompt: h.prompt, relationship: 'currentSession', model: h.model });
  models.set(h.title, h.model);
  if (fail) {
    from.emit({ type: 'tool.execution_complete', data: { toolCallId, success: false, error: { message: 'host refused' } } });
    return { failed: true };
  }
  const link = `${groupOf(from)}?chat=member-${++nchat}`;
  const member = await startSession(`member-${nchat}`, { link, workingDirectory: from.session.workingDirectory });
  from.emit({ type: 'tool.execution_complete', data: { toolCallId, success: true, result: { content: `Chat created in the current session (${link}).` } } });
  const up = await member.hooks.onUserPromptSubmitted({ prompt: args.prompt, sessionId: member.id });
  return { member, link, brief: up?.modifiedPrompt ?? '', context: up?.additionalContext ?? '' };
}

// The reviewer works its turn(s): each reply is checked when the turn ends; a block sends it back. Once its
// review is recorded, Grove has it report to the engineer with send_message, which starts the engineer's turn.
async function work(m, respond) {
  let blocks = 0;
  let last;
  let report = null;
  for (let turn = 0; turn < 6; turn++) {
    m.member.emit({ type: 'assistant.turn_start' });
    m.member.emit({ type: 'assistant.message', data: { content: await respond(m.brief, turn) } });
    const stop = await m.member.hooks.onAgentStop({ sessionId: m.member.id });
    if (stop?.decision === 'block' && /your work is recorded/.test(stop.reason)) {
      const session = /session "([^"]+)"/.exec(stop.reason)[1];
      const message = /message exactly:\n([\s\S]*?)\nThen end your turn/.exec(stop.reason)[1];
      report = await send(m.member, session, message);
      m.member.emit({ type: 'assistant.message', data: { content: 'Reported.' } });
      assert.equal(await m.member.hooks.onAgentStop({ sessionId: m.member.id }), undefined, 'reported; the member may stop');
      break;
    }
    if (stop?.decision === 'block') { blocks++; last = stop.reason; continue; }
    break;
  }
  m.member.emit({ type: 'session.idle', data: {} });
  return { blocks, last, report };
}

// The engineer delivers the hire and the reviewer works it.
async function hire(from, h, respond) {
  const m = await dispatch(from, h);
  assert.ok(!m.denied, m.denied);
  const r = await work(m, respond);
  return { ...m, ...r };
}


const PLAN = '# Plan\n' + 'Step details. '.repeat(30);
const IMPL = 'Changed src/app.ts to add the feature; tests pass. '.repeat(3);
const vote = (v) => async () => `Findings...\nVERDICT: ${v}`;
// The engineer's own turn: Grove sees what it says and does through session events.
const turn = (s, content = 'Working on it.') => {
  s.emit({ type: 'assistant.turn_start' });
  s.emit({ type: 'assistant.message', data: { content } });
};
const loadSkill = (s, name) => s.emit({ type: 'skill.invoked', data: { name, path: `/plugin/skills/${name}/SKILL.md`, content: '…', trigger: 'agent-invoked', pluginName: 'grove-agent-monitor' } });
const sprite = (s, id) => s.proc.liveView().agents.find((a) => a.id === id);
// The Chief started an engineer: the host returns the new session's link, which Grove remembers.
let csn = 0;
function started(chief, eng, prompt) {
  const toolCallId = `chief-cs-${++csn}`;
  chief.emit({ type: 'tool.execution_start', data: { toolCallId, toolName: 'create_session', arguments: { title: 'x', prompt } } });
  chief.emit({ type: 'tool.execution_complete', data: { toolCallId, success: true, result: { content: `New session created (${eng.link}).` } } });
}
let res;
// An engineer asks the host which chat it is (get_current_session); Grove learns its own link from that.
let gcs = 0;
function whoAmI(s, openLink = s.link) {
  const toolCallId = `gcs-${++gcs}`;
  s.emit({ type: 'tool.execution_start', data: { toolCallId, toolName: 'get_current_session', arguments: {} } });
  s.emit({ type: 'tool.execution_complete', data: { toolCallId, success: true, result: { content: JSON.stringify({ openLink: `${openLink}?view=chat`, workingDirectory: s.session.workingDirectory }) } } });
}
let h;
let told;
let back;
let notice;

// 1. A plain session: hooks stay out of the way; engineer tools are refused. A task needs the Chief's link
//    and a kind.
const chief = await startSession('chief-1');
assert.equal(chief.proc.role, 'none');
assert.equal(await chief.hooks.onPreToolUse({ toolName: 'task', toolArgs: { agent_type: 'explore', prompt: 'x' } }), undefined, 'no role → passthrough');
assert.equal((await chief.call('grove_next')).ok, false);
assert.equal((await chief.call('grove_submit', { step: 'S1', output: 'x' })).ok, false);
res = await chief.call('grove_create_task', { title: 'Add dark mode', goal: 'Users want dark mode', kind: 'code' });
assert.match(res.data, /Pass chiefSession: call get_current_session/, 'the Chief must say where to reach it');
res = await chief.call('grove_create_task', { title: 'Add dark mode', goal: 'Users want dark mode', chiefSession: chief.link });
assert.match(res.data, /kind must be one of code, research, other/);
assert.equal(chief.proc.role, 'none');

// 2. The first task makes it the Chief. The hand-off starts an independent scratch engineer,
//    without copying the Chief's directory, on the model for a code change.
await chief.hooks.onUserPromptSubmitted({ prompt: 'Add dark mode', workingDirectory: chief.session.workingDirectory });
res = await chief.call('grove_create_task', { title: 'Add dark mode', goal: 'Users want dark mode', criteria: ['Toggle in settings', 'Persists'], kind: 'code', destination: { mode: 'scratch' }, chiefSession: chief.link });
assert.equal(res.ok, true, res.data);
assert.equal(res.data.task, 'T1');
// Each task gets a mystical name the human can use instead of its number.
assert.equal(res.data.name, 'Tansy');
assert.equal(chief.proc.role, 'chief');
const handoff1 = res.data.handoff.prompt;
assert.match(handoff1, /^\[grove-engineer:chief-1\/T1\/[a-f0-9]+\] Grove task Tansy \(T1\): Add dark mode\. Grove fills in your brief\.$/);
assert.equal(res.data.handoff.title, 'Tansy · Add dark mode', 'the engineer session is titled by name');
assert.match(res.data.guidance, /tell the human Tansy \(T1\) has started .*calling it by its name, Tansy/);
assert.equal(res.data.handoff.relationship, 'independent');
assert.equal(res.data.handoff.workspace, undefined);
assert.equal(res.data.handoff.worktree, undefined);
assert.equal(res.data.handoff.model, 'claude-opus-5.5', 'a code change runs on Opus');
assert.match(res.data.guidance, /Start the engineer now: call create_session/);
let placed = await chief.hooks.onPreToolUse({ toolName: 'create_session', toolArgs: { title: 'T1', prompt: handoff1, relationship: 'currentSession', model: 'claude-haiku-5.5' } });
assert.deepEqual(placed.modifiedArgs, { title: 'T1', prompt: handoff1, relationship: 'independent', model: 'claude-opus-5.5' }, 'Scratch engineer has its own independent session, never the Chief directory');
placed = await chief.hooks.onPreToolUse({ toolName: 'create_session', toolArgs: { title: 'x', prompt: handoff1, workspace: '/other/repo', worktree: true } });
assert.deepEqual(placed.modifiedArgs, { title: 'x', prompt: handoff1, relationship: 'independent', model: 'claude-opus-5.5' }, 'structured scratch routing strips accidental caller placement');
assert.equal(await chief.hooks.onPreToolUse({ toolName: 'create_session', toolArgs: { title: 'x', prompt: 'unrelated' } }), undefined, 'other sessions are untouched');
assert.equal((await chief.hooks.onPreToolUse({ toolName: 'task', toolArgs: { agent_type: 'explore', prompt: 'x' } })).permissionDecision, 'deny', 'the Chief never hires');
assert.equal((await chief.hooks.onPreToolUse({ toolName: 'ask_user', toolArgs: {} })).permissionDecision, 'deny', 'the Chief stays available');
for (const tool of ['bash', 'view', 'edit', 'skill', 'github-mcp-server-merge_pull_request']) {
  assert.match((await chief.hooks.onPreToolUse({ toolName: tool, toolArgs: {} })).permissionDecisionReason, /coordinates and never does the work itself/, `the Chief can't use ${tool}`);
}
for (const tool of ['grove_status', 'send_message', 'get_session_context', 'open_canvas', 'tool_search_tool', 'report_intent']) {
  assert.equal(await chief.hooks.onPreToolUse({ toolName: tool, toolArgs: {} }), undefined, `the Chief can use ${tool}`);
}
await fs.access(path.join(process.env.COPILOT_HOME, 'extension-data', 'grove-agent-monitor', 'boards', 'chief-1.json'));
// The human says "tell Tansy…": every tool takes the name as well as the id.
res = await chief.call('grove_status', { taskId: 'tansy' });
assert.deepEqual([res.data.tasks[0].id, res.data.tasks[0].name], ['T1', 'Tansy']);
res = await chief.call('grove_status', { taskId: 'Glimmer' });
assert.match(res.data, /No task "Glimmer"\. Open tasks: Tansy \(T1\)\./);
assert.equal(chief.proc.liveView().process.tasks[0].name, 'Tansy');

// 3. A new session started with the hand-off becomes T1's engineer: Grove expands the marker into its brief
//    (standing instructions, goal, criteria, the steps and their skills). The hand-off is single use.
const eng = await startSession('eng-1');
started(chief, eng, handoff1);
let up = await eng.hooks.onUserPromptSubmitted({ prompt: handoff1 });
assert.match(up.modifiedPrompt, /^\[grove-engineer:chief-1\/T1\/[a-f0-9]+\]\n# Grove engineer · Tansy \(T1\): Add dark mode\n\nThe human calls this task \*\*Tansy\*\*/);
assert.match(up.modifiedPrompt, /You are its \*\*engineer\*\*/);
assert.match(up.modifiedPrompt, /## How you work\n\n1\. \*\*Choose the steps\*\*/, 'the standing instructions from grove-engineer.agent.md');
assert.match(up.modifiedPrompt, /## Goal\nUsers want dark mode\n\n## Acceptance criteria\n1\. Toggle in settings\n2\. Persists/);
assert.match(up.modifiedPrompt, /\| execute \| `grove-execute` \| making a change/);
assert.match(up.modifiedPrompt, /`code-change`: Plan \(reviewed by security, tests, architecture\) → Execute \(reviewed by security, tests, code, architecture\) → Verify \(reviewed by tests\)/);
assert.match(up.additionalContext, /this chat is the engineer for Tansy \(T1\)/);
assert.equal(eng.proc.role, 'lead');
assert.equal(eng.proc.engine.task('T1').owner, 'eng-1');
const replay = await startSession('replay');
assert.match((await replay.hooks.onUserPromptSubmitted({ prompt: handoff1 })).additionalContext, /already used/);
assert.equal(replay.proc.role, 'none');
await sync(eng, chief);
assert.match((await chief.call('grove_status', { taskId: 'T1' })).data.tasks[0].engineer.status, /own session/);
assert.equal(chief.proc.board.meta.leadLinks.T1, eng.link, 'the Chief remembers the engineer\'s session');

// 4. The engineer does the work itself, with every tool. It only starts sessions for its reviewers' tickets,
//    and never asks the human directly or messages the Chief with updates.
for (const tool of ['edit', 'bash', 'view', 'skill', 'openBrowserPage']) assert.equal(await eng.hooks.onPreToolUse({ toolName: tool, toolArgs: {} }), undefined, `the engineer can use ${tool}`);
assert.equal(await eng.hooks.onPreToolUse({ toolName: 'task', toolArgs: { agent_type: 'explore', prompt: 'find the theme code' } }), undefined, 'subagents for side lookups are fine');
assert.match((await eng.hooks.onPreToolUse({ toolName: 'ask_user', toolArgs: {} })).permissionDecisionReason, /ordinary questions/);
assert.match((await eng.hooks.onPreToolUse({ toolName: 'create_session', toolArgs: { title: 'x', prompt: 'do it' } })).permissionDecisionReason, /the only sessions you start are your reviewers/);
assert.equal(await eng.hooks.onPreToolUse({ toolName: 'send_message', toolArgs: { session: 'x', message: 'hello' } }), undefined, 'plain messages are fine');
assert.match((await send(eng, chief.link, 'T1 update: planning.')).denied, /Post progress with grove_update/);

// 5. The engineer chooses the steps first; it can't stop before it has.
turn(eng);
let stop = await eng.hooks.onAgentStop({});
assert.equal(stop.decision, 'block');
assert.match(stop.reason, /no step in progress.*grove_plan_steps/);
res = await eng.call('grove_next');
assert.match(res.data.guidance, /Choose the steps for this task with grove_plan_steps/);
assert.match((await eng.call('grove_plan_steps', { steps: [{ kind: 'review' }] })).data, /kind must be one of plan, research, execute, verify/);
assert.match((await eng.call('grove_plan_steps', { steps: [{ kind: 'research', reviewers: ['ux'] }] })).data, /"ux" is not a built-in reviewer/);
assert.equal((await eng.call('grove_deliver', { summary: 'Nothing to report yet, sorry.' })).ok, false, 'nothing to deliver yet');

// 6. Plan: the engineer gets the assignment and works it in its own chat (its sprite at the planning table).
res = await eng.call('grove_plan_steps', { template: 'code-change' });
assert.deepEqual(res.data.hires, [], 'no session for the engineer\'s own work');
assert.match(res.data.guidance, /Work on S1 now, in this chat/);
assert.match(res.data.work, /^## Your step: S1 · Plan\nLoad the `grove-plan` skill now, even if you loaded it earlier/);
assert.match(res.data.work, /Call `grove_submit` with the step's output: the complete plan, in Markdown/);
assert.match(res.data.work, /Then the security, tests, architecture reviewers check it/);
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'planning');
assert.equal(sprite(eng, 'grove-engineer-T1').role, 'engineer');
assert.equal(sprite(eng, 'grove-engineer-T1').task, 'S1 · Plan');
assert.equal(sprite(eng, 'grove-engineer-T1').taskName, 'Tansy', 'sprites carry the task name for their tooltip');
assert.equal(sprite(eng, 'grove-engineer-T1').name, 'Engineer');
turn(eng);
stop = await eng.hooks.onAgentStop({});
assert.match(stop.reason, /you're on S1 \(Plan\) and haven't submitted it/, 'stopping mid-step is sent back');
loadSkill(eng, 'grove-plan');
assert.deepEqual(eng.proc.engine.task('T1').steps[0].skills, ['grove-plan']);
res = await eng.call('grove_submit', { step: 'S1', output: 'A short plan.' });
assert.equal(res.ok, false);
assert.match(res.data, /Submit the complete plan/, 'a submission is checked right away');
res = await eng.call('grove_submit', { step: 'S1', output: PLAN });
assert.equal(res.ok, true, res.data);
assert.equal(res.data.submitted, 'S1');
assert.equal(res.data.reminder, undefined, 'the skill was loaded');
assert.match(res.data.guidance, /make each reviewer hire/);
assert.deepEqual(res.data.hires.map((x) => [x.tool, x.title, x.relationship]), [
  ['create_session', 'Tansy · Security reviewer', 'currentSession'], ['create_session', 'Tansy · Tests reviewer', 'currentSession'], ['create_session', 'Tansy · Architecture reviewer', 'currentSession'],
]);
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'plan-review', 'the engineer joins its reviewers at the lectern');
assert.equal(sprite(eng, 'grove-engineer-T1').group, 'T1:S1');
const rev = {};
for (const x of res.data.hires) {
  const m = await dispatch(eng, x);
  rev[x.title.replace(/^Tansy · | reviewer$/g, '').toLowerCase()] = m;
  assert.match(m.brief, /^\[grove:T1-rev-[a-z]+-\d+\]\n# Grove review/);
  assert.match(m.brief, /## How Grove reviews work\n# Reviewing in a Grove forum/, 'every reviewer gets the grove-review skill');
  assert.match(m.brief, /## Under review: S1 · Plan \(v1\)\n# Plan\nStep details/);
  assert.match(m.brief, /VERDICT: APPROVE\nVERDICT: CHANGES/);
  assert.doesNotMatch(m.brief, /You reviewed an earlier version/);
}
assert.match(rev.security.brief, /You are the \*\*security reviewer\*\* in a Grove forum/, 'its persona from the agent file');
assert.equal(sprite(eng, 'grove-T1-reviewer-security').activity, 'plan-review');
assert.equal(sprite(eng, 'grove-T1-reviewer-security').group, 'T1:S1');
// Reviewers can't message the Chief or start sessions; they report to the engineer.
assert.match((await send(rev.security.member, chief.link, 'Chief, a question')).denied, /report to the task's engineer/);
assert.match((await rev.security.member.hooks.onPreToolUse({ toolName: 'create_session', toolArgs: { title: 'x', prompt: 'y' } })).permissionDecisionReason, /don't start other sessions/);
let r = await work(rev.security, vote('APPROVE'));
assert.equal(r.report.target, eng, 'the reviewer reports to the engineer\'s own chat');
assert.match(r.report.context, /A reviewer reported back; Grove recorded it\. Call grove_next/);
r = await work(rev.architecture, vote('APPROVE'));
r = await work(rev.tests, async (_b, i) => (i === 0 ? 'Looks fine overall.' : 'Criterion 2 has no test.\nVERDICT: CHANGES'));
assert.equal(r.blocks, 1, 'a review without a verdict is sent back');
// Changes requested: the engineer revises in its own chat, with the round's discussion.
assert.equal(eng.proc.engine.task('T1').stage, 'working');
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'planning');
assert.equal(sprite(eng, 'grove-T1-reviewer-tests').activity, 'idle', 'reviewers rest in the tent between rounds');
assert.equal(sprite(eng, 'grove-T1-reviewer-tests').verdict, 'changes', 'the tent shows each reviewer\'s last verdict');
assert.equal(sprite(eng, 'grove-T1-reviewer-security').verdict, 'approve');
res = await eng.call('grove_next');
assert.match(res.data.work, /## Revising v1\nThe reviewers asked for changes/);
assert.match(res.data.work, /### This round's discussion\n[\s\S]*Tests reviewer — CHANGES\nCriterion 2 has no test\./);
assert.match(res.data.work, /End it with a section "## Response to reviewers"/);
loadSkill(eng, 'grove-plan');
res = await eng.call('grove_submit', { step: 'S1', output: `${PLAN}\nAdded a test for criterion 2.\n## Response to reviewers\nTests: added.` });
assert.deepEqual(res.data.hires.map((x) => [x.tool, x.session]), [
  ['send_message', rev.security.link], ['send_message', rev.tests.link], ['send_message', rev.architecture.link],
], 'round 2 goes to the same reviewer chats, so they remember round 1');
for (const x of res.data.hires) {
  const key = Object.keys(rev).find((k) => rev[k].link === x.session);
  rev[key] = { ...rev[key], ...(await dispatch(eng, x)) };
}
assert.match(rev.tests.brief, /You reviewed an earlier version in this chat \(your last verdict: CHANGES\)\. First check whether each point you raised was addressed/);
for (const k of ['security', 'tests', 'architecture']) await work(rev[k], vote('APPROVE'));

// 7. Execute: Grove follows the skills the engineer loads. Turning to research mid-step sends its sprite to
//    the research tree; the step's own skill brings it back to the forge.
const t1 = () => eng.proc.engine.task('T1');
res = await eng.call('grove_next');
assert.match(res.data.work, /^## Your step: S2 · Execute: Implement the plan\nLoad the `grove-execute` skill/);
const implDir = eng.proc.engine.stepEvidenceDir(t1(), t1().steps[1]);
assert.ok(res.data.work.includes(`## Visual evidence (optional, but the human looks at it first)\nIf a picture shows your result better than words (before and after screenshots, or a short screen recording of the change working), save it in: ${implDir}`));
loadSkill(eng, 'grove-execute');
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'implementing');
loadSkill(eng, 'grove-research');
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'research', 'a detour to the research tree');
assert.equal(sprite(eng, 'grove-engineer-T1').task, 'S2 · Execute: Implement the plan (research for it)');
loadSkill(eng, 'grove-execute');
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'implementing', 'back at the forge');
res = await eng.call('grove_submit', { step: 'S2', output: IMPL });
assert.deepEqual(res.data.hires.map((x) => [x.tool, x.title ?? x.session]), [
  ['send_message', rev.security.link], ['send_message', rev.tests.link], ['create_session', 'Tansy · Code reviewer'], ['send_message', rev.architecture.link],
]);
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'code-review', 'code reviews gather at the mirror');
for (const x of res.data.hires) {
  const m = await dispatch(eng, x);
  assert.match(m.brief, /Inspect the actual changes yourself/);
  await work(m, vote('APPROVE'));
  if (x.title) rev.code = m;
}

// 8. Verify: evidence is required, and the tests reviewer opens it (the engineer is checking its own work).
res = await eng.call('grove_next');
assert.match(res.data.work, /^## Your step: S3 · Verify\nLoad the `grove-verify` skill/);
const evDir = eng.proc.engine.stepEvidenceDir(t1(), t1().steps[2]);
const att = path.basename(evDir);
assert.ok(res.data.work.includes(`## Evidence (required; in session data, not the workspace)\nSave every artifact in: ${evDir}`));
loadSkill(eng, 'grove-verify');
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'testing');
res = await eng.call('grove_submit', { step: 'S3', output: 'Toggle works and persists.\nRESULT: PASS' });
assert.match(res.data, /Visual evidence is required: evidence\.json is missing/);
await fs.mkdir(evDir, { recursive: true });
await fs.writeFile(path.join(evDir, 'after.png'), 'png-bytes');
await fs.writeFile(path.join(evDir, 'evidence.json'), JSON.stringify({ summary: 'Dark mode on and persisted.', items: [{ file: 'after.png', caption: 'Settings with dark mode on', criterion: 'Toggle in settings' }] }));
res = await eng.call('grove_submit', { step: 'S3', output: '- Toggle in settings → after.png → pass\n- Persists → reloaded, still dark → pass\nRESULT: PASS' });
assert.deepEqual(res.data.hires.map((x) => [x.tool, x.session]), [['send_message', rev.tests.link]], 'the tests reviewer checks the verification');
rev.tests = { ...rev.tests, ...(await dispatch(eng, res.data.hires[0])) };
assert.ok(rev.tests.brief.includes(`Open the evidence yourself (in ${evDir})`));
assert.match(rev.tests.brief, /When you review a \*\*verify\*\* step, the engineer is checking its own work/);
await work(rev.tests, vote('APPROVE'));

// 9. Deliver: the code change opens a draft PR first (the engineer does it), then the Chief is told.
res = await eng.call('grove_next');
assert.match(res.data.guidance, /All planned steps are done.*grove_deliver/);
assert.deepEqual(res.data.results.map((x) => x.step), ['S1 · Plan', 'S2 · Execute: Implement the plan', 'S3 · Verify']);
turn(eng);
assert.equal((await eng.hooks.onAgentStop({})).decision, 'block', 'the engineer must deliver (or plan more) before it stops');
res = await eng.call('grove_deliver', { summary: 'Dark mode ships with a settings toggle; verified with screenshots.', decisions: ['Kept light as the default theme, so nothing changes for existing users'], ask: 'Approve the change, or say if the toggle belongs in the View menu.' });
assert.match(res.data.guidance, /open a draft pull request with the change/);
res = await eng.call('grove_next');
assert.match(res.data.work, /^## Your step: S4 · Execute: Open a draft pull request\nThe work is done/);
assert.match(res.data.work, /gh pr create --draft/);
assert.match(res.data.work, /NO PR: <why>/);
assert.doesNotMatch(res.data.work, /Load the `grove-execute` skill|Visual evidence/, 'Grove\'s PR steps need no skill or evidence');
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'implementing');
res = await eng.call('grove_submit', { step: 'S4', output: 'Committed and opened a draft PR with Closes #42.' });
assert.match(res.data, /PR: <url>/);
res = await eng.call('grove_submit', { step: 'S4', output: 'Committed and opened a draft PR with Closes #42.\nPR: https://github.com/acme/app/pull/77' });
assert.equal(t1().stage, 'awaiting-approval');
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'idle', 'the engineer rests in its tent while the human decides');
assert.equal(sprite(eng, 'grove-engineer-T1').task, 'waiting on you: awaiting your sign-off');
notice = res.data.messages[0];
assert.match(notice.message, /^\[grove-notice:chief-1\/T1:deliver-1\] Tansy \(T1\) "Add dark mode" is finished and needs the human's sign-off/);
told = await send(eng, notice.session, notice.message);
assert.match(told.context, /The engineer's summary: Dark mode ships/);
assert.match(told.context, /What the engineer needs from the human: Approve the change, or say if the toggle belongs in the View menu\./);
assert.match(told.context, /Draft pull request \(link it right after the report\): \[PR #77\]\(https:\/\/github\.com\/acme\/app\/pull\/77\)/);
assert.match(told.context, new RegExp(`\\[Settings with dark mode on\\]\\(/.+/${att}/after\\.png\\) \\(proves: Toggle in settings\\)`));
const reportFile = path.join(chief.proc.engine.root, 'T1', 'report.html');
let html = await fs.readFile(reportFile, 'utf8');
assert.match(html, /<p class="lead-ask"><b>The engineer asks<\/b>Approve the change/);
assert.match(html, /<title>Engineer<\/title><use href="#gv-mage-a-0-dusk"\/>/);
assert.ok(html.includes(`src="evidence/${att}/after.png"`));
await sync(eng, chief);
assert.equal(chief.proc.evidenceFile('T1', `evidence/${att}/after.png`)?.type, 'image/png');
const inboxT1 = chief.proc.liveView().process.inbox.items.find((x) => x.taskId === 'T1');
assert.deepEqual([inboxT1.label, inboxT1.ask, inboxT1.pr], ['Ready for sign-off · draft PR #77', 'Approve the change, or say if the toggle belongs in the View menu.', 'https://github.com/acme/app/pull/77']);
assert.equal(chief.proc.liveView().process.tasks.find((x) => x.id === 'T1').engineer, 'active');

// 10. Approving ships it: the engineer marks the PR ready; Grove watches it (not the engineer); a failing
//     check wakes the engineer to fix it; once ready, the Chief asks the human; on "merge" the engineer merges.
res = await chief.call('grove_record_decision', { taskId: 'T1', decision: 'approve', note: 'Ship it.' });
assert.match(res.data.guidance, /T1's engineer will publish the pull request/);
back = await send(chief, res.data.message.session, res.data.message.message);
assert.equal(back.target, eng);
assert.equal(t1().ship.phase, 'publish');
res = await eng.call('grove_next');
assert.match(res.data.work, /S5 · Execute: Publish: mark PR #77 ready for review/);
assert.match(res.data.work, /gh pr ready/);
assert.match(res.data.work, /Pull request: https:\/\/github\.com\/acme\/app\/pull\/77/);
assert.match(res.data.work, /🤖/);
await eng.call('grove_submit', { step: 'S5', output: 'Pushed and marked ready for review.\nPR: https://github.com/acme/app/pull/77' });
assert.equal(t1().stage, 'watching');
assert.equal(sprite(eng, 'grove-engineer-T1').activity, 'idle');
turn(eng, 'Done.');
assert.equal(await eng.hooks.onAgentStop({}), undefined, 'nothing for the engineer while Grove watches');
const gh = (over = {}) => ({ state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', headRefOid: 'aaa', url: 'https://github.com/acme/app/pull/77', number: 77, statusCheckRollup: [{ name: 'build', status: 'IN_PROGRESS' }], ...over });
ghState = new Error('gh: not logged in');
await eng.proc.watchPr({ force: true });
assert.match(sprite(eng, 'grove-engineer-T1').error, /Can't read PR #77: gh: not logged in/);
ghState = gh({ statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://ci/1' }] });
await eng.proc.watchPr({ force: true });
assert.equal(t1().stage, 'routing', 'a failing check wakes the engineer');
res = await eng.call('grove_next');
assert.match(res.data.guidance, /needs work:\n- Checks failing: build \(https:\/\/ci\/1\)\nPlan the fix with grove_plan_steps: usually one execute step in which you fix it/);
res = await eng.call('grove_plan_steps', { steps: [{ kind: 'execute', title: 'Fix the build', brief: 'Fix the failing build check on the PR branch and push.' }] });
assert.match(res.data.work, /Checks failing: build/);
assert.match(res.data.work, /The change is in a pull request: https:\/\/github\.com\/acme\/app\/pull\/77\. Push further changes to its branch/);
loadSkill(eng, 'grove-execute');
await eng.call('grove_submit', { output: 'Fixed the type error in src/app.ts and pushed to the PR branch; the build passes locally. '.repeat(2) });
assert.equal(t1().stage, 'watching', 'back to watching once the fix is in');
ghState = gh({ headRefOid: 'bbb', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
await eng.proc.watchPr({ force: true });
assert.equal(t1().stage, 'ready-to-merge');
notice = (await eng.call('grove_next')).data.messages[0];
told = await send(eng, notice.session, notice.message);
assert.match(told.context, /PR #77 .*is ready to merge/);
res = await chief.call('grove_record_decision', { taskId: 'T1', decision: 'merge' });
await send(chief, res.data.message.session, res.data.message.message);
res = await eng.call('grove_next');
assert.match(res.data.work, /gh pr merge/);
await eng.call('grove_submit', { output: 'Checked the head is green and approved, then merged with squash.\nPR: https://github.com/acme/app/pull/77' });
assert.equal(t1().stage, 'watching');
ghState = gh({ state: 'MERGED' });
await eng.proc.watchPr({ force: true });
assert.equal(t1().stage, 'done');
await sync(eng, chief);
assert.equal(chief.proc.liveView().agents.filter((a) => a.taskId === 'T1').length, 0, 'the team leaves when the task is done');
assert.equal(eng.sent.length, 0, 'the engineer was never woken by Grove');
assert.equal(chief.sent.length, 1);
assert.match(chief.sent[0], /^\[Grove → Chief of Staff\] Tansy \(T1\) "Add dark mode": PR #77 .*is merged, so the task is done\./);
chief.sent.length = 0;

// 11. Research runs on Sol. A reviewer blocked on the human pauses the task; "retry" puts it back to work
//     in the same chat. A question is answered by the engineer; "hold" stops everyone without waking it.
res = await chief.call('grove_create_task', { title: 'Usage numbers', goal: 'Weekly active users for the agents window.', kind: 'research', destination: { mode: 'scratch' } });
assert.equal(res.data.handoff.model, 'gpt-6.1-sol', 'research runs on Sol');
const h2 = res.data.handoff.prompt;
await settle(chief);
const eng2 = await startSession('eng-2');
started(chief, eng2, h2);
await eng2.hooks.onUserPromptSubmitted({ prompt: h2 });
const t2 = () => eng2.proc.engine.task('T2');
assert.equal((await eng2.call('grove_update', { text: 'Querying the last 7 days.' })).ok, true);
res = await eng2.call('grove_plan_steps', { template: 'research' });
assert.match(res.data.work, /Load the `grove-research` skill/);
assert.match(res.data.work, /a screenshot of the query and its results, a chart/);
assert.equal(sprite(eng2, 'grove-engineer-T2').activity, 'research');
res = await eng2.call('grove_submit', { step: 'S1', output: '## Answer\nWAU ~12k.\n\n## How\nKusto query over 7 days, filtered to the agents window.' });
assert.match(res.data.reminder, /didn't see you load the grove-research skill for S1/, 'a reminder, not a refusal');
const acc = await dispatch(eng2, res.data.hires[0]);
assert.equal(models.get('Duskwing · Accuracy reviewer'), 'grok-4.7', 'custom focuses take the generic reviewer\'s rotation');
assert.match(acc.brief, /Check the findings yourself: re-run queries/);
assert.match(acc.brief, /BLOCKED: <exactly what the human must do>/);
r = await work(acc, async () => 'Kusto returned AADSTS700082 (expired refresh token); I can\'t re-run the query.\nBLOCKED: Run `az login --tenant 72f9`, then tell the Chief of Staff');
assert.equal(t2().stage, 'blocked');
assert.equal(t2().pause.by, 'Accuracy reviewer');
assert.equal(sprite(eng2, 'grove-T2-reviewer-accuracy').activity, 'waiting', 'the blocked reviewer waits at the lantern');
assert.equal(sprite(eng2, 'grove-engineer-T2').activity, 'idle');
turn(eng2);
assert.match((await eng2.hooks.onAgentStop({})).reason, /notice:blocked-/, 'the engineer must tell the Chief before it stops');
notice = (await eng2.call('grove_next')).data.messages[0];
told = await send(eng2, notice.session, notice.message);
assert.match(told.context, /is blocked until the human does this: Run `az login --tenant 72f9`/);
await sync(eng2, chief);
assert.deepEqual(chief.proc.liveView().process.inbox.items.filter((x) => x.taskId === 'T2').map((x) => [x.kind, x.label]), [['blocked', 'Blocked on you · Accuracy reviewer']]);
res = await chief.call('grove_record_decision', { taskId: 'T2', decision: 'retry', note: 'Logged in, try again' });
await send(chief, res.data.message.session, res.data.message.message);
assert.equal(t2().stage, 'reviewing');
h = (await eng2.call('grove_next')).data.hires[0];
assert.equal(h.session, acc.link, 'the reviewer continues in its own chat');
const acc2 = { ...acc, ...(await dispatch(eng2, h)) };
assert.match(acc2.brief, /Logged in, try again/);
res = await chief.call('grove_record_decision', { taskId: 'T2', decision: 'question', note: 'Does this include insiders?' });
assert.match(res.data.guidance, /T2's engineer will answer/);
await send(chief, res.data.message.session, res.data.message.message);
assert.match((await eng2.call('grove_next')).data.guidance, /The human asked: "Does this include insiders\?"/);
res = await eng2.call('grove_answer', { text: 'Yes: insiders are included; the report splits them out.' });
told = await send(eng2, res.data.messages[0].session, res.data.messages[0].message);
assert.match(told.context, /the engineer answered the human's question\.\n\nThey asked: Does this include insiders\?\n\nAnswer:\nYes/);
await sync(acc2.member, eng2);
res = await chief.call('grove_record_decision', { taskId: 'T2', decision: 'hold', note: 'Pause until Monday' });
await send(chief, res.data.message.session, res.data.message.message);
assert.equal(t2().stage, 'on-hold');
turn(eng2, 'On hold.');
assert.equal(await eng2.hooks.onAgentStop({}), undefined, 'no pushback while on hold');
assert.deepEqual(await eng2.proc.leadPending(t2()), []);
assert.equal(sprite(eng2, 'grove-engineer-T2').task, 'on hold: Pause until Monday');
res = await chief.call('grove_record_decision', { taskId: 'T2', decision: 'resume' });
await send(chief, res.data.message.session, res.data.message.message);
assert.equal(t2().stage, 'reviewing');
h = (await eng2.call('grove_next')).data.hires[0];
assert.equal(h.session, acc.link);
await hire(eng2, h, vote('APPROVE'));
assert.equal(t2().stage, 'routing');
assert.equal(eng2.sent.length, 0, 'every hand-off reached the engineer as a message');
assert.equal(chief.sent.length, 0, 'and every notice reached the Chief as a message');

// 12. A stalled engineer is woken in its own chat; a new engineer can take a task over and catches up from
//     the board.
res = await chief.call('grove_create_task', { title: 'File issues', goal: 'File an issue for each flaky test.', kind: 'other', destination: { mode: 'scratch' } });
const h3 = res.data.handoff.prompt;
await settle(chief);
const eng3 = await startSession('eng-3', { graceMs: 0 });
started(chief, eng3, h3);
await eng3.hooks.onUserPromptSubmitted({ prompt: h3 });
await eng3.call('grove_plan_steps', { steps: [{ kind: 'research', title: 'Find the flaky tests' }, { kind: 'execute', title: 'File the issues' }] });
assert.equal((await eng3.call('grove_submit', { step: 'S1', output: '## Flaky tests\n- a.test.ts (fails 1 run in 20 on CI)\n- b.test.ts (fails on Windows agents only)' })).ok, true);
eng3.emit({ type: 'session.idle', data: {} });
await eng3.proc.continueLead();
assert.match(eng3.sent.at(-1), /^\[Grove\] T3 \(S2 Execute\): your step isn't finished\. Call grove_next for the assignment/, 'woken in its own chat');
res = await chief.call('grove_handoff', { taskId: 'T3' });
const eng3b = await startSession('eng-3b');
await eng3b.hooks.onUserPromptSubmitted({ prompt: res.data.handoff.prompt });
assert.equal(eng3b.proc.role, 'lead');
assert.equal(chief.proc.leadRoute(chief.proc.engine.task('T3')).link, null, 'the replaced engineer\'s chat is no longer a route');
whoAmI(eng3b);
assert.equal(eng3b.proc.engine.task('T3').lead.linkSource, 'self', 'the new engineer learns its own chat');
res = await eng3b.call('grove_next');
assert.match(res.data.guidance, /You took this task over from another engineer/);
assert.deepEqual(res.data.results.map((x) => x.step), ['S1 · Research: Find the flaky tests']);
assert.match(res.data.results[0].output, /a\.test\.ts/);
await settle(eng3b);
await eng3.proc.poll();
assert.equal(eng3.proc.role, 'none', 'the old engineer steps aside');
assert.equal((await eng3b.call('grove_submit', { step: 'S2', output: 'Filed #201 (a.test.ts) and #202 (b.test.ts), each with the failure logs and a link to the CI runs.' })).ok, true);
assert.equal(eng3b.proc.catchUp, false, 'caught up once it submits');
assert.equal((await eng3b.call('grove_next')).data.results.length, 2);
res = await eng3b.call('grove_deliver', { summary: 'Filed two issues for the flaky tests.', ship: false });
assert.equal(eng3b.proc.engine.task('T3').stage, 'awaiting-approval');

// 13. The Chief's inbox: "Attach to chat" puts the task in the Chief's next message; Complete signs it off.
await sync(eng3b, chief);
assert.deepEqual(await chief.proc.attachTask('T3'), { attached: ['T3'] });
up = await chief.hooks.onUserPromptSubmitted({ prompt: 'Looks good.' });
assert.match(up.additionalContext, /### Quill \(T3\) "File issues" \(Awaiting your sign-off\)/);
assert.match(up.additionalContext, /Engineer's summary: Filed two issues/);
assert.match(up.additionalContext, /Engineer session: agent-host-session:\/\/ahp-session\/G-eng-3b\n/, 'the current engineer, never the one it replaced');
assert.deepEqual(await chief.proc.inboxDecide('T3', 'complete'), { task: 'T3', decision: 'approve', outcome: 'done' });
await sync(chief, eng3b);
assert.equal(eng3b.proc.engine.task('T3').stage, 'done', 'the engineer applies an inbox decision from the board');

// 14. Errors show in the grove. A failed hire shows why while its retry waits; a session's own errors show on
//     its sprite until a turn goes through again. A turn that says and does nothing isn't pushed again.
const noResponse = 'No response was returned. Send your message again to retry.';
const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
res = await chief.call('grove_create_task', { title: 'Flaky', goal: 'A task whose sessions hit errors.', kind: 'research', destination: { mode: 'scratch' } });
const h4 = res.data.handoff.prompt;
await settle(chief);
const eng4 = await startSession('eng-4');
await eng4.hooks.onUserPromptSubmitted({ prompt: h4 });
res = await eng4.call('grove_plan_steps', { template: 'research' });
eng4.emit({ type: 'assistant.turn_start' });
eng4.emit({ type: 'assistant.message', data: { content: '' } });
assert.equal(await eng4.hooks.onAgentStop({}), undefined, 'a turn that said and did nothing is not sent back');
res = await eng4.call('grove_submit', { output: '## Answer\nNothing flaky this week.\n\n## How\nChecked the last 50 CI runs on main and the release branch.' });
assert.equal(res.ok, true, res.data);
assert.equal((await dispatch(eng4, res.data.hires[0], { fail: true })).failed, true);
assert.match(sprite(eng4, 'grove-T4-reviewer-accuracy').error, /^Retrying \(attempt 2\) after: could not reach the session: host refused/, 'a failed hire shows even without a chat');
const acc4 = await dispatch(eng4, (await eng4.call('grove_next')).data.hires[0]);
await sync(acc4.member, eng4);
assert.equal(sprite(eng4, 'grove-T4-reviewer-accuracy').error, '', 'the retry started');
acc4.member.emit({ type: 'assistant.turn_start' });
acc4.member.emit({ type: 'session.error', data: { errorType: 'query', message: noResponse } });
acc4.member.emit({ type: 'session.error', data: { errorType: 'query', message: noResponse } });
await pause();
await sync(acc4.member, eng4);
assert.equal(sprite(eng4, 'grove-T4-reviewer-accuracy').error, `Session error (×2): ${noResponse}`);
acc4.member.emit({ type: 'assistant.message', data: { content: 'Back at it.' } });
await pause();
await sync(acc4.member, eng4);
assert.equal(sprite(eng4, 'grove-T4-reviewer-accuracy').error, '', 'cleared once a turn goes through');
eng4.emit({ type: 'session.error', data: { errorType: 'query', message: noResponse } });
await settle(eng4);
assert.equal(sprite(eng4, 'grove-engineer-T4').error, `Session error: ${noResponse}`);
await chief.proc.engine.refresh();
assert.equal((await chief.call('grove_status', { taskId: 'T4' })).data.tasks[0].engineerError, `Session error: ${noResponse}`);
eng4.emit({ type: 'tool.execution_start', data: { toolCallId: 'tc-next', toolName: 'grove_next', arguments: {} } });
await settle(eng4);
assert.equal(sprite(eng4, 'grove-engineer-T4').error, '');
chief.emit({ type: 'session.error', data: { errorType: 'query', message: 'Execution failed: 408 Timed out reading request body.' } });
assert.equal(chief.proc.liveView().agents[0].error, 'Session error: Execution failed: 408 Timed out reading request body.');
chief.emit({ type: 'assistant.message', data: { content: 'Retrying.' } });
assert.equal(chief.proc.liveView().agents[0].error, '');

// 15. Models: every reviewer runs on the model set in its agent file; the engineer on its task kind's.
assert.deepEqual(Object.fromEntries([...models].filter(([t]) => t.startsWith('Tansy ·'))), {
  'Tansy · Security reviewer': 'claude-opus-5.5',
  'Tansy · Tests reviewer': 'gpt-6.1-sol',
  'Tansy · Architecture reviewer': 'gpt-6.1-sol',
  'Tansy · Code reviewer': 'claude-opus-5.5',
});
const { memberModel, engineerModel, parseModels } = await import('../extensions/grove-agent-monitor/lib/process/models.mjs');
assert.deepEqual(['code', 'research', 'other'].map((k) => engineerModel(k)), ['claude-opus-5.5', 'gpt-6.1-sol', 'gpt-6.1-sol']);
assert.deepEqual(parseModels('---\nname: x\nmodel: [a-1, "b-2"]\n---\n'), ['a-1', 'b-2']);
assert.deepEqual(parseModels('---\nmodel:\n  - a-1\n  - b-2\nname: x\n---\n'), ['a-1', 'b-2']);
assert.deepEqual(parseModels('---\nname: x\n---\n'), []);
const fiveFocus = { steps: [{ id: 'S1', reviewers: ['a', 'security', 'b', 'c', 'd', 'e'].map((name) => ({ name })) }] };
const seat = (specialty) => memberModel(fiveFocus, { role: 'reviewer', specialty, step: 'S1', agentType: specialty === 'security' ? 'grove-reviewer-security' : 'grove-reviewer' });
assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'security'].map(seat), ['grok-4.7', 'gemini-4-argon', 'gpt-6.1-sol', 'claude-opus-5.5', 'grok-4.7', 'claude-opus-5.5'], 'the rotation wraps');

// 16. The shelf. A task waiting on the human can be set aside: it leaves the inbox (at once, before its
//     engineer's Grove applies it), the Chief leaves the lantern, and the engineer isn't woken. Bringing it
//     back puts it exactly where it was; answering it from chat takes it off the shelf too.
res = await chief.call('grove_create_task', { title: 'Weekly numbers', goal: 'Weekly active users, every week.', kind: 'research', destination: { mode: 'scratch' } });
const h5 = res.data.handoff.prompt;
await settle(chief);
const eng5 = await startSession('eng-5');
started(chief, eng5, h5);
await eng5.hooks.onUserPromptSubmitted({ prompt: h5 });
const t5 = () => eng5.proc.engine.task('T5');
await eng5.call('grove_plan_steps', { steps: [{ kind: 'research', title: 'Pull WAU' }] });
await eng5.call('grove_submit', { output: '## Answer\nWAU ~12k this week.\n\n## How\nThe weekly Kusto query over the last 7 days.' });
res = await eng5.call('grove_deliver', { summary: 'WAU is about 12k this week.' });
await send(eng5, res.data.messages[0].session, res.data.messages[0].message);
await sync(eng5, chief);
let inbox5 = chief.proc.liveView().process.inbox;
assert.ok(inbox5.items.some((x) => x.taskId === 'T5'));
assert.equal(chief.proc.liveView().agents[0].activity, 'waiting', 'the Chief is at the lantern');
const eng5Sent = eng5.sent.length;
assert.deepEqual(await chief.proc.inboxDecide('T5', 'shelve'), { task: 'T5', decision: 'shelve', outcome: 'on the shelf' });
inbox5 = chief.proc.liveView().process.inbox;
assert.ok(!inbox5.items.some((x) => x.taskId === 'T5'), 'off the inbox right away');
assert.deepEqual(inbox5.shelf.map((x) => [x.taskId, x.name, x.was, x.summary]), [['T5', 'Sylph', 'Awaiting your sign-off', 'WAU is about 12k this week.']]);
assert.notEqual(chief.proc.liveView().agents[0].activity, 'waiting', 'the Chief leaves the lantern');
await sync(chief, eng5);
assert.equal(t5().stage, 'shelved', 'the engineer\'s Grove applies it from the board');
assert.equal(eng5.sent.length, eng5Sent, 'without waking the engineer');
assert.equal(sprite(eng5, 'grove-engineer-T5').activity, 'idle', 'it rests in its tent');
assert.equal(sprite(eng5, 'grove-engineer-T5').task, 'resting: on the shelf until you bring it back');
assert.match((await eng5.call('grove_next')).data.guidance, /T5 is on the shelf.*end your turn/);
turn(eng5, 'Shelved.');
assert.equal(await eng5.hooks.onAgentStop({}), undefined, 'nothing to push back on');
assert.match(await fs.readFile(path.join(chief.proc.engine.root, 'T5', 'report.html'), 'utf8'), /<span class="rune off">On the shelf<\/span>/);
await assert.rejects(chief.proc.inboxDecide('T5', 'shelve'), /already on the shelf/);
// Bring it back from the shelf.
assert.equal((await chief.proc.inboxDecide('T5', 'unshelve')).outcome, 'back in the inbox');
assert.ok(chief.proc.liveView().process.inbox.items.some((x) => x.taskId === 'T5'), 'back in the inbox at once');
await sync(chief, eng5);
assert.equal(t5().stage, 'awaiting-approval');
assert.equal(eng5.sent.length, eng5Sent);
// Shelve it from chat; later the human asks for a rerun about the attached task.
res = await chief.call('grove_record_decision', { taskId: 'T5', decision: 'shelve', note: 'Not now' });
assert.equal(res.data.message, null, 'nothing to send the engineer');
assert.match(res.data.guidance, /T5 is on the shelf: it's out of their inbox/);
await sync(chief, eng5);
assert.equal(t5().stage, 'shelved');
await chief.proc.attachTask('T5');
up = await chief.hooks.onUserPromptSubmitted({ prompt: 'Run this again with this week\'s data.' });
assert.match(up.additionalContext, /### Sylph \(T5\) "Weekly numbers" \(On the shelf\)/);
assert.match(up.additionalContext, /set it aside while it was "Awaiting your sign-off"/);
assert.match(up.additionalContext, /"changes" with their words \(for example to run it again/);
res = await chief.call('grove_record_decision', { taskId: 'T5', decision: 'changes', note: 'Run it again with this week\'s data.' });
assert.ok(res.data.message, 'a rerun goes to the engineer');
back = await send(chief, res.data.message.session, res.data.message.message);
assert.equal(back.target, eng5, 'the same engineer');
assert.equal(t5().stage, 'routing');
assert.match((await eng5.call('grove_next')).data.guidance, /The human asked for more: "Run it again with this week's data\."/);

// 16b. Inbox decisions converge, and messages only go to the engineer that holds the task now. A double
//      click records one decision; a dismiss overtakes a complete the engineer never picked up; relays to a
//      dead engineer back off, then the Chief is asked (once) for a new engineer, who applies the cancel.
const { decisionMessage } = await import('../extensions/grove-agent-monitor/lib/process/prompts.mjs');
let clock = Date.now();
chief.proc.now = () => clock;
const MIN = 60 * 1000;
const relayTick = async (mins = 10) => {
  clock += mins * MIN;
  await settle(chief);
  await chief.proc.engine.refresh();
  await chief.proc.relayToChief();
  await settle(chief);
};
const relayOf = (text) => ({ session: /\nsession: (\S+)\n/.exec(text)[1], message: /\nmessage: ([\s\S]*?)\nThen end your turn/.exec(text)[1] });
let rtc = 0;
const chiefSend = (args, outcome) => {
  const toolCallId = `relay-${++rtc}`;
  chief.emit({ type: 'tool.execution_start', data: { toolCallId, toolName: 'send_message', arguments: args } });
  const finish = (ok) => chief.emit({ type: 'tool.execution_complete', data: ok ? { toolCallId, success: true, result: { content: '{"action":"started"}' } } : { toolCallId, success: false, error: { message: `Session not found (${args.session}?token=secret)` } } });
  if (outcome !== undefined) finish(outcome);
  return finish;
};
res = await chief.call('grove_create_task', { title: 'Ship notes', goal: 'Write the release notes.', kind: 'research', destination: { mode: 'scratch' } });
const h6 = res.data.handoff.prompt;
await settle(chief);
const eng6 = await startSession('eng-6');
started(chief, eng6, h6);
await eng6.hooks.onUserPromptSubmitted({ prompt: h6 });
await eng6.call('grove_plan_steps', { steps: [{ kind: 'research', title: 'Draft notes' }] });
await eng6.call('grove_submit', { output: '## Answer\nThe notes are drafted.\n\n## How\nRead every merged PR since the last release.' });
await eng6.call('grove_deliver', { summary: 'Release notes drafted.' });
await sync(eng6, chief);
assert.equal(chief.proc.leadRoute(chief.proc.engine.task('T6')).route, 'verified');
// Two quick clicks on Complete: one decision.
const clicks = await Promise.all([chief.proc.inboxDecide('T6', 'complete'), chief.proc.inboxDecide('T6', 'complete')]);
assert.deepEqual(clicks.map((c) => !!c.duplicate).sort(), [false, true], 'the second click is a duplicate');
assert.equal((await chief.proc.board.readDecisions('T6')).length, 1, 'one decision on the board');
assert.equal(chief.proc.inboxLog.filter((x) => x.taskId === 'T6').length, 1, 'logged once');
// After a restart the inbox log is gone; the board still knows it.
assert.equal((await chief.proc.inboxDecide('T6', 'complete')).duplicate, true, 'an identical click later is still a duplicate');
assert.deepEqual(chief.proc.liveView().process.inbox.items.find((x) => x.taskId === 'T6')?.decision ?? chief.proc.decisionView('T6'), { seq: 1, action: 'approve', state: 'recorded' });
// The engineer's chat has gone away: it never applies that. The human dismisses the task instead.
eng6.proc.dispose();
assert.equal((await chief.proc.inboxDecide('T6', 'dismiss')).decision, 'cancel');
assert.equal(chief.proc.decisionView('T6').state, 'recorded');
// The first relay: Grove couldn't post to the Chief's own chat. Nothing counts as tried.
const realSend = chief.session.send;
chief.session.send = async () => { throw new Error('chat busy'); };
await relayTick();
chief.session.send = realSend;
let r6 = chief.proc.board.meta.decisionRelays.T6;
assert.deepEqual([r6.attempts, r6.wakeFailures, r6.lastError], [0, 1, 'could not post to the Chief\'s chat']);
// Relay 1: the Chief's send fails (the link is redacted in the reason). Relay 2: it is accepted, but the
// engineer never applies it. Relay 3 is still in flight when the Chief is told the engineer is unreachable.
await relayTick();
let rel = relayOf(chief.sent.at(-1));
assert.equal(rel.session, eng6.link, 'relayed to the engineer that holds the task');
assert.match(rel.message, /^\[grove-decision:chief-1\/T6:2\]/);
chiefSend(rel, false);
await settle(chief);
assert.equal(chief.proc.decisionView('T6').state, 'delivery-failed');
assert.match(chief.proc.decisionView('T6').reason, /Session not found/);
assert.doesNotMatch(chief.proc.decisionView('T6').reason, /secret/, 'no link query (or token) in the reason');
await relayTick();
chiefSend(relayOf(chief.sent.at(-1)), true);
await settle(chief);
assert.equal(chief.proc.decisionView('T6').state, 'delivery-accepted');
await relayTick();
const late = chiefSend(relayOf(chief.sent.at(-1)));
assert.equal(chief.proc.decisionView('T6').attempts, 3);
await relayTick();
assert.equal(chief.proc.decisionView('T6').state, 'needs-new-engineer');
assert.match(chief.sent.at(-1), /the human's decision \(#2, "cancel"\) hasn't reached its engineer: 3 relays haven't reached it.*Call grove_handoff for T6/s);
await relayTick();
await relayTick();
assert.equal(chief.sent.filter((m) => /grove_handoff for T6/.test(m)).length, 1, 'asked once per engineer');
// Two hand-offs; the create_session result for the first comes back late and is ignored.
const pA = (await chief.call('grove_handoff', { taskId: 'T6' })).data.handoff.prompt;
assert.equal(chief.proc.decisionView('T6').state, 'awaiting-engineer');
assert.equal(chief.proc.leadRoute(chief.proc.engine.task('T6')).link, null, 'the old chat is no longer a route');
const pB = (await chief.call('grove_handoff', { taskId: 'T6' })).data.handoff.prompt;
started(chief, { link: 'agent-host-session://ahp-session/G-ghost' }, pA);
await settle(chief);
assert.equal(chief.proc.board.meta.leadRoutes?.T6, undefined, 'a superseded hand-off never becomes a route');
late(true);
await settle(chief);
assert.equal(chief.proc.decisionView('T6').state, 'awaiting-engineer', 'a delivery to the replaced engineer doesn\'t count');
res = await chief.call('grove_status', { taskId: 'T6' });
assert.deepEqual([res.data.tasks[0].engineer.route, res.data.tasks[0].engineer.handoffPending], ['none', true]);
// The new engineer: create_session's result arrives first, then it claims.
const eng6b = await startSession('eng-6b');
started(chief, eng6b, pB);
await settle(chief);
await eng6b.hooks.onUserPromptSubmitted({ prompt: pB });
await sync(eng6b, chief);
const t6 = eng6b.proc.engine.task('T6');
assert.equal(t6.stage, 'cancelled', 'the dismiss wins; the complete never runs');
assert.deepEqual(t6.decisionResults.map((x) => [x.seq, x.action, x.result]), [[1, 'approve', 'superseded'], [2, 'cancel', 'applied']]);
await relayTick();
assert.deepEqual(chief.proc.decisionView('T6'), { seq: 2, action: 'cancel', state: 'applied' });
assert.ok(!chief.proc.liveView().process.inbox.items.some((x) => x.taskId === 'T6'));
// A stale relay of the overtaken complete reaches the new engineer: nothing to do.
const d1 = (await chief.proc.board.readDecisions('T6')).find((x) => x.seq === 1);
back = await send(chief, eng6b.link, decisionMessage(chief.proc.board.id, chief.proc.engine.task('T6'), d1));
assert.match(back.context, /Decision #1 was already handled \(result: superseded: overtaken by cancel #2\); nothing to do/);
assert.equal(eng6b.proc.engine.task('T6').stage, 'cancelled');

// 16c. Another task is untouched by all that. Its engineer claims before the Chief sees create_session's
//      result, and a link an older Grove stored without a source is never used.
assert.equal(chief.proc.leadRoute(chief.proc.engine.task('T5')).link, eng5.link, 'T5 still routes to its engineer');
res = await chief.call('grove_create_task', { title: 'Count stars', goal: 'How many stars this month?', kind: 'research', destination: { mode: 'scratch' } });
const h7 = res.data.handoff.prompt;
await settle(chief);
const eng7 = await startSession('eng-7');
await eng7.hooks.onUserPromptSubmitted({ prompt: h7 });
await sync(eng7, chief);
assert.equal(chief.proc.leadRoute(chief.proc.engine.task('T7')).link, null, 'no route until one is confirmed');
started(chief, eng7, h7);
await settle(chief);
assert.equal(chief.proc.leadRoute(chief.proc.engine.task('T7')).link, eng7.link);
const t7 = eng7.proc.engine.task('T7');
t7.lead.link = 'agent-host-session://ahp-session/G-ghost';
delete t7.lead.linkSource;
eng7.proc.engine.changed(t7, null);
await settle(eng7);
await chief.proc.engine.refresh();
let r7 = chief.proc.leadRoute(chief.proc.engine.task('T7'));
assert.deepEqual([r7.link, r7.quarantined], [eng7.link, true], 'the unsourced link is ignored');
await sync(eng7);
assert.deepEqual([t7.lead.link, t7.lead.linkSource], [eng7.link, 'chief'], 'the engineer drops it and takes the verified route');
// Hand-off tokens never leave the board.
const tokens = [...Object.values(chief.proc.board.meta.handoffs ?? {}), ...Object.values(chief.proc.board.meta.leadRoutes ?? {}).map((x) => x.token)].filter(Boolean);
assert.ok(tokens.length);
const shown = JSON.stringify([(await chief.call('grove_status')).data, chief.proc.liveView()]);
for (const tok of tokens) assert.ok(!shown.includes(tok), 'no hand-off token in status or views');

// 17. A board from the earlier process (a task lead with persona sessions) isn't migrated: Grove leaves it
//     untouched and says to start a new Chief of Staff chat.
const oldRoot = path.join(tmp, 'old-chief', 'files', 'grove');
await fs.mkdir(oldRoot, { recursive: true });
const oldBoard = JSON.stringify({ format: 'grove-agent-monitor/board', version: 1, id: 'old-chief', chiefSessionId: 'old-chief', nextTask: 3, handoffs: {}, notified: {} });
await fs.writeFile(path.join(oldRoot, 'board.json'), oldBoard);
const oldChief = await startSession('old-chief');
assert.match(oldChief.proc.error, /from an earlier Grove process \(format version 1; this Grove uses version 2\)\. Old boards aren't migrated: start a new Chief of Staff chat/);
assert.equal(oldChief.proc.role, 'none');
assert.equal(await fs.readFile(path.join(oldRoot, 'board.json'), 'utf8'), oldBoard, 'left untouched');

for (const s of all) await s.proc.dispose();
await fs.rm(tmp, { recursive: true, force: true });
console.log('process engine tests passed');
