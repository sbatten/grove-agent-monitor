---
name: grove-sprites
description: 'Author, animate, palette-swap and place hi-detail pixel-art sprites for the Grove agent-monitor canvas (bioluminescent fantasy forest, modern pixel-art style). Use when adding or editing sprites, characters, flora, props, palettes, glow effects, animations or scene composition in grove-agent-monitor, or when checking that pixel art matches the Grove aesthetic.'
---

# Grove sprite system

The Grove is a **480×320** pixel-art forest clearing, in the spirit of modern,
detailed pixel-art games such as Sea of Stars and Eastward rather than strict
handheld limits.
- **Roles become classes:** hired agents appear as **character classes**.
- **Activities become places:** agents **walk between workstations**, so you can
  tell what each agent is doing from where it stands.

Everything is drawn in code: there are no image files, every pixel is crisp,
and nothing is anti-aliased. Only the light is soft.

Paths below are relative to the plugin root:

| What | Where |
| --- | --- |
| Palette, hue-shifted material ramps, robe swaps | `extensions/grove-agent-monitor/web/engine/palette.mjs` |
| **Painter** (shaded shapes → token grids, contact shadows, selective outline) | `extensions/grove-agent-monitor/web/engine/paint.mjs` |
| Sprite compiler / renderer, soft glow | `extensions/grove-agent-monitor/web/engine/sprites.mjs` |
| Halo, value noise, PRNG helpers | `extensions/grove-agent-monitor/web/engine/dither.mjs` |
| Proportional 5×7 pixel font, UI panels | `extensions/grove-agent-monitor/web/engine/font.mjs` |
| Domain model (activities, stations, roles, themes) | `extensions/grove-agent-monitor/web/model.mjs` (shared with the server) |
| Sprite definitions | `extensions/grove-agent-monitor/web/sprites/*.mjs` (registered in `sprites/index.mjs`) |
| Character classes (24×32) | `extensions/grove-agent-monitor/web/sprites/characters.mjs` |
| Workstation sprites | `extensions/grove-agent-monitor/web/sprites/stations.mjs` |
| Station positions, agent spots, path graph | `extensions/grove-agent-monitor/web/scene/layout.mjs` |
| Static world painting per theme | `extensions/grove-agent-monitor/web/scene/world.mjs` |
| Walking actors | `extensions/grove-agent-monitor/web/scene/actors.mjs` |
| Scene composition, effects, UI | `extensions/grove-agent-monitor/web/scene/grove.mjs` |
| Sprite gallery view | `extensions/grove-agent-monitor/web/scene/gallery.mjs` |
| Validator / linter | `skills/grove-sprites/scripts/validate-sprites.mjs` |

## Art direction

1. **Crisp pixels, modern detail.**
   - Characters are **24×32**, props are roughly 10–56 px, and the scene is
     480×320 with integer coordinates.
   - The page scales by whole **device** pixels (`fit()` in `app.mjs`), so the
     art stays sharp in narrow side panels. It typically shows 2–4 device
     pixels per art pixel.
   - Never rotate, blur or smooth sprites.
2. **Forest plus bioluminescence.**
   - Base tones are deep teal-greens and indigo shadows.
   - Luminous accents are **cyan, violet, teal and magenta**.
   - Warm `amber` and `gold` are rare accents for trims, sparks and eyes.
   - `ember` is reserved for errors.
3. **Lighting.**
   - The moon is upper-right, so light comes from the upper right, toward the viewer.
   - The painter shades every form from that direction.
   - Moonlit silhouettes get a `rim`/`rimHi` edge.
4. **Hue-shifted ramps.**
   - Every material has a 5-step ramp from `makeRamp()`: shadows drift toward
     blue-violet and highlights toward warm yellow.
   - Shade by stepping along a ramp. Never darken with black or lower opacity.
5. **Selective outlines.**
   - `finish()` adds a 1px outward outline. It is the dark `outline` colour on
     the shadow side and a dark tone of the material on the lit side.
   - Overlapping parts get **contact shadows**, so heads, arms and props separate cleanly.
   - Glowing parts (orbs, lenses, runes) pass `casts: false` and are often unoutlined.
6. **Soft light over crisp pixels.**
   - Gradients in the sky, fog, halos and glow are smooth.
   - Sprite pixels stay hard-edged.
   - Glow is additive and should be sparse.
