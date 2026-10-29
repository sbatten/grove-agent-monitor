// Workstations, painted procedurally. Each has `idle` (unattended, dim) and `active` (occupied, glowing)
// variants; some animate (forge fire, campfire, mirror glints, twinkling stars, a flapping tome).
import { defineSprite } from '../engine/sprites.mjs';
import { painter } from '../engine/paint.mjs';

function line(p, x0, y0, x1, y1, token) {
  const pts = [];
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  p.px(pts, token, { outline: false });
}

// ---------- planning: star-map table ----------

function starTable(twinkle) {
  const p = painter(50, 26);
  p.rect(5, 14, 3, 11, 'wood', { bias: -0.6 });
  p.rect(42, 14, 3, 11, 'wood');
  p.poly([[4, 3], [46, 3], [48, 9], [2, 9]], 'night', { shade: 'vert', bias: 0.6 });
  p.rect(2, 9, 46, 3, 'night', { bias: -0.6 });
  p.poly([[2, 12], [48, 12], [47.4, 17], [42, 15.4], [36, 17.2], [30, 15.4], [25, 17.2], [20, 15.4], [14, 17.2], [8, 15.4], [2.6, 17]], 'night', { bias: -1 });
  p.rect(2, 11, 46, 1, 'gold', { bias: -0.5 });
  const stars = [[8, 5], [13, 7], [18, 4], [23, 6], [29, 5], [34, 7], [39, 4], [43, 6]];
  for (let i = 0; i + 1 < stars.length; i++) if (i !== 3) line(p, ...stars[i], ...stars[i + 1], 'line');
  stars.forEach(([x, y], i) => p.px([[x, y]], (i + twinkle) % 3 === 0 ? 'starHi' : 'star', { outline: false }));
  p.px([[25, 14], [31, 14], [19, 14]], 'star', { outline: false });
  return p.finish();
}

defineSprite({
  id: 'star-table',
  description: 'Planning: a table draped in night cloth whose constellations light up while plans are drawn.',
  tags: ['station', 'glow'],
  size: [50, 26],
  anchor: [25, 25],
  slots: { star: 'stone3', starHi: 'stone4', line: 'night1' },
  variants: { idle: {}, active: { star: 'cyan2', starHi: 'cyan3', line: 'cyan0' } },
  emissiveTokens: ['star', 'starHi', 'line'],
  frames: { a: starTable(0), b: starTable(1), c: starTable(2) },
  anims: { idle: { frames: ['a', 'b', 'c'], ticks: [40, 40, 40] } },
});

// ---------- plan review: oracle lectern ----------

function lectern() {
  const p = painter(30, 38);
  p.poly([[6, 37], [24, 37], [21, 32], [9, 32]], 'rock', { bias: -0.2 });
  p.rect(12, 17, 6, 16, 'rock');
  p.rect(11, 16, 8, 2, 'rock', { bias: 0.4 });
  p.poly([[2, 13], [28, 8], [28, 14], [2, 19]], 'wood');
  p.poly([[4, 11.6], [15, 9.6], [15, 15], [4, 17]], 'cloth', { shade: 'flat', level: 2 });
  p.poly([[15, 9.6], [26, 7.6], [26, 13], [15, 15]], 'cloth', { shade: 'flat', level: 3 });
  line(p, 15, 10, 15, 15, 'cloth0');
  const runes = [[6, 13], [8, 12], [10, 12], [6, 15], [9, 14], [12, 13], [17, 11], [19, 11], [22, 10], [17, 13], [20, 12], [23, 12]];
  p.px(runes, 'rune', { outline: false });
  p.px([[24, 13], [24, 14], [24, 15], [24, 16]], 'magenta0', { outline: false });
  return p.finish();
}

defineSprite({
  id: 'lectern',
  description: 'Plan review: an oracle lectern holding an open tome of runes.',
  tags: ['station', 'glow'],
  size: [30, 38],
  anchor: [15, 37],
  slots: { rune: 'rock1' },
  variants: { idle: {}, active: { rune: 'violet2' } },
  emissiveTokens: ['rune'],
  frames: { base: lectern() },
});

// ---------- implementing: rune forge + anvil ----------

