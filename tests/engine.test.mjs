// Run: node tests/engine.test.mjs
// The process engine on its own (no sessions): the engineer's steps and submissions, reviews, pausing,
// blockers, questions, shipping through a PR, review churn limits and host message limits.
import assert from 'node:assert/strict';
import {
  ProcessEngine, MAX_STEP_ROUNDS, RATE_LIMIT_BACKOFF_MS, TEMPLATES, parseBlocked, parsePr, prSummary, prLine, stageLabel, currentStep,
} from '../extensions/grove-agent-monitor/lib/process/engine.mjs';

const board = { root: '/board', saveTask: async () => {}, flush: async () => {} };
const engine = new ProcessEngine({ board, selfId: 'lead', validateEvidence: async (dir) => ({ ok: true, items: [{ file: 'a.png', caption: 'shot', criterion: '' }], dir, summary: 'Shown' }) });
let n = 0;
const task = (steps, kind = 'code') => {
  const t = engine.createTask({ id: `T${++n}`, title: `Task ${n}`, goal: 'Goal', criteria: [], kind });
  t.lead = { sessionId: 'lead', claimedAt: Date.now(), token: 'x' };
  if (steps) engine.planSteps(t.id, steps);
  return t;
};
const working = (t) => t.tickets.filter((k) => k.status === 'issued');
// The engineer submits the step in progress (grove_submit).
const submit = (t, text) => engine.submit(t.id, undefined, text);
// A reviewer's review arrives (the engineer's Grove applies results/<ticket>.json).
const report = async (t, k, text) => {
  k.status = 'running';
  assert.equal(await engine.applyResult({ ticket: k.id, token: k.token, status: 'done', text }), true);
};
const LONG = (s) => `${s} `.repeat(12);

// ---- parsers ----
assert.equal(parseBlocked('Tried twice.\nBLOCKED: Run `az login` and tell the Chief'), 'Run `az login` and tell the Chief');
assert.equal(parseBlocked('**BLOCKED:** Grant access**'), 'Grant access');
assert.equal(parseBlocked('Nothing blocked here'), null);
assert.deepEqual(parsePr('Opened https://github.com/acme/app/pull/12 then https://github.com/acme/app/pull/13.'), { url: 'https://github.com/acme/app/pull/13', repo: 'acme/app', number: 13 });
const sum = prSummary({ state: 'OPEN', statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'b', status: 'COMPLETED', conclusion: 'TIMED_OUT' }, { context: 'c', state: 'PENDING' }, { name: 'd', status: 'COMPLETED', conclusion: 'CANCELLED' }], reviewDecision: 'CHANGES_REQUESTED', mergeable: 'CONFLICTING' });
assert.deepEqual(sum.checks, { passed: 1, skipped: 1, pending: 1, failed: [{ name: 'b', url: null }] });
assert.equal(prLine({ number: 5, ...sum }), 'PR #5 (checks: 1 passed, 1 failing (b), 1 running, 1 skipped; review: changes requested; merge conflicts)');