7. **Readability first.**
   - A class must read by silhouette at 1×.
   - Leave at least 4px between agents and station props.
   - At least ~65% of the frame stays in dark ramps, so the glow means something.

## Palette

`PALETTE` (`palette.mjs`) is full 24-bit colour, referenced **by name**. The
gallery's first panel shows every swatch.

- **Scenery:**
  - sky: `sky0-5`, `dusk0-5`, `dawn0-5`
  - `star`, `moon*`
  - `hill0-2`, `farTree0-2`, `fog`
  - `tree*`, `rim*`
  - `grass0-5`, `dirt0-4`, `bark0-4`, `stone0-5`, `water*`
- **Glows:** `cyan0-3`, `violet0-3`, `teal0-3`, `magenta0-2`, `ember0-2`, `amber`,
  `amber2`, `white`. Higher numbers are hotter, whiter cores.
- **Material ramps** (`<name>0` darkest … `<name>4` highlight):
  - `skin`, `hair`, `ginger`, `beard`
  - `wood`, `leather`, `metal`, `gold`, `cloth`, `rock`, `leaf`, `straw`, `pants`
  - `night`, `glass`, `brick`, `coal`, `fire`
- **Robe ramps:** `robe_<violet|azure|teal|moss|rose|dusk>0-4`, exposed to
  sprites through the slots `robe0..robe4`.
- **Tent ramps:** `tent_<task colour>0-4`, each task colour dulled into dyed
  cloth. They're exposed through the slots `tent0..tent4`, plus `flag` for the
  task colour itself (`TENTS` in `palette.mjs`).
- **UI:** `outline`, `ink`, `shadow`, `uiBg`, `uiBg2`, `uiFrame`, `uiFrameHi`,
  `uiText`, `uiTextDim`.

**Adding colours:**
- **A material:** add its base colour to `MATERIALS`, and you get a 5-step ramp.
- **A one-off:** add it to `RAW`.

Prefer an existing ramp. The validator warns above ~48 colours per sprite variant.

## Painting a sprite

Most sprites are **painted procedurally** with the painter, which returns a
token grid for `defineSprite`:

```js
import { defineSprite } from '../engine/sprites.mjs';
import { painter } from '../engine/paint.mjs';

function lantern(on) {
  const p = painter(16, 24);                     // w, h
  p.rect(7, 2, 2, 20, 'wood');                    // ramp material: shaded per pixel (cylinder)
  p.ellipse(8, 14, 5, 6, 'metal', { shade: 'sphere' });
  p.ellipse(8, 14, 3, 4, on ? 'glassOn' : 'glassOff', { shade: 'flat', casts: false }); // flat token (slot)
  p.px([[8, 13]], 'white', { outline: false });   // detail pixels
  return p.finish();                              // contact shadows + selective outline → token grid
}

defineSprite({
  id: 'wisp-lantern',
  description: 'Hanging lantern with a captive wisp.',
  tags: ['prop', 'glow'],
  size: [16, 24],
  anchor: [8, 23],                                // ground-contact pixel; y-sorting uses anchor y
  slots: { glassOn: 'teal1', glassOff: 'rock1' }, // re-pointable tokens
  variants: { violet: { glassOn: 'violet1' } },
  emissiveTokens: ['glassOn'],                    // tokens that feed the glow layer
  frames: { on: lantern(true), off: lantern(false) },
  anims: { idle: { frames: ['on', 'off'], ticks: [50, 6] } },
});
```

Then import the module from `web/sprites/index.mjs` if it's new.

### Painter reference (`engine/paint.mjs`)

| Call | Draws |
| --- | --- |
| `ellipse(cx, cy, rx, ry, mat, opts)` / `circle(cx, cy, r, mat, opts)` | Ellipse (sphere shading by default). |
| `rect(x, y, w, h, mat, opts)` | Pixels with centres in `[x, x+w) × [y, y+h)` (cylinder shading). |
| `poly(points, mat, opts)` | Any polygon (cylinder shading). |
| `stroke(x0, y0, x1, y1, width, mat, opts)` | Thick capsule line: limbs, staffs, branches. |
| `fill(inside, mat, opts, box)` | Custom predicate `(x, y) => boolean` on pixel centres. |
| `px(points, token, { outline })` | Single detail pixels. They never cast contact shadows. |
| `erase(inside)` | Cut holes (notches, gaps). |
| `finish({ outline, separate })` | Contact shadows and outward selective outline. Returns the token grid. |

