// Bioluminescent flora, painted procedurally. Glowing parts use slot ramps so variants recolour them.
import { defineSprite } from '../engine/sprites.mjs';
import { painter } from '../engine/paint.mjs';

const CAP_SLOTS = { cap0: 'cyan0', cap1: 'cyan1', cap2: 'cyan2', cap3: 'cyan3' };
const CAP_VARIANTS = {
  violet: { cap0: 'violet0', cap1: 'violet1', cap2: 'violet2', cap3: 'violet3' },
  teal: { cap0: 'teal0', cap1: 'teal1', cap2: 'teal2', cap3: 'teal3' },
  cyan: CAP_SLOTS,
  rose: { cap0: 'magenta0', cap1: 'magenta1', cap2: 'magenta2', cap3: 'white' },
};
const CAP_GLOW = ['cap1', 'cap2', 'cap3'];

function shroom(w, h, capR, stemH) {
  const p = painter(w, h);
  const cx = w / 2;
  p.stroke(cx + 0.4, h - 1.4, cx - 0.2, h - 1.4 - stemH, Math.max(1.6, capR * 0.42), 'cloth', { bias: -0.4 });
  p.ellipse(cx - 0.2, h - 1.6 - stemH + capR * 0.35, capR * 0.85, capR * 0.22 + 0.4, 'cloth', { shade: 'flat', level: 0 });
  p.ellipse(cx - 0.2, h - 1.6 - stemH, capR, capR * 0.62, 'cap', { n: 4, shade: 'sphere', casts: false });
  p.px([[Math.round(cx - capR * 0.4), Math.round(h - 2 - stemH - capR * 0.2)], [Math.round(cx + capR * 0.3), Math.round(h - 2 - stemH - capR * 0.35)]], 'cap3', { outline: false });
  return p.finish();
}

defineSprite({
  id: 'shroom-tall',
  description: 'Tall bioluminescent mushroom; the cap pulses via glowStrength.',
  tags: ['flora', 'glow'],
  size: [16, 18],
  anchor: [8, 17],
  slots: CAP_SLOTS,
  variants: CAP_VARIANTS,
  emissiveTokens: CAP_GLOW,
  frames: { base: shroom(16, 18, 6.4, 9) },
});

defineSprite({
  id: 'shroom-small',
  description: 'Small glowing mushroom for clusters.',
  tags: ['flora', 'glow'],
  size: [10, 11],
  anchor: [5, 10],
  slots: { cap0: 'violet0', cap1: 'violet1', cap2: 'violet2', cap3: 'violet3' },
  variants: CAP_VARIANTS,
  emissiveTokens: CAP_GLOW,
  frames: { base: shroom(10, 11, 3.8, 4.4) },
});

function flower() {
  const p = painter(12, 18);
  p.stroke(6, 17, 6, 7, 1.2, 'leaf');
  p.ellipse(3.6, 13, 2.4, 1.2, 'leaf', { bias: -0.4 });
  p.ellipse(8.6, 11.4, 2.4, 1.2, 'leaf', { bias: 0.2 });
  for (const [x, y] of [[6, 2.6], [3.4, 4.6], [8.6, 4.6], [4.4, 7.4], [7.6, 7.4]]) p.circle(x, y, 1.7, 'cap', { n: 4, shade: 'sphere', casts: false });
  p.circle(6, 5.4, 1.2, 'cap3', { casts: false });
  return p.finish();
}

defineSprite({
  id: 'glowflower',
  description: 'Moonpetal flower with luminous petals.',
  tags: ['flora', 'glow'],
  size: [12, 18],
  anchor: [6, 17],
  slots: { cap0: 'violet0', cap1: 'violet1', cap2: 'violet2', cap3: 'violet3' },
  variants: CAP_VARIANTS,
  emissiveTokens: CAP_GLOW,
  frames: { base: flower() },
});

function lily() {
  const p = painter(20, 9);
  p.ellipse(10, 5, 8.6, 3, 'leaf', { shade: 'sphere' });
  p.erase((x, y) => x > 10 && x < 13 && y > 5 && y < 9);
  p.circle(9, 3, 2, 'cap', { n: 4, casts: false });
  p.px([[9, 2]], 'cap3', { outline: false });
  return p.finish();
}

defineSprite({
  id: 'lilypad',
  description: 'Lily pad with a glowing bloom.',
  tags: ['flora', 'glow', 'water'],
  size: [20, 9],
  anchor: [10, 8],
  slots: { cap0: 'magenta0', cap1: 'magenta1', cap2: 'magenta2', cap3: 'white' },
  emissiveTokens: CAP_GLOW,
  frames: { base: lily() },
});

function fern() {
  const p = painter(36, 24);
  const fronds = [[18, 23, 4, 4], [18, 23, 12, 1], [18, 23, 24, 2], [18, 23, 32, 6], [18, 23, 1, 12], [18, 23, 35, 14]];
  for (const [x0, y0, x1, y1] of fronds) {
    p.stroke(x0, y0, x1, y1, 1.4, 'tree1');
    const n = 6;
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = x0 + (x1 - x0) * t;
      const y = y0 + (y1 - y0) * t;
      p.ellipse(x - 1.6, y + 1, 1.8, 0.9, 'tree2', { shade: 'flat', casts: false });
      p.ellipse(x + 1.6, y + 1, 1.8, 0.9, 'tree1', { shade: 'flat', casts: false });
    }
    p.px([[Math.round(x1), Math.round(y1)]], 'teal1', { outline: false });
  }
  return p.finish({ separate: false });
}

defineSprite({
  id: 'fern',
  description: 'Dark foreground fern with faintly glowing tips; frames the scene edges.',
  tags: ['flora', 'foreground'],
  size: [36, 24],
  anchor: [18, 23],
  emissiveTokens: ['teal1'],
  frames: { base: fern() },
});

function bush() {
  const p = painter(32, 18);
  for (const [x, y, r] of [[8, 11, 6], [16, 8, 7.4], [24, 11, 6.4], [12, 13, 5], [21, 13.4, 5]]) p.ellipse(x, y, r, r * 0.8, 'leaf', { shade: 'sphere', bias: -1.1 });
  p.px([[10, 8], [18, 6], [23, 10], [14, 12], [7, 12], [26, 12]], 'violet1', { outline: false });
  return p.finish();
}

defineSprite({
  id: 'bush',
  description: 'Round shadowy shrub with glowing berries.',
  tags: ['flora'],
  size: [32, 18],
  anchor: [16, 17],
  emissiveTokens: ['violet1'],
  frames: { base: bush() },
});
