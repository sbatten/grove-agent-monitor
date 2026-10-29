import './sprites/index.mjs';
import { Grove, W, H, CHIEF_ID } from './scene/grove.mjs';
import { layoutGallery, drawGallery, GALLERY_W } from './scene/gallery.mjs';
import { makeCanvas } from './engine/dither.mjs';
import { STATIONS, STATION_LABELS, ACTIVITY_STATION } from './model.mjs';
import { TaskStrip, ForumView } from './tasks.mjs';
import { InboxPanel } from './inbox.mjs';

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const statusEl = $('status');

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const grove = new Grove(7);
const gallery = layoutGallery();
const [, galleryGlow] = makeCanvas(GALLERY_W, gallery.height);

let state = null;
let tick = 0;
let paused = false;
let connected = false;
let selectedId = null;
let hoverId = null;

function api(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  });
}

function setStatus(text) {
  statusEl.textContent = text;
}

// Feedback for something the human just did stays up for a few seconds over the connection status.
let notice = null;
function announce(text) {
  notice = { text, until: Date.now() + 6000 };
  setStatus(text);
}

function applyState(next) {
  const viewChanged = next.view !== state?.view;
  state = next;
  grove.setState(next);
  if (selectedId && !next.agents.some((a) => a.id === selectedId)) selectedId = null;
  if (hoverId?.startsWith('tent:') && !grove.cast.tents.has(hoverId.slice(5))) hoverId = null;
  if (viewChanged) configureView();
  $('theme').value = next.theme;
  strip.update(next.process ?? null);
  inbox.update(next.process ?? null);
  updateInboxButton();
  if (forum.open) stripEl.hidden = true;
  forum.update(next.process ?? null);
  describeScene();
  if (notice && Date.now() < notice.until) setStatus(notice.text);
  else setStatus(`${connected ? 'Connected' : 'Offline'} · scene “${next.scene}” · ${next.agents.length} agent${next.agents.length === 1 ? '' : 's'}`);
  if (paused) render();
}

function describeScene() {
  if (state.view === 'gallery') {
    canvas.setAttribute('aria-label', 'Sprite gallery showing every Grove sprite and animation');
    return;
  }
  const parts = [];
  const tents = grove.cast.tents;
  const inTent = (a) => ACTIVITY_STATION[a.activity] === 'camp' && a.taskId && !a.error && tents.has(a.taskId);
  for (const id of STATIONS) {
    const here = state.agents.filter((a) => ACTIVITY_STATION[a.activity] === id && !inTent(a));
    if (here.length) parts.push(`${STATION_LABELS[id].toLowerCase()}: ${here.map((a) => `${a.taskId ? `${a.taskName ?? a.taskId} ` : ''}${a.name || a.id}${a.error ? ' (error)' : ''}`).join(', ')}`);
  }
  for (const taskId of tents.keys()) {
    const here = state.agents.filter((a) => a.taskId === taskId && inTent(a));
    const task = state.process?.tasks?.find((t) => t.id === taskId);
    parts.push(`${task?.name ?? taskId} tent${task?.title ? ` (${task.title})` : ''}: ${here.length ? here.map((a) => a.name || a.id).join(', ') : 'empty'}`);
  }
  canvas.setAttribute('aria-label', parts.length ? `Forest grove. ${parts.join('; ')}.` : 'Forest grove with no agents hired.');
}

function updateInboxButton() {
  const btn = $('inbox-btn');
  btn.hidden = !inbox.available;
  const n = inbox.count;
  $('inbox-count').textContent = n ? String(n) : '';
  btn.classList.toggle('has-asks', n > 0);
  const attached = state?.process?.inbox?.attached ?? [];
  $('inbox-attached').textContent = attached.length ? `📎 ${attached.join(', ')}` : '';
  const att = state?.process?.inbox?.attached ?? [];
  btn.setAttribute('aria-label', `${n ? `Inbox: ${n} ${n === 1 ? 'task needs' : 'tasks need'} you` : 'Inbox: nothing waiting on you'}${att.length ? `; attached to your next message: ${att.join(', ')}` : ''}`);
  btn.setAttribute('aria-expanded', String(inbox.open));
}

function select(id) {
  selectedId = id;
  if (paused) render();
}

function openForum(taskId) {
  inbox.close();
  forumEl.hidden = false;
  stage.hidden = true;
  stripEl.hidden = true;
  forum.show(taskId, state?.process ?? null);
}

function closeForum() {
  forum.hide();
  forumEl.hidden = true;
  stage.hidden = false;
  stripEl.hidden = !(state?.process?.tasks?.length);
  fit();
  stripEl.querySelector('button')?.focus();
}

function configureView() {
  const g = state.view === 'gallery';
  canvas.width = g ? GALLERY_W : W;
  canvas.height = g ? gallery.height : H;
  ctx.imageSmoothingEnabled = false;
  stage.classList.toggle('gallery', g);
  $('view-scene').setAttribute('aria-pressed', String(!g));
  $('view-gallery').setAttribute('aria-pressed', String(g));
  fit();
  render();
}

