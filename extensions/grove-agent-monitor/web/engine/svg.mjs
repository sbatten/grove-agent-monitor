// Grove sprites as SVG, for pages that aren't the canvas (the task report). Each sprite frame becomes one
// <symbol> of crisp rects (runs of a colour merged per row), so a page can show the real pixel art at any
// size: `shape-rendering: crispEdges` keeps every art pixel square. No DOM needed; works in Node.
import { getSprite } from './sprites.mjs';
import { PALETTE } from './palette.mjs';

function colorOf(sprite, variant, ch) {
  const token = sprite.key[ch];
  if (token == null) return null;
  const v = sprite.variants[variant] ?? {};
  const name = v[token] ?? sprite.slots[token] ?? token;
  return PALETTE[name] ?? null;
}

// The SVG body (rects) of one frame of a sprite. Returns null for an unknown sprite.
export function spriteRects(id, { anim, frame = 0, variant = 'default' } = {}) {
  const sprite = getSprite(id);
  if (!sprite) return null;
  const a = sprite.anims[anim] ?? Object.values(sprite.anims)[0];
  const grid = a.grids[Math.max(0, Math.min(a.grids.length - 1, frame))];
  const v = sprite.variants[variant] ? variant : 'default';
  // One path per colour: each run of same-coloured pixels in a row is a 1-high rectangle.
  const paths = new Map();
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y];
    let x = 0;
    while (x < row.length) {
      const c = colorOf(sprite, v, row[x]);
      let end = x + 1;
      while (end < row.length && colorOf(sprite, v, row[end]) === c) end++;
      if (c) paths.set(c, `${paths.get(c) ?? ''}M${x} ${y}h${end - x}v1h${x - end}z`);
      x = end;
    }
  }
  return { w: sprite.w, h: sprite.h, body: [...paths].map(([c, d]) => `<path fill="${c}" d="${d}"/>`).join('') };
}

// Collects the sprites a page uses as <symbol>s, so each is defined once however often it appears.
export class SpriteSheet {
  constructor(prefix = 'sp') {
    this.prefix = prefix;
    this.symbols = new Map();
  }

  // An inline <svg> showing the sprite at `scale` CSS pixels per art pixel. Returns '' for an unknown sprite.
  use(id, { anim, frame = 0, variant = 'default', scale = 2, className = '', title = '' } = {}) {
    const key = `${this.prefix}-${id}-${anim ?? 'a'}-${frame}-${variant}`.replace(/[^A-Za-z0-9_-]/g, '_');
    if (!this.symbols.has(key)) {
      const r = spriteRects(id, { anim, frame, variant });
      if (!r) return '';
      this.symbols.set(key, r);
    }
    const { w, h } = this.symbols.get(key);
    const label = title ? `<title>${title.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</title>` : '';
    return `<svg class="sprite${className ? ` ${className}` : ''}" viewBox="0 0 ${w} ${h}" width="${w * scale}" height="${h * scale}" shape-rendering="crispEdges" ${title ? 'role="img"' : 'aria-hidden="true"'}>${label}<use href="#${key}"/></svg>`;
  }

  // The <svg> holding every symbol used so far. Put it once at the top of the page.
  defs() {
    if (!this.symbols.size) return '';
    const syms = [...this.symbols].map(([key, r]) => `<symbol id="${key}" viewBox="0 0 ${r.w} ${r.h}">${r.body}</symbol>`).join('');
    return `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${syms}</defs></svg>`;
  }
}