function forge(phase) {
  const p = painter(56, 34);
  p.rect(7, 0, 10, 9, 'brick', { bias: -0.2 });
  p.rect(6, 0, 12, 2, 'brick', { bias: 0.4 });
  p.poly([[2, 33], [31, 33], [29, 8], [4, 8]], 'brick');
  for (let y = 11; y < 33; y += 4) {
    line(p, 4, y, 30, y, 'brick0');
    for (let x = 6 + ((y / 4) % 2) * 3; x < 30; x += 6) line(p, x, y + 1, x, y + 3, 'brick0');
  }
  p.fill((x, y) => (((x - 16.5) / 7.5) ** 2 + ((y - 23) / 7) ** 2 <= 1 && y <= 30) || (x >= 9 && x <= 24 && y >= 23 && y <= 30), 'coal', { shade: 'flat', level: 0 }, [8, 15, 25, 31]);
  const f = [0, 1, -1][phase];
  p.ellipse(16.5, 26 + f * 0.3, 6, 4.6, 'flame0', { shade: 'flat', casts: false });
  p.ellipse(16.5 + f, 25.4, 4.2, 4, 'flame1', { shade: 'flat', casts: false });
  p.ellipse(16 - f, 26, 2.6, 3, 'flame2', { shade: 'flat', casts: false });
  p.px([[16 + f, 20], [14 - f, 21], [19, 21 + (phase % 2)]], 'flame3', { outline: false });
  p.px([[10, 29], [12, 30], [15, 29], [18, 30], [21, 29], [23, 30]], 'flame2', { outline: false });
  // Anvil.
  p.poly([[40, 33], [50, 33], [48, 28], [42, 28]], 'metal', { bias: -0.6 });
  p.rect(43, 24, 4, 5, 'metal', { bias: -0.3 });
  p.poly([[36, 20], [53, 20], [51, 25], [38, 25]], 'metal');
  p.poly([[53, 20], [55.6, 21], [53, 22.4]], 'metal', { bias: 0.4 });
  return p.finish();
}

defineSprite({
  id: 'forge',
  description: 'Implementing: a rune forge with magical fire, and an anvil.',
  tags: ['station', 'glow'],
  size: [56, 34],
  anchor: [28, 33],
  slots: { flame0: 'coal1', flame1: 'coal2', flame2: 'coal3', flame3: 'coal4' },
  variants: { idle: {}, active: { flame0: 'violet0', flame1: 'magenta1', flame2: 'violet2', flame3: 'violet3' } },
  emissiveTokens: ['flame0', 'flame1', 'flame2', 'flame3'],
  frames: { a: forge(0), b: forge(1), c: forge(2) },
  anims: { idle: { frames: ['a', 'b', 'c'], ticks: 7 } },
});

// ---------- code review: scrying mirror ----------

function mirror(phase) {
  const p = painter(30, 40);
  p.poly([[7, 39], [23, 39], [20, 35], [10, 35]], 'wood', { bias: -0.2 });
  p.rect(13, 26, 4, 10, 'wood');
  p.ellipse(15, 15, 11.4, 13.4, 'gold', { shade: 'sphere' });
  p.ellipse(15, 15, 8.8, 10.8, 'mglass', { n: 5, shade: 'sphere', bias: -0.4 });
  const g = [[-3, 3], [0, 0], [3, -3]][phase];
  line(p, 10 + g[0], 13 + g[1], 13 + g[0], 10 + g[1], 'glint');
  line(p, 12 + g[0], 17 + g[1], 17 + g[0], 12 + g[1], 'glint');
  p.circle(15, 2, 1.6, 'gem', { shade: 'flat', casts: false });
  return p.finish();
}

defineSprite({
  id: 'mirror',
  description: 'Code review: a scrying mirror that reveals code in ripples of light.',
  tags: ['station', 'glow'],
  size: [30, 40],
  anchor: [15, 39],
  slots: { mglass0: 'water0', mglass1: 'water1', mglass2: 'water2', mglass3: 'water3', mglass4: 'waterHi', glint: 'stone4', gem: 'teal0' },
  variants: { idle: {}, active: { mglass0: 'water1', mglass1: 'teal0', mglass2: 'teal1', mglass3: 'teal2', mglass4: 'teal3', glint: 'teal3', gem: 'teal2' } },
  emissiveTokens: ['mglass2', 'mglass3', 'mglass4', 'glint', 'gem'],
  frames: { a: mirror(0), b: mirror(1), c: mirror(2) },
  anims: { idle: { frames: ['a', 'b', 'c'], ticks: [40, 14, 14] } },
});

// ---------- testing: proving dummy ----------

