// Static layers of the grove (480×320), painted once per theme with a seeded PRNG and value noise.
import { PALETTE as P, mixHex } from '../engine/palette.mjs';
import { makeCanvas, hexToRgb, valueNoise, mulberry32 } from '../engine/dither.mjs';
import { drawSprite } from '../engine/sprites.mjs';
import { W, H, COUNCIL, NODES, PATH_EDGES } from './layout.mjs';

export const TREE_X = 240;
const HORIZON = 144;

export const THEME_LOOK = {
  night: { sky: ['sky0', 'sky1', 'sky2', 'sky3', 'sky4', 'sky5'], hills: ['hill0', 'hill1', 'hill2'], moon: { x: 428, y: 66, r: 16, phase: 0 }, aurora: 1, stars: 180, fireflies: 22, fog: 0.26 },
  dusk: { sky: ['dusk0', 'dusk1', 'dusk2', 'dusk3', 'dusk4', 'dusk5'], hills: ['dusk1', 'dusk2', 'dusk3'], moon: { x: 412, y: 58, r: 13, phase: 0.55 }, aurora: 0.45, stars: 70, fireflies: 22, fog: 0.22 },
  dawn: { sky: ['dawn0', 'dawn1', 'dawn2', 'dawn3', 'dawn4', 'dawn5'], hills: ['dawn1', 'dawn2', 'dawn3'], moon: { x: 80, y: 58, r: 11, phase: 0.35 }, aurora: 0, stars: 24, fireflies: 8, fog: 0.36 },
};

// Pixel buffer that accepts palette names or hex colours, with optional alpha blending.
export function painter(ctx, w, h) {
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const cache = new Map();
  const rgb = (c) => {
    let v = cache.get(c);
    if (!v) { v = hexToRgb(P[c] ?? c); cache.set(c, v); }
    return v;
  };
  return {
    set(x, y, c, a = 1) {
      x |= 0; y |= 0;
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const [r, g, b] = rgb(c);
      const i = (y * w + x) * 4;
      if (a >= 1 || d[i + 3] === 0) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; return; }
      d[i] += (r - d[i]) * a; d[i + 1] += (g - d[i + 1]) * a; d[i + 2] += (b - d[i + 2]) * a;
    },
    has(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      return d[((y | 0) * w + (x | 0)) * 4 + 3] > 0;
    },
    flush() { ctx.putImageData(img, 0, 0); },
  };
}

// Interpolate along a list of palette names (t in 0..1).
function ramp(names, t) {
  const c = Math.max(0, Math.min(names.length - 1, t * (names.length - 1)));
  const i = Math.floor(c);
  if (i >= names.length - 1) return P[names.at(-1)];
  return mixHex(P[names[i]], P[names[i + 1]], c - i);
}

function stepRamp(names, v) {
  return names[Math.max(0, Math.min(names.length - 1, Math.round(v)))];
}

export function buildSky(theme) {
  const look = THEME_LOOK[theme];
  const [c, ctx] = makeCanvas(W, H);
  const p = painter(ctx, W, H);
  for (let y = 0; y < H; y++) {
    const col = ramp(look.sky, Math.min(1, Math.pow(y / HORIZON, 1.15)));
    for (let x = 0; x < W; x++) p.set(x, y, col);
  }
  const { x: mx, y: my, r, phase } = look.moon;
  const noise = valueNoise(11);
  for (let dy = -r - 1; dy <= r + 1; dy++) {
    for (let dx = -r - 1; dx <= r + 1; dx++) {
      const dist = Math.hypot(dx + 0.5, dy + 0.5);
      if (dist > r) continue;
      if (phase > 0 && Math.hypot(dx + 0.5 + r * phase * 1.4, dy + 0.5 - 2) < r * 0.95) continue;
      const nx = (dx + 0.5) / r;
      const ny = (dy + 0.5) / r;
      const lit = Math.max(0, 0.55 + nx * 0.35 - ny * 0.3 + Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * 0.25);
      const mare = noise((dx + 40) * 0.22, (dy + 40) * 0.22);
      let t = Math.min(1, lit) - (mare > 0.62 ? 0.28 : 0);
      if (dist > r - 1) t -= 0.12;
      const col = theme === 'dawn' ? mixHex(P.dawn4, P.moonShade, Math.max(0, t)) : ramp(['moonDark', 'moonShade', 'moon'], Math.max(0, Math.min(1, t)));
      p.set(mx + dx, my + dy, col);
    }
  }
  p.flush();
  return c;
}

