// Character classes, painted procedurally at 24×32 (anchor: feet at [12, 31], facing right).
// Every class shares the robe slots (robe0..robe4) so ROBES palette swaps give each agent its colour.
import { defineSprite } from '../engine/sprites.mjs';
import { painter } from '../engine/paint.mjs';
import { ROBES } from '../engine/palette.mjs';

const W = 24;
const H = 32;
const CX = 12;

const BASE_SLOTS = {
  robe0: 'robe_violet0', robe1: 'robe_violet1', robe2: 'robe_violet2', robe3: 'robe_violet3', robe4: 'robe_violet4',
  eye: 'cyan2', orb0: 'cyan0', orb1: 'cyan1', orb2: 'cyan2', orb3: 'cyan3', spark: 'amber2',
};
const VARIANTS = Object.fromEntries(Object.entries(ROBES).map(([name, slots]) => [name, { ...slots }]));

// ---------- pose helpers ----------

function bodyY(pose) {
  return (pose.bob ? 1 : 0) + (pose.sit ? 5 : 0) + (pose.slump ? 1 : 0);
}

function headY(pose) {
  return bodyY(pose) + (pose.nod ? 1 : 0) + (pose.slump ? 1 : 0);
}

function stride(pose) {
  return pose.walk == null ? 0 : [1, 0, -1, 0][pose.walk];
}

function feet(p, pose) {
  if (pose.sit) {
    p.ellipse(16, 30.3, 2.6, 1.6, 'leather', { bias: -0.6 });
    p.ellipse(19.6, 30.4, 2.7, 1.6, 'leather');
    return;
  }
  const s = stride(pose);
  const lift = pose.walk == null ? [0, 0] : [[0, 1], [0, 0], [1, 0], [0, 0]][pose.walk];
  p.ellipse(9.6 - s * 2, 30.3 - lift[0], 2.6, 1.6, 'leather', { bias: -0.7 });
  p.ellipse(14.4 + s * 2, 30.3 - lift[1], 2.8, 1.7, 'leather');
}

function legs(p, pose, top) {
  if (pose.sit) return;
  const s = stride(pose);
  p.stroke(10, top, 9.6 - s * 2, 29, 3.2, 'pants', { bias: -0.6 });
  p.stroke(14, top, 14.4 + s * 2, 29, 3.2, 'pants');
}

// Long garment from shoulders to hem; returns edge functions for trims.
function garment(p, pose, { top, hem = 29, sw = 11, hw = 16, trim = true, sash = true, folds = true, mat = 'robe' }) {
  const sway = pose.walk == null ? 0 : [1, 0, -1, 0][pose.walk];
  const h = pose.sit ? Math.min(hem + 1, 30) : hem;
  const w = pose.sit ? hw + 3 : hw;
  const l0 = CX - sw / 2;
  const r0 = CX + sw / 2;
  const l1 = CX - w / 2 + sway;
  const r1 = CX + w / 2 + sway;
  const xl = (y) => l0 + ((l1 - l0) * (y - top)) / (h - top);
  const xr = (y) => r0 + ((r1 - r0) * (y - top)) / (h - top);
  p.poly([[l0, top], [r0, top], [r1, h], [CX + sway, h + 1], [l1, h]], mat,
    { folds: folds ? [Math.round(CX - 3 + sway), Math.round(CX + 2 + sway)] : [] });
  if (trim) p.poly([[xl(h - 2), h - 2], [xr(h - 2), h - 2], [r1, h], [CX + sway, h + 1], [l1, h]], 'gold', { bias: -0.4 });
  if (sash) p.rect(Math.ceil(xl(top + 6)), top + 6, Math.floor(xr(top + 6)) - Math.ceil(xl(top + 6)), 1, 'gold', { shade: 'cyl' });
  return { xl, xr };
}

function backArm(p, y, mat = 'robe') {
  p.stroke(7.4, 16 + y, 6.4, 21.4 + y, 3.8, mat, { bias: -0.9 });
  p.circle(6.2, 22.6 + y, 1.6, 'skin', { bias: -0.7 });
}

