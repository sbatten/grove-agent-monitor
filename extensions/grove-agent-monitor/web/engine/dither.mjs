// Ordered (Bayer 4x4) dithering — the GBA way to fake gradients and alpha.
export const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// True when pixel (x, y) should be "on" for coverage t in [0, 1].
export function dither(x, y, t) {
  return BAYER4[y & 3][x & 3] < t * 16;
}

// Deterministic PRNG so static scenery is identical on every load.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

const haloCache = new Map();

// Soft radial light. Draw it with globalCompositeOperation = 'lighter'.
export function halo(radius, hex, strength = 1) {
  const key = `${radius}|${hex}|${strength}`;
  let c = haloCache.get(key);
  if (c) return c;
  const size = radius * 2 + 1;
  const [canvas, ctx] = makeCanvas(size, size);
  const [r, g, b] = hexToRgb(hex);
  const grad = ctx.createRadialGradient(radius + 0.5, radius + 0.5, 0, radius + 0.5, radius + 0.5, radius + 0.5);
  const a = (k) => `rgba(${r},${g},${b},${Math.min(1, k * strength)})`;
  grad.addColorStop(0, a(0.5));
  grad.addColorStop(0.3, a(0.24));
  grad.addColorStop(0.65, a(0.07));
  grad.addColorStop(1, a(0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  haloCache.set(key, canvas);
  return canvas;
}

// Smooth value noise in [0, 1] for scenery textures.
export function valueNoise(seed = 1) {
  const rand = mulberry32(seed);
  const N = 256;
  const perm = Array.from({ length: N }, (_, i) => i).sort(() => rand() - 0.5);
  const vals = Array.from({ length: N }, () => rand());
  const at = (x, y) => vals[(perm[(x & 255)] + y) & 255];
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const tx = smooth(x - xi);
    const ty = smooth(y - yi);
    const a = at(xi, yi) + (at(xi + 1, yi) - at(xi, yi)) * tx;
    const b = at(xi, yi + 1) + (at(xi + 1, yi + 1) - at(xi, yi + 1)) * tx;
    return a + (b - a) * ty;
  };
}
