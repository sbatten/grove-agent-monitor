#!/usr/bin/env node
// Validate and lint Grove sprites.
// Usage: node validate-sprites.mjs [--web <path-to-extension-web-dir>] [--id <sprite-id>]
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(opt('--web') ?? path.join(here, '../../../extensions/grove-agent-monitor/web'));
const only = opt('--id');

const { listSprites, spriteErrors } = await import(pathToFileURL(path.join(webDir, 'engine/sprites.mjs')));
const { PALETTE } = await import(pathToFileURL(path.join(webDir, 'engine/palette.mjs')));
await import(pathToFileURL(path.join(webDir, 'sprites/index.mjs')));

const errors = [...spriteErrors()];
const warnings = [];

function resolve(sprite, token, variant) {
  const vmap = sprite.variants[variant] ?? {};
  if (token in vmap) return PALETTE[vmap[token]];
  if (token in sprite.slots) return PALETTE[sprite.slots[token]];
  return PALETTE[token];
}

for (const s of listSprites()) {
  if (only && s.id !== only) continue;
  const [ax, ay] = s.anchor;
  if (ax < 0 || ay < 0 || ax >= s.w || ay >= s.h) errors.push(`${s.id}: anchor [${ax}, ${ay}] is outside ${s.w}x${s.h}`);
  const used = new Set();
  for (const a of Object.values(s.anims)) for (const g of a.grids) for (const row of g) for (const ch of row) used.add(ch);
  for (const ch of Object.keys(s.key)) if (ch !== '.' && ch.charCodeAt(0) < 0x100 && !used.has(ch)) warnings.push(`${s.id}: key "${ch}" is never used`);
  for (const ch of s.emissive) if (!used.has(ch)) warnings.push(`${s.id}: emissive "${ch}" is never drawn`);
  for (const variant of Object.keys(s.variants)) {
    const colors = new Set();
    for (const ch of used) {
      const token = s.key[ch];
      if (token != null) colors.add(resolve(s, token, variant));
    }
    if (colors.size > 48) warnings.push(`${s.id} [${variant}]: ${colors.size} colours; keep sprites to curated ramps (aim for ≤ 48)`);
  }
  const animSummary = Object.entries(s.anims).map(([n, a]) => `${n}:${a.grids.length}f/${a.total}t`).join(' ');
  console.log(`✓ ${s.id.padEnd(14)} ${`${s.w}x${s.h}`.padEnd(6)} variants=${Object.keys(s.variants).length.toString().padEnd(3)} ${animSummary}`);
}

for (const w of warnings) console.log(`⚠ ${w}`);
for (const e of errors) console.error(`✗ ${e}`);
console.log(errors.length ? `\n${errors.length} error(s)` : '\nAll sprites valid.');
process.exit(errors.length ? 1 : 0);