function frontArm(p, from, hand, mat = 'robe') {
  p.stroke(from[0], from[1], hand[0] - 0.6, hand[1] - 0.8, 3.8, mat);
  p.circle(hand[0], hand[1], 1.7, 'skin');
}

function face(p, cx, cy, { rx = 4.4, ry = 4.5 } = {}) {
  p.ellipse(cx, cy, rx, ry, 'skin', { shade: 'sphere' });
}

function eyes(p, x, y, pose, token = 'ink') {
  if (pose.blink) {
    p.px([[x, y + 1], [x + 3, y + 1]], 'skin1', { outline: false });
    return;
  }
  p.px([[x, y], [x, y + 1], [x + 3, y], [x + 3, y + 1]], token, { outline: false });
  if (token === 'ink') p.px([[x, y], [x + 3, y]], 'white', { outline: false });
}

function staff(p, { x = 18, top = 4, orbR = 2.6, act = null, orbX = 18.9, orbY = 3.4 }) {
  p.rect(x, top + 1, 2, 31 - top, 'wood');
  const pulse = act === 1 ? 0.5 : 0;
  p.circle(orbX, orbY, orbR + pulse, 'orb', { n: 4, bias: act === 1 ? 1 : 0, casts: false });
  p.px([[x - 1, top + 2], [x + 2, top + 2]], 'gold3');
  if (act === 2) p.px([[orbX - 3, orbY - 1], [orbX + 3, orbY + 1], [orbX - 1, orbY - 3], [orbX + 2, orbY - 3]].map(([a, b]) => [Math.round(a), Math.round(b)]), 'orb3', { outline: false });
}

function sparkles(p, cx, cy, act, token) {
  const ring = [[[-3, -1], [3, 1]], [[-1, -3], [2, -2], [-3, 2]], [[3, -2], [-2, 3]], []][act % 4];
  p.px(ring.map(([dx, dy]) => [Math.round(cx + dx), Math.round(cy + dy)]), token, { outline: false });
}

// ---------- classes ----------

function mage(pose) {
  const p = painter(W, H);
  const y = bodyY(pose);
  const h = headY(pose);
  feet(p, pose);
  backArm(p, y);
  garment(p, pose, { top: 14 + y });
  p.poly([[7.5, 7 + h], [12.5, 3.6 + h], [8.6, 1 + h]], 'robe', { bias: 0.2 });
  p.ellipse(12, 9.4 + h, 6.2, 6.3, 'robe');
  p.ellipse(13.4, 10.8 + h, 3.5, 3.3, 'shadow');
  if (!pose.blink) p.px([[12, 10 + h], [15, 10 + h]], 'eye', { outline: false });
  staff(p, { act: pose.slump ? null : pose.act, orbR: pose.slump ? 2.2 : 2.6 });
  frontArm(p, [15.6, 16 + y], [18.8, 20.6 + y]);
  return p.finish();
}

function archmage(pose) {
  const p = painter(W, H);
  const y = bodyY(pose);
  const h = headY(pose);
  feet(p, pose);
  backArm(p, y);
  garment(p, pose, { top: 14 + y, sw: 12, hw: 18 });
  face(p, 12.2, 9.6 + h, { rx: 4.2, ry: 4.2 });
  eyes(p, 11, 8 + h, pose);
  p.px([[10, 7 + h], [11, 7 + h], [14, 7 + h], [15, 7 + h]], 'beard4', { outline: false });
  p.poly([[8.6, 11.4 + h], [16.2, 11.4 + h], [15.6, 17 + y], [12.6, 22 + y], [9.6, 17 + y]], 'beard', { shade: 'cyl' });
  p.px([[11, 12 + h], [12, 12 + h], [13, 12 + h], [14, 12 + h]], 'beard2', { outline: false });
  p.ellipse(12, 5.8 + h, 7.4, 1.8, 'robe', { bias: -0.2 });
  p.poly([[7.6, 5.6 + h], [16.4, 5.6 + h], [14.4, 2.6 + h], [8.6, 0.6 + h]], 'robe', { bias: 0.3 });
  p.rect(8, 4 + h, 8, 1, 'gold', { bias: 0.5 });
  p.px([[11, 2 + h], [13, 3 + h]], 'amber2', { outline: false });
  staff(p, { act: pose.slump ? null : pose.act, orbR: pose.slump ? 2.4 : 3, orbY: 3.6 });
  frontArm(p, [15.6, 16 + y], [18.8, 20.6 + y]);
  return p.finish();
}

