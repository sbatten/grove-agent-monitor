// The task report: one self-contained HTML page per task, written beside its evidence whenever the task comes
// back to the human, and served live by the canvas. Every report has the same shape, adapted to the task:
//   1. Your move: what the engineer needs from the human (or that nothing is needed), with its own ask,
//      and the summary, on a parchment scroll at the top.
//   2. The pull request, for code changes.
//   3. Evidence: screenshots and recordings, largest first; click to enlarge.
//   4. Acceptance criteria, each with the evidence that proves it.
//   5. Key decisions, the result, updates and questions.
//   6. How it was done (the team and every step with its reviews) and the activity log, folded away.
// Themed as the grove at a higher resolution (see report-theme.mjs). No scripts; every value is escaped.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import { KIND_LABELS, STAGE_LABELS, stepLabel, memberTitle, prLine } from './engine.mjs';
import { PALETTE } from '../../web/engine/palette.mjs';
import '../../web/sprites/index.mjs';
import { SpriteSheet } from '../../web/engine/svg.mjs';
import { getSprite } from '../../web/engine/sprites.mjs';
import { reportCss } from './report-theme.mjs';

export const REPORT_FILE = 'report.html';

export function reportPath(root, taskId) {
  return path.join(root, taskId, REPORT_FILE);
}

// The status rune under the title.
const STATUS = {
  'awaiting-approval': { label: 'Ready for your sign-off', tone: 'ask' },
  escalated: { label: 'Needs your decision', tone: 'ask' },
  blocked: { label: 'Blocked on you', tone: 'block' },
  'ready-to-merge': { label: 'Ready to merge', tone: 'ask' },
  'on-hold': { label: 'On hold', tone: 'off' },
  shelved: { label: 'On the shelf', tone: 'off' },
  watching: { label: 'Watching the PR', tone: 'work' },
  done: { label: 'Done', tone: 'done' },
  cancelled: { label: 'Cancelled', tone: 'off' },
};

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function when(at) {
  if (!Number.isFinite(at)) return '';
  return new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

// ---------- markdown (a safe subset) ----------

// Links may be web, mail or file links, or paths. Paths inside the task folder become relative links so they
// work both from disk and from the canvas; other absolute paths become file: URLs.
function safeUrl(raw, taskDir) {
  const url = String(raw).trim();
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^file:/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  if (path.isAbsolute(url)) {
    if (taskDir && url.startsWith(taskDir + path.sep)) return path.relative(taskDir, url).split(path.sep).map(encodeURIComponent).join('/');
    return pathToFileURL(url).href;
  }
  return encodeURI(url);
}

function inline(text, taskDir) {
  // Code spans first, so nothing inside them is formatted.
  return String(text).split(/(`[^`\n]+`)/).map((part) => {
    if (/^`[^`\n]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    let s = escapeHtml(part);
    const links = [];
    s = s.replace(/\[([^\]\n]+)\]\((?:&lt;([^\n]+?)&gt;|([^)\s]+))(?:\s+&quot;[^&]*&quot;)?\)/g, (m, label, angled, plain) => {
      const url = safeUrl((angled ?? plain).replace(/&amp;/g, '&'), taskDir);
      if (!url) return label;
      links.push(`<a href="${escapeHtml(url)}">${label}</a>`);
      return `\u0000${links.length - 1}\u0000`;
    });
    s = s.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, (u) => {
      links.push(`<a href="${u}">${u}</a>`);
      return `\u0000${links.length - 1}\u0000`;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => links[Number(i)]);
  }).join('');
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
// A table's delimiter row: cells of hyphens with optional alignment colons, separated by pipes.
const isTableRule = (l) => l.includes('|') && l.includes('-') && /^\s*\|?(\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/.test(l);

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function renderList(items, taskDir) {
  // items: [{ indent, ordered, text }]; deeper indents nest under the item before them.
  const html = [];
  let i = 0;
  const level = (base) => {
    const ordered = items[i].ordered;
    html.push(ordered ? '<ol>' : '<ul>');
    while (i < items.length && items[i].indent >= base) {
      if (items[i].indent > base) { level(items[i].indent); continue; }
      const it = items[i++];
      const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
      html.push(`<li${task ? ' class="check"' : ''}>${task ? `<span class="box">${task[1] === ' ' ? '☐' : '☑'}</span> ${inline(task[2], taskDir)}` : inline(it.text, taskDir)}`);
      if (i < items.length && items[i].indent > base) level(items[i].indent);
      html.push('</li>');
    }
    html.push(ordered ? '</ol>' : '</ul>');
  };
  while (i < items.length) level(items[i].indent);
  return html.join('');
}

export function markdown(src, { taskDir } = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const startsBlock = (l, next) => /^\s*```/.test(l) || /^#{1,6}\s/.test(l) || /^>\s?/.test(l) || LIST_ITEM.test(l) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(l) || (l.includes('|') && isTableRule(next ?? ''));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const n = Math.min(6, h[1].length + 2);
      out.push(`<h${n}>${inline(h[2].replace(/\s+#+\s*$/, ''), taskDir)}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.includes('|') && isTableRule(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c, taskDir)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '', taskDir)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(body.join('\n'), { taskDir })}</blockquote>`);
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (m) {
          items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: m[3] });
          i++;
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items.at(-1).text += ` ${lines[i++].trim()}`;
        } else break;
      }
      out.push(renderList(items, taskDir));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && (!para.length || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join('\n'), taskDir).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}

