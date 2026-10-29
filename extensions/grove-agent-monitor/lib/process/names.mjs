// Mystical task names, so the human can say "tell Moonfern to…" instead of remembering "T3".
// Every name starts with different letters, so a few typed letters pick one out.
export const TASK_NAMES = [
  'Moonfern', 'Thistle', 'Glimmer', 'Bramble', 'Wisp', 'Foxglove', 'Nightjar', 'Sorrel',
  'Lumen', 'Kestrel', 'Briar', 'Vesper', 'Yarrow', 'Gossamer', 'Juniper', 'Cinder',
  'Larkspur', 'Hollow', 'Mosswick', 'Zephyr', 'Tansy', 'Duskwing', 'Quill', 'Rowan',
  'Sylph', 'Inkcap', 'Fennel', 'Eventide', 'Starling', 'Bluebell', 'Wren', 'Nettle',
  'Opal', 'Gloaming', 'Aster', 'Hazel', 'Sundew', 'Puck', 'Rimewood', 'Clover',
  'Umber', 'Lichen', 'Saffron', 'Thimble', 'Dewdrop', 'Mistral', 'Bracken', 'Corvid',
  'Faelight', 'Willow', 'Nimbus', 'Sprig', 'Velvetcap', 'Ember', 'Birch', 'Jessamine',
  'Tinder', 'Oriel', 'Wyrdling', 'Shimmer', 'Ivy', 'Morrow', 'Spindle', 'Heather',
];

const ROMAN = ['', '', ' II', ' III', ' IV', ' V', ' VI', ' VII', ' VIII', ' IX', ' X'];

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
}

// Task n on a board gets the next name in the list, starting at a per-board offset, so names
// never repeat on a board (later laps add a numeral) and every board starts somewhere different.
export function taskName(boardId, n) {
  const L = TASK_NAMES.length;
  const lap = Math.floor((n - 1) / L);
  return `${TASK_NAMES[(hash(boardId) + n - 1) % L]}${ROMAN[lap + 1] ?? ` ${lap + 1}`}`;
}

// "Moonfern (T3)" in messages; just the id for a task without a name.
export function taskLabel(t) {
  return t.name ? `${t.name} (${t.id})` : t.id;
}

// The short handle for tight spots such as session titles.
export function taskTag(t) {
  return t.name ?? t.id;
}

// The task a human means by "T3", "t3", "Moonfern", "moonfern" or "Moonfern (T3)".
export function findTask(tasks, ref) {
  const s = String(ref ?? '').trim().replace(/^["'“”‘’]+|["'“”‘’.!?]+$/g, '');
  const id = s.match(/^t\d+$/i)?.[0] ?? s.match(/\((t\d+)\)$/i)?.[1];
  if (id) return tasks.find((t) => t.id.toLowerCase() === id.toLowerCase()) ?? null;
  const name = s.replace(/^the\s+/i, '').toLowerCase();
  return tasks.find((t) => t.name?.toLowerCase() === name) ?? null;
}
