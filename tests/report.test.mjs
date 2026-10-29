// Run: node tests/report.test.mjs
// The task report (a static page Grove writes for the human) and the canvas routes that serve it, its
// evidence and the Chief's inbox actions.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { markdown, renderReport, evidenceRel } from '../extensions/grove-agent-monitor/lib/process/report.mjs';
import { GroveRuntime } from '../extensions/grove-agent-monitor/lib/runtime.mjs';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-report-test-'));

// ---- markdown: a safe subset ----
const md = (s) => markdown(s, { taskDir: '/board/T1' });
assert.equal(md('Hello <script>alert(1)</script>'), '<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>', 'HTML is escaped');
assert.equal(md('[x](javascript:alert)'), '<p>x</p>', 'unsafe links lose their href');
assert.doesNotMatch(md('[x](javascript:alert(1)) [y](data:text/html,1)'), /href/);
assert.equal(md('[docs](https://example.com/a?b=1&c=2)'), '<p><a href="https://example.com/a?b=1&amp;c=2">docs</a></p>');
assert.equal(md('see [shot](</board/T1/evidence/attempt-1/a b.png>)'), '<p>see <a href="evidence/attempt-1/a%20b.png">shot</a></p>', 'task files link relatively');
assert.equal(md('[log](/tmp/x.log)'), '<p><a href="file:///tmp/x.log">log</a></p>');
assert.equal(md('**bold** and *it* and `a<b`'), '<p><strong>bold</strong> and <em>it</em> and <code>a&lt;b</code></p>');
assert.equal(md('# Title\n\ntext'), '<h3>Title</h3>\n<p>text</p>');
assert.equal(md('- a\n  - b\n- c'), '<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>');
assert.equal(md('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
assert.equal(md('- [x] done\n- [ ] todo'), '<ul><li class="check"><span class="box">☑</span> done</li><li class="check"><span class="box">☐</span> todo</li></ul>');
assert.equal(md('| a | b |\n|---|:-:|\n| 1 | <i> |'), '<div class="table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>&lt;i&gt;</td></tr></tbody></table></div>');
assert.equal(md('```\n<b>x</b>\n```'), '<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
assert.equal(md('> quoted'), '<blockquote><p>quoted</p></blockquote>');
assert.equal(md('line one\nline two'), '<p>line one<br>line two</p>');
assert.match(md('go to https://x.dev/a.'), /<a href="https:\/\/x\.dev\/a">https:\/\/x\.dev\/a<\/a>\./);

// ---- the report ----
const root = path.join(tmp, 'board');
const evDir = path.join(root, 'T1', 'evidence', 'attempt-2');
await fs.mkdir(evDir, { recursive: true });
await fs.writeFile(path.join(evDir, 'after.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
await fs.writeFile(path.join(evDir, 'flow.webm'), Buffer.alloc(4096, 7));
const at = Date.UTC(2026, 9, 26, 18, 0);
const task = {
  id: 'T1', title: 'Add <dark> mode', goal: 'Users want dark mode.', criteria: ['Toggle in settings', 'Persists across reloads'],
  stage: 'awaiting-approval', createdAt: at, updatedAt: at,
  delivery: { summary: 'Dark mode ships.\n\n- toggle\n- persisted', decisions: ['Kept light as default'], at, n: 1 },
  feedback: [{ from: 'human', at, text: 'Contrast too low' }],
  members: { 'reviewer-security': { key: 'reviewer-security', role: 'reviewer', specialty: 'security' }, 'reviewer-tests': {} },
  tickets: [{ id: 'T1-rev-security-1', role: 'reviewer', specialty: 'security', step: 'S1' }],
  history: [{ at, text: 'Task created: Add <dark> mode' }],
  escalation: null,
  steps: [
    { id: 'S1', kind: 'plan', title: 'Plan the work', status: 'done', version: 2, output: '## Plan\n1. Add toggle', reviewers: [{ name: 'security' }],
      forum: { round: 2, windowStart: 0, posts: [
        { author: 'Security reviewer', role: 'security', kind: 'review', verdict: 'changes', round: 1, at, text: 'XSS?' },
        { author: 'Security reviewer', role: 'security', kind: 'review', verdict: 'approve', round: 2, at, text: 'OK now' },
      ] }, verification: null },
    { id: 'S2', kind: 'verify', title: 'Verify', status: 'done', version: 1, output: 'All pass', reviewers: [], forum: { round: 0, windowStart: 0, posts: [] },
      verification: { result: 'pass', summary: 'Both criteria shown.', dir: evDir, items: [
        { file: 'after.png', caption: 'Settings <toggle>', criterion: 'Toggle in settings', type: 'image/png' },
        { file: 'flow.webm', caption: 'Reload keeps it', criterion: '2', type: 'video/webm' },
      ] } },
    { id: 'S3', kind: 'execute', title: 'Dropped', status: 'skipped', version: 0, output: '', reviewers: [], forum: { round: 0, windowStart: 0, posts: [] }, verification: null },
  ],
};
assert.equal(evidenceRel(task, task.steps[1].verification, 'after.png'), 'evidence/attempt-2/after.png');
assert.equal(evidenceRel(task, { dir: '/elsewhere/x' }, 'a.png'), null);
const html = renderReport(task, { root, boardId: 'b1', color: 'teal1', now: at });
// The task's name sits in the line above its title, so the title keeps its room.
{
  const named = renderReport({ ...task, name: 'Moonfern' }, { root, boardId: 'b1', color: 'teal1', now: at });
  assert.match(named, /<p class="eyebrow">Grove · Task report · <span class="task-name">Moonfern<\/span> · T\d+<\/p>\s*<h1>/);
  assert.match(named, /<title>Moonfern · /);
  assert.match(html, /<p class="eyebrow">Grove · Task report · T\d+<\/p>/, 'no name, just the id');
}
const section = (h, id) => (new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(h) ?? [''])[0];
const order = (h) => [...h.matchAll(/<section[^>]*id="([a-z]+)"/g)].map((m) => m[1]);
assert.match(html, /<title>T1 · Add &lt;dark&gt; mode — Grove report<\/title>/);
assert.match(html, /--task:#2ee0b0/);
assert.doesNotMatch(html, /<script/i, 'no scripts');
// The standard shape: your move and summary first, then evidence, criteria, decisions, result, how it was done.
assert.deepEqual(order(html), ['top', 'evidence', 'criteria', 'decisions', 'result', 'steps', 'log']);
let top = section(html, 'top');
assert.match(top, /<p class="kicker">Your move<\/p><h2 class="action">Check the result and sign it off<\/h2>/, 'the top says what the human must do');
assert.match(top, /<p class="kicker">Summary<\/p><div class="summary"><p>Dark mode ships\.<\/p>/);
assert.match(top, /<li><a href="#evidence">2 pieces of evidence<\/a><\/li>/);
assert.match(top, /Criteria shown: <span class="ok">2 of 2<\/span>/);
assert.match(top, /Verification: <span class="ok">passed<\/span>/);
// Evidence: images (click to enlarge) and recordings, with what they prove.
const ev = section(html, 'evidence');
assert.match(ev, /<a class="view" href="#ev-1" aria-label="Enlarge: Settings &lt;toggle&gt;"><img loading="lazy" src="evidence\/attempt-2\/after\.png" alt="Settings &lt;toggle&gt;"><\/a>/);
assert.match(ev, /<span class="kindtag">Recording<\/span>/);
assert.match(ev, /<video controls preload="metadata" src="evidence\/attempt-2\/flow\.webm"/);
assert.match(ev, /<span class="proves">Proves: Persists across reloads<\/span>/, 'a numbered criterion shows its text');
assert.match(html, /<div class="lightbox" id="ev-1" role="dialog"/);
assert.match(section(html, 'criteria'), /<li class="proven"><span class="mark"><span>✓<\/span><\/span><div><div>Persists across reloads<\/div><div class="proof"><a href="evidence\/attempt-2\/flow\.webm">Reload keeps it<\/a>/, 'evidence can name a criterion by number');
assert.match(section(html, 'decisions'), /<span class="who lead">Engineer<\/span><span>Kept light as default/);
assert.match(section(html, 'decisions'), /<b>S1 · Plan<\/b>: Approved unanimously after 2 rounds/);
assert.match(section(html, 'decisions'), /<span class="who you">You<\/span><span>Contrast too low/);
assert.match(section(html, 'result'), /Result<span class="sub">S1 · Plan<\/span>/, 'the result is the last non-verify output');
assert.doesNotMatch(html, /Dropped/, 'skipped steps are left out');
assert.match(section(html, 'steps'), /<ul class="team" aria-label="The team">/);
assert.match(html, /<svg class="sprite[^"]*" viewBox="0 0 24 32"[^>]*><title>Engineer<\/title><use href="#gv-mage-a-0-dusk"\/>/, 'the engineer and its reviewers appear as their grove sprites');
assert.match(html, /<title>Security reviewer<\/title><use href="#gv-seer-a-0-rose"\/>/);
assert.match(html, /<title>Tests reviewer<\/title><use href="#gv-seer-a-0-teal"\/>/);
assert.match(html, /<symbol id="gv-mage-a-0-dusk" viewBox="0 0 24 32"><path fill="#/);
assert.match(section(html, 'steps'), /<title>Plan station<\/title><use href="#gv-star-table-[^"]*-active"\/>[\s\S]*<div class="meta">Engineer · /, 'each step shows its workstation, and the engineer did it');
assert.doesNotMatch(html, /scribe|artificer|warden|scout/, 'no persona sprites');
// Each step's station fits its 64px slot at a whole-pixel scale (the table is 50px wide, so 1×), so it never
// runs under the text.
for (const m of section(html, 'steps').matchAll(/<span class="step-art"><svg class="sprite[^"]*" viewBox="0 0 (\d+) (\d+)" width="(\d+)" height="(\d+)"/g)) {
  const [w, h, sw, sh] = m.slice(1).map(Number);
  assert.ok(sw <= 64 && sh <= 64, `a step's station fits its slot (${sw}×${sh})`);
  assert.equal(sw % w, 0, 'whole-pixel scale');
  assert.equal(sw / w, sh / h);
}
assert.match(section(html, 'steps'), /<span class="step-art"><svg class="sprite" viewBox="0 0 50 26" width="50" height="26"/);
// Steps and the summons are pixel-art scrolls (rolled rods, knobs, pixel seal), not smooth gradients or a coloured stripe.
const { reportCss } = await import('../extensions/grove-agent-monitor/lib/process/report-theme.mjs');
const css = reportCss();
for (const sel of ['.rod', '.parchment', '.seal', '.step', '.step::before, .step::after']) {
  const at = css.indexOf(`\n${sel} {`);
  assert.ok(at >= 0, `${sel} rule exists`);
  assert.doesNotMatch(css.slice(at, css.indexOf('}', at)), /(linear|radial)-gradient/, `${sel} is pixel art, not a gradient`);
}
assert.match(css, /\.step::before, \.step::after \{[^}]*var\(--end-l\)[^}]*var\(--end-r\)/, 'step rods use per-status ends');
assert.match(css, /\.step\.working, \.step\.reviewing \{ --end-l: url\("data:image\/svg\+xml/, 'in-progress steps swap knobs');
assert.match(css, /shape-rendering[^"]*crispEdges/, 'scroll art is crisp');
assert.doesNotMatch(reportCss(), /\.step\.done \{ box-shadow: inset 3px 0 0 var\(--teal\)/, 'no green stripe');
// Escalated: the decision and each reviewer's position are at the top.
top = section(renderReport({ ...task, stage: 'escalated', delivery: null, escalation: { step: 'S1', reason: 'No unanimous agreement after 3 rounds.' } }, { root }), 'top');
assert.match(top, /<h2 class="action">Decide how S1 · Plan goes on<\/h2>/);
assert.match(top, /No unanimous agreement after 3 rounds\. Accept it as it is, send it back with direction, or cancel the task\./);
assert.match(top, /<li><b>Security reviewer<\/b> <span class="v-approve">approves<\/span>: OK now<\/li>/);
assert.match(top, /<p class="kicker">The task<\/p><div class="summary"><p>Users want dark mode\.<\/p>/);

// A code change: the engineer's ask and the draft PR are at the top; the PR has its own section.
const code = {
  ...task, stage: 'awaiting-approval',
  delivery: { ...task.delivery, ship: true, ask: 'Approve, or say if the toggle belongs in the *View* menu.' },
  ship: { phase: 'draft', pr: { url: 'https://github.com/acme/app/pull/77', repo: 'acme/app', number: 77, state: 'OPEN', draft: true, mergeable: 'MERGEABLE', checks: { passed: 3, skipped: 1, pending: 2, failed: [{ name: 'lint', url: 'https://ci/lint' }] }, checkedAt: at } },
  updates: [{ at, text: 'Published <PR>.' }, { at: at + 1, text: 'CI green.' }],
  questions: [{ seq: 1, at, text: 'Insiders included?', answer: 'Yes, split out.', answeredAt: at }, { seq: 2, at, text: 'And stable?', answer: null }],
};
const shipped = renderReport(code, { root });
assert.deepEqual(order(shipped), ['top', 'pr', 'evidence', 'criteria', 'decisions', 'result', 'updates', 'steps', 'log']);
top = section(shipped, 'top');
assert.match(top, /<h2 class="action">Review the change and sign it off<\/h2>/);
assert.match(top, /<p class="lead-ask"><b>The engineer asks<\/b>Approve, or say if the toggle belongs in the <em>View<\/em> menu\.<\/p>/);
assert.match(top, /Approving publishes the draft pull request/);
assert.match(top, /<li>Draft PR <a href="https:\/\/github\.com\/acme\/app\/pull\/77">#77<\/a><\/li>/, 'the PR link is in the summary');
const prs = section(shipped, 'pr');
assert.match(prs, /<a class="pr-link" href="https:\/\/github\.com\/acme\/app\/pull\/77">acme\/app#77<\/a><span class="rune draft">Draft<\/span>/);
assert.match(prs, /<span class="ok">3 passed<\/span><span class="no">1 failing<\/span><span class="run">2 running<\/span><span>1 skipped<\/span>/);
assert.match(prs, /<li><a href="https:\/\/ci\/lint">lint<\/a><\/li>/);
assert.match(section(shipped, 'result'), /What the team did[\s\S]*<details><summary>The plan<\/summary>/, 'a code change folds the result away');
const ups = section(shipped, 'updates');
assert.match(ups, /<ol class="log"><li><span class="meta">[^<]+<\/span> CI green\.<\/li><li><span class="meta">[^<]+<\/span> Published &lt;PR&gt;\.<\/li>/, 'newest update first, escaped');
assert.match(ups, /“Insiders included\?”[\s\S]*<div class="a doc"><p>Yes, split out\.<\/p><\/div>[\s\S]*“And stable\?”[\s\S]*Not answered yet\./);
// A code change that couldn't go in a PR says why.
assert.match(section(renderReport({ ...code, ship: { phase: 'draft', pr: null, noPr: 'not a git repository' } }, { root }), 'top'), /<li>No pull request: not a git repository<\/li>/);
// Other states.
const readyHtml = renderReport({ ...code, stage: 'ready-to-merge', ship: { phase: 'watch', pr: { ...code.ship.pr, draft: false, review: 'APPROVED', checks: { passed: 4, skipped: 1, pending: 0, failed: [] } } } }, { root });
assert.match(readyHtml, /<span class="rune ask">Ready to merge<\/span>/);
assert.match(section(readyHtml, 'top'), /<h2 class="action">Merge PR #77<\/h2>/);
const blocked = renderReport({ ...task, stage: 'blocked', delivery: null, pause: { kind: 'blocked', need: 'Run `az login`', by: 'Accuracy reviewer', at } }, { root });
assert.match(blocked, /<span class="rune block">Blocked on you<\/span>/);
assert.match(section(blocked, 'top'), /<h2 class="action">Unblock the team<\/h2><p class="need">Run <code>az login<\/code><\/p>/);
assert.match(section(blocked, 'top'), /reported by the accuracy reviewer/);
top = section(renderReport({ ...task, stage: 'on-hold', delivery: null, pause: { kind: 'hold', note: 'until Monday', at } }, { root }), 'top');
assert.match(top, /<p class="kicker">Where it stands<\/p><h2 class="action">On hold until you resume it<\/h2><p>You said: &quot;until Monday&quot;\./);
assert.doesNotMatch(top, /class="how"/, 'no answer instructions when nothing is asked');
top = section(renderReport({ ...task, stage: 'working', delivery: null, steps: [{ ...task.steps[0], status: 'working' }], updates: [{ at, text: 'Halfway.' }] }, { root }), 'top');
assert.match(top, /<h2 class="action">Nothing needed yet<\/h2><p>The engineer is working on S1 · Plan\./);
assert.match(top, /Latest from the engineer \([^)]*\): Halfway\./);

// ---- canvas routes ----
const proc = {
  ready: true,
  decided: [],
  attached: [],
  liveView: () => ({ agents: [], council: null, lastDecision: null, process: null }),
  reportFor: (id) => (id === 'T1' ? { task, root, boardId: 'b1', color: 'teal1' } : null),
  evidenceFile: (id, rel) => {
    if (id !== 'T1') return null;
    const it = task.steps[1].verification.items.find((x) => evidenceRel(task, task.steps[1].verification, x.file) === rel);
    return it ? { file: path.join(evDir, it.file), type: it.type } : null;
  },
  async inboxDecide(taskId, action) {
    const { ProcessError } = await import('../extensions/grove-agent-monitor/lib/process/engine.mjs');
    if (taskId === 'T9') throw new ProcessError('invalid_state', 'T9 isn\'t waiting on you');
    this.decided.push([taskId, action]);
    return { task: taskId, decision: 'approve', outcome: 'done' };
  },
  async attachTask(taskId, { attach }) {
    this.attached.push([taskId, attach]);
    return { attached: attach ? [taskId] : [] };
  },
};
const runtime = new GroveRuntime({ webDir: path.join(tmp, 'web'), dataDir: path.join(tmp, 'data'), log: () => {} });
runtime.setProcess(proc);
const { url } = await runtime.open('grove', {});
const get = (p, headers = {}) => fetch(new URL(p, url), { headers, redirect: 'manual' });
const post = (p, body, headers = {}) => fetch(new URL(p, url), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

let r = await get('report/T1');
assert.equal(r.status, 308);
assert.equal(r.headers.get('location'), '/report/T1/', 'trailing slash, so relative evidence links resolve');
r = await get('report/T1/');
assert.equal(r.status, 200);
assert.match(r.headers.get('content-security-policy'), /default-src 'none'.*media-src 'self'/);
assert.match(await r.text(), /Add &lt;dark&gt; mode/);
assert.equal((await get('report/T2/')).status, 404);
r = await get('report/T1/evidence/attempt-2/after.png');
assert.equal(r.status, 200);
assert.equal(r.headers.get('content-type'), 'image/png');
assert.equal((await r.arrayBuffer()).byteLength, 8);
r = await get('report/T1/evidence/attempt-2/flow.webm', { Range: 'bytes=100-199' });
assert.equal(r.status, 206, 'videos can seek');
assert.equal(r.headers.get('content-range'), 'bytes 100-199/4096');
assert.equal((await r.arrayBuffer()).byteLength, 100);
assert.equal((await get('report/T1/evidence/attempt-2/flow.webm', { Range: 'bytes=9999-' })).status, 416);
assert.equal((await get('report/T1/evidence/attempt-2/evidence.json')).status, 404, 'only listed evidence');
assert.equal((await get('report/T1/..%2F..%2Fboard.json')).status, 404);
assert.equal((await get('report/T1/%E0%A4%A')).status, 404, 'bad encoding');

r = await post('api/inbox/decide', { taskId: 'T1', action: 'complete' });
assert.equal(r.status, 200);
assert.deepEqual(proc.decided, [['T1', 'complete']]);
r = await post('api/inbox/decide', { taskId: 'T9', action: 'complete' });
assert.equal(r.status, 400);
assert.match((await r.json()).error, /isn't waiting on you/);
// Every inbox button reaches Grove through this route.
for (const action of ['merge', 'shelve', 'unshelve', 'dismiss']) assert.equal((await post('api/inbox/decide', { taskId: 'T1', action })).status, 200, `the inbox can ${action}`);
assert.deepEqual(proc.decided.slice(1).map(([, a]) => a), ['merge', 'shelve', 'unshelve', 'dismiss']);
const { INBOX_ACTION_NAMES } = await import('../extensions/grove-agent-monitor/lib/process/integration.mjs');
assert.deepEqual([...INBOX_ACTION_NAMES].sort(), ['complete', 'dismiss', 'merge', 'shelve', 'unshelve']);
assert.equal((await post('api/inbox/decide', { taskId: 'T1', action: 'approve' })).status, 400);
assert.equal((await post('api/inbox/decide', { taskId: '../x', action: 'complete' })).status, 400);
assert.equal((await post('api/inbox/decide', { taskId: 'T1', action: 'dismiss' }, { Origin: 'http://evil.example' })).status, 403, 'cross-origin posts are refused');
r = await post('api/inbox/attach', { taskId: 'T1' });
assert.deepEqual(await r.json(), { attached: ['T1'] });
r = await post('api/inbox/attach', { taskId: 'T1', attach: false });
assert.deepEqual(await r.json(), { attached: [] });
assert.equal((await post('api/inbox/attach', { taskId: 'T1', attach: 'yes' })).status, 400);
assert.deepEqual(proc.attached, [['T1', true], ['T1', false]]);

await runtime.dispose();
await fs.rm(tmp, { recursive: true, force: true });
console.log('report tests passed');
