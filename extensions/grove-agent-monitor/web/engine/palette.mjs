// Grove palette: curated colours plus hue-shifted material ramps, in full 24-bit colour.
// Sprites and scenery reference colours by NAME ('robe2', 'skin3', 'cyan1'), never raw hex.

import { TASK_COLORS } from '../model.mjs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hexToHsl(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  const to = (v) => Math.round(clamp(v + m, 0, 1) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

function hueToward(h, target, amount) {
  const d = ((target - h + 540) % 360) - 180;
  return h + clamp(d, -amount, amount);
}

// Hue-shifted ramp: shadows drift toward blue-violet, highlights toward warm yellow.
// The middle step is the base colour.
export function makeRamp(hex, n = 5, { dark = 0.62, light = 0.5, shift = 16 } = {}) {
  const [h, s, l] = hexToHsl(hex);
  return Array.from({ length: n }, (_, i) => {
    const d = n === 1 ? 0 : i / (n - 1) - 0.5;
    const L = d < 0 ? l * (1 + d * 2 * dark) : l + d * 2 * light * (1 - l);
    const H = hueToward(h, d < 0 ? 250 : 55, Math.abs(d) * 2 * shift);
    const S = clamp(s * (1 - Math.abs(d) * 0.3) + (d < 0 ? 0.06 : 0), 0, 1);
    return hslToHex(H, S, clamp(L, 0.02, 0.98));
  });
}

export function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (sh) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

const RAW = {
  // Night sky: deep indigo into a violet horizon.
  sky0: '#070616', sky1: '#0e0b2a', sky2: '#17133e', sky3: '#221a54', sky4: '#30246a', sky5: '#463282',
  // Dusk sky: violet into a rose horizon.
  dusk0: '#100822', dusk1: '#1c0e34', dusk2: '#2e1646', dusk3: '#4a2058', dusk4: '#782c62', dusk5: '#b04a68',
  // Dawn sky: blue into a peach horizon.
  dawn0: '#101838', dawn1: '#1c2a56', dawn2: '#324274', dawn3: '#5a5e92', dawn4: '#9a7c9e', dawn5: '#e0a490',
  sun: '#f8d8a8',
  star: '#eef4ff', starDim: '#8890cc',
  moon: '#e6f0ff', moonShade: '#aebce6', moonDark: '#7a86c2',

  hill0: '#14163a', hill1: '#1c2248', hill2: '#262e5a',
  farTree0: '#0f1a32', farTree1: '#16283e', farTree2: '#1f3a4c',
  fog: '#6c5cb0',

  treeDark: '#061210', tree0: '#0a1c1a', tree1: '#112e24', tree2: '#18422c', tree3: '#245a34', tree4: '#367442', tree5: '#52924c',
  rim: '#3c7ca0', rimHi: '#7cc4dc',

  grass0: '#0b221c', grass1: '#123422', grass2: '#1b4a2c', grass3: '#2a6236', grass4: '#447e40', grass5: '#62a050',
  moss: '#2c7050', mossHi: '#48a070',
  dirt0: '#1a1320', dirt1: '#2a1f2e', dirt2: '#3e2f3e', dirt3: '#58464e', dirt4: '#76606a',
  bark0: '#120a12', bark1: '#22141c', bark2: '#34222c', bark3: '#4a3440', bark4: '#664a56',
  straw0: '#5a4632', straw1: '#8a7048', straw2: '#b89a64',
  parch0: '#8c8098', parch1: '#c8bcd8',
  stone0: '#1a1a32', stone1: '#2a2e4e', stone2: '#444e6c', stone3: '#6a7696', stone4: '#9aa8c4', stone5: '#c4d0e4',

  water0: '#08122c', water1: '#0e2248', water2: '#18386c', water3: '#2a60a0', waterHi: '#6cbcec',

  // Bioluminescence. Higher steps are hotter, whiter cores.
  cyan0: '#1478aa', cyan1: '#34c4ea', cyan2: '#a4f2ff', cyan3: '#e8fdff',
  violet0: '#4c26a0', violet1: '#8a4ae8', violet2: '#c8a0ff', violet3: '#efe2ff',
  magenta0: '#9c2a9a', magenta1: '#e05ed8', magenta2: '#ffb8f4',
  teal0: '#12a088', teal1: '#2ee0b0', teal2: '#a4ffe0', teal3: '#e6fff6',
  ember0: '#a01e3e', ember1: '#f04e6e', ember2: '#ffb0b8',
  amber: '#f8d070', amber2: '#fff0c0',
  white: '#f8f8ff',

  outline: '#130b28', ink: '#0c0618', shadow: '#08051a',
  uiBg: '#0d0a22', uiBg2: '#1a1440', uiFrame: '#6a58c0', uiFrameHi: '#b8a8ff', uiText: '#f2eeff', uiTextDim: '#9a92ca',
};

