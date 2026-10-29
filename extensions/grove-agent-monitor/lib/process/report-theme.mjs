// The look of the task report: the grove at night, at a higher resolution. Pixel art (real Grove sprites, a
// treeline, scroll rods) stays pixel art, scaled up crisply; text is set at full resolution for reading.
// Everything is inline (CSS and data: URIs), so the page works from disk and under the canvas's strict CSP.
import { mulberry32 } from '../../web/engine/dither.mjs';
import { PALETTE as P } from '../../web/engine/palette.mjs';

const svgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}")`;

// A pixel treeline silhouette (two layers of stepped pines), tiled along the bottom of the page. Each layer is
// one path tracing its skyline column by column, so it stays small.
function treeline() {
  const rnd = mulberry32(17);
  const W = 160;
  const H = 40;
  const layer = (step, spread, minTop, fill) => {
    const top = new Array(W).fill(H - 4);
    for (let cx = Math.floor(rnd() * 4); cx < W + 8; cx += step + Math.floor(rnd() * spread)) {
      const peak = minTop + Math.floor(rnd() * 12);
      for (let y = peak; y < H; y += 1) {
        const half = Math.min(9, Math.floor((y - peak) * 0.45) + ((y - peak) % 4 === 3 ? -1 : 0)) + 1;
        for (let x = cx - half; x < cx + half; x += 1) {
          const wx = ((x % W) + W) % W;
          if (y < top[wx]) top[wx] = y;
        }
      }
    }
    let d = `M0 ${H}V${top[0]}`;
    for (let x = 1; x < W; x += 1) if (top[x] !== top[x - 1]) d += `H${x}V${top[x]}`;
    return `<path d="${d}H${W}V${H}Z" fill="${fill}"/>`;
  };
  const back = layer(7, 6, 6, '#141038');
  const front = layer(9, 8, 14, '#0a1b1e');
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" shape-rendering="crispEdges">${back}${front}</svg>`);
}

// Stars and a few glowing motes, as a tile.
function starfield() {
  const rnd = mulberry32(5);
  const dots = [];
  for (let i = 0; i < 46; i += 1) {
    const big = rnd() < 0.12;
    const c = big ? '#f2eeff' : rnd() < 0.5 ? '#9a92ca' : '#c8c0f0';
    dots.push(`<rect x="${Math.floor(rnd() * 240)}" y="${Math.floor(rnd() * 240)}" width="${big ? 2 : 1}" height="${big ? 2 : 1}" fill="${c}" opacity="${big ? 0.9 : 0.55}"/>`);
  }
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240" width="240" height="240" shape-rendering="crispEdges">${dots.join('')}</svg>`);
}

// A gilded pixel corner for the scroll panels (drawn for the top-left; CSS mirrors it for the others).
function corner(flipX, flipY) {
  const g = '#d9b45a';
  const d = '#8a6d33';
  const px = [[0, 0, g], [1, 0, g], [2, 0, g], [3, 0, d], [0, 1, g], [0, 2, g], [0, 3, d], [2, 2, '#5ad8f0']];
  const r = px.map(([x, y, c]) => `<rect x="${flipX ? 5 - x : x}" y="${flipY ? 5 - y : y}" width="1" height="1" fill="${c}"/>`).join('');
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 6" width="6" height="6" shape-rendering="crispEdges">${r}</svg>`);
}

// ---- pixel scroll art ----
// Scrolls are drawn like the grove's sprites: a few flat colours per material, hard pixel edges, scaled up
// by whole pixels (SVG with crispEdges, so it stays sharp at any zoom). No smooth gradients.

// A pixel image from rows of palette keys ('.' is transparent).
function pixels(rows, pal) {
  const w = rows[0].length;
  const out = [];
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x += 1) {
      const c = pal[row[x]];
      if (c) out.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${c}"/>`);
    }
  });
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${rows.length}" width="${w}" height="${rows.length}" shape-rendering="crispEdges">${out.join('')}</svg>`);
}

const mirror = (rows) => rows.map((r) => [...r].reverse().join(''));