function scribe(pose) {
  const p = painter(W, H);
  const y = bodyY(pose);
  const h = headY(pose);
  feet(p, pose);
  garment(p, pose, { top: 14 + y, sw: 11, hw: 15 });
  face(p, 12, 9.8 + h);
  p.ellipse(8.4, 9.8 + h, 1.4, 2.2, 'hair', { bias: -0.4 });
  p.stroke(7.4, 4.6 + h, 4.6, 1.6 + h, 1.3, 'cloth', { bias: 0.6 });
  p.px([[4, 1 + h]], 'ink');
  p.ellipse(11.6, 5.6 + h, 5.4, 2.6, 'robe', { bias: 0.2 });
  p.px([[12, 3 + h], [13, 3 + h]], 'gold3');
  eyes(p, 11, 9 + h, pose);
  const ring = (cx, cy) => [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]].map(([a, b]) => [cx + a, cy + b]);
  p.px([...ring(11, 10 + h), ...ring(14, 10 + h)].filter(([a]) => a !== 12 || true), 'gold3', { outline: false });
  if (!pose.blink) p.px([[11, 10 + h], [14, 10 + h]], 'ink', { outline: false });
  // Open book held at the chest.
  const by = 17 + y;
  const turning = !pose.slump && pose.act === 2;
  p.poly([[8.6, by], [12.6, by + 1], [12.6, by + 6], [8.6, by + 5]], 'cloth', { bias: -0.6, shade: 'flat', level: 2 });
  p.poly([[12.6, by + 1], [16.8, by], [16.8, by + 5], [12.6, by + 6]], 'cloth', { shade: 'flat', level: 3 });
  if (turning) p.poly([[12.6, by - 2], [14.6, by - 3], [14.6, by + 4], [12.6, by + 5]], 'cloth', { shade: 'flat', level: 4 });
  p.stroke(8.6, by + 5.6, 16.8, by + 5.6, 1.2, 'leather', { bias: -0.5 });
  const glow = pose.slump ? 'cloth1' : pose.act === 1 || pose.act === 3 ? 'runeHi' : 'rune';
  p.px([[10, by + 2], [11, by + 2], [10, by + 4], [14, by + 2], [15, by + 2], [14, by + 3], [15, by + 4]], glow, { outline: false });
  p.circle(8.8, by + 3.6, 1.6, 'skin', { bias: -0.4 });
  p.circle(16.8, by + 3.4, 1.6, 'skin');
  return p.finish();
}