function pine(p, cx, base, ht, { fill, shade, rim, dark, noise, rimChance = 0.8 }) {
  const tiers = Math.max(3, Math.round(ht / 7));
  for (let i = 0; i <= ht; i++) {
    const y = base - i;
    const frac = 1 - i / ht;
    const tierPos = ((i / ht) * tiers) % 1;
    let hw = frac * ht * 0.34 * (0.62 + 0.38 * (1 - tierPos));
    if (i >= ht - 1) hw = 0.4;
    const left = Math.round(cx - hw);
    const right = Math.round(cx + hw);
    for (let x = left; x <= right; x++) {
      const n = noise(x * 0.5, y * 0.5);
      let col = fill;
      if (x > cx && (x - cx) / Math.max(1, hw) > 0.35 - n * 0.3) col = shade;
      if (dark && x < cx - hw * 0.5 && n < 0.55) col = dark;
      p.set(x, y, col);
    }
    if (rim && hw > 1 && (noise(right * 0.7, y * 0.7) < rimChance)) p.set(right, y, rim);
  }
}

function blob(p, cx, cy, r, steps, noise, { rim, rimHi, bias = 0, squash = 1 } = {}) {
  for (let y = Math.floor(cy - r * squash) - 1; y <= cy + r * squash + 1; y++) {
    for (let x = Math.floor(cx - r) - 1; x <= cx + r + 1; x++) {
      const dx = (x + 0.5 - cx) / r;
      const dy = (y + 0.5 - cy) / (r * squash);
      const n = noise(x * 0.35, y * 0.35);
      const d = Math.hypot(dx, dy) + (n - 0.5) * 0.35;
      if (d > 1) continue;
      const light = dx * 0.55 - dy * 0.7 + bias + (noise(x * 0.9 + 50, y * 0.9) - 0.5) * 0.6;
      let col = stepRamp(steps, (steps.length - 1) * (0.42 + light * 0.42));
      if (rim && d > 0.82 && light > 0.35) col = light > 0.75 && rimHi ? rimHi : rim;
      p.set(x, y, col);
    }
  }
}

function thickLine(p, x0, y0, x1, y1, w0, w1, colorAt) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 1.5);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const w = w0 + (w1 - w0) * t;
    for (let dy = -Math.ceil(w); dy <= Math.ceil(w); dy++) {
      for (let dx = -Math.ceil(w); dx <= Math.ceil(w); dx++) {
        if (Math.hypot(dx, dy) <= w) p.set(x + dx, y + dy, colorAt(dx, dy, w));
      }
    }
  }
}

