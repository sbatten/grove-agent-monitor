// Grove sprite system.
//
// A frame is either a palette-indexed ASCII grid (each character maps to a colour or slot through `key`)
// or a token grid produced by the painter (engine/paint.mjs), where each cell is a colour/slot name or null.
// Slots (e.g. "robe2") can be re-pointed by variants for palette swaps. Emissive characters/tokens also
// feed the soft glow layer.
//
// See skills/grove-sprites/SKILL.md for the authoring guide.

import { PALETTE } from './palette.mjs';
import { hexToRgb, makeCanvas } from './dither.mjs';

const registry = new Map();
const errors = [];
const GLOW_R = 5;
const TOKEN_BASE = 0x100;

export function defineSprite(def) {
  try {
    registry.set(def.id, normalize(def));
  } catch (err) {
    errors.push(`${def?.id ?? '<anonymous>'}: ${err.message}`);
  }
}

export function getSprite(id) {
  return registry.get(id);
}

export function listSprites() {
  return [...registry.values()];
}

export function spriteErrors() {
  return [...errors];
}

// Convert painter token grids into ASCII rows by allocating private key characters.
function tokenize(def) {
  const key = { '.': null, ...(def.key ?? {}) };
  const charFor = new Map(Object.entries(key).filter(([, t]) => t != null).map(([c, t]) => [t, c]));
  let next = TOKEN_BASE;
  const frames = {};
  for (const [name, rows] of Object.entries(def.frames ?? {})) {
    if (!Array.isArray(rows) || !Array.isArray(rows[0])) { frames[name] = rows; continue; }
    frames[name] = rows.map((row) => row.map((t) => {
      if (t == null) return '.';
      if (!charFor.has(t)) {
        while (String.fromCharCode(next) in key) next++;
        const ch = String.fromCharCode(next++);
        key[ch] = t;
        charFor.set(t, ch);
      }
      return charFor.get(t);
    }).join(''));
  }
  let emissive = def.emissive ?? '';
  for (const t of def.emissiveTokens ?? []) if (charFor.has(t)) emissive += charFor.get(t);
  return { ...def, key, frames, emissive };
}

function normalize(input) {
  const def = tokenize(input);
  const { id, size, anchor, key, frames, anims } = def;
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('id must be kebab-case');
  const [w, h] = size ?? [];
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 64 || h > 64) throw new Error('size must be [w, h] within 64x64');
  if (!key || typeof key !== 'object') throw new Error('key is required');
  if (!('.' in key)) throw new Error('key must map "." (transparent)');
  const slots = def.slots ?? {};
  const variants = { default: {}, ...(def.variants ?? {}) };
  const emissive = new Set([...(def.emissive ?? '')]);

  for (const [ch, token] of Object.entries(key)) {
    if ([...ch].length !== 1) throw new Error(`key "${ch}" must be a single character`);
    if (token === null) continue;
    if (!(token in slots) && !(token in PALETTE)) throw new Error(`key "${ch}" -> unknown color/slot "${token}"`);
  }
  for (const [slot, colorName] of Object.entries(slots)) {
    if (!(colorName in PALETTE)) throw new Error(`slot "${slot}" -> unknown color "${colorName}"`);
  }
  for (const [vName, map] of Object.entries(variants)) {
    for (const [slot, colorName] of Object.entries(map)) {
      if (!(slot in slots) && !Object.values(key).includes(slot)) throw new Error(`variant "${vName}" overrides unknown slot "${slot}"`);
      if (!(colorName in PALETTE)) throw new Error(`variant "${vName}" -> unknown color "${colorName}"`);
    }
  }

  const grids = {};
  for (const [name, rows] of Object.entries(frames ?? {})) {
    if (!Array.isArray(rows) || rows.length !== h) throw new Error(`frame "${name}" must have ${h} rows (has ${rows?.length})`);
    rows.forEach((row, y) => {
      if ([...row].length !== w) throw new Error(`frame "${name}" row ${y} must be ${w} wide (is ${[...row].length})`);
      for (const ch of row) if (!(ch in key)) throw new Error(`frame "${name}" row ${y} uses unmapped char "${ch}"`);
    });
    grids[name] = rows.map((r) => [...r]);
  }
  if (!Object.keys(grids).length) throw new Error('at least one frame is required');

  const animDefs = anims ?? { idle: { frames: [Object.keys(grids)[0]], ticks: 60 } };
  const resolvedAnims = {};
  for (const [name, a] of Object.entries(animDefs)) {
    const list = (a.frames ?? []).map((f, i) => resolveFrame(f, grids, key, w, h, `${name}[${i}]`));
    if (!list.length) throw new Error(`anim "${name}" has no frames`);
    const ticks = Array.isArray(a.ticks) ? a.ticks : list.map(() => a.ticks ?? 30);
    if (ticks.length !== list.length || ticks.some((t) => !Number.isInteger(t) || t < 1)) throw new Error(`anim "${name}" ticks must be positive integers per frame`);
    resolvedAnims[name] = { grids: list, ticks, total: ticks.reduce((s, t) => s + t, 0), loop: a.loop !== false };
  }

  return {
    id, w, h,
    anchor: anchor ?? [w >> 1, h - 1],
    key, slots, variants, emissive,
    anims: resolvedAnims,
    tags: def.tags ?? [],
    description: def.description ?? '',
    cache: new Map(),
  };
}