function artificer(pose) {
  const p = painter(W, H);
  const y = bodyY(pose);
  const h = headY(pose);
  const act = pose.slump ? null : pose.act;
  feet(p, pose);
  legs(p, pose, 24);
  backArm(p, y);
  garment(p, pose, { top: 14 + y, hem: 25, sw: 11, hw: 13, trim: false, sash: false, folds: false });
  p.poly([[9, 17 + y], [15, 17 + y], [15.6, 26], [8.4, 26]], 'leather', { bias: 0.4 });
  p.rect(7, 20 + y, 10, 1, 'leather', { bias: -1 });
  p.px([[12, 20 + y]], 'gold3');
  face(p, 12, 10 + h);
  eyes(p, 11, 10 + h, pose);
  p.ellipse(11.6, 6.8 + h, 4.9, 2.8, 'ginger', { bias: 0.2 });
  for (const sp of [[[7, 7.4], [5.6, 3.2], [9.4, 5.4]], [[8.8, 5.4], [9.6, 1.4], [11.8, 4.6]], [[11.2, 4.8], [13.4, 1], [14.4, 5]], [[13.6, 5.2], [17, 2.8], [16.2, 7]]]) {
    p.poly(sp.map(([a, b]) => [a, b + h]), 'ginger', { bias: 0.4 });
  }
  p.rect(7, 7 + h, 10, 1, 'leather', { bias: -0.8 });
  const lens = act === 2 ? 'lensHi' : 'lens';
  p.circle(11.4, 7.4 + h, 1.5, lens, { shade: 'flat', casts: false });
  p.circle(14.8, 7.4 + h, 1.5, lens, { shade: 'flat', casts: false });
  // Hammer: hanging at rest, raised then striking while working.
  const pose4 = act == null ? { hand: [18.6, 20.6 + y], ang: 1.72 } : [
    { hand: [17.6, 15.6 + y], ang: -2.05 },
    { hand: [18.8, 19 + y], ang: 1.25 },
    { hand: [18.8, 19 + y], ang: 1.25 },
    { hand: [18, 17 + y], ang: -1.55 },
  ][act];
  const [hx, hyy] = pose4.hand;
  const L = 8;
  const ex = hx + Math.cos(pose4.ang) * L;
  const ey = hyy + Math.sin(pose4.ang) * L;
  p.stroke(hx, hyy, ex, ey, 1.6, 'wood');
  const nx = -Math.sin(pose4.ang);
  const ny = Math.cos(pose4.ang);
  p.stroke(ex - nx * 2.4, ey - ny * 2.4, ex + nx * 2.4, ey + ny * 2.4, 3.4, 'metal', { shade: 'sphere' });
  frontArm(p, [15.6, 16 + y], pose4.hand);
  if (act === 1) p.px([[21, 27], [22, 25], [19, 28], [23, 28], [20, 24]], 'spark', { outline: false });
  return p.finish();
}

function seer(pose) {
  const p = painter(W, H);
  const y = bodyY(pose);
  const h = headY(pose);
  const act = pose.slump ? null : pose.act;
  feet(p, pose);
  backArm(p, y);
  garment(p, pose, { top: 14 + y, sw: 11, hw: 17 });
  p.px([[9, 22 + y], [14, 19 + y], [11, 26], [16, 25]], 'stars', { outline: false });
  p.poly([[8, 6 + h], [15, 6 + h], [11.6, 0.6 + h]], 'robe', { bias: 0.3 });
  p.ellipse(12, 9.8 + h, 6.2, 6.4, 'robe');
  p.ellipse(13.4, 11.2 + h, 3.5, 3.4, 'cloth', { bias: -0.4 });
  p.rect(10, 9 + h, 7, 2, 'shadow');
  if (!pose.blink) p.px([[11, 9 + h], [15, 9 + h]], 'eye', { outline: false });
  p.circle(13.4, 6.6 + h, 1.2, pose.slump ? 'rock1' : 'gem', { shade: 'flat', casts: false });
  // Palm up, orb hovering above it.
  const hand = [18.4, 19.6 + y];
  frontArm(p, [15.6, 16 + y], hand);
  if (!pose.slump) {
    const oy = act == null ? 0 : [0, -1, -2, -1][act];
    p.circle(19.2, 14 + y + oy, 2.3, 'orb', { n: 4, bias: act === 2 ? 1 : 0, casts: false });
    if (act != null) sparkles(p, 19.2, 14 + y + oy, act, 'orb3');
  }
  return p.finish();
}