export function buildLand(rand, meta, theme) {
  const look = THEME_LOOK[theme];
  const [c, ctx] = makeCanvas(W, H);
  const p = painter(ctx, W, H);
  const noise = valueNoise(7);
  const hills = look.hills.map((n) => P[n]);

  // Three mountain layers fading into haze.
  const ridge = (x, k) => [
    () => 88 + 9 * Math.sin(x * 0.014 + 0.5) + 6 * Math.sin(x * 0.041 + 2) + 3 * Math.sin(x * 0.11),
    () => 104 + 10 * Math.sin(x * 0.018 + 1.2) + 7 * Math.sin(x * 0.047 + 0.4) + 3 * Math.sin(x * 0.13 + 2),
    () => 120 + 6 * Math.sin(x * 0.026 + 3) + 4 * Math.sin(x * 0.07 + 1) + 2 * Math.sin(x * 0.19),
  ][k]();
  for (let k = 0; k < 3; k++) {
    for (let x = 0; x < W; x++) {
      const top = Math.round(ridge(x, k));
      const lit = ridge(x + 1, k) > ridge(x - 1, k);
      for (let y = top; y < HORIZON + 6; y++) {
        const haze = Math.min(1, (y - top) / 60) * 0.45 + (2 - k) * 0.12;
        let col = mixHex(hills[2 - k] ?? hills[0], P.fog, haze * 0.5);
        if (y < top + 2 && lit) col = mixHex(col, P.stone3, 0.35);
        p.set(x, y, col);
      }
    }
  }

  // Far and near treelines.
  for (let x = -6; x < W + 6; x += 5 + Math.floor(rand() * 6)) {
    pine(p, x, 134 + Math.floor(rand() * 4), 14 + Math.floor(rand() * 16), { fill: P.farTree0, shade: P.farTree1, rim: P.farTree2, noise, rimChance: 0.45 });
  }
  for (let x = 0; x < W; x++) for (let y = 134; y < 150; y++) p.set(x, y, mixHex(P.farTree0, P.tree0, (y - 134) / 16));
  for (let x = -10; x < W + 10; x += 12 + Math.floor(rand() * 12)) {
    if (Math.abs(x - TREE_X) < 58) continue;
    pine(p, x, 150 + Math.floor(rand() * 5), 36 + Math.floor(rand() * 28), { fill: P.tree0, shade: P.tree1, rim: P.rim, dark: P.treeDark, noise, rimChance: 0.5 });
  }

  // Ground: noise-mottled grass, lit toward the moonwell.
  const grass = ['grass0', 'grass1', 'grass2', 'grass3', 'grass4'];
  for (let y = HORIZON; y < H; y++) {
    const t = (y - HORIZON) / (H - HORIZON);
    for (let x = 0; x < W; x++) {
      if (y < HORIZON + 8 && noise(x * 0.3, y * 0.3) > (y - HORIZON) / 8) { p.set(x, y, P.tree0); continue; }
      const edge = Math.abs(x - 240) / 240;
      const light = Math.max(0, 1 - Math.hypot(x - COUNCIL.x, (y - COUNCIL.y) * 1.7) / 190);
      const n = noise(x * 0.08, y * 0.12) * 0.9 + noise(x * 0.4, y * 0.5) * 0.35;
      p.set(x, y, P[stepRamp(grass, 0.4 + t * 1.2 - edge * 1.1 + light * 1.6 + (n - 0.6) * 1.2)]);
    }
  }
  // Grass blades and tiny flowers.
  for (let i = 0; i < 1400; i++) {
    const x = Math.floor(rand() * W);
    const y = HORIZON + 8 + Math.floor(rand() * (H - HORIZON - 8));
    const light = Math.max(0, 1 - Math.hypot(x - COUNCIL.x, (y - COUNCIL.y) * 1.7) / 190);
    const tall = 2 + Math.floor(rand() * 3);
    const col = light > 0.35 ? (rand() < 0.4 ? P.grass5 : P.grass4) : rand() < 0.5 ? P.grass3 : P.grass1;
    for (let k = 0; k < tall; k++) p.set(x + (k === tall - 1 && rand() < 0.5 ? 1 : 0), y - k, k === 0 ? P.grass1 : col);
  }
  for (let i = 0; i < 70; i++) {
    const x = Math.floor(rand() * W);
    const y = 170 + Math.floor(rand() * 140);
    p.set(x, y, rand() < 0.5 ? P.violet2 : P.cyan2, 0.8);
  }

  // Dirt paths along the walk graph (they are the map of the grove).
  for (const [a, b] of PATH_EDGES) {
    const [x0, y0] = NODES[a];
    const [x1, y1] = NODES[b];
    const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n + 2;
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
          const px = Math.round(x + dx);
          const py = Math.round(y + dy);
          const e = Math.hypot(dx / 6.4, dy / 4.2) + (noise(px * 0.4, py * 0.4) - 0.5) * 0.45;
          if (e > 1) continue;
          const tone = noise(px * 0.25 + 9, py * 0.25) + (dy < 0 ? 0.15 : 0);
          p.set(px, py, e > 0.82 ? P.dirt1 : tone > 0.75 ? P.dirt3 : tone > 0.45 ? P.dirt2 : P.dirt1);
        }
      }
    }
    for (let i = 0; i < n; i += 9) {
      const t = i / n;
      const px = Math.round(x0 + (x1 - x0) * t + (rand() - 0.5) * 8);
      const py = Math.round(y0 + (y1 - y0) * t + 2 + (rand() - 0.5) * 4);
      p.set(px, py, P.stone2); p.set(px + 1, py, P.stone3); p.set(px + 1, py - 1, P.stone4); p.set(px, py + 1, P.dirt0);
    }
  }

  // Moonwell: carved stone ring (the water is animated).
  meta.well = [];
  const { x: wx, y: wy } = COUNCIL;
  for (let y = wy - 16; y <= wy + 16; y++) {
    for (let x = wx - 34; x <= wx + 34; x++) {
      const dx = x + 0.5 - wx;
      const dy = y + 0.5 - wy;
      const eo = (dx / 27) ** 2 + (dy / 10) ** 2;
      const ei = (dx / 21) ** 2 + (dy / 6.6) ** 2;
      if (ei <= 1) { meta.well.push([x, y, ei, dx, dy]); continue; }
      if (eo <= 1) {
        const ang = Math.atan2(dy * 2.6, dx);
        const blk = ((ang + Math.PI) / (Math.PI * 2)) * 20;
        const lit = -dy / 10 + dx / 60;
        let col = lit > 0.25 ? P.stone4 : lit > -0.1 ? P.stone3 : P.stone2;
        if (eo > 0.86 && dy < 0) col = P.stone5;
        if (blk - Math.floor(blk) < 0.09) col = P.stone1;
        if (noise(x * 0.6, y * 0.6) > 0.82) col = P.moss;
        p.set(x, y, col);
      } else if (dy >= 0 && (dx / 27) ** 2 + ((dy - 4) / 10) ** 2 <= 1) {
        const row = Math.floor((dy + 2) / 3);
        const mortar = (y - wy) % 3 === 0 || (x + (row % 2) * 4) % 8 === 0;
        p.set(x, y, mortar ? P.stone0 : dx > 10 ? P.stone2 : P.stone1);
      }
    }
  }

  // The ancient tree: textured trunk, flaring roots, a hollow for the research shelf.
  for (let y = 40; y <= 180; y++) {
    let hw = 14 + (y - 40) * 0.05;
    if (y > 150) hw += ((y - 150) / 30) ** 2 * 22;
    for (let x = Math.floor(TREE_X - hw - 2); x <= TREE_X + hw + 2; x++) {
      const wob = (noise(y * 0.08, 3) - 0.5) * 3;
      const s = (x - TREE_X - wob) / hw;
      if (Math.abs(s) > 1) continue;
      if (y > 168 && Math.abs(s) > 0.8 && noise(x * 0.5, y * 0.5) > 0.5) continue;
      const ridges = Math.sin((x - TREE_X) * 0.9 + noise(x * 0.1, y * 0.06) * 6);
      let v = 1.4 + s * 1.5 + ridges * 0.6;
      if (s > 0.86) v = 4;
      p.set(x, y, P[stepRamp(['bark0', 'bark1', 'bark2', 'bark3', 'bark4'], v)]);
      if (s > 0.9 && noise(x, y * 0.3) > 0.4) p.set(x, y, P.rim);
    }
  }
  for (let y = 132; y <= 176; y++) for (let x = TREE_X - 30; x <= TREE_X + 30; x++) {
    if (((x + 0.5 - TREE_X) / 30) ** 2 + ((y + 0.5 - 178) / 44) ** 2 <= 1) p.set(x, y, (y + x) % 7 === 0 ? P.bark1 : P.bark0);
  }
  const barkAt = (dx, dy, w) => (dy < -w * 0.35 ? P.bark3 : dy > w * 0.35 ? P.bark0 : P.bark2);
  thickLine(p, TREE_X - 8, 82, TREE_X - 74, 58, 5, 1.6, barkAt);
  thickLine(p, TREE_X + 8, 74, TREE_X + 78, 50, 5, 1.6, barkAt);
  thickLine(p, TREE_X - 40, 70, TREE_X - 56, 44, 2.4, 1, barkAt);
  thickLine(p, TREE_X, 64, TREE_X - 10, 22, 4.4, 1.6, barkAt);
  meta.owl = [TREE_X - 50, 72];

  // Canopy: overlapping leaf clusters with moonlit rims.
  const leaves = [P.shadow, P.treeDark, P.tree0, P.tree1, P.tree2, P.tree3, P.tree4];
  const clusters = [];
  for (let i = 0; i < 46; i++) {
    const a = rand() * Math.PI * 2;
    const rr = Math.sqrt(rand());
    clusters.push([TREE_X + Math.cos(a) * rr * 96, 40 + Math.sin(a) * rr * 28, 13 + rand() * 12]);
  }
  clusters.sort((a, b) => a[1] - b[1]);
  for (const [cx, cy, r] of clusters) blob(p, cx, cy, r, leaves, noise, { rim: P.rim, rimHi: P.rimHi, bias: cy > 52 ? -0.35 : 0, squash: 0.85 });

  meta.vines = [];
  for (let i = 0; i < 14; i++) {
    const x = Math.round(TREE_X - 86 + rand() * 172);
    if (Math.abs(x - TREE_X) < 24) continue;
    let y = 96;
    while (y > 10 && !p.has(x, y)) y--;
    if (y <= 10 || y > 90) continue;
    const len = 8 + Math.floor(rand() * 18);
    for (let k = 1; k <= len; k++) p.set(x + Math.round(Math.sin(k * 0.4) * 0.6), y + k, k % 3 === 0 ? P.tree3 : P.tree1);
    meta.vines.push([x, y + len + 1, rand() * 6.28]);
  }

  p.flush();
  for (const [x, y] of [[28, 162], [172, 160], [308, 160], [452, 162], [20, 214]]) drawSprite(ctx, 'bush', x, y);
  for (const [x, y, f] of [[192, 280], [300, 214], [24, 200], [456, 212], [126, 317], [460, 290]]) drawSprite(ctx, 'rock', x, y, { flip: !!f });
  return c;
}