// ---------- the report ----------

// Each step is drawn with the workstation the engineer works it at in the grove.
const KIND_STATION = { plan: ['star-table', 'active'], research: ['bookshelf', 'active'], execute: ['forge', 'active'], verify: ['dummy', 'hit'] };
// Each step's workstation sits in a fixed square slot, at the largest whole-pixel scale that fits it.
const STEP_ART = 60;
function fitScale(id, box) {
  const sp = getSprite(id);
  return sp ? Math.max(1, Math.floor(box / Math.max(sp.w, sp.h))) : 1;
}

const RESULT_NAMES = { plan: 'The plan', research: 'The findings', execute: 'The engineer\'s summary', verify: 'The verification report' };
// The same robes the reviewers wear in the grove.
const SPECIALTY_ROBE = { security: 'rose', tests: 'teal', code: 'violet', architecture: 'azure', accuracy: 'moss' };

function memberName(key) {
  return memberTitle({ specialty: key.replace(/^reviewer-/, '') });
}

// Each reviewer's latest verdict in the step's current review window.
function verdicts(step) {
  const f = step.forum;
  const last = new Map();
  for (const p of f.posts) if (p.kind === 'review' && p.round > f.windowStart) last.set(p.role, p);
  return step.reviewers.map((r) => ({ name: r.name, verdict: last.get(r.name)?.verdict ?? null, post: last.get(r.name) ?? null }));
}

function reviewOutcome(step) {
  if (!step.reviewers.length) return 'Not reviewed';
  const rounds = Math.max(0, step.forum.round - step.forum.windowStart);
  const human = step.forum.posts.findLast((p) => p.kind === 'human');
  if (human?.verdict === 'approve' && step.status === 'done') return 'Accepted by you despite open objections';
  const v = verdicts(step);
  if (step.status === 'done' && v.every((x) => x.verdict === 'approve')) return `Approved unanimously${rounds > 1 ? ` after ${rounds} rounds` : ''}`;
  if (!rounds) return 'Review not started';
  return `Round ${rounds}: ${v.filter((x) => x.verdict === 'approve').length} of ${v.length} approve`;
}

// Evidence lives in <task>/evidence/attempt-N/, so its link relative to the report is known from that layout
// (whichever spelling of the board's path the writer used). Anything elsewhere gets null.
export function evidenceRel(task, v, file) {
  const parts = path.normalize(v.dir).split(path.sep);
  const [t, ev, attempt] = parts.slice(-3);
  if (t !== task.id || ev !== 'evidence' || !/^attempt-\d+$/.test(attempt)) return null;
  return `evidence/${attempt}/${file}`;
}

// Every evidence item the human should see, grouped by the step that produced it: the latest verification
// first, then other steps' evidence, newest first. Redone steps are replaced by their redo.
function evidenceGroups(task) {
  const done = task.steps.filter((s) => s.status === 'done' || (s.kind === 'verify' && s.verification?.result === 'fail'));
  const redone = new Set(done.map((s) => s.redoOf).filter(Boolean));
  const groups = [];
  let n = 0;
  for (const s of [...done].reverse()) {
    if (redone.has(s.id)) continue;
    const v = s.kind === 'verify' ? s.verification : s.evidence;
    if (!v?.items?.length) continue;
    if (s.kind === 'verify' && groups.some((g) => g.kind === 'verify')) continue;
    groups.push({
      step: s, kind: s.kind, result: s.kind === 'verify' ? v.result : null, summary: v.summary ?? '',
      items: v.items.map((it) => {
        const rel = evidenceRel(task, v, it.file);
        return { ...it, id: `ev-${++n}`, href: rel ? rel.split('/').map(encodeURIComponent).join('/') : pathToFileURL(path.join(v.dir, it.file)).href };
      }),
    });
  }
  return groups.sort((a, b) => (a.kind === 'verify' ? 0 : 1) - (b.kind === 'verify' ? 0 : 1));
}