function resolveFrame(f, grids, key, w, h, label) {
  const ref = typeof f === 'string' ? { from: f } : f;
  const src = grids[ref.from];
  if (!src) throw new Error(`${label} references unknown frame "${ref.from}"`);
  let g = src.map((r) => [...r]);
  for (const op of ref.ops ?? []) g = applyOp(g, op, key, w, h, label);
  return g;
}

// Frame ops let one hand-drawn frame yield many animation frames.
function applyOp(g, op, key, w, h, label) {
  if (op.shift) {
    // Move rows [from..to] by dy, leaving vacated rows transparent. Classic breathing/bob.
    const [from, to, dy] = op.shift;
    const out = g.map((r) => [...r]);
    for (let y = from; y <= to; y++) out[y] = Array(w).fill('.');
    for (let y = from; y <= to; y++) {
      const ny = y + dy;
      if (ny >= 0 && ny < h) out[ny] = [...g[y]];
    }
    return out;
  }
  if (op.patch) {
    const out = g.map((r) => [...r]);
    for (const [x, y, ch] of op.patch) {
      if (!(ch in key)) throw new Error(`${label} patch uses unmapped char "${ch}"`);
      if (x >= 0 && x < w && y >= 0 && y < h) out[y][x] = ch;
    }
    return out;
  }
  if (op.swap) {
    for (const ch of Object.values(op.swap)) if (!(ch in key)) throw new Error(`${label} swap uses unmapped char "${ch}"`);
    return g.map((r) => r.map((ch) => op.swap[ch] ?? ch));
  }
  if (op.rows) {
    // Replace whole rows: { rows: { 15: '..ktttk..' } }
    const out = g.map((r) => [...r]);
    for (const [y, row] of Object.entries(op.rows)) {
      const yi = Number(y);
      if (!Number.isInteger(yi) || yi < 0 || yi >= h) throw new Error(`${label} rows op has bad row index ${y}`);
      if (row.length !== w) throw new Error(`${label} rows op row ${y} must be ${w} wide`);
      for (const ch of row) if (!(ch in key)) throw new Error(`${label} rows op uses unmapped char "${ch}"`);
      out[yi] = [...row];
    }
    return out;
  }
  if (op.mirror) return g.map((r) => [...r].reverse());
  throw new Error(`${label} has unknown op ${JSON.stringify(op)}`);
}

function colorFor(sprite, ch, variant) {
  const token = sprite.key[ch];
  if (token == null) return null;
  const vmap = sprite.variants[variant] ?? sprite.variants.default;
  if (token in vmap) return PALETTE[vmap[token]];
  if (token in sprite.slots) return PALETTE[sprite.slots[token]];
  return PALETTE[token];
}

function compile(sprite, variant) {
  const cacheKey = variant;
  let compiled = sprite.cache.get(cacheKey);
  if (compiled) return compiled;
  compiled = {};
  for (const [name, anim] of Object.entries(sprite.anims)) {
    compiled[name] = anim.grids.map((g) => ({ img: renderGrid(sprite, g, variant), glow: renderGlow(sprite, g, variant) }));
  }
  sprite.cache.set(cacheKey, compiled);
  return compiled;
}