export function buildFore(rand, meta) {
  const [c, ctx] = makeCanvas(W, H);
  const p = painter(ctx, W, H);
  const noise = valueNoise(23);
  const trunk = (x0, x1, flareRight) => {
    for (let y = 0; y < H; y++) {
      const flare = y > 280 ? ((y - 280) / 40) ** 2 * 12 : 0;
      const a = flareRight ? x0 : x0 - flare;
      const b = flareRight ? x1 + flare : x1;
      for (let x = Math.floor(a); x <= b; x++) {
        const s = (x - a) / Math.max(1, b - a);
        const r = Math.sin(x * 1.3 + noise(x * 0.1, y * 0.05) * 5);
        p.set(x, y, s > 0.75 ? P.bark1 : r > 0.6 ? P.bark1 : P.bark0);
      }
    }
  };
  trunk(-1, 7, true);
  trunk(472, 480, false);
  const dark = [P.shadow, P.treeDark, P.tree0, P.tree1];
  for (const [cx, cy, r] of [[8, 0, 28], [48, -8, 20], [36, 28, 18], [92, -4, 14], [472, 0, 24], [440, -10, 18]]) blob(p, cx, cy, r, dark, noise, { rim: P.tree2, bias: -0.4 });

  meta.moss = [];
  for (const [x0, x1] of [[12, 60], [432, 468]]) {
    for (let i = 0; i < 5; i++) {
      const x = Math.round(x0 + rand() * (x1 - x0));
      let y = 34;
      while (y > 0 && !p.has(x, y)) y--;
      const len = 10 + Math.floor(rand() * 22);
      for (let k = 1; k <= len; k++) p.set(x + Math.round(Math.sin(k * 0.3)), y + k, k % 4 === 0 ? P.moss : P.tree0);
      meta.moss.push([x, y + len + 1, rand() * 6.28]);
    }
  }
  for (let x = 0; x < W; x++) {
    const hgt = 2 + Math.floor(rand() * 5 * (Math.abs(x - 240) / 240 + 0.2));
    for (let k = 0; k < hgt; k++) p.set(x + (k === hgt - 1 && rand() < 0.4 ? 1 : 0), H - 1 - k, k === hgt - 1 ? P.tree1 : P.treeDark);
  }
  p.flush();
  drawSprite(ctx, 'fern', 6, H - 1);
  drawSprite(ctx, 'fern', 474, H - 1, { flip: true });
  return c;
}