// ---- the engineer works each step itself; only reviewers get tickets ----
assert.deepEqual(TEMPLATES['code-change'].map((s) => [s.kind, s.reviewers ?? []]), [
  ['plan', ['security', 'tests', 'architecture']], ['execute', ['security', 'tests', 'code', 'architecture']], ['verify', ['tests']],
], 'the engineer verifies its own work, so the tests reviewer checks the evidence');
assert.throws(() => engine.createTask({ id: 'T99', title: 'x', goal: 'g', kind: 'sports' }), /kind must be one of code, research, other/);
let t = task({ template: 'code-change' });
assert.equal(t.kind, 'code');
assert.equal(t.stage, 'working');
assert.equal(currentStep(t).id, 'S1');
assert.equal(t.tickets.length, 0, 'no hire for the engineer\'s own work');
assert.equal(currentStep(t).evidenceAttempt, undefined, 'plans have no evidence folder');
await assert.rejects(submit(t, 'Too short'), /complete plan/, 'submissions are checked right away');
await assert.rejects(engine.submit(t.id, 'S2', LONG('A plan for the change')), /step in progress is S1/);
await assert.rejects(submit(t, `${LONG('Plan')}\nBLOCKED: Need access`), /call grove_blocked/);
await submit(t, LONG('## Plan\nSteps, files, risks, criteria and verification.'));
assert.equal(t.stage, 'reviewing');
assert.deepEqual(working(t).map((k) => [k.role, k.specialty, k.dispatcher, k.member]), [
  ['reviewer', 'security', 'lead', 'reviewer-security'], ['reviewer', 'tests', 'lead', 'reviewer-tests'], ['reviewer', 'architecture', 'lead', 'reviewer-architecture'],
], 'the engineer hires the step\'s reviewers');
await assert.rejects(submit(t, LONG('Again')), /no step to submit/, 'nothing to submit while the reviewers work');
// Changes requested: the engineer revises in its own chat, with a fresh round.
for (const k of working(t)) await report(t, k, k.specialty === 'tests' ? 'Criterion 2 is untestable.\nVERDICT: CHANGES' : 'Fine.\nVERDICT: APPROVE');
assert.equal(t.stage, 'working');
assert.equal(currentStep(t).status, 'working');
assert.equal(working(t).length, 0);
await submit(t, LONG('## Plan v2\nCriterion 2 is now measurable.'));
assert.equal(t.steps[0].forum.round, 2);
for (const k of working(t)) await report(t, k, 'Good now.\nVERDICT: APPROVE');
assert.equal(t.steps[0].status, 'done');
assert.equal(currentStep(t).id, 'S2');
assert.equal(currentStep(t).evidenceAttempt, 1, 'execute may leave evidence');
// Skills: loading the step's skill is noted; another phase's skill is a detour the grove shows.
assert.equal(engine.noteSkill(t, 'grove-execute'), true);
assert.deepEqual(currentStep(t).skills, ['grove-execute']);
assert.equal(t.lead.phase, undefined);
assert.equal(engine.noteSkill(t, 'grove-agent-monitor:grove-research'), true, 'plugin-qualified names count');
assert.deepEqual(t.lead.phase.kind, 'research');
assert.equal(engine.noteSkill(t, 'some-other-skill'), false);
assert.equal(engine.noteSkill(t, 'grove-execute'), true, 'back to its own station');
assert.equal(t.lead.phase, undefined);
await submit(t, LONG('Changed the files; tests pass.'));
for (const k of working(t)) await report(t, k, 'Ship it.\nVERDICT: APPROVE');
assert.equal(currentStep(t).kind, 'verify');
assert.deepEqual(currentStep(t).skills, [], 'each step starts with no skills noted');
await assert.rejects(submit(t, LONG('All good')), /RESULT: PASS/);
await submit(t, `${LONG('Every criterion shown.')}\nRESULT: PASS`);
assert.equal(t.steps[2].verification.result, 'pass');
assert.equal(t.steps[2].verification.dir, '/board/T' + n + '/evidence/attempt-2');
assert.deepEqual(working(t).map((k) => k.specialty), ['tests']);
await report(t, working(t)[0], 'Evidence matches.\nVERDICT: APPROVE');
assert.equal(t.stage, 'routing', 'all steps done: the engineer delivers');
// A failed verification goes back to the engineer to decide what to redo.
t = task({ steps: [{ kind: 'verify' }] });
await submit(t, `${LONG('Broken.')}\nRESULT: FAIL`);
assert.equal(t.stage, 'routing');
assert.equal(t.feedback.at(-1).from, 'verification');

