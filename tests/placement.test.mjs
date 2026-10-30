// Run: node tests/placement.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  destination, engineerPlacement, observePlacement, gitIdentity, committedSnapshot,
  prepareReviewer, reviewerPlacement, reviewerMatches, confirmationForm,
} from '../extensions/grove-agent-monitor/lib/process/placement.mjs';

const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'grove-placement-test-')));
process.env.COPILOT_HOME = path.join(tmp, 'home');
const { GroveProcess } = await import('../extensions/grove-agent-monitor/lib/process/integration.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const processes = [];
const rows = [];
const evidence = (name, data) => { rows.push({ name, ...data }); console.log(`${name}: ${JSON.stringify(data)}`); };
let id = 0;
let callId = 0;

async function session(directory, link, existingId) {
  const sessionId = existingId ?? `placement-${++id}`;
  const listeners = [];
  const s = { sessionId, workspacePath: path.join(tmp, sessionId), workingDirectory: directory, on: (fn) => listeners.push(fn), send: async () => 'queued' };
  const p = new GroveProcess({ log: () => {}, onChange: () => {}, pollMs: 0, prPollMs: 0 });
  await p.attach(s);
  processes.push(p);
  const hooks = p.hooks();
  const tools = Object.fromEntries(p.tools().map((t) => [t.name, t]));
  const emit = (type, data) => listeners.forEach((fn) => fn({ type, data }));
  const call = async (name, args = {}, result) => {
    const toolCallId = `test-${++callId}`;
    emit('tool.execution_start', { toolCallId, toolName: name, arguments: args });
    const pre = await hooks.onPreToolUse({ toolName: name, toolArgs: args, sessionId });
    if (pre?.permissionDecision === 'deny') {
      emit('tool.execution_complete', { toolCallId, success: false, error: { message: 'Denied by preToolUse hook' } });
      return pre;
    }
    const output = tools[name] ? await tools[name].handler(pre?.modifiedArgs ?? args) : result;
    emit('tool.execution_complete', { toolCallId, success: output?.resultType !== 'failure', result: output });
    return output;
  };
  return { p, hooks, call, emit, s, link: link ?? `agent-host-session://ahp-session/${sessionId}` };
}

async function repository(name) {
  const root = path.join(tmp, name);
  await fs.mkdir(root);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  await fs.writeFile(path.join(root, 'source.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'base');
  return root;
}

try {
  const repo = await repository('repo');
  const other = await repository('other');
  const checkout = path.join(tmp, 'engineer');
  const review = path.join(tmp, 'reviewer');
  git(repo, 'worktree', 'add', '-b', 'feature', checkout);
  git(repo, 'worktree', 'add', '-b', 'review', review);
  const base = git(repo, 'rev-parse', 'HEAD');
  await fs.writeFile(path.join(checkout, 'source.txt'), 'feature\n');
  git(checkout, 'commit', '-am', 'feature');
  const sha = git(checkout, 'rev-parse', 'HEAD');
  assert.notEqual(base, sha);
  const newTask = { destination: { mode: 'new-worktree', workspace: repo } };
  const newArgs = engineerPlacement(newTask);
  assert.deepEqual(newArgs, { workspace: repo, worktree: true });
  newTask.placement = await observePlacement(newTask, checkout);
  assert.equal(newTask.placement.status, 'verified');
  assert.equal((await observePlacement(newTask, repo)).status, 'invalid');
  assert.equal((await observePlacement(newTask, other)).status, 'invalid');
  evidence('creation-routing-matrix', { mode: 'new-worktree', emitted: newArgs, actual: newTask.placement.directory, result: 'verified', host: 'SIMULATED + real Git fixture' });
  for (const mode of ['read-only', 'existing-worktree']) {
    const t = { destination: { mode, workspace: checkout } };
    assert.deepEqual(engineerPlacement(t), { workspace: checkout, worktree: false });
    assert.equal((await observePlacement(t, checkout)).status, 'verified');
    assert.equal((await observePlacement(t, repo)).status, 'invalid');
    evidence('creation-routing-matrix', { mode, emitted: engineerPlacement(t), redirectedToPrimary: 'rejected' });
  }
  assert.deepEqual(engineerPlacement({ destination: { mode: 'scratch' } }), {});
  const alias = path.join(tmp, 'alias');
  await fs.symlink(checkout, alias);
  assert.equal((await observePlacement({ destination: { mode: 'existing-worktree', workspace: pathToFileURL(alias).href } }, checkout)).status, 'verified');
  for (const invalid of [undefined, {}, { mode: 'scratch', workspace: repo }, { mode: 'new-worktree', workspace: 'relative' },
    { mode: 'new-worktree', workspace: `${repo}/../repo` }, { mode: 'read-only', workspace: '\0' }, { mode: 'scratch', worktree: true }]) {
    assert.throws(() => destination(invalid));
  }
  const unborn = path.join(tmp, 'unborn');
  await fs.mkdir(unborn);
  git(unborn, 'init');
  assert.equal((await observePlacement({ destination: { mode: 'new-worktree', workspace: unborn } }, unborn)).status, 'invalid');
  assert.equal((await observePlacement(newTask, path.join(tmp, 'missing'))).status, 'invalid');
  assert.equal((await observePlacement(newTask, undefined)).status, 'invalid');
  assert.equal((await observePlacement(newTask, path.join(checkout, 'source.txt'))).status, 'invalid');
  const ticket = { worktree: true, snapshot: sha, version: 1 };
  assert.deepEqual(reviewerPlacement(newTask, ticket), { workspace: checkout, worktree: true });
  assert.equal((await observePlacement(newTask, review, { reviewer: ticket })).status, 'invalid', 'same repository, wrong HEAD is rejected');
  await prepareReviewer(newTask, ticket, review);
  const verifiedReview = await observePlacement(newTask, review, { reviewer: ticket });
  assert.equal(verifiedReview.head, sha);
  assert.equal(verifiedReview.branch, 'HEAD');
  assert.equal(reviewerMatches(newTask, ticket, verifiedReview), true);
  assert.equal(reviewerMatches(newTask, { ...ticket, snapshot: base }, verifiedReview), false);
  assert.equal((await observePlacement(newTask, checkout, { reviewer: ticket })).status, 'invalid', 'cannot isolate into engineer checkout');
  assert.equal((await observePlacement(newTask, checkout, { reviewer: { worktree: false } })).status, 'verified');
  assert.equal((await observePlacement(newTask, review, { reviewer: { worktree: false } })).status, 'invalid');
  assert.equal(await committedSnapshot(checkout), sha);
  await fs.writeFile(path.join(checkout, 'source.txt'), 'dirty\n');
  await assert.rejects(committedSnapshot(checkout), /tracked changes/);
  await fs.writeFile(path.join(checkout, 'source.txt'), 'feature\n');
  git(checkout, 'update-index', '--refresh');
  await fs.writeFile(path.join(checkout, 'untracked.txt'), 'dirty\n');
  await assert.rejects(committedSnapshot(checkout), /untracked/);
  await fs.unlink(path.join(checkout, 'untracked.txt'));
  evidence('reviewer-placement-and-revision', { defaultHead: base, submitted: sha, actual: verifiedReview.head, branch: 'HEAD', staleHead: 'rejected', dirtyContent: 'rejected' });

  const chiefDir = path.join(tmp, 'chief-cwd');
  await fs.mkdir(chiefDir);
  const chief = await session(chiefDir);
  const create = (intent) => chief.call('grove_create_task', {
    title: 'Fixture', goal: `Do not infer the path ${repo} from prose`, kind: 'code', chiefSession: chief.link, destination: intent,
  });
  const initialRole = chief.p.role;
  assert.equal((await create(undefined)).resultType, 'failure');
  assert.equal(chief.p.role, initialRole, 'invalid destination does not allocate a board');
  const created = JSON.parse((await create({ mode: 'existing-worktree', workspace: checkout })).textResultForLlm);
  const before = JSON.stringify(chief.p.board.meta);
  const filesBefore = await fs.readdir(path.join(chief.p.board.root, 'tasks'));
  assert.equal((await create({ mode: 'scratch', workspace: chiefDir })).resultType, 'failure');
  assert.equal(JSON.stringify(chief.p.board.meta), before);
  assert.deepEqual(await fs.readdir(path.join(chief.p.board.root, 'tasks')), filesBefore);
  const prompt = created.handoff.prompt;
  const corrected = await chief.hooks.onPreToolUse({ toolName: 'create_session', toolArgs: { title: 'x', prompt, workspace: chiefDir, worktree: true } });
  assert.equal(corrected.modifiedArgs.workspace, checkout);
  assert.equal(corrected.modifiedArgs.worktree, false);
  assert.equal((await chief.hooks.onPreToolUse({ toolName: 'create_session', toolArgs: { title: 'x', prompt: prompt.replace(/\/[a-f0-9]+\]/, '/deadbeef]') } })).permissionDecision, 'deny');
  assert.equal(await chief.hooks.onPreToolUse({ toolName: 'create_session', toolArgs: { title: 'x', prompt: 'unrelated' } }), undefined);
  for (const intent of [{ mode: 'new-worktree', workspace: repo }, { mode: 'read-only', workspace: repo }, { mode: 'scratch' }]) {
    const launch = JSON.parse((await create(intent)).textResultForLlm).handoff;
    const pre = await chief.hooks.onPreToolUse({ toolName: 'create_session', toolArgs: { ...launch, workspace: chiefDir, worktree: false } });
    assert.deepEqual(pre.modifiedArgs, launch, 'returned handoff and hook share one exact routing contract');
  }
  evidence('destination-validation-atomicity', { metadataUnchanged: true, taskFilesUnchanged: true, prosePathIgnored: true });
  let eng = await session(repo);
  await eng.hooks.onUserPromptSubmitted({ prompt });
  let t = eng.p.leadTask();
  assert.equal(t.placement.status, 'invalid', 'simulate host canonicalization to primary');
  assert.equal((await eng.call('bash')).permissionDecision, 'deny');
  assert.equal((await eng.call('get_current_session', {}, { workingDirectory: pathToFileURL(repo).href })).permissionDecision, undefined);
  assert.throws(() => eng.p.engine.requirePlacement(t), /Host attached/);
  for (const toolName of ['ask_user', 'set_workspace', 'isolate_session', 'move_session']) {
    assert.equal((await eng.call(toolName, { workspaceFolder: checkout, isolation: false })).permissionDecision, 'deny', toolName);
  }
  assert.equal((await eng.call('grove_record_decision', { taskId: t.id, decision: 'note', note: 'self repair', workspaceRepair: true })).resultType, 'failure');
  await eng.p.board.flush();
  const authorize = async () => {
    const r = await chief.call('grove_record_decision', { taskId: t.id, decision: 'note', note: 'The human explicitly requested repair.', workspaceRepair: true });
    assert.equal(r.resultType, 'success', r.textResultForLlm);
    await eng.p.applyLeadDecisions({ wake: false });
    return eng.p.leadTask().workspaceRepair.target;
  };
  const confirm = async (target, answer = true) => eng.call('ask_user', {
    message: 'Confirm the authorized workspace repair.',
    requestedSchema: { properties: { workspaceConfirmation: confirmationForm(target) } },
  }, { workspaceConfirmation: answer });
  let target = await authorize();
  assert.equal((await confirm(target, false)).permissionDecision, undefined);
  assert.equal((await eng.call('set_workspace', target)).permissionDecision, 'deny', 'negative consent');
  target = await authorize();
  await confirm(target);
  await eng.call('get_current_session', {}, { workingDirectory: repo });
  assert.equal((await eng.call('set_workspace', target)).permissionDecision, 'deny', 'intervening tool');
  target = await authorize();
  await confirm(target);
  assert.equal((await eng.call('set_workspace', { ...target, isolation: true })).permissionDecision, 'deny', 'wrong isolation');
  target = await authorize();
  await confirm(target);
  await eng.call('isolate_session');
  assert.equal((await eng.call('set_workspace', target)).permissionDecision, 'deny', 'even denied intervening tools invalidate consent');
  target = await authorize();
  await confirm(target);
  await eng.call('ask_user', {});
  assert.equal((await eng.call('set_workspace', target)).permissionDecision, 'deny', 'unrelated forms invalidate consent');
  target = await authorize();
  await eng.call('ask_user', {
    message: 'Confirm the authorized workspace repair.',
    requestedSchema: { properties: { workspaceConfirmation: confirmationForm(target) } },
  });
  assert.equal((await eng.call('set_workspace', target)).permissionDecision, 'deny', 'missing affirmative tool response cannot bypass consent');
  target = await authorize();
  await confirm(target);
  eng.p.leadTask().workspaceRepair.sessionId = 'another-owner';
  assert.equal((await eng.call('set_workspace', target)).permissionDecision, 'deny', 'stale owner authority');
  target = await authorize();
  await eng.p.dispose();
  eng = await session(repo, eng.link, eng.s.sessionId);
  t = eng.p.leadTask();
  assert.equal(t.workspaceRepair, undefined, 'restart before confirmation invalidates persisted repair authority');
  assert.equal((await confirm(target)).permissionDecision, 'deny', 'old decision cannot restore a repair form after restart');
  target = await authorize();
  await confirm(target);
  await eng.p.dispose();
  eng = await session(repo, eng.link, eng.s.sessionId);
  t = eng.p.leadTask();
  assert.equal((await eng.call('set_workspace', target)).permissionDecision, 'deny', 'restart after affirmative confirmation invalidates consent');
  assert.equal((await confirm(target)).permissionDecision, 'deny', 'restart after confirmation also requires fresh Chief authority');
  target = await authorize();
  await confirm(target);
  assert.deepEqual(await eng.call('set_workspace', target, { success: true }), { success: true }, 'one matching immediate repair passes through');
  assert.equal((await eng.call('set_workspace', target)).permissionDecision, 'deny', 'one use');
  eng.s.workingDirectory = checkout;
  await eng.hooks.onUserPromptSubmitted({ prompt: 'Host completed attachment', workingDirectory: checkout });
  assert.equal(await eng.call('bash'), undefined);
  assert.equal(t.placement.status, 'verified');
  const unchanged = await fs.readFile(eng.p.board.taskFile(t.id), 'utf8');
  await eng.call('view');
  await eng.call('bash');
  assert.equal(await fs.readFile(eng.p.board.taskFile(t.id), 'utf8'), unchanged, 'ordinary calls do not rewrite unchanged placement');
  git(checkout, 'checkout', '--detach');
  assert.equal(await eng.call('bash'), undefined, 'detached HEAD within the verified checkout does not deadlock Git recovery');
  assert.notEqual(t.stage, 'blocked');
  await eng.p.dispose();
  eng = await session(checkout, eng.link, eng.s.sessionId);
  t = eng.p.leadTask();
  assert.equal(await eng.call('bash'), undefined, 'same-owner restart during detached Git work remains usable');
  assert.equal(t.placement.branch, 'HEAD');
  assert.notEqual(t.stage, 'blocked');
  git(checkout, 'checkout', '-b', 'continued-feature');
  assert.equal(await eng.call('bash'), undefined, 'branch changes within the same checkout remain allowed');
  await eng.p.checkPlacement({ force: true });
  assert.equal(t.placement.branch, 'continued-feature', 'boundary observation records branch change without treating it as placement failure');
  evidence('placement-git-operation-freedom-and-cache', { detachedHead: 'bash allowed', detachedRestart: 'bash allowed',
    newBranch: 'verified at boundary', ordinaryCalls: 'no task-file rewrites' });
  evidence('workspace-repair-authority-and-consent', { selfAuthority: 'denied', no: 'denied', interveningTool: 'denied', wrongIsolation: 'denied',
    restartBeforeForm: 'old authority denied', restartAfterYes: 'old consent denied', yesImmediate: 'allowed once', repaired: t.placement.directory });

  const scratchLaunch = JSON.parse((await create({ mode: 'scratch' })).textResultForLlm).handoff;
  const workspaceless = await session(undefined);
  await workspaceless.hooks.onUserPromptSubmitted({ prompt: scratchLaunch.prompt });
  assert.equal((await workspaceless.call('bash')).permissionDecision, 'deny', 'unknown cwd is not private-scratch proof');
  const ownScratch = path.join(tmp, 'own-scratch');
  await fs.mkdir(ownScratch);
  await workspaceless.call('get_current_session', {}, { workingDirectory: pathToFileURL(ownScratch).href });
  assert.equal(await workspaceless.call('bash'), undefined, 'current-session metadata is engineer fallback');
  assert.equal(workspaceless.p.leadTask().placement.directory, ownScratch);
  await workspaceless.hooks.onUserPromptSubmitted({ prompt: 'Fresh per-chat cwd', workingDirectory: chiefDir });
  assert.equal((await workspaceless.call('bash')).permissionDecision, 'deny', 'fresh hook overrides stale metadata and rejects Chief scratch reuse');
  evidence('placement-gates-and-recovery', { unknown: 'denied', metadataFallback: 'verified', perChatHookPrecedence: 'Chief reuse rejected' });

  // Engine methods also refuse delivery/review dispatch while unverified.
  t.placement.status = 'invalid';
  assert.throws(() => eng.p.engine.deliver(t.id, 'A sufficiently long report for delivery'), /attachment|Host|unknown/i);
  t.placement = await observePlacement(t, checkout);
  eng.p.engine.planSteps(t.id, { steps: [{ kind: 'execute', reviewers: [{ name: 'code', worktree: true }] }] });
  await fs.writeFile(path.join(checkout, 'source.txt'), 'uncommitted\n');
  await assert.rejects(eng.p.engine.submit(t.id, undefined, 'Code changes with enough detail for the execute contract. '.repeat(3)), /tracked changes/);
  await fs.writeFile(path.join(checkout, 'source.txt'), 'feature\n');
  git(checkout, 'update-index', '--refresh');
  await eng.p.engine.submit(t.id, undefined, 'Code changes with enough detail for the execute contract. '.repeat(3));
  let k = t.tickets.at(-1);
  assert.equal(k.snapshot, sha);
  assert.equal(k.worktree, true);
  assert.equal(k.version, 1);
  const { hireInstruction } = await import('../extensions/grove-agent-monitor/lib/process/prompts.mjs');
  let h = hireInstruction(t, k, { boardId: eng.p.board.id, route: eng.p.engine.route(t, k) });
  assert.deepEqual({ relationship: h.relationship, workspace: h.workspace, worktree: h.worktree }, { relationship: 'currentSession', workspace: checkout, worktree: true });
  await eng.p.board.flush();
  await fs.writeFile(path.join(review, 'source.txt'), 'dirty at bind\n');
  let dirtyAtBind = await session(review, `${eng.link}?chat=dirty-at-bind`);
  await dirtyAtBind.hooks.onUserPromptSubmitted({ prompt: h.prompt, workingDirectory: review });
  assert.equal((await dirtyAtBind.call('view')).permissionDecision, 'deny', 'dirty isolated checkout is gated even when HEAD matches');
  await fs.writeFile(path.join(review, 'source.txt'), 'feature\n');
  git(review, 'update-index', '--refresh');
  assert.equal((await dirtyAtBind.call('view')).permissionDecision, 'deny', 'preparation failure stays blocking until a fresh assignment');
  await eng.p.engine.applyResult(await eng.p.board.readResult(k.id));
  await eng.p.board.flush();
  await dirtyAtBind.p.dispose();
  dirtyAtBind = await session(review, dirtyAtBind.link, dirtyAtBind.s.sessionId);
  assert.equal((await dirtyAtBind.call('view')).permissionDecision, 'deny', 'reviewer restart cannot discard preparation failure');
  assert.equal((await dirtyAtBind.p.engine.checkOutput(t, k, 'BLOCKED: Human must resolve the failed checkout setup.')).blocked,
    'Human must resolve the failed checkout setup.', 'reviewer human prerequisites use the BLOCKED report contract');
  await dirtyAtBind.p.finishWork('done', { text: 'VERDICT: APPROVE' });
  assert.equal(await eng.p.engine.applyResult(await eng.p.board.readResult(k.id)), true);
  assert.equal(k.status, 'failed', 'failed preparation cannot approve a submission');
  k = t.tickets.at(-1);
  h = hireInstruction(t, k, { boardId: eng.p.board.id, route: eng.p.engine.route(t, k) });
  await eng.p.board.flush();
  const dirtyAfterSetup = await session(review, `${eng.link}?chat=dirty-after-setup`);
  await dirtyAfterSetup.hooks.onUserPromptSubmitted({ prompt: h.prompt, workingDirectory: review });
  const priorClean = dirtyAfterSetup.p.memberPlacement;
  assert.equal(priorClean.clean, true);
  await fs.writeFile(path.join(review, 'source.txt'), 'dirty after setup\n');
  assert.equal((await dirtyAfterSetup.call('view')).permissionDecision, 'deny', 'content changes after setup gate isolated work');
  await dirtyAfterSetup.p.finishWork('done', { text: 'VERDICT: APPROVE' });
  const staleCleanReport = { ...await eng.p.board.readResult(k.id), placement: priorClean };
  await eng.p.engine.applyResult(staleCleanReport);
  assert.equal(k.status, 'failed', 'acceptance rechecks content rather than trusting stale clean metadata');
  await fs.writeFile(path.join(review, 'source.txt'), 'feature\n');
  git(review, 'update-index', '--refresh');
  k = t.tickets.at(-1);
  h = hireInstruction(t, k, { boardId: eng.p.board.id, route: eng.p.engine.route(t, k) });
  await eng.p.board.flush();
  const member = await session(review, `${eng.link}?chat=reviewer`);
  await member.hooks.onUserPromptSubmitted({ prompt: h.prompt, workingDirectory: review });
  assert.equal(await member.call('view'), undefined);
  for (const name of ['ask_user', 'set_workspace', 'isolate_session', 'move_session']) assert.equal((await member.call(name)).permissionDecision, 'deny');
  member.p.currentWork().ticket.version += 100;
  await member.p.beat(true);
  assert.equal((await eng.p.board.readResult(k.id)).submissionVersion, k.version, 'heartbeat echoes the assigned version rather than refreshed ticket data');
  await member.p.finishWork('done', { text: 'Please revise the code.\nVERDICT: CHANGES' });
  const stored = await eng.p.board.readResult(k.id);
  assert.equal(stored.version, 2, 'storage format version must not collide with submission version');
  assert.equal(stored.submissionVersion, k.version, 'verdict echoes the independently captured assignment version');
  assert.equal(stored.placement.head, sha);
  assert.equal(await eng.p.engine.applyResult(stored), true);
  assert.equal(k.status, 'done', 'matching pinned review accepted');
  assert.equal(t.stage, 'working');
  await fs.writeFile(path.join(checkout, 'source.txt'), 'revision two\n');
  git(checkout, 'commit', '-am', 'revision two');
  const sha2 = git(checkout, 'rev-parse', 'HEAD');
  t.placement = await observePlacement(t, checkout);
  await eng.p.engine.submit(t.id, undefined, 'Revised code and tests, with enough detail for another review. '.repeat(3));
  const k2 = t.tickets.at(-1);
  assert.equal(k2.version, 2);
  assert.equal(k2.snapshot, sha2);
  assert.notEqual(k2.snapshot, k.snapshot);
  await eng.p.engine.applyResult({ ticket: k2.id, token: k2.token, status: 'done', text: 'VERDICT: APPROVE', placement: verifiedReview, submissionVersion: 2 });
  assert.notEqual(k2.status, 'done', 'same repository but previous submission HEAD cannot be accepted');
  assert.equal(await eng.p.engine.applyResult(stored), false, 'completed old tickets cannot approve a new version');
  await eng.p.board.flush();
  const recovery = JSON.parse((await chief.call('grove_handoff', { taskId: t.id })).textResultForLlm).handoff;
  assert.equal(recovery.workspace, checkout);
  assert.equal(recovery.worktree, false, 'continuation recovery retains actual checkout, not another worktree');
  const old = { key: k.member, title: 'Code reviewer', role: 'reviewer', link: member.link, status: 'alive', worktree: false };
  t.members[k.member] = old;
  assert.equal(eng.p.engine.route(t, k2).tool, 'create_session', 'mode switch requires fresh hire');
  const retry = t.tickets.at(-1);
  const retryHire = hireInstruction(t, retry, { boardId: eng.p.board.id, route: eng.p.engine.route(t, retry) });
  const failed = await eng.call('create_session', retryHire, { resultType: 'failure', content: 'Provider rejects per-chat worktree creation.' });
  assert.equal(failed.resultType, 'failure');
  assert.notEqual(retry.status, 'done', 'unsupported provider cannot count as a review');
  assert.equal(t.tickets.at(-1).worktree, true, 'retry preserves explicit isolation rather than silently sharing');
  assert.equal(t.tickets.at(-1).snapshot, sha2);
  const waiting = t.tickets.at(-1);
  await eng.p.engine.applyResult({ ticket: waiting.id, token: waiting.token, status: 'done',
    text: 'BLOCKED: Enable supported per-chat worktree creation.', submissionVersion: waiting.version,
    placement: { status: 'invalid', error: 'Unsupported provider' } });
  assert.equal(t.stage, 'blocked', 'unverified reviewers can report a human prerequisite, not approve code');
  assert.match(t.pause.need, /per-chat worktree/);
  evidence('reviewer-placement-and-revision', { pinnedVersion: k2.version, matchingReport: 'accepted', oldVersionReport: 'rejected',
    dirtyAtBind: 'work denied; approval rejected', dirtyAfterSetup: 'work denied; stale clean report rejected',
    modeSwitch: 'new hire', emitted: { workspace: h.workspace, worktree: h.worktree } });

  // A legacy board retains previous reports/votes rather than inventing destination.
  const report = 'Preserved legacy approved output';
  const legacy = chief.p.engine.createTask({ id: 'T99', title: 'Legacy', goal: 'legacy' });
  legacy.steps = [{ id: 'S1', status: 'done', output: report, version: 1, kind: 'research', reviewers: [], forum: { posts: [{ verdict: 'approve' }] } }];
  chief.p.engine.changed(legacy, null);
  await chief.p.board.flush();
  const reload = await session(chiefDir);
  await reload.p.engine.load();
  const loaded = reload.p.engine.state.tasks.find((x) => x.id === 'T99');
  assert.equal(loaded.steps[0].output, report);
  assert.equal(loaded.steps[0].forum.posts[0].verdict, 'approve');
  assert.equal(loaded.destination, undefined);
  const handoff = await chief.call('grove_handoff', { taskId: 'T99' });
  assert.equal(handoff.resultType, 'failure');
  evidence('legacy-routing-preservation', { reportPreserved: true, votePreserved: true, missingRecoveryDestination: 'explicit failure' });
  console.log('placement tests passed');
} finally {
  await Promise.all(processes.map((p) => p.dispose()));
  await fs.rm(tmp, { recursive: true, force: true });
}
