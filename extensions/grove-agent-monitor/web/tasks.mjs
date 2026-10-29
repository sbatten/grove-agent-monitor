// Read-only views of the Chief-of-Staff process: a slim task strip under the scene and a forum screen.
// Decisions happen in the Chief of Staff's inbox (inbox.mjs) or its chat.
import { PALETTE } from './engine/palette.mjs';

function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style') for (const [sk, sv] of Object.entries(v)) n.style.setProperty(sk, sv);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const FINISHED = new Set(['done', 'cancelled']);

export class TaskStrip {
  constructor({ root, onOpen }) {
    this.root = root;
    this.onOpen = onOpen;
    this.key = '';
  }

  update(process) {
    const tasks = process?.tasks ?? [];
    const key = JSON.stringify(tasks.map((t) => [t.id, t.name, t.stage, t.stageLabel, t.working, t.title, t.engineer]));
    if (key === this.key) return;
    this.key = key;
    this.root.hidden = !tasks.length;
    const active = tasks.filter((t) => !FINISHED.has(t.stage));
    const finished = tasks.filter((t) => FINISHED.has(t.stage)).slice(-4);
    const chip = (t) => el('li', {},
      el('button', {
        type: 'button',
        class: `chip${FINISHED.has(t.stage) ? ' chip-finished' : ''}${t.waitingOnHuman ? ' chip-human' : ''}`,
        style: { '--task': PALETTE[t.color] ?? PALETTE.uiText },
        title: `${t.name ? `${t.name} (${t.id})` : t.id} · ${t.title} — ${t.stageLabel}. Open its steps and reviews.`,
        onclick: () => this.onOpen(t.id),
      },
      el('span', { class: 'chip-flag', 'aria-hidden': 'true' }),
      el('span', { class: 'task-kicker', text: t.name ? `${t.name} · ${t.id}` : t.id }),
      el('span', { class: 'chip-title', text: t.title }),
      el('span', { class: 'chip-stage', text: t.waitingOnHuman ? `${t.stageLabel} · in your inbox` : t.engineer === 'pending' ? 'Waiting for its engineer' : t.working ? `${t.stageLabel} · ${t.working} reviewing` : t.stageLabel })));
    this.root.replaceChildren(el('ul', { class: 'chips', 'aria-label': 'Tasks' }, active.map(chip), finished.map(chip)));
  }
}

const STEP_STATUS = { pending: 'Next', working: 'Working', reviewing: 'In review', done: 'Done', skipped: 'Skipped' };

// A task's steps, and the selected step's output and review discussion.
export class ForumView {
  constructor({ root, onClose }) {
    this.root = root;
    this.onClose = onClose;
    this.taskId = null;
    this.stepId = null;
    this.key = '';
  }

  get open() {
    return !!this.taskId;
  }

  show(taskId, process) {
    this.taskId = taskId;
    this.stepId = null;
    this.key = '';
    this.update(process, true);
    this.root.querySelector('.forum-back')?.focus();
  }

  hide() {
    this.taskId = null;
    this.root.replaceChildren();
  }