const isVideo = (it) => String(it.type ?? '').startsWith('video/') || /\.(mp4|webm)$/i.test(it.file);

// Which evidence proves a criterion: matched by its text, or by its number ("1", "#1", "criterion 1").
function proofFor(criterion, index, items) {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const c = norm(criterion);
  return items.filter((it) => {
    const k = norm(it.criterion);
    if (!k) return false;
    if (k === c || (k.length > 8 && (c.includes(k) || k.includes(c)))) return true;
    return new RegExp(`^(criterion |ac |#)?${index + 1}\\b`).test(k);
  });
}

function criterionText(task, it) {
  const n = /^(?:criterion |ac |#)?(\d+)$/i.exec(String(it.criterion ?? '').trim());
  return n && task.criteria[Number(n[1]) - 1] ? task.criteria[Number(n[1]) - 1] : it.criterion;
}

// What the engineer needs from the human, in the task's current state.
function yourMove(task, { pr }) {
  const st = task.stage;
  const code = !!(task.delivery?.ship || task.ship);
  const step = task.steps.find((s) => s.id === task.escalation?.step);
  const open = (task.questions ?? []).find((q) => !q.answer);
  switch (st) {
    case 'awaiting-approval':
      return {
        ask: true,
        action: code ? 'Review the change and sign it off' : 'Check the result and sign it off',
        detail: code && pr
          ? `Approving publishes ${pr.draft ? 'the draft' : 'the'} pull request: the engineer marks it ready for review and Grove watches it through checks and review until it's ready to merge. Or ask for changes.`
          : code ? 'Approving opens a pull request, which Grove watches until it\'s ready to merge. Or ask for changes.'
            : 'Approve it if it answers what you asked, or ask for more.',
      };
    case 'escalated':
      return { ask: true, action: `Decide how ${step ? stepLabel(step) : 'the stuck step'} goes on`, detail: `${task.escalation?.reason ?? 'Its review could not agree.'} Accept it as it is, send it back with direction, or cancel the task.`, positions: step ? verdicts(step).filter((v) => v.post) : [] };
    case 'blocked':
      return { ask: true, action: 'Unblock the team', need: task.pause?.need ?? '', detail: `Everyone on the task has stopped until this is done${task.pause?.by ? ` (reported by the ${task.pause.by.toLowerCase()})` : ''}. The team then carries on in the same chats.` };
    case 'ready-to-merge':
      return { ask: true, action: `Merge PR #${task.ship?.pr?.number}`, detail: 'Checks passed and the review is approved. Say merge and the engineer merges it, without bypassing checks or reviews. Or ask for changes.' };
    case 'shelved':
      return { ask: false, action: 'On the shelf', detail: `You set this aside while it was ${(STATUS[task.shelf?.from]?.label ?? 'waiting on you').toLowerCase()}. Nothing runs, and the engineer keeps everything it did${task.ship?.pr ? '; Grove still watches the pull request and brings it back if it needs work' : ''}. When you're ready, bring it back from the shelf in the Grove (click the Chief), or tell the Chief of Staff what you want, for example to approve it or to run it again.` };
    case 'on-hold':
      return { ask: false, action: 'On hold until you resume it', detail: `${task.pause?.note ? `You said: "${task.pause.note}". ` : ''}Nothing runs until you tell the Chief of Staff to resume.` };
    case 'watching':
      return { ask: false, action: 'Nothing needed from you', detail: `Grove is watching ${pr ? `PR #${pr.number}` : 'the pull request'} and brings the engineer back if checks fail or reviewers ask for changes. You'll hear when it's ready to merge.` };
    case 'done':
      return { ask: false, action: task.ship?.phase === 'merged' ? `Done: PR #${task.ship.pr?.number} is merged` : 'Done', detail: 'Nothing more is needed. Ask the Chief of Staff if you want more; it reopens the task.' };
    case 'cancelled':
      return { ask: false, action: 'Cancelled', detail: 'The team stopped work on this task.' };
    default: {
      const cur = task.steps.find((s) => s.status === 'working' || s.status === 'reviewing');
      return { ask: false, action: 'Nothing needed yet', detail: `The engineer is working${cur ? ` on ${stepLabel(cur)}` : ''}. Grove tells the Chief of Staff when they need you.${open ? ` Your question "${open.text}" is with the team.` : ''}` };
    }
  }
}

// How to answer, in this state: the inbox buttons that apply, or the Chief of Staff's chat.
function howToAnswer(task) {
  const buttons = {
    'awaiting-approval': task.delivery?.ship ? '<b>Approve</b>' : '<b>Complete</b>',
    escalated: '<b>Accept</b>',
    'ready-to-merge': '<b>Merge</b>',
  }[task.stage];
  const inbox = `${buttons ? `${buttons}, ` : ''}<b>Shelve</b> to come back to it later, <b>Dismiss</b>, or <b>Attach to chat</b> to write about this task without naming it`;
  return task.stage === 'blocked'
    ? `When it's done, tell the Chief of Staff in its chat. From the Grove inbox (click the Chief): ${inbox}.`
    : `Answer in the Chief of Staff's chat, or from its inbox in the Grove (click the Chief): ${inbox}.`;
}

export function renderReport(task, { root, boardId = '', color: colorName = 'amber', now = Date.now() } = {}) {
  const taskDir = path.join(root, task.id);
  const md = (s) => markdown(s, { taskDir });
  const sheet = new SpriteSheet('gv');
  // Section icons: whole-pixel scales that bring each sprite to about the same height.
  const icon = (id, opts = {}) => sheet.use(id, { ...opts, scale: Math.max(1, Math.floor(52 / (getSprite(id)?.h ?? 26))) });
  const color = PALETTE[colorName] ?? PALETTE.amber;
  const status = STATUS[task.stage] ?? { label: STAGE_LABELS[task.stage] ?? 'In progress', tone: 'work' };
  const steps = task.steps.filter((s) => s.status !== 'skipped');
  const groups = evidenceGroups(task);
  const items = groups.flatMap((g) => g.items);
  const shipPr = task.ship?.pr ?? null;
  const pr = shipPr ? { ...shipPr, draft: task.ship.phase === 'draft' || shipPr.draft } : null;
  const isCode = !!(task.delivery?.ship || task.ship);
  const verification = groups.find((g) => g.kind === 'verify');
  const result = [...steps].reverse().find((s) => s.status === 'done' && s.output && s.kind !== 'verify' && !s.ship);
  const delivery = task.delivery;
  const proven = task.criteria.map((c, i) => proofFor(c, i, items));
  const move = yourMove(task, { pr });

  // ---- 1. your move and the summary, on the scroll ----
  const facts = [];
  if (pr) facts.push(`<li>${pr.draft ? 'Draft PR' : 'PR'} <a href="${escapeHtml(pr.url)}">#${escapeHtml(pr.number)}</a></li>`);
  else if (task.ship?.noPr) facts.push(`<li>No pull request: ${escapeHtml(task.ship.noPr)}</li>`);
  if (items.length || isCode) facts.push(`<li><a href="#evidence">${items.length} piece${items.length === 1 ? '' : 's'} of evidence</a></li>`);
  if (task.criteria.length) facts.push(`<li>Criteria shown: <span class="${proven.every((p) => p.length) ? 'ok' : 'no'}">${proven.filter((p) => p.length).length} of ${task.criteria.length}</span></li>`);
  if (verification) facts.push(`<li>Verification: <span class="${verification.result === 'pass' ? 'ok' : 'no'}">${verification.result === 'pass' ? 'passed' : 'failed'}</span></li>`);
  const reviewed = steps.filter((s) => s.reviewers.length && s.version);
  if (reviewed.length) facts.push(`<li>Reviews: ${reviewed.map((s) => `${escapeHtml(s.id)} ${s.status === 'done' ? '<span class="ok">✓</span>' : '<span class="no">…</span>'}`).join(' · ')}</li>`);
  const positions = move.positions?.length
    ? `<ul class="positions">${move.positions.map((p) => `<li><b>${escapeHtml(p.post.author)}</b> <span class="v-${p.verdict}">${p.verdict === 'approve' ? 'approves' : 'wants changes'}</span>: ${escapeHtml(firstSentence(p.post.text))}</li>`).join('')}</ul>`
    : '';
  const summonsBody = [
    `<div class="move ${move.ask ? 'ask' : 'calm'}">`,
    sheet.use('lantern-post', { variant: move.ask ? 'active' : 'idle', scale: 2 }),
    '<div>',
    `<p class="kicker">${move.ask ? 'Your move' : 'Where it stands'}</p>`,
    `<h2 class="action">${escapeHtml(move.action)}</h2>`,
    move.need ? `<p class="need">${inline(move.need, taskDir)}</p>` : '',
    delivery?.ask && (task.stage === 'awaiting-approval' || task.shelf?.from === 'awaiting-approval') ? `<p class="lead-ask"><b>The engineer asks</b>${inline(delivery.ask, taskDir)}</p>` : '',
    `<p>${escapeHtml(move.detail)}</p>`,
    positions,
    move.ask ? `<p class="how">${howToAnswer(task)}</p>` : '',
    '</div></div>',
  ].join('');
  const summary = delivery
    ? `<p class="kicker">Summary</p><div class="summary">${md(delivery.summary)}</div><p class="meta">Delivered by the engineer ${escapeHtml(when(delivery.at))}${delivery.n > 1 ? ` · delivery ${delivery.n}` : ''}</p>`
    : `<p class="kicker">The task</p><div class="summary">${md(task.goal)}</div>`;
  const latest = task.updates?.at(-1);
  const sections = [];
  sections.push(`<section class="summons" id="top" aria-label="Your move and summary">
  <div class="rod" aria-hidden="true"></div>
  <div class="parchment">
    <div class="seal" aria-hidden="true">${escapeHtml(task.id)}</div>
    ${summonsBody}
    <div class="scroll-rule" aria-hidden="true"></div>
    ${summary}${latest && !delivery ? `<p class="meta">Latest from the engineer (${escapeHtml(when(latest.at))}): ${inline(latest.text, taskDir)}</p>` : ''}
    ${facts.length ? `<ul class="facts">${facts.join('')}</ul>` : ''}
  </div>
  <div class="rod" aria-hidden="true"></div>
</section>`);

  // ---- 2. the pull request ----
  if (pr || task.ship?.noPr) {
    const phase = { draft: 'Draft: waiting for your sign-off', publish: 'Being published', watch: 'Grove is watching checks and review', merge: 'Being merged', merged: 'Merged' }[task.ship.phase] ?? '';
    let body;
    if (pr) {
      const c = pr.checks;
      const checks = c ? `<div class="checks"><span class="ok">${c.passed} passed</span>${c.failed?.length ? `<span class="no">${c.failed.length} failing</span>` : ''}${c.pending ? `<span class="run">${c.pending} running</span>` : ''}${c.skipped ? `<span>${c.skipped} skipped</span>` : ''}${pr.review ? `<span>review: ${escapeHtml(pr.review.toLowerCase().replace(/_/g, ' '))}</span>` : ''}${pr.mergeable === 'CONFLICTING' ? '<span class="no">merge conflicts</span>' : ''}</div>` : '<p class="meta">Checks haven\'t been read yet.</p>';
      const failing = c?.failed?.length ? `<p>Failing checks:</p><ul class="problems">${c.failed.map((f) => `<li>${f.url ? `<a href="${escapeHtml(f.url)}">${escapeHtml(f.name)}</a>` : escapeHtml(f.name)}</li>`).join('')}</ul>` : '';
      const fixing = task.ship.attention?.problems?.length && task.stage === 'routing' ? `<p>The engineer is fixing:</p><ul class="problems">${task.ship.attention.problems.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : '';
      body = `<div class="pr"><div class="pr-state"><a class="pr-link" href="${escapeHtml(pr.url)}">${escapeHtml(pr.repo ? `${pr.repo}#${pr.number}` : `PR #${pr.number}`)}</a>${pr.draft ? '<span class="rune draft">Draft</span>' : ''}${pr.state && pr.state !== 'OPEN' ? `<span class="rune ${pr.state === 'MERGED' ? 'done' : 'off'}">${escapeHtml(pr.state.toLowerCase())}</span>` : ''}</div>${checks}${failing}${fixing}${pr.error ? `<p class="meta">Grove can't read the PR right now: ${escapeHtml(pr.error)}</p>` : ''}${pr.checkedAt ? `<p class="meta">Checked ${escapeHtml(when(pr.checkedAt))}</p>` : ''}</div>`;
    } else {
      body = `<p>No pull request: ${escapeHtml(task.ship.noPr)}</p>`;
    }
    sections.push(`<section class="panel" id="pr"><h2>${icon('forge', { variant: 'active' })}Pull request<span class="sub">${escapeHtml(phase)}</span></h2>${body}</section>`);
  }

  // ---- 3. evidence ----
  if (groups.length || isCode || task.steps.some((s) => s.kind === 'verify')) {
    const lightboxes = [];
    const figure = (it, task_) => {
      const proves = it.criterion ? `<span class="proves">Proves: ${escapeHtml(criterionText(task_, it))}</span>` : '';
      if (isVideo(it)) {
        return `<figure class="mirror"><div class="view"><video controls preload="metadata" src="${escapeHtml(it.href)}" aria-label="${escapeHtml(it.caption)}"></video></div><figcaption><span class="kindtag">Recording</span><span class="cap">${escapeHtml(it.caption)}</span>${proves}<a class="filelink" href="${escapeHtml(it.href)}">${escapeHtml(it.file)}</a></figcaption></figure>`;
      }
      lightboxes.push(`<div class="lightbox" id="${it.id}" role="dialog" aria-label="${escapeHtml(it.caption)}"><a class="close" href="#evidence" aria-label="Close"></a><img src="${escapeHtml(it.href)}" alt="${escapeHtml(it.caption)}"><p>${escapeHtml(it.caption)}</p><a class="x" href="#evidence">Close ✕</a></div>`);
      return `<figure class="mirror"><a class="view" href="#${it.id}" aria-label="Enlarge: ${escapeHtml(it.caption)}"><img loading="lazy" src="${escapeHtml(it.href)}" alt="${escapeHtml(it.caption)}"></a><figcaption><span class="cap">${escapeHtml(it.caption)}</span>${proves}<a class="filelink" href="${escapeHtml(it.href)}">${escapeHtml(it.file)}</a></figcaption></figure>`;
    };
    const body = groups.length
      ? groups.map((g) => {
        const verdict = g.kind === 'verify' ? (g.result === 'pass' ? '<span class="rune pass">Verification passed</span>' : '<span class="rune fail">Verification failed</span>') : `<span class="rune off">${escapeHtml(KIND_LABELS[g.kind])}</span>`;
        return `<div class="ev-group"><div class="ev-head"><h3>${escapeHtml(stepLabel(g.step))}</h3>${verdict}</div>${g.summary ? `<div class="doc">${md(g.summary)}</div>` : ''}<div class="gallery${g.items.length === 1 ? ' single' : ''}">${g.items.map((it) => figure(it, task)).join('')}</div></div>`;
      }).join('')
      : '<p class="empty">No visual evidence yet.</p>';
    sections.push(`<section class="panel" id="evidence"><h2>${icon('mirror', { variant: 'active' })}Evidence<span class="sub">${items.length ? 'Click an image to enlarge it' : ''}</span></h2>${body}</section>${lightboxes.join('')}`);
  }

  // ---- 4. acceptance criteria ----
  if (task.criteria.length) {
    const rows = task.criteria.map((c, i) => {
      const proof = proven[i];
      const thumbs = proof.filter((it) => !isVideo(it)).slice(0, 3).map((it) => `<a href="#${it.id}" aria-label="Enlarge: ${escapeHtml(it.caption)}"><img loading="lazy" src="${escapeHtml(it.href)}" alt=""></a>`).join('');
      const links = proof.length ? proof.map((it) => `<a href="${isVideo(it) ? escapeHtml(it.href) : `#${it.id}`}">${escapeHtml(it.caption)}</a>`).join(' · ') : '<span class="meta">No evidence linked</span>';
      return `<li class="${proof.length ? 'proven' : ''}"><span class="mark"><span>${proof.length ? '✓' : '○'}</span></span><div><div>${inline(c, taskDir)}</div><div class="proof">${links}</div></div>${thumbs ? `<div class="thumbs">${thumbs}</div>` : '<div></div>'}</li>`;
    });
    sections.push(`<section class="panel" id="criteria"><h2>${icon('dummy', { variant: proven.every((p) => p.length) ? 'hit' : 'idle' })}Acceptance criteria<span class="sub">${proven.filter((p) => p.length).length} of ${task.criteria.length} shown by evidence</span></h2><ol class="criteria">${rows.join('')}</ol></section>`);
  }

  // ---- 5. decisions, result, updates, questions ----
  const decisionRows = [];
  for (const d of delivery?.decisions ?? []) decisionRows.push(`<li><span class="who lead">Engineer</span><span>${inline(d, taskDir)}</span></li>`);
  for (const s of steps) if (s.reviewers.length && s.version) decisionRows.push(`<li><span class="who review">Review</span><span><b>${escapeHtml(stepLabel(s))}</b>: ${escapeHtml(reviewOutcome(s))}</span></li>`);
  for (const f of task.feedback.filter((x) => x.from === 'human')) decisionRows.push(`<li><span class="who you">You</span><span>${inline(f.text, taskDir)} <span class="meta">${escapeHtml(when(f.at))}</span></span></li>`);
  if (decisionRows.length) sections.push(`<section class="panel" id="decisions"><h2>${icon('council-stone', { variant: 'decided' })}Decisions</h2><ul class="decisions">${decisionRows.join('')}</ul></section>`);

  if (result) {
    const doc = `<div class="doc">${md(result.output)}</div>`;
    const folded = isCode;
    sections.push(`<section class="panel" id="result"><h2>${icon('tome')}${folded ? 'What the team did' : 'Result'}<span class="sub">${escapeHtml(stepLabel(result))}</span></h2>${folded ? `<details><summary>${escapeHtml(RESULT_NAMES[result.kind] ?? 'The engineer\'s report')}</summary>${doc}</details>` : doc}</section>`);
  }

  if (task.updates?.length || task.questions?.length) {
    const ups = task.updates?.length ? `<ol class="log">${[...task.updates].reverse().slice(0, 30).map((u) => `<li><span class="meta">${escapeHtml(when(u.at))}</span> ${inline(u.text, taskDir)}</li>`).join('')}</ol>` : '';
    const qs = task.questions?.length ? `<ol class="qa">${task.questions.map((q) => `<li><p class="q">“${inline(q.text, taskDir)}” <span class="meta">${escapeHtml(when(q.at))}</span></p>${q.answer ? `<div class="a doc">${md(q.answer)}</div>` : '<p class="meta">Not answered yet.</p>'}</li>`).join('')}</ol>` : '';
    sections.push(`<section class="panel" id="updates"><h2>${icon('owl')}Updates${qs ? ' and questions' : ''}<span class="sub">From the engineer</span></h2>${qs ? `${qs}${ups ? '<div class="scroll-rule" aria-hidden="true"></div>' : ''}` : ''}${ups}</section>`);
  }

  // ---- 6. how it was done ----
  if (steps.length) {
    const team = [`<li>${sheet.use('mage', { variant: 'dusk', scale: 2, className: 'glow', title: 'Engineer' })}Engineer</li>`];
    for (const key of Object.keys(task.members ?? {})) {
      const m = task.members[key];
      const specialty = m.specialty ?? key.replace(/^reviewer-/, '');
      team.push(`<li>${sheet.use('seer', { variant: SPECIALTY_ROBE[specialty] ?? 'dusk', scale: 2, title: memberName(key) })}${escapeHtml(memberName(key))}</li>`);
    }
    const rows = steps.map((s) => {
      const [station, stationVariant] = s.ship ? ['forge', 'active'] : KIND_STATION[s.kind];
      const v = verdicts(s);
      const chips = v.map((r) => `<span class="vote ${r.verdict ?? 'pending'}">${escapeHtml(r.name)} · ${r.verdict === 'approve' ? 'approve' : r.verdict === 'changes' ? 'changes' : 'pending'}</span>`).join('');
      const posts = s.forum.posts.filter((p) => p.kind !== 'system' || p.verdict);
      const discussion = posts.length ? `<details><summary>Review discussion (${posts.length} post${posts.length === 1 ? '' : 's'})</summary><ol class="posts">${posts.map((p) => `<li class="post ${escapeHtml(p.kind)}"><div class="post-head"><b>${escapeHtml(p.author)}</b>${p.verdict ? `<span class="vote ${p.verdict === 'approve' ? 'approve' : 'changes'}">${p.verdict === 'approve' ? 'approve' : 'changes'}</span>` : ''}<span class="meta">R${Math.max(1, p.round - s.forum.windowStart)} · ${escapeHtml(when(p.at))}</span></div><div class="doc">${md(p.text)}</div></li>`).join('')}</ol></details>` : '';
      const output = s.output ? `<details><summary>${escapeHtml(KIND_LABELS[s.kind])} output${s.version > 1 ? ` (v${s.version})` : ''}</summary><div class="doc">${md(s.output)}</div></details>` : '';
      return `<li class="step ${escapeHtml(s.status)}"><span class="step-art">${sheet.use(station, { variant: stationVariant, scale: fitScale(station, STEP_ART), title: `${KIND_LABELS[s.kind]} station` })}</span><div><div class="step-head"><span class="kind">${escapeHtml(KIND_LABELS[s.kind])}</span><b>${escapeHtml(s.id)} · ${escapeHtml(s.title || KIND_LABELS[s.kind])}</b><span class="rune ${s.status === 'done' ? 'done' : s.status === 'pending' ? 'off' : 'work'}">${escapeHtml(s.status)}</span></div><div class="meta">Engineer${s.redoOf ? ` · re-runs ${escapeHtml(s.redoOf)}` : ''} · ${escapeHtml(reviewOutcome(s))}</div>${chips ? `<div class="votes">${chips}</div>` : ''}${s.brief && !s.ship ? `<p class="brief">${inline(firstSentence(s.brief, 300), taskDir)}</p>` : ''}${output}${discussion}</div></li>`;
    });
    sections.push(`<section class="panel" id="steps"><h2>${icon('star-table', { variant: 'active' })}How it was done<span class="sub">${steps.length} step${steps.length === 1 ? '' : 's'}</span></h2><ul class="team" aria-label="The team">${team.join('')}</ul><ol class="steps">${rows.join('')}</ol></section>`);
  }
  sections.push(`<section class="panel" id="log"><h2>${icon('campfire')}Activity</h2><details><summary>Activity log (${task.history.length} entries)</summary><ol class="log">${task.history.map((h) => `<li><span class="meta">${escapeHtml(when(h.at))}</span> ${escapeHtml(h.text)}</li>`).join('')}</ol></details></section>`);

  const nav = [
    ['top', move.ask ? 'Your move' : 'Summary'],
    (pr || task.ship?.noPr) && ['pr', 'Pull request'],
    sections.some((s) => s.includes('id="evidence"')) && ['evidence', `Evidence${items.length ? ` (${items.length})` : ''}`],
    task.criteria.length && ['criteria', 'Criteria'],
    decisionRows.length && ['decisions', 'Decisions'],
    result && ['result', isCode ? 'What the team did' : 'Result'],
    (task.updates?.length || task.questions?.length) && ['updates', 'Updates'],
    steps.length && ['steps', 'How it was done'],
    ['log', 'Activity'],
  ].filter(Boolean);

  const banner = sheet.use('book', { variant: colorName, anim: 'glow', frame: 1, scale: 5 });
  const flora = [sheet.use('shroom-tall', { variant: 'teal', scale: 2 }), sheet.use('glowflower', { variant: 'violet', scale: 2 }), sheet.use('shroom-small', { variant: 'cyan', scale: 2 }), sheet.use('glowflower', { variant: 'teal', scale: 2 }), sheet.use('shroom-tall', { variant: 'rose', scale: 2 })].join('');
  const body = `<header class="wrap banner">
  ${banner}
  <div>
    <p class="eyebrow">Grove · Task report · ${task.name ? `<span class="task-name">${escapeHtml(task.name)}</span> · ` : ''}${escapeHtml(task.id)}</p>
    <h1>${escapeHtml(task.title)}</h1>
    <p class="status"><span class="rune ${status.tone}">${escapeHtml(status.label)}</span><span class="meta">Started ${escapeHtml(when(task.createdAt))} · updated ${escapeHtml(when(task.updatedAt))}</span></p>
  </div>
</header>
<nav class="runes" aria-label="Sections"><div class="wrap">${nav.map(([id, label]) => `<a href="#${id}">${escapeHtml(label)}</a>`).join('')}</div></nav>
<main class="wrap">
${sections.filter(Boolean).join('\n')}
</main>
<footer class="wrap"><div class="flora" aria-hidden="true">${flora}</div>Written by Grove ${escapeHtml(when(now))}${boardId ? ` · board ${escapeHtml(boardId)}` : ''}</footer>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(task.name ?? task.id)} · ${escapeHtml(task.title)} — Grove report</title>
<style>${reportCss()}</style>
</head>
<body style="--task:${escapeHtml(color)}">
${sheet.defs()}
${body}
</body>
</html>
`;
}

function firstSentence(text, max = 220) {
  const t = String(text ?? '').replace(/^#+\s.*$/gm, '').replace(/\s+/g, ' ').replace(/VERDICT:\s*\w+/gi, '').trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1] : t;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Write the report beside the task's evidence, atomically.
export async function writeReport(task, { root, boardId, color }) {
  const file = reportPath(root, task.id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, renderReport(task, { root, boardId, color }), 'utf8');
  await fs.rename(tmp, file);
  return file;
}