**Materials:**
- A **ramp name** (`'robe'`, `'skin'`, `'metal'`…) is shaded per pixel.
- Any other string (`'gold3'`, `'ink'`, a slot like `'rune'`) is a **flat token**.
- Pass `{ n: 4 }` to shade with a *slot ramp* (e.g. `'cap'` → `cap0..cap3`), so
  variants can recolour shaded glows.

**Options:**
- `shade`: `'sphere' | 'cyl' | 'vert' | 'flat'`. With `'flat'`, pass `level` too.
- `bias`: shift by ramp steps; use −1 for the far, shadowed side.
- `contrast`.
- `folds`: columns darkened by one step, for cloth.
- `casts` / `receives`: contact-shadow control.
- `outline: false` to skip the outline.

Draw **back to front**: back arm → body → head → front arm → props. Each part
drawn later is "in front", and `finish()` darkens the back part where they touch.

### ASCII grids (small UI sprites)

Tiny sprites like the status `bubble` can still be palette-indexed ASCII:
- `key` maps each character to a colour or slot, and `'.'` is transparent.
- Rows must be exactly `size[0]` wide.

**Frame ops** derive frames from a base grid:

| Op | Effect |
| --- | --- |
| `{ shift: [fromRow, toRow, dy] }` | Moves a row band |
| `{ patch: [[x, y, ch], …] }` | Sets pixels |
| `{ swap: { a: 'b' } }` | Replaces characters |
| `{ rows: { 15: '…' } }` | Replaces whole rows |
| `{ mirror: true }` | Flips horizontally |

For anything larger, paint frames procedurally from pose parameters instead of
using ops.

### Slots and variants

- **Slots** are named tokens that variants re-point. Examples:
  - `robe0..4` → a robe ramp;
  - `orb0..3` → `cyan` or `violet`;
  - `rune` / `runeHi`;
  - station glows such as `flame0..3` and `mglass0..4`.
- **Characters:** variant = robe name from `ROBES` (`violet`, `azure`, `teal`,
  `moss`, `rose`, `dusk`). Class glow colours stay fixed per class.
- **Stations:** `idle` (dim) and `active` (glowing). Some stations add more:
  `dummy` has `hit` and `fail`, and `council-stone` has `decided`.

### Emissive glow

Tokens listed in `emissiveTokens` (or characters in `emissive` for ASCII
sprites) get a precomputed **soft bloom**. It has radius 5 and a smooth falloff,
and is composited additively after the foreground.

Control it per draw with `glowStrength` (0–1), which is how pulses and flickers
are done. For free-floating light, use `grove.addGlow(x, y, r, color, strength)`
or `halo(r, color)` (a smooth radial gradient).

### Animation timing

Ticks run at 60 per second. `ticks` is one number or a per-frame array.

| Motion | Ticks/frame |
| --- | --- |
| Idle breathing | 40–60 |
| Blink | ~6, every 2–4 s |
| Walk (4 frames) | 7 |
| Working loop | 8–12 |
| Talk nods | 10–16 |

The scene desynchronizes instances by offsetting `tick` by a hash of the agent id.

### Drawing

```js
drawSprite(ctx, id, x, y, { anim, tick, variant, flip, glow, glowStrength });
```

`(x, y)` is where the **anchor** lands. World objects are y-sorted by anchor y.
Use `drawText` (proportional 5×7 font, 7px tall) and `drawPanel` (framed, with
cut corners) for UI.

## Character classes (`sprites/characters.mjs`)

An agent's **role** picks its class. Each is painted at **24×32** with anchor
`[12, 31]`, facing right, and must read by silhouette alone:

| Role | Class | Silhouette cue | Glow |
| --- | --- | --- | --- |
| orchestrator | `archmage` | tall banded hat, long white beard, great staff | violet orb |
| planner | `scribe` | cap with quill, round gold spectacles, open book at chest | violet runes |
| implementer | `artificer` | spiky ginger hair, goggles, leather apron, hammer | cyan lenses, amber sparks |
| reviewer | `seer` | tall veiled hood, third-eye gem, orb over the palm | magenta gem, violet orb |
| tester | `warden` | antlered helm, breastplate, rune shield | teal rune |
| researcher | `scout` | leaf hood, pointed ear, ragged cloak, wisp lantern | teal wisp |
| generalist, engineer | `mage` | pointed hood with glowing eyes, staff | cyan orb |