function warden(pose) {
  const p = painter(W, H);
  const y = bodyY(pose);
  const h = headY(pose);
  const act = pose.slump ? null : pose.act;
  feet(p, pose);
  legs(p, pose, 26);
  backArm(p, y, 'metal');
  garment(p, pose, { top: 15 + y, hem: 27, sw: 11, hw: 14, sash: false, folds: false });
  p.ellipse(12, 18.4 + y, 5.4, 4.6, 'metal', { shade: 'sphere' });
  p.px([[12, 17 + y], [12, 18 + y], [12, 19 + y]], 'metal1', { outline: false });
  // Antlers behind the helm.
  p.stroke(8.4, 5 + h, 5, 1.2 + h, 1.4, 'wood', { bias: 0.4 });
  p.stroke(6.4, 3 + h, 3.6, 3.4 + h, 1.2, 'wood', { bias: 0.4 });
  p.stroke(15.6, 5 + h, 19, 1.2 + h, 1.4, 'wood', { bias: 0.6 });
  p.stroke(17.6, 3 + h, 20.4, 3 + h, 1.2, 'wood', { bias: 0.6 });
  face(p, 12.4, 11 + h, { rx: 4, ry: 3.8 });
  eyes(p, 11, 10 + h, pose);
  p.ellipse(12, 7.6 + h, 5.2, 3.8, 'metal', { shade: 'sphere' });
  p.rect(7, 8 + h, 2, 4, 'metal', { bias: -0.6 });
  p.rect(6.8, 9 + h, 10.6, 1, 'metal', { bias: -1 });
  // Shield with a rune, carried in front.
  const sy = 20.6 + y + (act === 1 ? -1 : 0);
  p.ellipse(18.6, sy, 3.6, 4.8, 'wood', { shade: 'sphere' });
  p.ellipse(18.9, sy, 2.5, 3.6, 'metal', { shade: 'sphere', bias: 0.2 });
  const rune = pose.slump ? 'metal1' : act === 1 ? 'runeHi' : 'rune';
  p.px([[19, sy - 2], [19, sy - 1], [19, sy], [19, sy + 1], [18, sy - 1], [20, sy - 1], [18, sy + 1], [20, sy + 1]].map(([a, b]) => [a, Math.round(b)]), rune, { outline: false });
  return p.finish();
}

function scout(pose) {
  const p = painter(W, H);
  const y = bodyY(pose);
  const h = headY(pose);
  const act = pose.slump ? null : pose.act;
  feet(p, pose);
  legs(p, pose, 23);
  backArm(p, y, 'leaf');
  p.poly([[8, 15 + y], [16, 15 + y], [16.6, 25], [7.4, 25]], 'leaf', { bias: -0.2 });
  p.rect(7.4, 21 + y, 9.4, 1, 'leather', { bias: -0.6 });
  p.poly([[6.4, 13 + y], [17.6, 13 + y], [18.6, 21 + y], [16.4, 23 + y], [14, 21.6 + y], [11.6, 23.4 + y], [9.4, 21.6 + y], [7.2, 23 + y], [5.6, 21 + y]], 'robe');
  p.poly([[7.6, 6.6 + h], [2.6, 2 + h], [9.6, 4.6 + h]], 'robe', { bias: 0.2 });
  p.ellipse(11.8, 8.8 + h, 5.6, 5.4, 'robe');
  face(p, 13, 10.6 + h, { rx: 3.9, ry: 3.9 });
  p.px([[11, 7 + h], [12, 7 + h], [13, 7 + h], [14, 7 + h]], 'hair3', { outline: false });
  p.poly([[8.8, 10.2 + h], [4.4, 7.6 + h], [9.2, 12 + h]], 'skin', { bias: -0.2 });
  eyes(p, 12, 10 + h, pose);
  // Lantern with a wisp, held out front.
  const sway = act == null ? 0 : [0, 1, 0, -1][act];
  const hand = [18.4, 18.4 + y];
  p.px([[18 + sway, 20 + y], [18 + sway, 21 + y]], 'gold2');
  p.rect(16 + sway, 22 + y, 5, 6, 'metal', { bias: -0.6 });
  p.rect(17 + sway, 23 + y, 3, 4, pose.slump ? 'glass1' : act === 1 || act === 3 ? 'wispHi' : 'wisp', { casts: false });
  p.poly([[15.6 + sway, 22.2 + y], [21.4 + sway, 22.2 + y], [18.5 + sway, 20 + y]], 'metal', { bias: 0.3 });
  frontArm(p, [15.6, 15.6 + y], hand, 'robe');
  return p.finish();
}

// ---------- registration ----------