// Integer scaling in *device* pixels keeps every art pixel crisp at any devicePixelRatio,
// so the canvas stays sharp in narrow side panels as well as full windows.
function fit() {
  if (!state) return;
  const dpr = window.devicePixelRatio || 1;
  const aw = Math.max(1, stage.clientWidth - 16);
  const ah = Math.max(1, stage.clientHeight - 16);
  const cw = canvas.width;
  const ch = canvas.height;
  const gallery = state.view === 'gallery';
  const fitDev = gallery ? (aw * dpr) / cw : Math.min((aw * dpr) / cw, (ah * dpr) / ch);
  const dev = Math.floor(fitDev);
  const css = dev >= 1 ? dev / dpr : Math.min(aw / cw, gallery ? Infinity : ah / ch);
  canvas.style.width = `${cw * css}px`;
  canvas.style.height = `${ch * css}px`;
}

function render() {
  if (!state) return;
  if (state.view === 'gallery') drawGallery(ctx, galleryGlow, tick, gallery);
  else grove.draw(ctx, tick, { motion: reducedMotion.matches ? 0.25 : 1, selectedId, hoverId, quietId: inbox.open ? CHIEF_ID : null });
}

let last = performance.now();
let acc = 0;
function frame(now) {
  // Hidden webviews stop rAF; when we come back, show where everyone is now rather than replaying walks.
  if (now - last > 1000) {
    grove.cast.settle();
    acc = 0;
    last = now;
  }
  acc += now - last;
  last = now;
  let steps = Math.min(4, Math.floor(acc / (1000 / 60)));
  acc -= steps * (1000 / 60);
  if (acc > 100) acc = 0;
  if (!paused && steps > 0 && state) {
    while (steps-- > 0) {
      tick++;
      grove.update(tick, reducedMotion.matches ? 0.25 : 1);
    }
    render();
  }
  requestAnimationFrame(frame);
}

function toScene(e) {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
}

canvas.addEventListener('mousemove', (e) => {
  if (state?.view !== 'scene') return;
  // Hover only highlights; details (an agent's tooltip, the Chief's inbox) open on click.
  hoverId = grove.hitTest(...toScene(e));
  canvas.style.cursor = hoverId ? 'pointer' : 'default';
});
canvas.addEventListener('mouseleave', () => {
  hoverId = null;
});
canvas.addEventListener('click', (e) => {
  if (state?.view !== 'scene') return;
  const id = grove.hitTest(...toScene(e));
  // Clicking the Chief (or the books over it) opens its inbox, a menu over the whole grove.
  if (id === CHIEF_ID && inbox.available) { inbox.show(); return; }
  // Clicking a team tent opens its task's steps and reviews.
  if (id?.startsWith('tent:') && state.process?.tasks?.some((t) => t.id === id.slice(5))) { openForum(id.slice(5)); return; }
  select(id && id !== selectedId ? id : null);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (inbox.open) inbox.close(true);
  else if (forum.open) closeForum();
  else if (selectedId) select(null);
});

async function snapshot({ requestId, scale }) {
  if (document.hidden || performance.now() - last > 250) grove.cast.settle();
  render();
  const s = Math.max(1, Math.min(4, scale | 0 || 3));
  const [big, bctx] = makeCanvas(canvas.width * s, canvas.height * s);
  bctx.drawImage(canvas, 0, 0, big.width, big.height);
  const png = big.toDataURL('image/png').split(',')[1];
  await api('api/snapshot', { requestId, png, width: big.width, height: big.height, view: state.view }).catch((e) => setStatus(`Snapshot failed: ${e.message}`));
}

function connect() {
  const es = new EventSource('api/events');
  es.addEventListener('state', (e) => {
    connected = true;
    applyState(JSON.parse(e.data));
  });
  es.addEventListener('snapshot', (e) => snapshot(JSON.parse(e.data)));
  es.onerror = () => {
    connected = false;
    setStatus('Reconnecting to the grove…');
  };
}

const report = (e) => setStatus(e.message);
const stripEl = $('task-strip');
const forumEl = $('forum');
const strip = new TaskStrip({ root: stripEl, onOpen: (id) => openForum(id) });
const forum = new ForumView({ root: forumEl, onClose: () => closeForum() });
const inbox = new InboxPanel({
  root: $('inbox'),
  api,
  onStatus: announce,
  onChange: () => { updateInboxButton(); if (paused) render(); },
});
$('inbox-btn').addEventListener('click', () => {
  if (inbox.open) inbox.close(true);
  else inbox.show();
});
$('view-scene').addEventListener('click', () => api('api/view', { view: 'scene' }).catch(report));
$('view-gallery').addEventListener('click', () => api('api/view', { view: 'gallery' }).catch(report));
$('demo').addEventListener('click', () => api('api/demo').catch(report));
$('clear').addEventListener('click', () => api('api/clear').catch(report));
$('theme').addEventListener('change', (e) => api('api/configure', { theme: e.target.value }).catch(report));
$('pause').addEventListener('click', (e) => {
  paused = !paused;
  e.currentTarget.setAttribute('aria-pressed', String(paused));
  e.currentTarget.textContent = paused ? 'Resume' : 'Pause';
});

const resizer = new ResizeObserver(() => fit());
resizer.observe(stage);
resizer.observe(stripEl);
addEventListener('resize', fit);
matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener?.('change', fit);
connect();
requestAnimationFrame(frame);