// A scroll's rolled paper: one column, repeated across. o outline · H highlight · L light · B body · S shade ·
// D deep shade.
const ROLL = ['o', 'H', 'L', 'L', 'B', 'S', 'D', 'o'];
// Each end of a rod: a knob, a short wooden dowel, and the spiral end of the rolled paper (k is the spiral).
// h g d s are the knob's tones, w x the dowel's.
const ROD_END = [
  '.ooo.......',
  'ohggo....oo',
  'ohgdo...oHL',
  'oggdoooookL',
  'oggdowwwokB',
  'oggdoxxxokB',
  'oggdoooookS',
  'ogdso...okD',
  'oddso....oo',
  '.ooo.......',
];
const KNOBS = {
  gold: { h: '#ffe7a0', g: '#d9b45a', d: '#8a6d33', s: '#4a3412' },
  cyan: { h: '#d8f8ff', g: '#5ad8f0', d: '#2a8aa8', s: '#0f3c50' },
  dim: { h: '#8a82b8', g: '#5a5288', d: '#3a3462', s: '#221e44' },
};
const WOOD = { w: '#a0703e', x: '#5e3a20' };
const PAPER_ROLLS = {
  parchment: { o: '#4a3418', H: '#fdf6e2', L: '#f1e4c4', B: '#e3cf9f', S: '#cdb47e', D: '#a8895a', k: '#b89a66' },
  vellum: { o: '#07051a', H: '#8a7cd4', L: '#5e50a8', B: '#483c8a', S: '#32296c', D: '#211a4c', k: '#16113a' },
};
function roll(paper) {
  return pixels(ROLL, PAPER_ROLLS[paper]);
}
function rodEnd(paper, knob, right = false) {
  return pixels(right ? mirror(ROD_END) : ROD_END, { ...PAPER_ROLLS[paper], ...WOOD, ...KNOBS[knob] });
}

// Paper grain: a sparse speckle tile in two or three nearby tones.
function grain(seed, tones) {
  const rnd = mulberryLite(seed);
  const rows = [];
  for (let y = 0; y < 24; y += 1) {
    let row = '';
    for (let x = 0; x < 24; x += 1) {
      const r = rnd();
      row += r < 0.025 ? 'a' : r < 0.045 ? 'b' : r < 0.05 ? 'c' : '.';
    }
    rows.push(row);
  }
  return pixels(rows, tones);
}