function defineClass(id, description, build, { slots = {}, emissiveTokens = [] } = {}) {
  const frames = {};
  const add = (name, pose) => {
    frames[name] = build(pose);
    return name;
  };
  const idle = [add('idle0', {}), add('idle1', { bob: 1 }), 'idle0', add('blink', { blink: true })];
  const walk = [0, 1, 2, 3].map((i) => add(`walk${i}`, { walk: i, bob: i % 2 }));
  const work = [0, 1, 2, 3].map((i) => add(`work${i}`, { act: i }));
  add('talk0', {});
  add('talk1', { nod: 1 });
  const sit = [add('sit0', { sit: true }), add('sit1', { sit: true, blink: true })];
  const error = [add('err0', { slump: true, blink: true }), add('err1', { slump: true })];
  defineSprite({
    id,
    description,
    tags: ['character', 'agent'],
    size: [W, H],
    anchor: [12, 31],
    slots: { ...BASE_SLOTS, ...slots },
    variants: VARIANTS,
    emissiveTokens: ['eye', 'orb0', 'orb1', 'orb2', 'orb3', 'spark', ...emissiveTokens],
    frames,
    anims: {
      idle: { frames: idle, ticks: [44, 44, 30, 6] },
      walk: { frames: walk, ticks: 7 },
      work: { frames: work, ticks: [12, 8, 12, 8] },
      talk: { frames: ['talk0', 'talk1', 'talk0', 'talk1'], ticks: [10, 10, 16, 10] },
      sit: { frames: sit, ticks: [180, 6] },
      error: { frames: error, ticks: [50, 6] },
    },
  });
}

defineClass('mage', 'Generalist: hooded mage with glowing eyes and a staff orb.', mage);
defineClass('archmage', 'Orchestrator: star-banded hat, long white beard, great staff with a violet orb.', archmage, {
  slots: { orb0: 'violet0', orb1: 'violet1', orb2: 'violet2', orb3: 'violet3' },
});
defineClass('scribe', 'Planner: cap with a quill, round spectacles, an open book of glowing runes.', scribe, {
  slots: { rune: 'violet1', runeHi: 'violet3' }, emissiveTokens: ['rune', 'runeHi'],
});
defineClass('artificer', 'Implementer: spiky hair, glowing goggles, leather apron and a rune hammer.', artificer, {
  slots: { lens: 'cyan1', lensHi: 'cyan3' }, emissiveTokens: ['lens', 'lensHi'],
});
defineClass('seer', 'Reviewer: tall veiled hood, third-eye gem, an orb hovering over the palm.', seer, {
  slots: { orb0: 'violet0', orb1: 'violet1', orb2: 'violet2', orb3: 'violet3', gem: 'magenta1', eye: 'magenta2', stars: 'violet2' },
  emissiveTokens: ['gem', 'stars'],
});
defineClass('warden', 'Tester: antlered helm, plate and a rune shield that flashes on each trial.', warden, {
  slots: { rune: 'teal1', runeHi: 'teal3' }, emissiveTokens: ['rune', 'runeHi'],
});
defineClass('scout', 'Researcher: leaf hood, pointed ear, short cloak and a wisp lantern.', scout, {
  slots: { wisp: 'teal1', wispHi: 'teal3' }, emissiveTokens: ['wisp', 'wispHi'],
});

// ---------- ambient ----------

