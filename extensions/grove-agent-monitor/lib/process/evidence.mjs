// Visual evidence produced by verifiers lives in session data. This module validates an evidence
// folder and serves its files safely.
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const MEDIA_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
});
const MAX_BYTES = 25 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/;

export function safeName(name) {
  return typeof name === 'string' && SAFE_NAME.test(name) && !name.includes('..') && path.basename(name) === name;
}

export async function validateEvidence(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'evidence.json'), 'utf8'));
  } catch (err) {
    return err.code === 'ENOENT' ? { ok: false, missing: true, reason: 'evidence.json is missing.' } : { ok: false, reason: 'evidence.json is not valid JSON.' };
  }
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.items) || !manifest.items.length) {
    return { ok: false, reason: 'evidence.json must have a non-empty "items" array.' };
  }
  const items = [];
  for (const [i, it] of manifest.items.entries()) {
    if (!it || !safeName(it.file)) return { ok: false, reason: `items[${i}].file must be a plain file name inside the evidence folder.` };
    const ext = path.extname(it.file).toLowerCase();
    if (!MEDIA_TYPES[ext]) return { ok: false, reason: `items[${i}] "${it.file}" is not an allowed type (${Object.keys(MEDIA_TYPES).join(' ')}).` };
    let st;
    try {
      st = await fs.stat(path.join(dir, it.file));
    } catch {
      return { ok: false, reason: `"${it.file}" listed in evidence.json does not exist.` };
    }
    if (!st.isFile() || st.size === 0) return { ok: false, reason: `"${it.file}" is empty.` };
    if (st.size > MAX_BYTES) return { ok: false, reason: `"${it.file}" is larger than 25 MB.` };
    if (typeof it.caption !== 'string' || !it.caption.trim()) return { ok: false, reason: `items[${i}] needs a caption explaining what it shows.` };
    items.push({ file: it.file, caption: it.caption.trim().slice(0, 400), criterion: String(it.criterion ?? '').trim().slice(0, 300), type: MEDIA_TYPES[ext] });
  }
  return { ok: true, items, dir, summary: String(manifest.summary ?? '').trim().slice(0, 4000) };
}