function dummy() {
  const p = painter(20, 30);
  p.poly([[4, 29], [16, 29], [12.6, 26], [7.4, 26]], 'wood', { bias: -0.3 });
  p.rect(9, 14, 2, 13, 'wood');
  p.rect(1, 12, 18, 2, 'wood', { bias: 0.2 });
  p.ellipse(10, 16, 5, 6.6, 'straw');
  p.ellipse(3.6, 13.4, 2.4, 2, 'straw', { bias: -0.4 });
  p.ellipse(16.4, 13.4, 2.4, 2, 'straw', { bias: 0.3 });
  p.ellipse(10, 5.4, 4, 4.2, 'straw', { shade: 'sphere' });
  line(p, 6, 9, 14, 9, 'leather1');
  line(p, 6, 20, 14, 20, 'leather1');
  p.circle(10, 15.4, 2.6, 'target', { shade: 'flat', casts: false });
  p.px([[10, 15]], 'targetHi', { outline: false });
  return p.finish();
}

defineSprite({
  id: 'dummy',
  description: 'Testing: a straw proving dummy with a rune target.',
  tags: ['station', 'glow'],
  size: [20, 30],
  anchor: [10, 29],
  slots: { target: 'straw1', targetHi: 'straw2' },
  variants: { idle: {}, active: { target: 'teal1', targetHi: 'teal3' }, hit: { target: 'white', targetHi: 'white' }, fail: { target: 'ember1', targetHi: 'ember2' } },
  emissiveTokens: ['target', 'targetHi'],
  frames: { base: dummy() },
});

// ---------- research: bookshelf in the tree hollow ----------

function bookshelf() {
  const p = painter(46, 34);
  p.rect(1, 1, 44, 32, 'wood', { bias: -0.8 });
  p.rect(3, 3, 40, 28, 'coal', { shade: 'flat', level: 0, casts: false });
  const mats = ['leather', 'night', 'leaf', 'fire', 'gold', 'glass', 'gbook', 'robe_dusk', 'cloth'];
  const shelves = [12, 22, 31];
  let k = 0;
  for (const base of shelves) {
    let x = 4;
    while (x < 41) {
      const w = 2 + ((k * 7) % 3);
      const h = 6 + ((k * 5) % 3);
      const mat = mats[(k * 4 + base) % mats.length];
      if (mat === 'gbook') p.rect(x, base - h, w, h, 'gbook', { shade: 'flat', casts: false });
      else if (mat === 'robe_dusk') p.rect(x, base - h, w, h, 'pants');
      else p.rect(x, base - h, w, h, mat);
      if (k % 5 === 2) x += 1;
      x += w;
      k++;
    }
  }
  p.rect(2, 12, 42, 2, 'wood');
  p.rect(2, 22, 42, 2, 'wood');
  p.rect(0, 0, 46, 2, 'wood', { bias: 0.5 });
  return p.finish();
}

defineSprite({
  id: 'bookshelf',
  description: 'Research: a bookshelf grown into the ancient tree, glowing tomes among the spines.',
  tags: ['station', 'glow'],
  size: [46, 34],
  anchor: [23, 33],
  slots: { gbook: 'violet0' },
  variants: { idle: {}, active: { gbook: 'cyan2' } },
  emissiveTokens: ['gbook'],
  frames: { base: bookshelf() },
});

function tome(open) {
  const p = painter(16, 12);
  const lift = open ? 0 : 2;
  p.poly([[1, 3 + lift], [8, 5], [8, 11], [1, 9 + lift]], 'cloth', { shade: 'flat', level: 3 });
  p.poly([[8, 5], [15, 3 + lift], [15, 9 + lift], [8, 11]], 'cloth', { shade: 'flat', level: 4 });
  p.px([[3, 6 + lift], [5, 7], [11, 7], [13, 6 + lift], [4, 8 + lift], [12, 8 + lift]], 'cyan1', { outline: false });
  return p.finish();
}

defineSprite({
  id: 'tome',
  description: 'Floating open tome that hovers over the research nook while someone studies.',
  tags: ['station', 'glow', 'fx'],
  size: [16, 12],
  anchor: [8, 11],
  emissiveTokens: ['cyan1'],
  frames: { a: tome(true), b: tome(false) },
  anims: { idle: { frames: ['a', 'b'], ticks: [14, 14] } },
});

// ---------- council: standing stone ----------

function councilStone() {
  const p = painter(12, 22);
  p.poly([[2, 21], [10, 21], [10.4, 6], [8, 1], [4, 1.6], [1.6, 6]], 'rock');
  p.poly([[1.6, 21], [10.4, 21], [10.4, 17], [7, 18.6], [4, 17.2], [1.6, 18]], 'leaf', { bias: -0.4 });
  p.px([[6, 6], [6, 7], [5, 8], [7, 8], [6, 9], [6, 10], [5, 12], [7, 12], [6, 13]], 'rune', { outline: false });
  return p.finish();
}