Each class is a **builder** `(pose) => tokenGrid`. Every builder shares these helpers:
- `feet`, `legs`, `garment` (body and robe, with trim and sash);
- `backArm`, `frontArm`, `face`, `eyes`;
- `staff`, `sparkles`.

`defineClass()` renders the standard animation set from poses:

| Anim | Used when | Pose |
| --- | --- | --- |
| `idle` | at the waiting lantern; listening at council | `{}`, `{ bob }`, blink |
| `walk` | moving between stations | `{ walk: 0..3 }` (stride, hem sway, bob) |
| `work` | at a workstation or forum huddle | `{ act: 0..3 }` (hammer swing, page turn, orb flare, shield flash, lantern sway) |
| `talk` | current speaker in a council or huddle | head nods |
| `sit` | resting at camp | lowered body, feet forward |
| `error` | the agent has an error | slump, eyes off, props dim |

**To add a class:**
1. Add it to `ROLES` in `model.mjs`.
2. Write a builder using the shared helpers. Use `garment(..., { mat: 'robe' })`
   so the robe palette swap applies.
3. Call `defineClass(id, description, builder, { slots, emissiveTokens })`.

## Workstations and layout (`scene/layout.mjs`)

```
  back row    PLANNING        RESEARCH (tree)     REVIEW
  ─────────── upper path y=198 ────────────────────────────
  middle row  IMPLEMENTING    COUNCIL (moonwell)  CODE REVIEW
  ─────────── lower path y=266 ───────────────────────────→ road (hire / dismiss)
  front row   TESTING         CAMP                NEEDS YOU
```

| Activity | Station | Sprite(s) | Active effect |
| --- | --- | --- | --- |
| `planning` | planning | `star-table` | constellations light, cyan motes |
| `plan-review` | plan-review | `lectern` | runes glow, violet glyphs |
| `implementing` | implementing | `forge` | magic fire, cyan/violet sparks |
| `code-review` | code-review | `mirror` | teal glass and glints |
| `testing` | testing | `dummy` ×2 | target flashes `hit` (or `fail` on error) |
| `research` | research | `bookshelf` + floating `tome` | glowing spines |
| `council` (via `convene`) | council | 6 × `council-stone` + moonwell | violet runes; teal `decided` flash |
| `waiting` | waiting ("NEEDS YOU") | `lantern-post` | magenta beacon |
| `idle`, `done` | camp | `campfire` + `log`s | always lit; agents `sit` |

Each `STATION_LAYOUT` entry has these fields:
- `x`, `y`: the station center.
- `node`: the path-graph node agents walk to.
- `label`: where the label is drawn.
- `props`: the sprites to draw.
- `spots`: agent feet positions. They fill in order; any extras queue beside the last spot.

Rules:
- **Walking.** Agents follow `NODES`/`EDGES` (Dijkstra in `route()`), then
  step off the path to their spot.
  - New hires enter from the `gate` node off the right edge, and dismissed
    agents leave the same way.
  - Paths are painted from `PATH_EDGES`, so the dirt trails *are* the graph.
- **Adding a station:**
  1. Add it to `STATIONS`, `STATION_LABELS`, and (if needed) `ACTIVITY_STATION` and `ACTIVITIES` in `model.mjs`.
  2. Give it a `STATION_LAYOUT` entry whose node connects to the graph.
  3. Add its `idle`/`active` sprite in `stations.mjs`.
  4. Add an active effect in `Grove.queueStation`.
- **Readability.**
  - Keep at least 4px between a spot and any station sprite so silhouettes don't merge. Characters are 24px wide, so space spots at least ~26px apart.
  - Middle-row labels sit *below* their stations, and back-row labels sit above them.
  - An agent's name and tooltip appear only once it's clicked (selected); hover just highlights it, so details don't flicker past as agents walk. Never add always-on text near agents.
- **Hidden stations.** `configureScene({ stations: { testing: false } })` hides
  an unused station. Occupied stations always show.

## Chief-of-Staff process agents