function renderGrid(sprite, g, variant) {
  const [c, ctx] = makeCanvas(sprite.w, sprite.h);
  const img = ctx.createImageData(sprite.w, sprite.h);
  for (let y = 0; y < sprite.h; y++) {
    for (let x = 0; x < sprite.w; x++) {
      const hex = colorFor(sprite, g[y][x], variant);
      if (!hex) continue;
      const [r, gg, b] = hexToRgb(hex);
      const i = (y * sprite.w + x) * 4;
      img.data[i] = r; img.data[i + 1] = gg; img.data[i + 2] = b; img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Emissive pixels bloom outward with a smooth falloff (composited additively by the scene).
function renderGlow(sprite, g, variant) {
  if (!sprite.emissive.size) return null;
  const W = sprite.w + GLOW_R * 2;
  const H = sprite.h + GLOW_R * 2;
  const acc = new Float32Array(W * H * 3);
  let any = false;
  for (let y = 0; y < sprite.h; y++) {
    for (let x = 0; x < sprite.w; x++) {
      const ch = g[y][x];
      if (!sprite.emissive.has(ch)) continue;
      const hex = colorFor(sprite, ch, variant);
      if (!hex) continue;
      any = true;
      const [r, gg, b] = hexToRgb(hex);
      for (let dy = -GLOW_R; dy <= GLOW_R; dy++) {
        for (let dx = -GLOW_R; dx <= GLOW_R; dx++) {
          const d = Math.hypot(dx, dy);
          if (d > GLOW_R + 0.5) continue;
          const wgt = 0.16 * Math.pow(1 - d / (GLOW_R + 1), 2.2);
          const i = ((y + dy + GLOW_R) * W + (x + dx + GLOW_R)) * 3;
          acc[i] += r * wgt; acc[i + 1] += gg * wgt; acc[i + 2] += b * wgt;
        }
      }
    }
  }
  if (!any) return null;
  const [c, ctx] = makeCanvas(W, H);
  const img = ctx.createImageData(W, H);
  for (let i = 0, o = 0; i < acc.length; i += 3, o += 4) {
    const m = Math.max(acc[i], acc[i + 1], acc[i + 2]);
    if (m < 2) continue;
    const k = m > 255 ? 255 / m : 1;
    img.data[o] = acc[i] * k; img.data[o + 1] = acc[i + 1] * k; img.data[o + 2] = acc[i + 2] * k; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export function frameIndex(sprite, anim, tick) {
  const a = sprite.anims[anim] ?? sprite.anims.idle ?? Object.values(sprite.anims)[0];
  let t = a.loop ? ((tick % a.total) + a.total) % a.total : Math.min(tick, a.total - 1);
  for (let i = 0; i < a.ticks.length; i++) {
    if (t < a.ticks[i]) return i;
    t -= a.ticks[i];
  }
  return a.ticks.length - 1;
}

/**
 * Draw a sprite with its anchor at (x, y).
 * opts: { anim, tick, variant, flip, glow (ctx), glowStrength }
 */
export function drawSprite(ctx, id, x, y, opts = {}) {
  const sprite = registry.get(id);
  if (!sprite) return;
  const animName = sprite.anims[opts.anim] ? opts.anim : Object.keys(sprite.anims)[0];
  const variant = sprite.variants[opts.variant] ? opts.variant : 'default';
  const frames = compile(sprite, variant)[animName];
  const f = frames[frameIndex(sprite, animName, opts.tick ?? 0)];
  const flip = !!opts.flip;
  const ax = flip ? sprite.w - 1 - sprite.anchor[0] : sprite.anchor[0];
  const dx = Math.round(x - ax);
  const dy = Math.round(y - sprite.anchor[1]);
  blit(ctx, f.img, dx, dy, flip);
  if (opts.glow && f.glow && (opts.glowStrength ?? 1) > 0) {
    opts.glow.save();
    opts.glow.globalAlpha = Math.min(1, opts.glowStrength ?? 1);
    blit(opts.glow, f.glow, dx - GLOW_R, dy - GLOW_R, flip);
    opts.glow.restore();
  }
}

function blit(ctx, img, x, y, flip) {
  if (!flip) {
    ctx.drawImage(img, x, y);
    return;
  }
  ctx.save();
  ctx.translate(x + img.width, y);
  ctx.scale(-1, 1);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}