// ---- hold and resume: everyone stops, then picks up in the same place ----
t = task({ template: 'research' }, 'research');
engine.humanDecision({ taskId: t.id, action: 'hold', note: 'Wait for me' });
assert.equal(t.stage, 'on-hold');
assert.match(engine.decisionError(t, 'approve'), /nothing to approve/);
assert.match(engine.decisionError(t, 'retry'), /isn't blocked/);
engine.humanDecision({ taskId: t.id, action: 'resume' });
assert.equal(t.stage, 'working', 'the engineer carries on with its step');
// ... and a review that was open re-issues only the reviewers who hadn't voted.
await submit(t, LONG('## Answer 42'));
assert.equal(t.stage, 'reviewing');
const k1 = working(t)[0];
engine.humanDecision({ taskId: t.id, action: 'hold' });
assert.equal(k1.status, 'cancelled', 'open hires stop');
assert.equal(await engine.applyResult({ ticket: k1.id, token: k1.token, status: 'done', text: 'late\nVERDICT: APPROVE' }), false, 'late reports are ignored');
engine.humanDecision({ taskId: t.id, action: 'resume' });
assert.equal(t.stage, 'reviewing');
assert.deepEqual(working(t).map((k) => [k.role, k.specialty, k.round]), [['reviewer', 'accuracy', k1.round]]);

// ---- a reviewer is blocked on the human; "retry" continues in the same review ----
let k;
k = working(t)[0];
await report(t, k, 'Kusto said AADSTS700082; no data queried.\nBLOCKED: Run `az login --tenant 72f9` and tell the Chief of Staff');
assert.equal(t.stage, 'blocked');
assert.equal(k.status, 'blocked');
assert.equal(t.pause.need, 'Run `az login --tenant 72f9` and tell the Chief of Staff');
assert.equal(t.pause.by, 'Accuracy reviewer');
assert.equal(stageLabel(t), 'Blocked on you');
let actions = engine.humanActions([t]);
assert.equal(actions[0].kind, 'unblock');
assert.match(actions[0].text, /is blocked: Run `az login/);
engine.humanDecision({ taskId: t.id, action: 'retry', note: 'I logged in' });
assert.equal(t.stage, 'reviewing');
assert.equal(working(t)[0].specialty, 'accuracy', 'the blocked reviewer gets its work again');
assert.equal(t.feedback.at(-1).text, 'I logged in', 'the team sees what the human said');
// The engineer can report a blocker too; a blocked task can be put on hold instead, and resumed later.
t = task({ template: 'research' }, 'research');
assert.throws(() => engine.block(t.id, { need: 'x' }), /exactly what the human must do/);
engine.block(t.id, { need: 'Grant the bot write access to acme/app', reason: '403 on push' });
assert.equal(t.stage, 'blocked');
assert.equal(t.pause.by, 'Engineer');
engine.humanDecision({ taskId: t.id, action: 'hold' });
assert.equal(t.stage, 'on-hold');
assert.match(engine.decisionError(t, 'retry'), /isn't blocked/);
engine.humanDecision({ taskId: t.id, action: 'resume' });
assert.equal(t.stage, 'working');

// ---- questions and the status board ----
t = task({ template: 'research' }, 'research');
engine.humanDecision({ taskId: t.id, action: 'question', note: 'Did you consider insiders?' });
assert.equal(t.stage, 'working', 'a question doesn\'t stop the work');
assert.equal(engine.openQuestion(t).text, 'Did you consider insiders?');
engine.answer(t.id, 'Yes, insiders are split out.');
assert.equal(engine.openQuestion(t), null);
assert.throws(() => engine.answer(t.id, 'again'), /no open question/);
engine.postUpdate(t.id, 'Query is running.');
assert.equal(t.updates.at(-1).text, 'Query is running.');
assert.match(t.history.at(-1).text, /^Update: Query is running\./);

// ---- review churn: an unchanged revision escalates; no step reviews more than MAX_STEP_ROUNDS rounds ----
t = task({ steps: [{ kind: 'execute', reviewers: ['code'] }] });
await submit(t, LONG('Implemented v1'));
await report(t, working(t)[0], 'Needs a test.\nVERDICT: CHANGES');
assert.equal(t.stage, 'working');
await submit(t, LONG('Implemented v1'));
assert.equal(t.stage, 'escalated', 'the same output after "changes" would repeat the review');
assert.match(t.escalation.reason, /submitted the same execute/);
t = task({ steps: [{ kind: 'execute', reviewers: ['code'] }] });
for (let i = 1; ; i++) {
  await submit(t, LONG(`Implemented v${i}`));
  await report(t, working(t)[0], 'Still wrong.\nVERDICT: CHANGES');
  if (t.stage === 'escalated') {
    // The human sends it back (resetting the 3-round window); after MAX_STEP_ROUNDS rounds it always comes back to them.
    if (t.steps[0].forum.round >= MAX_STEP_ROUNDS) break;
    engine.humanDecision({ taskId: t.id, action: 'changes', note: 'Try another approach' });
    assert.equal(t.stage, 'working', 'back to the engineer');
  }
}
assert.equal(t.steps[0].forum.round, MAX_STEP_ROUNDS);
assert.match(t.escalation.reason, new RegExp(`after ${MAX_STEP_ROUNDS} review rounds on this step`));

// ---- the host's message limit: retry the same reviewer chat later, without counting an attempt ----
t = task({ steps: [{ kind: 'execute', reviewers: ['code'] }] });
await submit(t, LONG('Implemented'));
k = working(t)[0];
engine.authorizeHire({ marker: k.id, tool: 'create_session' });
engine.bindToolCall('c1', k.id);
engine.dispatchEnded({ toolCallId: 'c1', success: true, link: 'agent-host-session://ahp-session/L?chat=code' });
assert.equal(t.lead.link, 'agent-host-session://ahp-session/L', 'a reviewer\'s link names the engineer\'s session');
await report(t, k, 'Fix it.\nVERDICT: CHANGES');
await submit(t, LONG('Implemented, fixed'));
k = working(t)[0];
assert.deepEqual(engine.route(t, k), { tool: 'send_message', session: 'agent-host-session://ahp-session/L?chat=code' }, 'the same reviewer chat, so it remembers');
engine.authorizeHire({ marker: k.id, tool: 'send_message', target: 'agent-host-session://ahp-session/L?chat=code' });
engine.bindToolCall('c2', k.id);
engine.dispatchEnded({ toolCallId: 'c2', success: false, error: 'Refusing to send more messages: this session already used 102 of 100 allowed in the last 60 minutes.' });
assert.equal(t.members['reviewer-code'].status, 'alive', 'the chat isn\'t lost');
const retry = t.tickets.at(-1);
assert.equal(retry.attempt, k.attempt, 'not counted as a failed attempt');
assert.ok(retry.retryAt > Date.now() + RATE_LIMIT_BACKOFF_MS - 5000);
assert.equal(engine.issuedTickets([t]).length, 0, 'held back until the limit resets');
retry.retryAt = Date.now() - 1;
assert.equal(engine.issuedTickets([t]).length, 1);
engine.authorizeHire({ marker: retry.id, tool: 'send_message', target: 'agent-host-session://ahp-session/L?chat=code' });
engine.bindToolCall('c3', retry.id);
engine.dispatchEnded({ toolCallId: 'c3', success: false, error: 'Unknown chat owner: ahp-chat:/code' });
assert.equal(t.members['reviewer-code'].status, 'lost', 'a chat that is gone is replaced');
assert.deepEqual(engine.route(t, t.tickets.at(-1)), { tool: 'create_session' });

// ---- shipping ----
// Deliver a task's work; a code change opens its draft PR first (`draft`: the engineer's last line).
const deliver = async (steps, opts, draft = 'PR: https://github.com/acme/app/pull/9') => {
  const x = task(steps);
  while (x.stage === 'working') await submit(x, LONG('Done the thing'));
  engine.deliver(x.id, 'Summary of what was done for the human.', opts);
  if (x.stage === 'working') await submit(x, `Opened the draft.\n${draft}`);
  return x;
};
t = await deliver({ steps: [{ kind: 'research' }] });
assert.equal(t.delivery.ship, false, 'research isn\'t shipped');
assert.equal(t.ship, null, 'and gets no draft PR');
engine.humanDecision({ taskId: t.id, action: 'approve' });
assert.equal(t.stage, 'done');
t = await deliver({ steps: [{ kind: 'execute' }] }, { ship: false });
engine.humanDecision({ taskId: t.id, action: 'approve' });
assert.equal(t.stage, 'done', 'the lead said it isn\'t a PR');
// A code change goes to the human with a draft PR; a delivery that can't have one says why.
t = task({ steps: [{ kind: 'execute' }] });
await submit(t, LONG('Done the thing'));
engine.deliver(t.id, 'Summary of what was done for the human.', { ask: 'Approve, or keep the old name?' });
assert.equal(t.stage, 'working');
assert.equal(t.steps.at(-1).ship, 'draft');
assert.equal(t.steps.at(-1).evidenceAttempt, undefined, 'PR steps have no evidence folder');
assert.equal(t.delivery.ask, 'Approve, or keep the old name?');
assert.equal((await engine.checkStep(t, t.steps.at(-1), LONG('Opened it'))).ok, false, 'the draft PR step must give the PR');
assert.equal((await engine.checkStep(t, t.steps.at(-1), 'Nothing to commit.\nNO PR: the change is outside any git repository')).noPr, 'the change is outside any git repository');
await submit(t, 'Opened it.\nPR: https://github.com/acme/app/pull/8');
assert.equal(t.stage, 'awaiting-approval', 'then the human signs off');
assert.equal(t.ship.phase, 'draft');
assert.equal(t.ship.pr.number, 8);
actions = engine.humanActions([t]);
assert.deepEqual([actions[0].pr, actions[0].ask], [{ url: 'https://github.com/acme/app/pull/8', number: 8, draft: true }, 'Approve, or keep the old name?']);
assert.equal(engine.observePr(t, { state: 'OPEN', isDraft: true, statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' }] }), true, 'the draft\'s checks are recorded for the report');
assert.equal(t.stage, 'awaiting-approval', 'without moving the task');
assert.throws(() => engine.planSteps(t.id, { redoFrom: t.steps.at(-1).id }), /waiting on the human/);
t = await deliver({ steps: [{ kind: 'execute' }] }, undefined, 'NO PR: not a git repository');
assert.equal(t.stage, 'awaiting-approval');
assert.equal(t.ship.noPr, 'not a git repository');
assert.equal(engine.humanActions([t])[0].noPr, 'not a git repository');
engine.humanDecision({ taskId: t.id, action: 'approve' });
assert.equal(t.stage, 'done', 'a change with no possible PR is done when approved');
t = await deliver({ steps: [{ kind: 'execute' }] });
assert.equal(t.delivery.ship, true);
assert.match(engine.decisionError(t, 'note', 'x', { ship: false }), /ship only applies/);
engine.humanDecision({ taskId: t.id, action: 'approve', ship: false });
assert.equal(t.stage, 'done', 'the human can skip the PR');
// A finished task can be reopened.
engine.humanDecision({ taskId: t.id, action: 'changes', note: 'Also handle the empty state' });
assert.equal(t.stage, 'routing');
assert.equal(t.feedback.at(-1).text, 'Also handle the empty state');
// Ship: approval marks the draft ready, then Grove watches; a human "changes" while watching goes back to the
// lead; a closed PR escalates.
t = await deliver({ steps: [{ kind: 'execute' }] });
engine.humanDecision({ taskId: t.id, action: 'approve' });
assert.equal(t.steps.at(-1).title, 'Publish: mark PR #9 ready for review');
assert.equal((await engine.checkStep(t, t.steps.at(-1), LONG('Opened it'))).ok, false, 'the publish output must give the PR');
await assert.rejects(submit(t, 'Could not push.\nBLOCKED: Grant push access'), /call grove_blocked/);
await submit(t, 'Marked it ready.\nPR: https://github.com/acme/app/pull/9');
assert.equal(t.stage, 'watching');
assert.equal(stageLabel(t), 'Watching PR #9');
const open = { state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', headRefOid: 'a', statusCheckRollup: [] };
assert.equal(engine.applyPrStatus(t, open), true, 'first status is recorded');
assert.equal(engine.applyPrStatus(t, open), false, 'an unchanged PR changes nothing');
engine.applyPrStatus(t, { ...open, mergeable: 'CONFLICTING' });
assert.equal(t.stage, 'routing');
assert.deepEqual(t.ship.attention.problems, ['The branch has merge conflicts with its base']);
engine.deliver(t.id, 'Rebased onto main; conflicts resolved.');
assert.equal(t.stage, 'watching', 'delivering while shipping goes back to watching');
assert.equal(t.updates.at(-1).text, 'Rebased onto main; conflicts resolved.');
engine.applyPrStatus(t, { ...open, mergeable: 'CONFLICTING' });
assert.equal(t.stage, 'watching', 'the same problem on the same head isn\'t raised twice');
engine.humanDecision({ taskId: t.id, action: 'changes', note: 'Rename the setting' });
assert.equal(t.stage, 'routing');
assert.match(t.ship.attention.problems[0], /The human asked for changes: "Rename the setting"/);
assert.match(engine.decisionError(t, 'merge'), /no open pull request to merge/);
for (const s of t.steps) if (s.status === 'pending') s.status = 'skipped';
engine.advance(t);
assert.equal(t.stage, 'watching');
engine.applyPrStatus(t, { ...open, state: 'CLOSED' });
assert.equal(t.stage, 'escalated');
assert.match(t.escalation.reason, /PR #9 was closed without being merged/);
// Ready to merge, then not ready again (a new push restarted checks).
t = await deliver({ steps: [{ kind: 'execute' }] }, undefined, 'PR: https://github.com/acme/app/pull/10');
engine.humanDecision({ taskId: t.id, action: 'approve' });
await submit(t, 'PR: https://github.com/acme/app/pull/10');
engine.applyPrStatus(t, { ...open, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
assert.equal(t.stage, 'ready-to-merge');
actions = engine.humanActions([t]);
assert.equal(actions[0].kind, 'merge');
engine.applyPrStatus(t, { ...open, reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED', headRefOid: 'b', statusCheckRollup: [{ name: 'a', status: 'IN_PROGRESS' }] });
assert.equal(t.stage, 'watching');
// "approve" on a ready PR means merge.
engine.applyPrStatus(t, { ...open, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', headRefOid: 'b', statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
engine.humanDecision({ taskId: t.id, action: 'approve' });
assert.equal(t.stage, 'working');
assert.equal(t.steps.at(-1).ship, 'merge');
// Hold while shipping returns to watching.
t.steps.at(-1).status = 'done';
engine.advance(t);
engine.humanDecision({ taskId: t.id, action: 'hold' });
engine.humanDecision({ taskId: t.id, action: 'resume' });
assert.equal(t.stage, 'watching');

// ---- the shelf: set a task that waits on the human aside, then bring it back exactly where it was ----
t = await deliver({ steps: [{ kind: 'research' }] });
assert.equal(t.stage, 'awaiting-approval');
assert.match(engine.decisionError(t, 'unshelve'), /isn't on the shelf/);
engine.humanDecision({ taskId: t.id, action: 'shelve', note: 'Next week' });
assert.equal(t.stage, 'shelved');
assert.equal(stageLabel(t), 'On the shelf');
assert.deepEqual([t.shelf.from, t.shelf.note], ['awaiting-approval', 'Next week']);
assert.deepEqual(engine.humanActions([t]), [], 'off the human\'s inbox');
assert.match(engine.decisionError(t, 'shelve'), /already on the shelf/);
assert.match(engine.decisionError(t, 'hold'), /on the shelf; "hold" doesn't apply/);
assert.match(engine.decisionError(t, 'merge'), /no open pull request/, 'other answers are checked against where it was');
engine.humanDecision({ taskId: t.id, action: 'unshelve' });
assert.deepEqual([t.stage, t.shelf], ['awaiting-approval', null], 'back exactly where it was');
assert.equal(engine.humanActions([t])[0].kind, 'approve-result');
// Answering a shelved task takes it off the shelf: "changes" reruns it with the same engineer.
engine.humanDecision({ taskId: t.id, action: 'shelve' });
engine.humanDecision({ taskId: t.id, action: 'changes', note: 'Run it again with this week\'s data' });
assert.deepEqual([t.stage, t.shelf], ['routing', null]);
assert.equal(t.feedback.at(-1).text, 'Run it again with this week\'s data');
// Only tasks waiting on the human can be shelved; cancelling works from the shelf.
t = task({ steps: [{ kind: 'research' }] });
assert.match(engine.decisionError(t, 'shelve'), /only a task waiting on the human can be shelved/);
engine.block(t.id, { need: 'Run az login and tell the Chief of Staff' });
engine.humanDecision({ taskId: t.id, action: 'shelve' });
assert.equal(t.shelf.from, 'blocked');
engine.humanDecision({ taskId: t.id, action: 'retry', note: 'Logged in' });
assert.equal(t.stage, 'working', '"retry" applies straight from the shelf');
t = await deliver({ steps: [{ kind: 'research' }] });
engine.humanDecision({ taskId: t.id, action: 'shelve' });
engine.humanDecision({ taskId: t.id, action: 'cancel' });
assert.deepEqual([t.stage, t.shelf], ['cancelled', null]);
// A shelved PR is still watched: it stays shelved while it's fine, and comes off the shelf if it needs work.
t = await deliver({ steps: [{ kind: 'execute' }] }, undefined, 'PR: https://github.com/acme/app/pull/11');
engine.humanDecision({ taskId: t.id, action: 'approve' });
await submit(t, 'PR: https://github.com/acme/app/pull/11');
engine.applyPrStatus(t, { ...open, reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
assert.equal(t.stage, 'ready-to-merge');
engine.humanDecision({ taskId: t.id, action: 'shelve' });
engine.applyPrStatus(t, { ...open, reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ name: 'a', status: 'IN_PROGRESS' }] });
assert.deepEqual([t.stage, t.shelf.from], ['shelved', 'watching'], 'still shelved; it comes back to watching');
engine.applyPrStatus(t, { ...open, headRefOid: 'z', statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE' }] });
assert.deepEqual([t.stage, t.shelf], ['routing', null], 'a failing check takes it off the shelf, to the engineer');
assert.match(t.history.at(-1).text, /needs work, so it came off the shelf/);
t = await deliver({ steps: [{ kind: 'execute' }] }, undefined, 'PR: https://github.com/acme/app/pull/12');
engine.humanDecision({ taskId: t.id, action: 'shelve' });
assert.equal(engine.observePr(t, { state: 'OPEN', isDraft: true, statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }] }), true, 'a shelved draft PR is still observed for the report');
assert.equal(t.stage, 'shelved');

// ---- evidence from research and implementation steps ----
const evEngine = new ProcessEngine({
  board,
  selfId: 'lead',
  validateEvidence: async (dir) => (dir.includes('T90') ? { ok: true, dir, summary: 'Query and chart', items: [{ file: 'chart.png', caption: 'WAU by week', criterion: '', type: 'image/png' }] } : dir.includes('T91') ? { ok: false, reason: 'items[0] "x.txt" is not an allowed type' } : { ok: false, missing: true, reason: 'evidence.json is missing.' }),
});
const r1 = evEngine.createTask({ id: 'T90', title: 'Numbers', goal: 'g', criteria: [], kind: 'research' });
evEngine.planSteps('T90', { steps: [{ kind: 'research' }] });
assert.equal(r1.steps[0].evidenceAttempt, 1, 'research gets an evidence folder');
assert.equal(evEngine.stepEvidenceDir(r1, r1.steps[0]), '/board/T90/evidence/attempt-1');
await evEngine.submit('T90', 'S1', LONG('## Answer 42'));
assert.equal(r1.steps[0].evidence.items[0].caption, 'WAU by week');
assert.deepEqual(evEngine.evidenceGroups(r1).map((g) => [g.step, g.kind, g.items.length]), [['S1', 'research', 1]]);
const r2 = evEngine.createTask({ id: 'T91', title: 'Change', goal: 'g', criteria: [] });
evEngine.planSteps('T91', { steps: [{ kind: 'execute' }] });
assert.equal(r2.steps[0].evidenceAttempt, 1, 'execute too (numbered per task)');
await assert.rejects(evEngine.submit('T91', 'S1', LONG('Changed it')), /isn't valid: items\[0\] "x\.txt" is not an allowed type/, 'broken evidence is sent back');
const r3 = evEngine.createTask({ id: 'T92', title: 'Change', goal: 'g', criteria: [] });
evEngine.planSteps('T92', { steps: [{ kind: 'execute' }] });
assert.deepEqual(await evEngine.checkStep(r3, r3.steps[0], LONG('Changed it')), { ok: true }, 'no evidence is fine');
await assert.rejects(evEngine.submit('T92', 'S1', 'x'), /summary of what you did/);

// Task names: unique on a board (a numeral after a full lap), different starts per board, found by id or name.
{
  const { TASK_NAMES, taskName, taskLabel, findTask } = await import('../extensions/grove-agent-monitor/lib/process/names.mjs');
  assert.equal(new Set(TASK_NAMES.map((n) => n.slice(0, 4).toLowerCase())).size, TASK_NAMES.length, 'names start differently');
  const lap = Array.from({ length: TASK_NAMES.length }, (_, i) => taskName('board-a', i + 1));
  assert.equal(new Set(lap).size, TASK_NAMES.length, 'no repeats in a lap');
  assert.equal(taskName('board-a', TASK_NAMES.length + 1), `${lap[0]} II`);
  assert.equal(taskName('board-a', 2 * TASK_NAMES.length + 2), `${lap[1]} III`);
  assert.notEqual(taskName('board-a', 1), taskName('board-b', 1), 'boards start in different places');
  const tasks = [{ id: 'T1', name: 'Moonfern' }, { id: 'T2', name: 'Wisp II' }, { id: 'T3' }];
  assert.equal(taskLabel(tasks[0]), 'Moonfern (T1)');
  assert.equal(taskLabel(tasks[2]), 'T3', 'tasks from before names keep their id');
  for (const ref of ['T1', 't1', 'Moonfern', 'moonfern', ' "Moonfern." ', 'the Moonfern', 'Moonfern (T1)']) assert.equal(findTask(tasks, ref)?.id, 'T1', ref);
  assert.equal(findTask(tasks, 'wisp ii')?.id, 'T2');
  assert.equal(findTask(tasks, 'Glimmer'), null);
  assert.equal(findTask(tasks, 'T9'), null);
  // A task saved before names existed gets its name when the board loads, the same in every session.
  const old = new ProcessEngine({ board: { id: 'board-a', root: '/b', readTasks: async () => [{ id: 'T2', title: 'Old', steps: [], tickets: [] }, { id: 'T3', name: 'Kept', title: 'Named', steps: [], tickets: [] }] }, selfId: 'x' });
  await old.load();
  assert.deepEqual(old.state.tasks.map((t) => t.name), [taskName('board-a', 2), 'Kept']);
}

console.log('engine tests passed');