Most agents on screen come from the **Grove process**, not from manual canvas
actions. `GroveProcess.liveView()` in `lib/process/integration.mjs` reads the
shared board, which every engineer and reviewer session writes to. Each
**session** is one sprite for the life of its task: the Chief, each task's
engineer (id `grove-engineer-<task>`), and each of its reviewers (one per
specialty per task, id `grove-<task>-reviewer-<specialty>`). Reviewers stand in
their huddle while they hold a ticket (`dispatched` or `running`) and rest in
their team's tent between rounds. One canvas shows every session's work. The
canvas is **monitor-only**: it never offers approvals or other decisions,
which happen in the Chief of Staff's chat (or its inbox).

| Process role | Class | Activity → station | Robe |
| --- | --- | --- | --- |
| Chief of Staff | `archmage` | `waiting` ("Needs you") while a decision waits in chat; `council` while it's taking a turn; otherwise camp (available) | violet |
| engineer | `mage`, **shapeshifting** into each station's class (below) | follows its current step: `plan` → planning, `research` → research, `execute` (and Grove's PR steps) → implementing, `verify` → testing; choosing the next steps → planning. A phase skill it loads mid-step (`lead.phase` on the task) moves it to that kind's station until the next step or skill. While its step is reviewed it joins the huddle (below). Camp (its tent) while the task waits on the human, is on hold, or ships | dusk |
| reviewer of an `execute` or `verify` step | `seer` | **code-review**, in a per-step huddle with the engineer | security rose · tests teal · code violet · architecture azure · accuracy moss · others dusk |
| reviewer of a `plan` or `research` step | `seer` | **plan-review** (labelled REVIEW), in a per-step huddle with the engineer | same as above |
| whoever is blocked on the human (the engineer via `grove_blocked`, or a reviewer that ended with `BLOCKED:`) | its class | `waiting`: at the NEEDS YOU lantern beside the Chief, until the human unblocks the task | its robe |

Reviewer agents carry `verdict` (`approve` / `changes`, their last on the task),
which the tent tooltip shows next to their names.

**Shapeshifting.** A role with `shapeshifter: true` in `ROLES` (the engineer)
is a mage in its own form. Once it stands at a station listed in
`STATION_FORMS` (`model.mjs`), it takes the form of the class that works there:
`scribe` at planning, `scout` at research, `artificer` at the forge, `warden`
at the testing dummies. It walks, joins review huddles, sits at council or
camp, and waits at the lantern as a mage.
- **State:** `Actor.form` is the sprite shown. `Actor.updateForm()` (called by
  `Cast.update`) starts a `morph` `{ from, to, t }` when `targetForm` changes,
  which takes `MORPH_TICKS` (40). If the target changes mid-morph, it restarts
  from whichever form is showing more. `Cast.settle()` and first placement skip
  the animation.
- **Drawing** (`Grove.drawBody`): a ring of light (white, violet and cyan
  pixels with a soft violet/cyan glow) rises from the feet to the head. Rows
  below the ring are drawn in the new form and rows above in the old (canvas
  clips on whole pixel rows, so nothing blurs). `spawnStationFx` throws a burst
  of motes as it starts and motes off the ring as it rises. The robe colour
  carries over, so it's still recognisably the same agent.
- **Tooltip:** "LARK · ENGINEER IN ARTIFICER FORM".
- The demo party's Lark is an engineer that moves between stations.

### Several tasks at once

- **Task colour:** `taskColor(taskId)` in `integration.mjs` cycles through
  `TASK_COLORS` (amber, cyan1, magenta1, teal1, violet2, ember1, waterHi,
  mossHi). The same colour is used for:
  - the agent's **pennant**, drawn by `Grove.drawPennant` *behind* the sprite on
    a pole at the agent's back;
  - the **huddle banner**, drawn by `Grove.drawHuddleTags`, which shows the task
    id and round (`T3 R2`) with a colour underline and "discussion dots";
  - the team's **tent** at camp (sprite `tent`, one variant per task colour);
  - the task's **book** over the Chief while it waits on the human (sprite
    `book`, same slots and variants as the tent);
  - the matching chip in the task strip.
  `TASK_COLORS` lives in `web/model.mjs`, shared by the server and the page.
