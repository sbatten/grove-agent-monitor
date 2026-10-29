// The Chief of Staff's inbox: click the Chief in the grove (or the Inbox button) to open it. It's a near
// full-screen menu over the grove, like a game's pause menu, with one row per task: a book that opens the
// task's report, what it needs and a short summary, then its actions in a column of their own (attach to the
// Chief's chat, Complete / Merge, Shelve, Dismiss). Asks come first, then tasks in progress, then the shelf:
// tasks set aside for later, which you can bring back.
import { PALETTE } from './engine/palette.mjs';
import { drawSprite } from './engine/sprites.mjs';

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
  if (!ts) return '';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// The book sprite in the task's colour, drawn at art size and scaled up crisply by CSS.
function bookIcon(color) {
  const c = el('canvas', { width: '14', height: '16', class: 'book-icon', 'aria-hidden': 'true' });
  drawSprite(c.getContext('2d'), 'book', 7, 15, { anim: 'glow', variant: color, tick: 0 });
  return c;
}

const FINISHED = new Set(['done', 'cancelled']);
const CONFIRM_MS = 4000;

export class InboxPanel {
  constructor({ root, api, onStatus, onChange }) {
    this.root = root;
    this.api = api;
    this.onStatus = onStatus;
    this.onChange = onChange;
    this.process = null;
    this.confirming = new Map(); // task id → timer while Dismiss waits for a second click
    this.busy = new Set();
    this.key = '';
    this.returnFocus = null;
    // Clicking the dimmed grove around the panel closes it.
    root.addEventListener('mousedown', (e) => { if (e.target === root) this.close(true); });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); this.close(true); return; }
      if (e.key === 'Tab') this.trapFocus(e);
    });
  }

  // Keep keyboard focus inside the open menu.
  trapFocus(e) {
    const all = [...this.root.querySelectorAll('button:not([disabled]), a[href]')].filter((n) => n.offsetParent);
    if (!all.length) return;
    const first = all[0];
    const last = all.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  get open() {
    return !this.root.hidden;
  }

  get count() {
    return this.process?.inbox?.items?.length ?? 0;
  }

  get available() {
    return !!this.process?.inbox;
  }

  update(process) {
    this.process = process;
    if (!this.available && this.open) this.close();
    if (this.open) this.render();
  }

  show() {
    if (!this.available) return;
    const wasOpen = this.open;
    if (!wasOpen) this.returnFocus = document.activeElement;
    this.root.hidden = false;
    this.render(!wasOpen);
    if (!wasOpen) {
      (this.root.querySelector('.row .act-complete') ?? this.root.querySelector('.row .act') ?? this.root.querySelector('.inbox-close'))?.focus();
      this.onChange?.();
    }
  }

  close(restoreFocus = false) {
    if (!this.open) return;
    this.root.hidden = true;
    this.key = '';
    this.onChange?.();
    if (restoreFocus) {
      const back = this.returnFocus && document.contains(this.returnFocus) && this.returnFocus !== document.body ? this.returnFocus : document.getElementById('inbox-btn');
      back?.focus();
    }
    this.returnFocus = null;
  }

  async act(taskId, kind, run, done) {
    if (this.busy.has(taskId)) return;
    this.busy.add(taskId);
    this.render(true);
    try {
      const out = await run();
      done?.(out);
    } catch (err) {
      this.onStatus(`${taskId}: ${err.message}`);
    } finally {
      this.busy.delete(taskId);
      if (this.open) this.render(true);
    }
  }

  isAttached(id) {
    return (this.process?.inbox?.attached ?? []).includes(id);
  }

  // Grove adds attached tasks to the human's next message to the Chief; clicking again removes one.
  attach(t) {
    const attach = !this.isAttached(t.id);
    return this.act(t.id, 'attach', () => this.api('api/inbox/attach', { taskId: t.id, attach }), (out) => {
      this.process = { ...this.process, inbox: { ...this.process.inbox, attached: out.attached } };
      this.onStatus(attach
        ? `${t.name ?? t.id} is attached: your next message to the Chief of Staff is about it. Write it in the Chief's chat.`
        : `${t.name ?? t.id} is no longer attached.`);
    });
  }

  complete(t) {
    return this.act(t.id, 'complete', () => this.api('api/inbox/decide', { taskId: t.id, action: 'complete' }), (out) => {
      this.onStatus({ done: `${t.name ?? t.id} completed: signed off.`, shipping: `${t.name ?? t.id} approved: the team opens a pull request next.` }[out.outcome] ?? `${t.name ?? t.id}: step accepted; the team carries on.`);
    });
  }

  merge(t) {
    return this.act(t.id, 'merge', () => this.api('api/inbox/decide', { taskId: t.id, action: 'merge' }), () => {
      this.onStatus(`${t.name ?? t.id}: the team is merging the pull request.`);
    });
  }

  // Set a task that's waiting on you aside for later, or bring it back into the inbox.
  shelve(t, back = false) {
    return this.act(t.id, back ? 'unshelve' : 'shelve', () => this.api('api/inbox/decide', { taskId: t.id, action: back ? 'unshelve' : 'shelve' }), () => {
      this.onStatus(back ? `${t.name ?? t.id} is back in your inbox.` : `${t.name ?? t.id} is on the shelf: out of your inbox, with its engineer resting. Bring it back from the shelf whenever you're ready.`);
    });
  }

  dismiss(t) {
    if (!this.confirming.has(t.id)) {
      this.confirming.set(t.id, setTimeout(() => { this.confirming.delete(t.id); if (this.open) this.render(true); }, CONFIRM_MS));
      this.render(true);
      this.root.querySelector(`[data-dismiss="${t.id}"]`)?.focus();
      return undefined;
    }
    clearTimeout(this.confirming.get(t.id));
    this.confirming.delete(t.id);
    return this.act(t.id, 'dismiss', () => this.api('api/inbox/decide', { taskId: t.id, action: 'dismiss' }), () => this.onStatus(`${t.name ?? t.id} dismissed: the task is cancelled.`));
  }

  buttons(t, { ask, shelved = false }) {
    const inbox = this.process.inbox;
    const busy = this.busy.has(t.id);
    const confirming = this.confirming.has(t.id);
    const who = t.name ? `${t.name} (${t.id})` : t.id;
    const out = [];
    if (inbox.canAttach) {
      const on = this.isAttached(t.id);
      out.push(el('button', {
        type: 'button',
        class: `act act-attach${on ? ' attached' : ''}`,
        disabled: busy,
        'aria-pressed': String(on),
        'aria-label': `Attach ${who} to your next message to the Chief of Staff`,
        title: on ? 'Attached: your next message to the Chief of Staff is about this task. Click to remove it.' : 'Your next message to the Chief of Staff will be about this task, so you don\'t have to name it',
        onclick: () => this.attach(t),
      }, on ? '📎 Attached ✕' : '📎 Attach to chat'));
    }
    if (inbox.canDecide) {
      if (shelved) {
        out.push(el('button', { type: 'button', class: 'act act-complete', disabled: busy, 'aria-label': `Bring ${who} back to your inbox`, title: 'Put it back in your inbox, exactly where it was', onclick: () => this.shelve(t, true) }, '↩ Bring back'));
      }
      // Blockers are answered through the Chief of Staff (attach the task and say it's done), not a button.
      if (shelved) { /* no other answers here: bring it back, or attach it and tell the Chief */ } else if (ask?.kind === 'merge') {
        out.push(el('button', { type: 'button', class: 'act act-complete', disabled: busy, 'aria-label': `Merge ${who}'s pull request`, title: 'The team merges the pull request (without bypassing checks or reviews)', onclick: () => this.merge(t) }, '⇢ Merge'));
      } else if (ask && ask.kind !== 'blocked') {
        const accept = ask.kind === 'input';
        const ships = ask.kind === 'sign-off' && /PR/.test(ask.label);
        out.push(el('button', { type: 'button', class: 'act act-complete', disabled: busy, 'aria-label': `${accept ? 'Accept' : ships ? 'Approve' : 'Complete'} ${who}`, title: accept ? 'Accept the stuck step as it is; the team carries on' : ships ? 'Approve the change: the team opens a pull request, and Grove watches it until it\'s ready to merge' : 'Sign off: the task is done', onclick: () => this.complete(t) }, accept ? '✓ Accept' : ships ? '✓ Approve' : '✓ Complete'));
      }
      if (ask) {
        out.push(el('button', { type: 'button', class: 'act act-shelve', disabled: busy, 'aria-label': `Shelve ${who}`, title: 'Not now: set it aside for later. It leaves your inbox, its engineer rests, and everything is kept until you bring it back.', onclick: () => this.shelve(t) }, '⤓ Shelve'));
      }
      out.push(el('button', { type: 'button', class: `act act-dismiss${confirming ? ' confirming' : ''}`, 'data-dismiss': t.id, disabled: busy, 'aria-label': confirming ? `Confirm: dismiss ${who}` : `Dismiss ${t.id}`, title: 'Drop the task without finishing it (cancels it)', onclick: () => this.dismiss(t) }, confirming ? 'Confirm dismiss?' : '✕ Dismiss'));
    }
    return out;
  }

  // One task as a full-width row: its book (the report), what it is and needs, and its actions.
  row({ t, color, kind, report, label, labelClass, meta = [], ask, summary, buttons }) {
    const id = t.id;
    return el('li', { class: `row row-${kind}`, style: { '--task': PALETTE[color] ?? PALETTE.uiText } },
      report
        ? el('a', { class: 'book', href: report, target: '_blank', rel: 'noopener', 'data-focus': `book-${id}`, 'aria-label': `Open ${t.name ?? id}'s report`, title: `Open ${id}'s report: summary, decisions, evidence and reviews` }, bookIcon(color), el('span', { class: 'book-label', text: 'Report' }))
        : el('span', { class: 'book book-none', 'aria-hidden': 'true' }, el('span', { class: 'chip-flag' })),
      el('div', { class: 'row-body' },
        el('div', { class: 'task-kicker', text: t.name ? `${t.name} · ${id}` : id }),
        el('div', { class: 'row-title', text: t.title }),
        el('div', { class: 'row-meta' }, label ? el('span', { class: `row-kind ${labelClass ?? ''}`, text: label }) : null, ...meta),
        ask ? el('p', { class: 'row-ask', text: ask }) : null,
        summary ? el('p', { class: 'row-summary', text: summary }) : null),
      el('div', { class: 'row-actions' }, buttons.map((b) => { b.setAttribute('data-focus', `${b.className}-${id}`); return b; })));
  }

  section(title, rows, { className, empty } = {}) {
    if (!rows.length && !empty) return null;
    return el('section', { class: `inbox-section ${className ?? ''}`, 'aria-label': title },
      el('h3', {}, el('span', { text: title }), el('span', { class: 'count-pill', text: String(rows.length) })),
      rows.length ? el('ul', { class: 'rows' }, rows) : el('p', { class: 'inbox-empty', text: empty }));
  }

  render(force = false) {
    const p = this.process;
    if (!p?.inbox) return;
    const items = p.inbox.items;
    const waiting = new Set(items.map((i) => i.taskId));
    const shelf = p.inbox.shelf ?? [];
    const shelved = new Set(shelf.map((x) => x.taskId));
    const active = (p.tasks ?? []).filter((t) => !FINISHED.has(t.stage) && !waiting.has(t.id) && !shelved.has(t.id));
    const attached = p.inbox.attached ?? [];
    const key = JSON.stringify([items, active.map((t) => [t.id, t.name, t.stageLabel, t.title, t.updates?.at(-1)?.text]), shelf, p.inbox.canDecide, p.inbox.canAttach, attached, [...this.confirming.keys()], [...this.busy]]);
    if (!force && key === this.key) return;
    this.key = key;
    const focused = document.activeElement && this.root.contains(document.activeElement) ? document.activeElement.getAttribute('data-focus') : null;

    const head = el('header', { class: 'inbox-head' },
      el('div', { class: 'inbox-heading' },
        el('h2', { id: 'inbox-title', text: 'Chief of Staff · Inbox' }),
        el('p', { class: 'inbox-sub', text: items.length ? `${items.length} ${items.length === 1 ? 'task needs' : 'tasks need'} you` : 'Nothing is waiting on you' })),
      el('button', { type: 'button', class: 'inbox-close', 'aria-label': 'Close the inbox', 'data-focus': 'close', title: 'Close (Esc)', onclick: () => this.close(true) }, '✕ Close'));

    const askRows = items.map((a) => {
      const t = (p.tasks ?? []).find((x) => x.id === a.taskId) ?? { id: a.taskId, title: a.title };
      return this.row({
        t: { id: a.taskId, name: a.name, title: a.title }, color: a.color, kind: a.kind, report: a.report, label: a.label, labelClass: `kind-${a.kind}`,
        meta: [
          a.evidence ? el('span', { text: `${a.evidence} evidence item${a.evidence === 1 ? '' : 's'}` }) : null,
          a.pr ? el('a', { class: 'pr-link', href: a.pr, target: '_blank', rel: 'noopener', text: a.kind === 'sign-off' ? 'Draft PR ↗' : 'Open PR ↗' }) : null,
          a.since ? el('span', { text: ago(a.since) }) : null,
        ],
        ask: a.ask, summary: a.summary, buttons: this.buttons(t, { ask: a }),
      });
    });
    const runRows = active.map((t) => this.row({
      t, color: t.color, kind: 'run', report: null,
      label: t.engineer === 'pending' ? 'Waiting for its engineer' : t.stageLabel,
      summary: t.updates?.at(-1)?.text ?? '', buttons: this.buttons(t, { ask: null }),
    }));
    const shelfRows = shelf.map((x) => this.row({
      t: { id: x.taskId, name: x.name, title: x.title }, color: x.color, kind: 'shelved', report: x.report,
      label: `Was: ${x.was}`, meta: [x.since ? el('span', { text: `shelved ${ago(x.since)}` }) : null, x.pr ? el('a', { class: 'pr-link', href: x.pr, target: '_blank', rel: 'noopener', text: 'PR ↗' }) : null],
      summary: x.summary, buttons: this.buttons({ id: x.taskId, name: x.name, title: x.title }, { ask: null, shelved: true }),
    }));

    const notes = [];
    if (!p.inbox.canDecide && (items.length || active.length || shelf.length)) notes.push('Open the Grove from the Chief of Staff\'s chat to complete or dismiss tasks here.');
    if (!items.length && !active.length && !shelf.length) notes.push('Ask the Chief of Staff for something in its chat; tasks that need you show up here.');
    const attachedNote = attached.length ? el('p', { class: 'inbox-attached', role: 'status' },
      `📎 Your next message to the Chief of Staff is about ${attached.map((id) => (p.tasks ?? []).find((x) => x.id === id)?.name ?? id).join(', ')}. Write it in the Chief's chat; you don't need to name ${attached.length === 1 ? 'it' : 'them'}.`) : null;

    const panel = el('div', { class: 'inbox-panel' },
      head,
      el('div', { class: 'inbox-scroll' },
        attachedNote,
        this.section('Needs you', askRows, { className: 'inbox-asks', empty: 'Nothing is waiting on you.' }),
        this.section('In progress', runRows, { className: 'inbox-running' }),
        this.section('On the shelf', shelfRows, { className: 'inbox-shelf' }),
        notes.length ? el('p', { class: 'inbox-note', text: notes.join(' ') }) : null),
      el('footer', { class: 'inbox-foot' }, el('span', { text: 'Esc or click outside to return to the grove' })));
    this.root.replaceChildren(panel);
    if (focused) this.root.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus();
  }
}