defineSprite({
  id: 'council-stone',
  description: 'Council: a standing stone ringing the moonwell; its rune lights while council is in session.',
  tags: ['station', 'glow'],
  size: [12, 22],
  anchor: [6, 21],
  slots: { rune: 'rock1' },
  variants: { idle: {}, active: { rune: 'violet2' }, decided: { rune: 'teal2' } },
  emissiveTokens: ['rune'],
  frames: { base: councilStone() },
});

// ---------- needs you: signal lantern ----------

function lanternPost() {
  const p = painter(26, 40);
  p.poly([[1, 39], [9, 39], [7, 36], [3, 36]], 'rock', { bias: -0.3 });
  p.rect(3, 4, 3, 33, 'wood');
  p.rect(3, 4, 16, 2, 'wood', { bias: 0.3 });
  p.stroke(6, 9, 10, 5.4, 1.4, 'wood', { bias: -0.3 });
  p.px([[17, 6], [17, 7], [17, 8]], 'metal1');
  p.poly([[13, 11], [21, 11], [17, 8.4]], 'metal', { bias: 0.3 });
  p.rect(13, 11, 8, 10, 'metal', { bias: -0.6 });
  p.rect(14, 12, 6, 8, 'lglass', { shade: 'flat', casts: false });
  p.px([[17, 15], [17, 16], [16, 16]], 'lflame', { outline: false });
  p.rect(13, 21, 8, 2, 'metal');
  return p.finish();
}

defineSprite({
  id: 'lantern-post',
  description: 'Needs you: a signal lantern that blazes magenta while an agent waits on the user.',
  tags: ['station', 'glow'],
  size: [26, 40],
  anchor: [4, 39],
  slots: { lglass: 'rock1', lflame: 'rock2' },
  variants: { idle: {}, active: { lglass: 'magenta1', lflame: 'magenta2' } },
  emissiveTokens: ['lglass', 'lflame'],
  frames: { base: lanternPost() },
});

// ---------- camp: spirit fire + log seats ----------

function campfire(phase) {
  const p = painter(22, 22);
  for (const [x, y] of [[3, 19], [7, 20.4], [11, 20.8], [15, 20.4], [19, 19]]) p.ellipse(x, y, 2.4, 1.6, 'rock', { shade: 'sphere' });
  p.stroke(4, 18.6, 18, 16, 2.4, 'wood', { bias: -0.3 });
  p.stroke(4, 16, 18, 18.6, 2.4, 'wood');
  const f = [0, 1, -1][phase];
  p.ellipse(11, 13.6, 5, 4.8, 'teal0', { shade: 'flat', casts: false });
  p.poly([[7, 14], [15, 14], [11.4 + f, 2 + Math.abs(f)]], 'teal0', { shade: 'flat', casts: false });
  p.ellipse(11 + f * 0.5, 13.6, 3.4, 3.6, 'teal1', { shade: 'flat', casts: false });
  p.poly([[8.6, 13], [13.4, 13], [11 - f, 5]], 'teal1', { shade: 'flat', casts: false });
  p.ellipse(11, 14.4, 1.8, 2.2, 'teal3', { shade: 'flat', casts: false });
  p.px([[9 + f, 4], [14, 7 - (phase % 2)]], 'teal2', { outline: false });
  return p.finish({ separate: false });
}

defineSprite({
  id: 'campfire',
  description: 'Camp: a spirit fire where idle and finished agents rest.',
  tags: ['station', 'glow'],
  size: [22, 22],
  anchor: [11, 21],
  emissiveTokens: ['teal0', 'teal1', 'teal2', 'teal3'],
  frames: { a: campfire(0), b: campfire(1), c: campfire(2) },
  anims: { idle: { frames: ['a', 'b', 'c'], ticks: 8 } },
});

function log() {
  const p = painter(28, 10);
  p.stroke(3, 5, 24, 5, 6, 'wood');
  p.ellipse(24.4, 5, 2.2, 3, 'straw', { shade: 'flat', level: 2 });
  p.px([[24, 4], [25, 5], [24, 6]], 'straw1', { outline: false });
  p.px([[8, 3], [13, 4], [18, 3]], 'wood1', { outline: false });
  return p.finish();
}

defineSprite({
  id: 'log',
  description: 'Log seat beside the campfire.',
  tags: ['prop'],
  size: [28, 10],
  anchor: [14, 9],
  frames: { base: log() },
});