- **Tents:** `Cast.syncTents` pitches a tent for each task with agents in the
  grove, at the lowest free index of `tentSlot(i)` (`scene/layout.mjs`), so
  spots nearest the fire are used first. The tent sprite is small (22×18, anchor [10,17]) so
  camp holds many.
  - **Resting:** idle team members (`camp` activity with a `taskId`) walk to the
    tent's door (`Actor.goToTent`) and set `inside`.
  - **Inside means invisible:** inside actors aren't drawn, hit-tested or
    huddled.
  - **Pitch and strike:** `raised` animates 0→1 over 36 ticks while the tent
    is pitched, revealed bottom-up with sparkles in the task colour. It strikes
    once the team has gone and no one is inside.
  - **Doorway:** the `lit` anim shows a warm doorway while anyone is inside;
    `empty` shows a dark one. A **shelved** task's tent (`process.tasks[].stage
    === 'shelved'`) stays dark and `Grove.drawSleep` floats two 4×4 violet z's
    up from it in turn; its tooltip says what it was waiting for.
  - **Hover and click:** `Grove.hitTest` returns `tent:<taskId>`, and
    `drawTentTooltip` lists the task's name and id (in its colour, above the
    title), its stage, and who's inside (reviewers with their last verdict)
    and out. Agent tooltips likewise start with their task's name and id
    (`agent.taskName`). The
    page opens the task view when a tent is clicked.
  - **No limit:** the first `TENT_SPACIOUS` (10) spots don't touch (`TENT_GRID`,
    in two rows on either side of the fire). The next ones fill `TENT_GAPS`, then
    further laps nudge every spot along a golden-angle spiral. Every spot is
    unique, clamped to `TENT_BANDS` and clear of the fire seats. Overlapping
    tents are drawn and hit-tested front-most (largest y) first.
- **Inbox books:** `Grove.inboxBooks` floats one `book` (14×16, anchor [7,15],
  anim `glow` pulses the rune) per task in `process.inbox.items` over the
  Chief (`CHIEF_ID`, `grove-chief`), fanned 11px apart and bobbing, three at
  most with a `+N` count. They draw in the y-sorted pass just in front of the
  Chief, and replace its `waiting` bubble.
  - **Click:** `Grove.hitTest` returns `CHIEF_ID` for the books too. Clicking
    opens the inbox (`web/inbox.mjs`): a near full-screen modal menu over the
    dimmed grove (page UI rather than canvas UI, because it has buttons), with
    one row per task (book · details · actions). `draw({ quietId })` suppresses the
    Chief's canvas tooltip while it's open.
  - **In the inbox,** each row's report link is the same `book` sprite drawn
    to a 14×16 canvas and scaled ×2 with `image-rendering: pixelated`.
- **In task reports:** the HTML report (`lib/process/report.mjs`) is rendered
  in Node, so it can't use a canvas. `web/engine/svg.mjs` turns registered
  sprites into SVG `<symbol>`s (one `<path>` per colour, `shape-rendering:
  crispEdges`) and `SpriteSheet.use(id, { anim, frame, variant, scale })`
  places them. Scale by whole numbers only. The report's theme
  (`lib/process/report-theme.mjs`) is a higher-resolution take on the grove:
  the same palette, pixel treeline and gilded pixel corners, but smooth text.
- **Huddles:** `HUDDLES` in `scene/layout.mjs` gives each review station
  several centres and per-member offsets.
  - **Placement:** `Cast.sync` gives each review group (`T3:S1`, task and step) its own
    centre, ordered by task number so huddles never swap places. The centres
    flank the lectern and the mirror so the props stay visible.
  - **Talking:** `Grove.isHuddleSpeaker` rotates the `talk` animation through
    each huddle's members.
- **Read-only views** in `web/tasks.mjs`:
  - `TaskStrip` shows one chip per task.
  - `ForumView` is a separate screen with round votes, posts and the current
    plan or implementation, but no actions. Escape returns to the scene.
- **Adding a reviewer persona:**
  1. Add its focus to `REVIEWER_FOCUS` (and `PERSONA_REVIEWERS`) in `lib/process/engine.mjs`.
  2. Give it a robe in `SPECIALTY_ROBE` (`integration.mjs` and `report.mjs`).
  3. Add `agents/grove-reviewer-<name>.agent.md` with its `model:`.
- **The engineer's stations** come from `KIND_ACTIVITY` in `integration.mjs`
  and `KIND_SKILLS` in `engine.mjs`; the report draws each step with the same
  station sprite (`KIND_STATION` in `report.mjs`).

## Scene composition (`scene/grove.mjs`)

Layers, back to front:

1. `sky` (static per theme: smooth gradient + shaded moon or crescent)
2. stars, aurora (night: full, dusk: faint, dawn: none), moon bloom
3. `land` (static, textured with value noise: three mountain layers, two
   treelines, mottled grass with blades, dirt paths with pebbles, the ancient
   tree with bark ridges and leaf clusters, the moonwell)
4. horizon fog
5. moonwell water
6. **y-sorted world**: flora, station props, agents, owl
7. particles and fireflies
8. `fore` (static: thin framing trunks, corner canopy, bottom grass)
9. additive glow layer
10. UI: station labels, bubbles, focus name tag, HUD, tooltip

Static layers are rebuilt per **theme** (`night` / `dusk` / `dawn`, set in
`THEME_LOOK` in `world.mjs`) with the same seed, so geometry never shifts.

**Calm by default.** The background stays dim and sparse: a few mushrooms at
the edges, about 22 fireflies, and no ambient particle spam. Motion and glow
should mostly come from **occupied stations and agents**, because that is the
information. Empty stations dim, and their labels fade to `stone2`.

### Agent visuals

| Condition | Anim | Bubble | Other |
| --- | --- | --- | --- |
| walking | `walk` | — | faces direction of travel |
| at a work station | `work` | — | station lights up |
| at council, speaking | `talk` | `…` | speaker rotates every 2.5 s |
| at council, listening | `idle` | — | |
| waiting on user | `idle` | `?` | lantern beacon pulses |
| `error` set | `error` | `!` | red flicker, ember smoke; testing dummies show `fail` |
| done (first 10 s) | `sit` | `✓` | at camp |
| idle | `sit` | — | at camp (team members go into their team's tent instead) |

## Workflow

1. **Edit** a sprite in `web/sprites/*.mjs`, or add a new module and import it from `sprites/index.mjs`.
2. **Validate:** `node skills/grove-sprites/scripts/validate-sprites.mjs`.
   - Add `--id <sprite>` to check one sprite.
   - It reports malformed rows, unmapped chars or tokens, bad slots/variants,
     anchors out of bounds, unused keys, and variants over ~48 colours.
   - It exits non-zero on errors.
3. **Look at it.** Open the `grove-agent-monitor` canvas with `open_canvas`
   and input `{}`, then:
   - `invoke_canvas_action` → `summonDemo` to fill every station; the party
     keeps hiring, walking, convening and resolving every ~4.5 s.
   - `invoke_canvas_action` → `setView` `{ "view": "gallery" }` to see every
     animation and variant live.
   - `invoke_canvas_action` → `snapshot` `{ "scale": 2 }` to get a PNG of what
     the user sees. Snapshots need the canvas to be visible.
   - Reload the canvas page (or reopen the canvas) after editing web files.
     Extension code changes (`extension.mjs`, `lib/`) need `extensions_reload`.
4. **Place** it via `scene/layout.mjs` or `scene/grove.mjs`, `setView` →
   `scene`, and `snapshot` again. Check every theme with `configureScene`.
5. **Critique** the snapshot against the checklist below before you finish.

## Aesthetic checklist

- [ ] Only palette names, no raw hex in sprites. Prefer existing ramps (≤ ~48 colours per variant).
- [ ] Integer positions and whole-device-pixel scaling only. No smoothing, rotation or sub-pixel motion.
- [ ] Silhouette reads at 1×: test by squinting at the gallery.
- [ ] Light comes from the upper-right, and shadows hue-shift toward blue/violet along ramps (never black or opacity).
- [ ] Selective outlines: dark on the shadow side, material-toned on the lit side. Glowing parts are mostly unoutlined.
- [ ] Overlapping parts are separated by contact shadows, not extra outlines.
- [ ] Glow is purposeful and sparse: cyan/violet/teal/magenta, ember only for errors.
- [ ] Soft gradients only in light (sky, fog, halos, glow). Sprite pixels stay hard.
- [ ] Detail serves readability: 24×32 characters show face, costume and prop, but no noisy single-pixel speckle.
- [ ] The background stays calm and darker than the agents and stations.