  update(process, force = false) {
    if (!this.taskId) return;
    const t = process?.tasks.find((x) => x.id === this.taskId);
    if (!t) { this.onClose(); return; }
    const steps = t.steps ?? [];
    // Default to the step in progress, else the last one that produced something.
    const step = steps.find((x) => x.id === this.stepId)
      ?? steps.find((x) => x.status === 'working' || x.status === 'reviewing')
      ?? [...steps].reverse().find((x) => x.version)
      ?? steps[0];
    const key = `${t.id}|${step?.id}|${t.updatedAt}`;
    if (!force && key === this.key) return;
    this.key = key;
    const scroller = this.root.querySelector('.forum-posts');
    const atBottom = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24 : true;
    const prevTop = scroller?.scrollTop ?? 0;
    const color = PALETTE[t.color] ?? PALETTE.uiText;

    const header = el('header', { class: 'forum-top', style: { '--task': color } },
      el('button', { type: 'button', class: 'forum-back', onclick: () => this.onClose() }, '◀ Grove'),
      el('div', { class: 'forum-title' },
        el('span', { class: 'chip-flag', 'aria-hidden': 'true' }),
        el('div', { class: 'forum-name' }, el('span', { class: 'task-kicker', text: t.name ? `${t.name} · ${t.id}` : t.id }), el('h2', { text: t.title })),
        el('span', { class: 'chip-stage', text: t.stageLabel }),
        steps.length ? el('a', { class: 'report-link', href: `report/${t.id}/`, target: '_blank', rel: 'noopener', title: `Open ${t.id}'s report in a new tab` }, 'Report ↗') : null),
      steps.length ? el('div', { class: 'seg', role: 'group', 'aria-label': 'Steps' },
        steps.map((x) => el('button', {
          type: 'button',
          'aria-pressed': String(x.id === step?.id),
          title: `${x.label} — ${STEP_STATUS[x.status] ?? x.status}${x.reviewers.length ? `; reviewed by ${x.reviewers.join(', ')}` : ''}`,
          onclick: () => { this.stepId = x.id; this.update(process, true); },
        }, `${x.id} ${x.kind}${x.status === 'done' ? ' ✓' : x.status === 'pending' ? ' …' : ''}`))) : null);

    let body;
    if (!step) {
      body = el('div', { class: 'forum-posts', tabindex: '0' }, el('p', { class: 'empty', text: t.engineer === 'pending' ? 'Waiting for the engineer to start.' : 'The engineer is choosing the steps for this task.' }));
    } else {
      const f = step.forum;
      const current = new Map();
      for (const p of f.posts) if (p.kind === 'review' && p.round === f.round) current.set(p.role, p.verdict);
      const round = f.round ? f.round - f.windowStart : 0;
      const status = el('p', { class: 'step-status' }, `${step.label} · ${STEP_STATUS[step.status] ?? step.status}${step.verification ? ` · verification ${step.verification.result.toUpperCase()} (${step.verification.artifacts} artifact${step.verification.artifacts === 1 ? '' : 's'})` : ''}`);
      const votes = step.reviewers.length && f.round ? el('ul', { class: 'votes', 'aria-label': `Round ${round} votes` },
        el('li', { class: 'votes-round', text: `Round ${round} of ${process.maxRounds}` }),
        step.reviewers.map((r) => {
          const v = current.get(r);
          return el('li', { class: `vote ${v ? `vote-${v}` : 'vote-pending'}` }, `${r[0].toUpperCase()}${r.slice(1)} · ${v === 'approve' ? 'APPROVE' : v === 'changes' ? 'CHANGES' : 'pending'}`);
        })) : null;
      const artifact = step.version ? el('details', { class: 'artifact', open: !step.reviewers.length }, el('summary', { text: `${step.label} · v${step.version}` }), el('pre', { text: step.output })) : null;
      const posts = f.posts.length
        ? el('ol', { class: 'posts' }, f.posts.map((p) => el('li', { class: `post post-${p.kind}` },
            el('div', { class: 'post-head' },
              el('span', { class: 'round', text: `R${Math.max(1, p.round - f.windowStart)}` }),
              el('strong', { text: p.author }),
              p.verdict ? el('span', { class: `vote vote-${p.verdict}`, text: p.verdict === 'approve' ? 'APPROVE' : 'CHANGES' }) : null,
              el('span', { class: 'when', text: ago(p.at) })),
            el('pre', { class: 'post-body', text: p.text }))))
        : el('p', { class: 'empty', text: step.reviewers.length ? `The review (${step.reviewers.join(', ')}) opens once the work is in.` : step.version ? 'This step has no reviewers.' : 'Work on this step hasn\'t produced anything yet.' });
      const delivered = t.delivery ? el('details', { class: 'artifact', open: true }, el('summary', { text: 'Delivered to you' }), el('pre', { text: t.delivery })) : null;
      body = el('div', { class: 'forum-posts', tabindex: '0', 'aria-label': `${step.id} output and review` }, delivered, status, votes, artifact, posts);
    }
    // The engineer's status board, the PR and anything the human is needed for, above the steps.
    const banner = [];
    if (t.pause) banner.push(el('p', { class: 'task-banner', style: { '--task': color } }, t.pause.kind === 'hold' ? `On hold${t.pause.note ? `: ${t.pause.note}` : ''}. Resume it through the Chief of Staff.` : `Blocked on you: ${t.pause.need ?? ''}${t.pause.by ? ` (reported by the ${t.pause.by.toLowerCase()})` : ''}. Tell the Chief of Staff when it's done.`));
    if (t.ship?.pr) banner.push(el('p', { class: 'task-banner', style: { '--task': color } }, el('a', { class: 'report-link', href: t.ship.pr.url, target: '_blank', rel: 'noopener', text: 'PR ↗' }), ' ', t.ship.pr.error ? `PR #${t.ship.pr.number}: Grove can't read it (${t.ship.pr.error})` : t.ship.pr.line));
    if (t.updates?.length) banner.push(el('details', { class: 'artifact', open: true }, el('summary', { text: `Updates from the engineer (${t.updates.length})` }), el('ol', { class: 'updates-list' }, [...t.updates].reverse().slice(0, 8).map((u) => el('li', {}, el('span', { class: 'when', text: ago(u.at) }), ' ', u.text)))));
    const open = (t.questions ?? []).filter((q) => !q.answer);
    if (open.length) banner.push(el('p', { class: 'task-banner', style: { '--task': color } }, `Your question, not answered yet: ${open.at(-1).text}`));
    if (banner.length) body.prepend(...banner);
    const note = el('p', { class: 'forum-note', text: t.waitingOnHuman ? 'This task is waiting on you: answer from the Chief of Staff\'s inbox (click the Chief in the grove) or in its chat.' : 'Read-only. Each task runs in its own lead chat; decide from the Chief of Staff\'s inbox or its chat.' });
    this.root.replaceChildren(header, body, note);
    body.scrollTop = atBottom && !force ? body.scrollHeight : prevTop;
  }
}
