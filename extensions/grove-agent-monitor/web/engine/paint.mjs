// Procedural pixel painter for Grove sprites.
//
// Shapes are filled with a *material*: either a flat token ('gold3', 'ink') or a ramp name ('robe', 'skin')
// that the painter shades per pixel from a fixed light (upper right, toward the viewer). Tokens are palette
// colour names or sprite slot names, so palette swaps still work. finish() adds contact shadows between
// overlapping parts and an outward, selective outline, then returns a token grid for defineSprite().

const LIGHT = (() => {
  const v = [0.55, -0.62, 0.56];
  const m = Math.hypot(...v);
  return v.map((c) => c / m);
})();

import { MATERIALS } from './palette.mjs';

// Ramp materials are shaded per pixel; anything else is a flat token (palette colour or slot name).
const RAMP_STEPS = { robe: 5, orb: 4, cyan: 4, violet: 4, teal: 4, magenta: 3 };
for (const name of Object.keys(MATERIALS)) RAMP_STEPS[name] = 5;

function parseMaterial(mat, opts) {
  // A slot ramp (e.g. 'cap' → cap0..cap3) is requested by passing opts.n.
  if (!(mat in RAMP_STEPS) && !opts.n) return { flat: mat };
  return { ramp: mat, n: opts.n ?? RAMP_STEPS[mat] };
}