function owl(blink) {
  const p = painter(20, 18);
  p.ellipse(4.8, 11.6, 2.6, 4.6, 'rock', { bias: -0.8 });
  p.ellipse(15.2, 11.6, 2.6, 4.6, 'rock', { bias: -0.2 });
  p.ellipse(10, 11, 5.8, 6.2, 'rock', { shade: 'sphere' });
  p.poly([[5, 5], [3.6, 0.8], [7.6, 3.6]], 'rock', { bias: -0.2 });
  p.poly([[15, 5], [16.4, 0.8], [12.4, 3.6]], 'rock', { bias: 0.4 });
  p.ellipse(10, 8.2, 4.8, 3.6, 'cloth', { bias: -1, shade: 'sphere' });
  if (blink) p.px([[7, 8], [8, 8], [9, 8], [11, 8], [12, 8], [13, 8]], 'cloth1', { outline: false });
  else {
    p.circle(8, 8, 1.5, 'owlEye', { shade: 'flat', casts: false });
    p.circle(12, 8, 1.5, 'owlEye', { shade: 'flat', casts: false });
    p.px([[8, 8], [12, 8]], 'ink', { outline: false });
  }
  p.px([[10, 9], [10, 10]], 'gold2', { outline: false });
  p.px([[8, 13], [10, 12], [12, 13], [9, 15], [11, 15]], 'rock1', { outline: false });
  p.px([[8, 17], [12, 17]], 'gold1');
  return p.finish();
}

defineSprite({
  id: 'owl',
  description: 'Grove familiar perched on the ancient tree; blinks with glowing eyes.',
  tags: ['character', 'ambient'],
  size: [20, 18],
  anchor: [10, 17],
  slots: { owlEye: 'teal2' },
  emissiveTokens: ['owlEye'],
  frames: { base: owl(false), blink: owl(true) },
  anims: { idle: { frames: ['base', 'blink', 'base', 'blink'], ticks: [200, 6, 14, 6] } },
});

// Floating status bubble shown above an agent.
defineSprite({
  id: 'bubble',
  description: 'Status bubble: talk dots, waiting "?", done check, error "!".',
  tags: ['ui'],
  size: [15, 12],
  anchor: [7, 11],
  key: { '.': null, k: 'outline', w: 'uiText', v: 'uiTextDim', g: 'glyph' },
  slots: { glyph: 'violet1' },
  variants: { talk: { glyph: 'violet0' }, waiting: { glyph: 'magenta0' }, done: { glyph: 'teal0' }, error: { glyph: 'ember0' } },
  frames: {
    base: [
      '..kkkkkkkkkkk..',
      '.kwwwwwwwwwwwk.',
      'kwwwwwwwwwwwwwk',
      'kwwwwwwwwwwwwwk',
      'kwwwwwwwwwwwwwk',
      'kwwwwwwwwwwwwwk',
      'kwwwwwwwwwwwwwk',
      'kvwwwwwwwwwwwvk',
      '.kvvvvvvvvvvvk.',
      '..kkkkkwvkkkk..',
      '......kvk......',
      '.......k.......',
    ],
  },
  anims: {
    talk: {
      frames: [
        { from: 'base', ops: [{ patch: [[3, 4], [4, 4], [3, 5], [4, 5]].map(([x, y]) => [x, y, 'g']) }] },
        { from: 'base', ops: [{ patch: [[3, 4], [4, 4], [3, 5], [4, 5], [6, 4], [7, 4], [6, 5], [7, 5]].map(([x, y]) => [x, y, 'g']) }] },
        { from: 'base', ops: [{ patch: [[3, 4], [4, 4], [3, 5], [4, 5], [6, 4], [7, 4], [6, 5], [7, 5], [9, 4], [10, 4], [9, 5], [10, 5]].map(([x, y]) => [x, y, 'g']) }] },
      ],
      ticks: [12, 12, 18],
    },
    waiting: { frames: [{ from: 'base', ops: [{ patch: [[6, 2], [7, 2], [8, 2], [5, 3], [9, 3], [8, 4], [7, 5], [7, 7]].map(([x, y]) => [x, y, 'g']) }] }], ticks: [60] },
    done: { frames: [{ from: 'base', ops: [{ patch: [[4, 4], [5, 5], [6, 6], [7, 5], [8, 4], [9, 3], [10, 2], [5, 4], [6, 5]].map(([x, y]) => [x, y, 'g']) }] }], ticks: [60] },
    error: { frames: [{ from: 'base', ops: [{ patch: [[7, 2], [7, 3], [7, 4], [7, 5], [7, 7], [6, 2], [6, 3], [6, 4], [6, 5], [6, 7]].map(([x, y]) => [x, y, 'g']) }] }], ticks: [60] },
  },
});