// A wax seal: a lumpy disc, tinted with the task's colour through a mask, with pixel highlights and shade.
const SEAL = [
  '.....oooooo.....',
  '...oo######oo...',
  '..o##########o..',
  '.o############o.',
  '.o###hh#######o.',
  'o###h########ss.',
  'o##h###rrrr##sso',
  'o##h##r####r#sso',
  'o#####r####r#sso',
  'o#####r####r#sso',
  'o##s###rrrr##sso',
  '.o##s#######ssso',
  '.o###ss####ssso.',
  '..o###ssssssso..',
  '...oossssssoo...',
  '.....oooooo.....',
];
const sealMask = () => pixels(SEAL.map((r) => r.replace(/[#hrs]/g, 'x')), { x: '#000', o: '#000' });
const sealShade = () => pixels(SEAL, { o: 'rgba(20,4,12,.55)', h: 'rgba(255,255,255,.45)', s: 'rgba(30,6,16,.35)', r: 'rgba(30,6,16,.28)' });

function mulberryLite(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A rune divider: dots and diamonds in gold and cyan.
function runeRule() {
  const cells = [];
  for (let x = 0; x < 24; x += 6) {
    cells.push(`<rect x="${x + 1}" y="2" width="1" height="1" fill="#8a6d33"/>`, `<rect x="${x + 3}" y="1" width="1" height="3" fill="#d9b45a"/>`, `<rect x="${x + 2}" y="2" width="3" height="1" fill="#d9b45a"/>`, `<rect x="${x + 3}" y="2" width="1" height="1" fill="#5ad8f0"/>`);
  }
  return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 5" width="24" height="5" shape-rendering="crispEdges">${cells.join('')}</svg>`);
}

const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", "URW Palladio L", Georgia, serif';

export function reportCss() {
  return `
:root {
  color-scheme: dark;
  --night0: #06051a; --night1: #0d0a26; --night2: #161133; --night3: #1f1846;
  --ink: #ece6ff; --dim: #a79fd6; --faint: #6f68a0;
  --gold: #d9b45a; --gold-dim: #8a6d33; --gold-soft: rgba(217, 180, 90, .32);
  --parch: #f1e4c4; --parch2: #e3cf9f; --parch3: #cdb47e; --parch-ink: #2b1f3c; --parch-dim: #6b5a4a;
  --cyan: ${P.cyan1}; --cyan-hi: ${P.cyan2}; --teal: ${P.teal1}; --magenta: ${P.magenta1}; --amber: ${P.amber}; --violet: ${P.violet2}; --ember: ${P.ember1};
  --good: #7cf0c8; --bad: #ff7a90;
  --serif: ${SERIF};
  --sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 64px; background: var(--night0); }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
body {
  margin: 0; min-height: 100vh; color: var(--ink); font: 16px/1.6 var(--sans);
  background:
    radial-gradient(ellipse 80% 40% at 50% -6%, color-mix(in srgb, var(--task) 22%, transparent), transparent 70%),
    radial-gradient(ellipse 60% 30% at 85% 4%, rgba(46, 224, 176, .10), transparent 70%),
    ${starfield()} 0 0 / 480px 480px repeat,
    linear-gradient(180deg, var(--night0) 0%, var(--night1) 45%, #0b1626 100%) fixed;
  background-attachment: fixed;
  padding-bottom: 150px;
}
body::after {
  content: ""; position: fixed; left: 0; right: 0; bottom: 0; height: 160px; pointer-events: none; z-index: -1;
  background: ${treeline()} 0 100% / 640px 160px repeat-x; opacity: .9;
}
a { color: var(--cyan-hi); text-decoration-color: color-mix(in srgb, var(--cyan) 50%, transparent); text-underline-offset: 2px; }
a:hover { color: #fff; }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--cyan); outline-offset: 3px; border-radius: 3px; }
code, pre { font: 13.5px/1.5 var(--mono); }
code { background: rgba(255, 255, 255, .08); padding: 1px 5px; border-radius: 4px; }
pre { background: #07061a; border: 1px solid var(--night3); padding: 10px 12px; border-radius: 6px; overflow: auto; }
pre code { background: none; padding: 0; }
.sprite { display: block; image-rendering: pixelated; flex: none; }
.glow { filter: drop-shadow(0 0 6px color-mix(in srgb, var(--task) 70%, transparent)); }
.meta { color: var(--dim); font-size: 13px; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 0 24px; }

/* ---- banner ---- */
.banner { display: flex; gap: 20px; align-items: center; padding-top: 36px; padding-bottom: 18px; }
.banner > div { min-width: 0; }
h1, .action, .eyebrow { overflow-wrap: anywhere; }
main.wrap > * { min-width: 0; }
.move > div, .step > div, .criteria li > div { min-width: 0; }
.summons code, .need code { white-space: normal; overflow-wrap: anywhere; }
.banner .sprite { filter: drop-shadow(0 0 14px color-mix(in srgb, var(--task) 75%, transparent)); }
.eyebrow { margin: 0; font: 600 12px/1.4 var(--sans); letter-spacing: .18em; text-transform: uppercase; color: var(--task); }
.eyebrow .task-name { font-weight: 800; color: color-mix(in srgb, var(--task) 55%, #fbf3dc); }
h1 { margin: 4px 0 8px; font: 600 34px/1.15 var(--serif); color: #fbf3dc; text-shadow: 0 0 24px color-mix(in srgb, var(--task) 45%, transparent); }
.status { margin: 0; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }

/* ---- runes: status pills ---- */
.rune { display: inline-flex; align-items: center; gap: 6px; font: 700 11.5px/1 var(--sans); letter-spacing: .1em; text-transform: uppercase; padding: 5px 11px 5px 9px; border-radius: 3px; background: var(--night3); color: var(--dim); box-shadow: inset 0 0 0 1px rgba(255,255,255,.06); }
.rune::before { content: ""; width: 7px; height: 7px; transform: rotate(45deg); background: currentColor; box-shadow: 0 0 6px currentColor; }
.rune.ask { background: #3a1240; color: #ffb0f6; }
.rune.block { background: #3c2410; color: #ffc27a; }
.rune.work { background: #0f2c3c; color: var(--cyan-hi); }
.rune.done, .rune.pass { background: #0f3428; color: var(--good); }
.rune.fail { background: #3a1020; color: var(--bad); }
.rune.off { background: #221f36; color: var(--dim); }
.rune.draft { background: #2a2350; color: #cbb8ff; }

/* ---- nav ---- */
nav.runes { position: sticky; top: 0; z-index: 3; background: color-mix(in srgb, var(--night0) 88%, transparent); backdrop-filter: blur(8px); border-bottom: 1px solid var(--gold-soft); }
nav.runes .wrap { display: flex; gap: 4px; flex-wrap: wrap; padding-top: 8px; padding-bottom: 8px; }
nav.runes a { color: var(--dim); text-decoration: none; padding: 4px 10px; border-radius: 3px; font-size: 13.5px; }
nav.runes a:hover { color: #fff3c8; background: var(--night3); }

main.wrap { display: grid; gap: 22px; padding-top: 22px; }

/* ---- the summons: a parchment scroll with your move and the summary ---- */
.summons { position: relative; margin: 10px 28px 4px; }
.rod { position: relative; z-index: 1; height: 30px; margin: 0 -24px; padding: 0 33px;
  background: ${rodEnd('parchment', 'gold')} left top / 33px 30px no-repeat, ${rodEnd('parchment', 'gold', true)} right top / 33px 30px no-repeat, ${roll('parchment')} 0 3px / 3px 24px repeat-x;
  background-clip: border-box, border-box, content-box; background-origin: border-box, border-box, content-box; }
.parchment { position: relative; margin: -9px 0; padding: 34px 40px 32px; color: var(--parch-ink);
  background: ${grain(11, { a: '#ebdbb6', b: '#f7ecd2', c: '#dcc596' })} 0 0 / 72px 72px, var(--parch);
  box-shadow: inset 0 15px 0 var(--parch3), inset 0 -15px 0 var(--parch3), inset 3px 0 0 var(--parch3), inset -3px 0 0 var(--parch3), inset 6px 0 0 var(--parch2), inset -6px 0 0 var(--parch2), 6px 6px 0 rgba(0,0,0,.35); }
.parchment a { color: #5a2a8a; text-decoration-color: rgba(90,42,138,.45); }
.parchment .meta { color: var(--parch-dim); }
.parchment code { background: rgba(90,60,30,.12); }
.seal { position: absolute; top: 24px; right: 24px; width: 64px; height: 64px; display: grid; place-items: center;
  font: 700 18px/1 var(--serif); color: #fff6e0; text-shadow: 2px 2px 0 rgba(30,6,16,.45);
  background: ${sealShade()} center / 100% 100% no-repeat, var(--task);
  -webkit-mask: ${sealMask()} center / 100% 100% no-repeat; mask: ${sealMask()} center / 100% 100% no-repeat; }
.move { display: flex; gap: 18px; align-items: flex-start; padding-right: 76px; }
.move .sprite { margin-top: -6px; }
.move.ask .sprite { filter: drop-shadow(0 0 10px rgba(224, 94, 216, .55)); }
.kicker { margin: 0 0 4px; font: 700 11.5px/1.3 var(--sans); letter-spacing: .2em; text-transform: uppercase; color: #8b2c7e; }
.move.calm .kicker { color: var(--parch-dim); }
.action { margin: 0 0 8px; font: 700 27px/1.2 var(--serif); color: #23153a; }
.lead-ask { margin: 10px 0 8px; padding: 10px 14px; border-left: 3px solid #8b2c7e; background: rgba(139,44,126,.07); border-radius: 0 6px 6px 0; font: italic 18px/1.5 var(--serif); color: #2b1f3c; }
.lead-ask b { font-style: normal; font: 700 11px/1 var(--sans); letter-spacing: .14em; text-transform: uppercase; color: #8b2c7e; display: block; margin-bottom: 4px; }
.need { font-size: 17px; font-weight: 600; background: rgba(255,170,80,.18); border: 1px dashed #a46a2c; border-radius: 6px; padding: 10px 14px; }
.how { margin: 10px 0 0; color: var(--parch-dim); font-size: 14px; }
.positions { margin: 10px 0 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.positions li { font-size: 15px; }
.positions .v-changes { color: #a3123a; font-weight: 700; } .positions .v-approve { color: #136d4f; font-weight: 700; }
.scroll-rule { height: 10px; margin: 22px -8px 18px; background: ${runeRule()} center / 96px 20px repeat-x; image-rendering: pixelated; opacity: .75; filter: sepia(.4) brightness(.65); }
.summary { font-size: 16.5px; }
.summary > :first-child { margin-top: 0; }
.facts { list-style: none; margin: 16px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.facts li { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 4px; background: rgba(90,60,30,.10); box-shadow: inset 0 0 0 1px rgba(90,60,30,.22); font-size: 13.5px; color: #3a2a48; }
.facts a { font-weight: 600; }
.facts .ok { color: #136d4f; font-weight: 700; } .facts .no { color: #a3123a; font-weight: 700; }

/* ---- scroll panels ---- */
.panel { position: relative; padding: 22px 26px 24px; border-radius: 6px;
  background:
    ${corner(false, false)} 7px 7px / 18px 18px no-repeat,
    ${corner(true, false)} calc(100% - 7px) 7px / 18px 18px no-repeat,
    ${corner(false, true)} 7px calc(100% - 7px) / 18px 18px no-repeat,
    ${corner(true, true)} calc(100% - 7px) calc(100% - 7px) / 18px 18px no-repeat,
    linear-gradient(180deg, rgba(26, 20, 60, .94), rgba(16, 12, 40, .96));
  box-shadow: inset 0 0 0 1px var(--gold-soft), inset 0 0 0 5px rgba(8, 6, 26, .7), inset 0 0 0 6px rgba(217,180,90,.14), 0 14px 34px rgba(0,0,0,.35); }
.panel > h2 { display: flex; align-items: center; gap: 14px; margin: 0 0 14px; font: 600 23px/1.2 var(--serif); color: #f6e7bf; }
.panel > h2 .sub { font: 400 13.5px/1.4 var(--sans); color: var(--dim); margin-left: auto; text-align: right; }
.panel > h2 .sprite { filter: drop-shadow(0 0 8px rgba(90, 216, 240, .35)); }
.panel > :last-child { margin-bottom: 0; }
.panel p { margin: 0 0 10px; }
.empty { color: var(--dim); font-style: italic; }

/* ---- pull request ---- */
.pr { display: grid; gap: 8px; }
.pr-link { font: 600 20px/1.3 var(--serif); }
.pr-state { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.checks { display: flex; gap: 14px; flex-wrap: wrap; color: var(--dim); font-size: 14px; }
.checks .ok { color: var(--good); } .checks .no { color: var(--bad); } .checks .run { color: var(--amber); }
.problems { margin: 0; padding-left: 20px; color: #ffc6d0; }

/* ---- evidence: scrying mirrors ---- */
.ev-group + .ev-group { margin-top: 22px; }
.ev-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; margin: 0 0 8px; }
.ev-head h3 { margin: 0; font: 600 17px/1.3 var(--serif); color: #f3e3b8; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 18px; margin-top: 12px; align-items: start; }
.gallery.single { grid-template-columns: minmax(0, 1fr); }
figure.mirror { margin: 0; display: flex; flex-direction: column; border-radius: 8px; overflow: hidden;
  background: #04030f; box-shadow: 0 0 0 1px var(--gold-dim), 0 0 0 4px #0c0922, 0 0 0 5px var(--gold-soft), 0 10px 26px rgba(0,0,0,.5); }
figure.mirror:hover, figure.mirror:focus-within { box-shadow: 0 0 0 1px var(--gold), 0 0 0 4px #0c0922, 0 0 0 5px rgba(217,180,90,.5), 0 0 26px color-mix(in srgb, var(--task) 40%, transparent); }
figure.mirror .view { display: grid; place-items: center; background: radial-gradient(ellipse at 50% 40%, #121034, #04030f); }
/* Never scaled up past the capture's own size, so screenshots stay sharp. */
figure.mirror img { display: block; max-width: 100%; max-height: 640px; width: auto; height: auto; }
figure.mirror video { display: block; width: 100%; aspect-ratio: 16 / 10; max-height: 640px; background: #000; }
figure.mirror .view:focus-visible { outline: 2px solid var(--cyan); outline-offset: -4px; }
figcaption { padding: 12px 16px 14px; display: grid; gap: 4px; background: linear-gradient(180deg, #120e2e, #0d0a24); }
figcaption .cap { font: 600 16px/1.4 var(--serif); color: #fbf3dc; }
.proves { color: var(--good); font-size: 14px; }
.proves::before { content: "✦ "; color: var(--teal); }
.filelink { font-size: 12.5px; color: var(--dim); }
.kindtag { font: 700 10.5px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; color: var(--amber); }

/* lightbox (no script: :target) */
.lightbox { display: none; position: fixed; inset: 0; z-index: 10; background: rgba(4, 3, 15, .97); backdrop-filter: blur(6px); padding: 4vh 4vw; grid-template-rows: 1fr auto; gap: 12px; }
.lightbox:target { display: grid; }
.lightbox img { max-width: 100%; max-height: 82vh; margin: auto; object-fit: contain; box-shadow: 0 0 0 2px var(--gold-dim), 0 0 40px color-mix(in srgb, var(--task) 35%, transparent); background: #000; }
.lightbox p { margin: 0; text-align: center; font: 600 17px/1.4 var(--serif); color: #fbf3dc; }
.lightbox .close { position: absolute; inset: 0; z-index: -1; }
.lightbox .x { position: absolute; top: 16px; right: 22px; font: 600 15px/1 var(--sans); color: var(--ink); text-decoration: none; padding: 8px 12px; border-radius: 4px; background: var(--night3); }

/* ---- criteria ---- */
.criteria { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
.criteria li { display: grid; grid-template-columns: 28px 1fr auto; gap: 12px; align-items: start; }
.mark { width: 26px; height: 26px; display: grid; place-items: center; transform: rotate(45deg); border-radius: 4px; background: var(--night3); color: var(--dim); box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); margin-top: 1px; }
.mark span { transform: rotate(-45deg); font-size: 13px; font-weight: 700; }
.proven .mark { background: #0f3428; color: var(--good); box-shadow: 0 0 10px rgba(124, 240, 200, .35); }
.proof { font-size: 14px; margin-top: 2px; }
.thumbs { display: flex; gap: 6px; }
.thumbs img { width: 72px; height: 48px; object-fit: cover; border-radius: 3px; box-shadow: 0 0 0 1px var(--gold-dim); display: block; }

/* ---- decisions ---- */
.decisions { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.decisions li { display: grid; grid-template-columns: 74px 1fr; gap: 12px; align-items: baseline; }
.who { text-align: center; font: 700 10.5px/1 var(--sans); letter-spacing: .12em; text-transform: uppercase; padding: 5px 0; border-radius: 3px; }
.who.lead { background: #1c2c50; color: #9cc8ff; }
.who.review { background: #2a1c50; color: #cbb8ff; }
.who.you { background: #3a1240; color: #ffb0f6; }

/* ---- documents ---- */
.doc { overflow-wrap: anywhere; }
.doc > :first-child { margin-top: 0; }
.doc h3, .doc h4, .doc h5, .doc h6 { font-family: var(--serif); color: #f3e3b8; margin: 18px 0 6px; }
.table { overflow: auto; }
table { border-collapse: collapse; margin: 8px 0; font-size: 14.5px; }
th, td { border: 1px solid var(--night3); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--night2); color: #f3e3b8; font-family: var(--serif); }
blockquote { margin: 8px 0; padding: 2px 14px; border-left: 3px solid var(--gold-dim); color: var(--dim); }
details { margin: 8px 0 0; }
summary { cursor: pointer; color: var(--cyan-hi); font-weight: 600; }
summary::marker { color: var(--gold); }

/* ---- updates & questions ---- */
.log { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.log li { padding-left: 16px; position: relative; }
.log li::before { content: ""; position: absolute; left: 2px; top: 9px; width: 6px; height: 6px; transform: rotate(45deg); background: var(--gold); box-shadow: 0 0 6px rgba(217,180,90,.6); }
.qa { list-style: none; padding: 0; margin: 0; display: grid; gap: 16px; }
.qa .q { font: italic 17px/1.5 var(--serif); color: #fbf3dc; margin: 0 0 6px; }
.qa .a { padding: 10px 14px; border-radius: 6px; background: rgba(90, 216, 240, .06); box-shadow: inset 0 0 0 1px rgba(90, 216, 240, .18); }

/* ---- how it was done ---- */
.team { display: flex; flex-wrap: wrap; gap: 14px 18px; margin: 0 0 18px; padding: 0; list-style: none; }
.team li { display: grid; justify-items: center; gap: 4px; font-size: 12.5px; color: var(--dim); text-align: center; max-width: 92px; }
.steps { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 34px; }
.step-art { width: 64px; height: 64px; display: flex; align-items: center; justify-content: center; }
.step-art .sprite { display: block; }
/* Each step is a small scroll: dark vellum between two rolled rods, whose end knobs show the step's state
   (gold when done, cyan while it runs or is reviewed, dim before it starts). Pixel art, like the grove. */
.step { --end-l: ${rodEnd('vellum', 'gold')}; --end-r: ${rodEnd('vellum', 'gold', true)};
  position: relative; display: grid; grid-template-columns: 64px minmax(0, 1fr); align-items: start; gap: 14px; margin: 0 24px; padding: 32px 22px 30px;
  background: ${grain(5, { a: '#181339', b: '#100c29', c: '#211a47' })} 0 0 / 48px 48px, #130f2e;
  box-shadow: inset 0 18px 0 #0d0a24, inset 0 -18px 0 #0d0a24, inset 2px 0 0 #221a4e, inset -2px 0 0 #221a4e, inset 4px 0 0 #1a1440, inset -4px 0 0 #1a1440, 4px 4px 0 rgba(0,0,0,.3); }
.step::before, .step::after { content: ""; position: absolute; z-index: 1; left: -24px; right: -24px; height: 30px; padding: 0 33px;
  background: var(--end-l) left top / 33px 30px no-repeat, var(--end-r) right top / 33px 30px no-repeat, ${roll('vellum')} 0 3px / 3px 24px repeat-x;
  background-clip: border-box, border-box, content-box; background-origin: border-box, border-box, content-box; }
.step::before { top: -12px; }
.step::after { bottom: -12px; }
.step.working, .step.reviewing { --end-l: ${rodEnd('vellum', 'cyan')}; --end-r: ${rodEnd('vellum', 'cyan', true)}; }
.step.pending, .step.skipped { --end-l: ${rodEnd('vellum', 'dim')}; --end-r: ${rodEnd('vellum', 'dim', true)}; }
.step.pending .step-art { opacity: .55; }
.step-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.step-head b { font: 600 17px/1.3 var(--serif); color: #fbf3dc; }
.kind { font: 700 10.5px/1 var(--sans); letter-spacing: .14em; text-transform: uppercase; color: var(--task); }
.votes { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
.vote { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--night3); color: var(--dim); }
.vote.approve { background: #0f3428; color: var(--good); }
.vote.changes { background: #3a1020; color: var(--bad); }
.brief { color: var(--dim); font-size: 14px; margin: 6px 0; }
.posts { list-style: none; padding: 0; margin: 10px 0 0; display: grid; gap: 10px; }
.post { background: #0c0a22; border: 1px solid var(--night3); border-radius: 6px; padding: 8px 12px; }
.post.human { border-color: #8b2c7e; }
.post-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }

footer.wrap { margin-top: 34px; display: grid; justify-items: center; gap: 8px; color: var(--faint); font-size: 12.5px; }
.flora { display: flex; gap: 18px; align-items: flex-end; }

@media (max-width: 680px) {
  .wrap { padding: 0 14px; }
  body { font-size: 15.5px; }
  .banner { align-items: flex-start; padding-top: 22px; }
  .banner .sprite { width: 42px; height: 48px; }
  h1 { font-size: 25px; }
  .action { font-size: 22px; }
  .summons { margin: 6px 4px 2px; }
  .summons { margin: 6px 26px 2px; }
  .move .sprite { display: none; }
  nav.runes .wrap { flex-wrap: nowrap; overflow-x: auto; }
  nav.runes a { white-space: nowrap; }
  .panel > h2 { flex-wrap: wrap; font-size: 20px; }
  .panel > h2 .sub { margin-left: 0; width: 100%; text-align: left; }
  .decisions li { grid-template-columns: 1fr; gap: 4px; }
  .who { justify-self: start; padding: 5px 8px; }
  .parchment { padding: 24px 20px; }
  .move { padding-right: 0; flex-direction: column; }
  .seal { width: 48px; height: 48px; font-size: 13px; top: auto; bottom: 18px; right: 14px; }
  .panel { padding: 18px 16px; }
  .criteria li { grid-template-columns: 28px 1fr; }
  .thumbs { grid-column: 2; }
  .step { grid-template-columns: 1fr; }
  .step > .step-art { display: none; }
}
@media print {
  body { background: #fff; color: #000; padding: 0; }
  body::after, nav.runes, .lightbox { display: none; }
  .panel, .parchment { box-shadow: none; background: #fff; border: 1px solid #ccc; }
}
`;
}