export class Painter {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.tok = Array.from({ length: h }, () => Array(w).fill(null));
    this.info = Array.from({ length: h }, () => Array(w).fill(null));
    this.parts = 0;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  // Fill every pixel whose centre satisfies inside(x + 0.5, y + 0.5).
  fill(inside, mat, opts = {}, box = null) {
    const m = parseMaterial(mat, opts);
    const pixels = [];
    const [x0, y0, x1, y1] = box ?? [0, 0, this.w - 1, this.h - 1];
    for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(this.h - 1, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(this.w - 1, Math.ceil(x1)); x++) {
        if (inside(x + 0.5, y + 0.5)) pixels.push([x, y]);
      }
    }
    if (!pixels.length) return this;
    const part = ++this.parts;
    let cx;
    let cy;
    let rx;
    let ry;
    if (opts.center) [cx, cy] = opts.center;
    if (opts.radius) [rx, ry] = Array.isArray(opts.radius) ? opts.radius : [opts.radius, opts.radius];
    if (cx === undefined || rx === undefined) {
      let ax = Infinity;
      let ay = Infinity;
      let bx = -Infinity;
      let by = -Infinity;
      for (const [x, y] of pixels) { ax = Math.min(ax, x); ay = Math.min(ay, y); bx = Math.max(bx, x + 1); by = Math.max(by, y + 1); }
      cx ??= (ax + bx) / 2;
      cy ??= (ay + by) / 2;
      rx ??= Math.max(0.5, (bx - ax) / 2);
      ry ??= Math.max(0.5, (by - ay) / 2);
    }
    const shade = opts.shade ?? 'cyl';
    const folds = new Set(opts.folds ?? []);
    for (const [x, y] of pixels) {
      let token;
      let level = null;
      if (m.flat) token = m.flat;
      else {
        if (shade === 'flat') level = opts.level ?? Math.floor((m.n - 1) / 2);
        else {
          const u = Math.max(-1, Math.min(1, (x + 0.5 - cx) / rx));
          const v = Math.max(-1, Math.min(1, (y + 0.5 - cy) / ry));
          let n;
          if (shade === 'sphere') n = [u, v, Math.sqrt(Math.max(0.05, 1 - u * u - v * v))];
          else if (shade === 'vert') n = [0, v * 0.9, Math.sqrt(Math.max(0.05, 1 - v * v * 0.81))];
          else n = [u, -0.12 + v * 0.18, Math.sqrt(Math.max(0.05, 1 - u * u))];
          const len = Math.hypot(...n);
          const I = (n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]) / len;
          const mid = (m.n - 1) / 2;
          level = mid + (I - 0.35) * (m.n - 1) * 0.9 * (opts.contrast ?? 1) + (opts.bias ?? 0);
        }
        if (folds.has(x)) level -= 1;
        level = Math.max(0, Math.min(m.n - 1, Math.round(level)));
        token = `${m.ramp}${level}`;
      }
      this.tok[y][x] = token;
      this.info[y][x] = { part, ramp: m.ramp ?? null, n: m.n ?? 0, level, casts: opts.casts !== false, receives: opts.receives !== false, outline: opts.outline !== false };
    }
    return this;
  }

  ellipse(cx, cy, rx, ry, mat, opts = {}) {
    return this.fill((x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1, mat,
      { shade: 'sphere', center: [cx, cy], radius: [rx, ry], ...opts }, [cx - rx - 1, cy - ry - 1, cx + rx + 1, cy + ry + 1]);
  }

  circle(cx, cy, r, mat, opts = {}) {
    return this.ellipse(cx, cy, r, r, mat, opts);
  }

  rect(x, y, w, h, mat, opts = {}) {
    return this.fill((px, py) => px >= x && px < x + w && py >= y && py < y + h, mat, opts, [x, y, x + w, y + h]);
  }

  poly(points, mat, opts = {}) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const inside = (px, py) => {
      let c = false;
      for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    return this.fill(inside, mat, opts, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  }

  // A thick stroke between two points (capsule).
  stroke(x0, y0, x1, y1, width, mat, opts = {}) {
    const r = width / 2;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy || 1;
    const inside = (px, py) => {
      const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
      return Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t)) <= r;
    };
    const pad = r + 1;
    return this.fill(inside, mat, opts, [Math.min(x0, x1) - pad, Math.min(y0, y1) - pad, Math.max(x0, x1) + pad, Math.max(y0, y1) + pad]);
  }

  // Single pixels (details: eyes, glints, stars). Details never cast contact shadows.
  px(points, token, opts = {}) {
    const list = typeof points[0] === 'number' ? [points] : points;
    const part = ++this.parts;
    for (const [x, y] of list) {
      if (!this.inBounds(x, y)) continue;
      this.tok[y][x] = token;
      this.info[y][x] = { part, ramp: null, n: 0, level: null, casts: false, receives: false, outline: opts.outline !== false };
    }
    return this;
  }

  erase(inside) {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (inside(x + 0.5, y + 0.5)) { this.tok[y][x] = null; this.info[y][x] = null; }
    }
    return this;
  }

  // Contact shadows: where a later (front) part meets an earlier one, darken the back part's edge.
  separate() {
    const out = this.tok.map((r) => r.slice());
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      const a = this.info[y][x];
      if (!a || !a.ramp || !a.receives) continue;
      let drop = 0;
      for (const [dx, dy, d] of [[0, -1, 2], [-1, 0, 1], [1, 0, 1], [0, 1, 1]]) {
        const b = this.info[y + dy]?.[x + dx];
        if (b && b.casts && b.part > a.part) drop = Math.max(drop, d);
      }
      if (drop) out[y][x] = `${a.ramp}${Math.max(0, a.level - drop)}`;
    }
    this.tok = out;
    return this;
  }

  // Outward outline: transparent pixels touching the sprite become outline. On the lit side (right/top)
  // the outline takes a dark tone of the neighbouring material instead of the global outline colour.
  outline(color = 'outline') {
    const out = this.tok.map((r) => r.slice());
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.tok[y][x] != null) continue;
      const left = this.info[y]?.[x - 1];
      const below = this.info[y + 1]?.[x];
      const right = this.info[y]?.[x + 1];
      const above = this.info[y - 1]?.[x];
      const n = [left, below, right, above].filter((v) => v && v.outline);
      if (!n.length) continue;
      const litOnly = !right && !above && (left || below);
      const src = left ?? below;
      out[y][x] = litOnly && src?.ramp ? `${src.ramp}${Math.min(1, src.n - 1)}` : color;
    }
    this.tok = out;
    return this;
  }

  finish({ outline = true, separate = true } = {}) {
    if (separate) this.separate();
    if (outline) this.outline();
    return this.tok;
  }
}

export function painter(w, h) {
  return new Painter(w, h);
}
