import { defineSprite } from '../engine/sprites.mjs';
import { painter } from '../engine/paint.mjs';
import { TENTS, BOOKS } from '../engine/palette.mjs';

function rock() {
  const p = painter(16, 10);
  p.ellipse(8, 6, 6.6, 3.8, 'rock', { shade: 'sphere' });
  p.ellipse(6, 3.4, 3.4, 1.2, 'leaf', { shade: 'flat', level: 1, casts: false });
  return p.finish();
}

defineSprite({
  id: 'rock',
  description: 'Small moonlit rock with a cap of moss.',
  tags: ['prop'],
  size: [16, 10],
  anchor: [8, 9],
  frames: { base: rock() },
});

// ---------- team tent ----------
// Pitched at camp when a task's team forms, in the task's colour. Idle members rest inside it; the doorway
// glows while anyone is in. Slots tent0..tent4 (cloth ramp) and flag are re-pointed per task colour.

function tent(door) {
  const p = painter(22, 18);
  // Side panel (depth, toward the light) and the front face, an A-frame with a hem.
  p.poly([[10, 2], [17, 4], [20.6, 16], [15, 17]], 'tent', { n: 5, shade: 'vert', bias: 0.7 });
  p.poly([[10, 2], [1.4, 17], [18.6, 17]], 'tent', { n: 5, shade: 'vert', bias: -0.15 });
  p.px([[10, 2], [11, 3], [13, 3], [14, 4], [16, 4]], 'tent4', { outline: false });
  p.rect(2, 16, 16, 1, 'tent1');
  // Doorway: dark when empty, lantern-lit while someone rests inside.
  p.poly([[10, 7], [6.6, 17], [13.4, 17]], door === 'dark' ? 'ink' : 'den', { shade: 'flat', casts: false });
  if (door !== 'dark') {
    p.poly([[10, 10], [8.2, 17], [11.8, 17]], 'warm', { shade: 'flat', casts: false });
    p.px(door === 'lit' ? [[9, 14], [10, 14], [10, 13], [9, 15], [10, 15]] : [[10, 14], [9, 15], [10, 15]], 'lamp', { outline: false });
    p.px([[10, 14]], 'lampHi', { outline: false });
  }
  // Tied-back flaps, one lit and one in shade.
  p.poly([[10, 7], [6.6, 17], [5.4, 17], [9.2, 7.6]], 'tent', { n: 5, shade: 'flat', level: 3 });
  p.poly([[10, 7], [13.4, 17], [14.6, 17], [10.8, 7.6]], 'tent', { n: 5, shade: 'flat', level: 1 });
  // Ridge pole and the task flag.
  p.rect(9.6, 0, 1, 3, 'wood');
  p.poly([[10.6, 0], [14.4, 1], [10.6, 2]], 'flag', { shade: 'flat', casts: false });
  return p.finish();
}

defineSprite({
  id: 'tent',
  description: 'Team tent at camp, in the task colour; idle team members rest inside and the doorway glows.',
  tags: ['prop', 'glow'],
  size: [22, 18],
  anchor: [10, 17],
  slots: {
    tent0: 'robe_dusk0', tent1: 'robe_dusk1', tent2: 'robe_dusk2', tent3: 'robe_dusk3', tent4: 'robe_dusk4',
    flag: 'stone4', den: 'straw0', warm: 'gold1', lamp: 'amber', lampHi: 'amber2',
  },
  variants: TENTS,
  emissiveTokens: ['flag', 'warm', 'lamp', 'lampHi'],
  frames: { dark: tent('dark'), lit: tent('lit'), flicker: tent('flicker') },
  anims: {
    lit: { frames: ['lit', 'flicker', 'lit'], ticks: [70, 6, 30] },
    empty: { frames: ['dark'], ticks: 60 },
  },
});

// ---------- task report book ----------
// A closed tome in the task colour with a glowing rune and a ribbon bookmark. Books float over the Chief of
// Staff while tasks wait on the human, and the inbox uses one as the link to each task's report. Same slots
// as the tent, dyed per task with the brighter BOOKS ramps.

function book(bright) {
  const p = painter(14, 16);
  // Page block (seen past the cover on the right and bottom), then the cover and its spine.
  p.poly([[3, 3], [12.6, 2], [12.6, 13.4], [3, 14.4]], 'parch1', { shade: 'flat', casts: false });
  p.px([[12, 4], [12, 6], [12, 8], [12, 10], [12, 12]], 'parch0', { outline: false });
  p.poly([[1.4, 1.6], [11.2, 0.6], [11.2, 12.6], [1.4, 13.6]], 'tent', { n: 5, shade: 'vert', bias: 0.35 });
  p.rect(1.4, 1.6, 1.6, 12, 'tent1');
  // Gilt corners and the rune; the ribbon hangs from the pages.
  p.px([[10, 1], [10, 12], [3, 2], [3, 13]], 'gold3', { outline: false });
  const rune = bright ? 'runeHi' : 'rune';
  p.px([[6, 4], [5, 5], [7, 5], [6, 6], [6, 7], [4, 8], [8, 8], [6, 9], [5, 10], [7, 10]], rune, { outline: false });
  p.rect(8, 13.4, 1, 2.4, 'flag', { shade: 'flat', casts: false });
  return p.finish();
}

defineSprite({
  id: 'book',
  description: 'Task report: a closed tome in the task colour with a glowing rune, floating over the Chief when a task needs you.',
  tags: ['prop', 'glow', 'fx'],
  size: [14, 16],
  anchor: [7, 15],
  slots: {
    tent0: 'robe_dusk0', tent1: 'robe_dusk1', tent2: 'robe_dusk2', tent3: 'robe_dusk3', tent4: 'robe_dusk4',
    flag: 'stone4', rune: 'cyan1', runeHi: 'cyan2',
  },
  variants: BOOKS,
  emissiveTokens: ['flag', 'rune', 'runeHi'],
  frames: { a: book(false), b: book(true) },
  anims: { glow: { frames: ['a', 'b', 'a'], ticks: [50, 18, 30] } },
});