// Material ramps (5 steps, 0 = deepest shadow … 4 = highlight).
export const MATERIALS = {
  skin: '#d4a894', hair: '#6e4430', ginger: '#c0643a', beard: '#d8d2ea', wood: '#7a5236', leather: '#6a4a3c',
  metal: '#8a94b4', gold: '#d6a444', cloth: '#e0d4ba', rock: '#737c9c', leaf: '#3e7c4c', straw: '#c29a58',
  pants: '#3c3a58', night: '#26306e', glass: '#2c5894', brick: '#5c6280', coal: '#3a2a34', fire: '#d8504a',
};

export const ROBE_BASE = Object.freeze({
  violet: '#7646cc', azure: '#3672c6', teal: '#289886', moss: '#588636', rose: '#c64892', dusk: '#626a8a',
});

const ENTRIES = { ...RAW };
for (const [name, hex] of Object.entries(MATERIALS)) makeRamp(hex).forEach((c, i) => { ENTRIES[`${name}${i}`] = c; });
for (const [name, hex] of Object.entries(ROBE_BASE)) makeRamp(hex).forEach((c, i) => { ENTRIES[`robe_${name}${i}`] = c; });
// Tent canvas for each task colour: the glow colour dulled into dyed cloth so tents don't outshine the scene.
for (const name of TASK_COLORS) makeRamp(mixHex(RAW[name], '#2a2050', 0.55), 5, { light: 0.32 }).forEach((c, i) => { ENTRIES[`tent_${name}${i}`] = c; });
// Report-book covers: brighter than tent cloth, since a waiting book should catch the eye.
for (const name of TASK_COLORS) makeRamp(mixHex(RAW[name], '#2a2050', 0.22), 5, { light: 0.42 }).forEach((c, i) => { ENTRIES[`book_${name}${i}`] = c; });

export const PALETTE = Object.freeze(ENTRIES);

// Robe palette swaps: sprite slots robe0..robe4 → a robe ramp.
export const ROBES = Object.freeze(Object.fromEntries(Object.keys(ROBE_BASE).map((name) => [
  name, Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`robe${i}`, `robe_${name}${i}`])),
])));

export const ROBE_NAMES = Object.freeze(Object.keys(ROBES));

// Tent palette swaps: sprite slots tent0..tent4 (cloth) and flag → a task colour.
export const TENTS = Object.freeze(Object.fromEntries(TASK_COLORS.map((name) => [
  name, { ...Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`tent${i}`, `tent_${name}${i}`])), flag: name },
])));

// Book palette swaps: the book sprite shares the tent's slots, dyed with the brighter book ramps.
export const BOOKS = Object.freeze(Object.fromEntries(TASK_COLORS.map((name) => [
  name, { ...Object.fromEntries([0, 1, 2, 3, 4].map((i) => [`tent${i}`, `book_${name}${i}`])), flag: name },
])));

export function color(name) {
  const c = PALETTE[name];
  if (!c) throw new Error(`Unknown palette color "${name}"`);
  return c;
}
