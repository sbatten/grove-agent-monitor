// Spatial layout of the grove (480×320): where each workstation sits, where agents stand at it,
// and the path graph agents walk along between stations.
//
//   back row    PLANNING        RESEARCH (tree)     PLAN REVIEW
//   ─────────── upper path y=198 ─────────────────────────────
//   middle row  IMPLEMENTING    COUNCIL (moonwell)  CODE REVIEW
//   ─────────── lower path y=266 ────────────────────────────→ road out (hire / dismiss)
//   front row   TESTING         CAMP                NEEDS YOU

export const W = 480;
export const H = 320;

export const COUNCIL = { x: 240, y: 230, rx: 62, ry: 18 };

const councilSeats = Array.from({ length: 6 }, (_, i) => {
  const a = ((30 + i * 60) * Math.PI) / 180;
  return [Math.round(COUNCIL.x + Math.cos(a) * COUNCIL.rx), Math.round(COUNCIL.y + Math.sin(a) * COUNCIL.ry) + 6];
}).sort((a, b) => b[1] - a[1]);

export const COUNCIL_STONES = Array.from({ length: 6 }, (_, i) => {
  const a = ((i * 60) * Math.PI) / 180;
  return [Math.round(COUNCIL.x + Math.cos(a) * (COUNCIL.rx - 6)), Math.round(COUNCIL.y + Math.sin(a) * (COUNCIL.ry - 2)) + 4];
});

// spots: where agents stand (feet). The first spots fill first; extras queue beside the last spot.
export const STATION_LAYOUT = {
  planning: {
    x: 96, y: 176, node: 'planning', label: [96, 138],
    props: [{ sprite: 'star-table', x: 96, y: 178 }],
    spots: [[58, 184], [134, 184], [82, 196], [110, 196]],
  },
  research: {
    x: 240, y: 172, node: 'B', label: [240, 108],
    props: [{ sprite: 'bookshelf', x: 240, y: 174 }],
    spots: [[204, 184], [276, 184], [226, 194], [254, 194]],
  },
  'plan-review': {
    x: 384, y: 176, node: 'plan-review', label: [384, 116],
    props: [{ sprite: 'lectern', x: 384, y: 178 }],
    spots: [[354, 186], [414, 186], [384, 194]],
  },
  implementing: {
    x: 84, y: 236, node: 'L', label: [84, 256],
    props: [{ sprite: 'forge', x: 80, y: 238 }],
    spots: [[128, 240], [36, 244], [116, 250], [48, 252]],
  },
  council: {
    x: COUNCIL.x, y: COUNCIL.y, node: 'K', label: [240, 256],
    props: [],
    spots: councilSeats,
  },
  'code-review': {
    x: 396, y: 236, node: 'R', label: [396, 256],
    props: [{ sprite: 'mirror', x: 396, y: 240 }],
    spots: [[366, 242], [426, 242], [380, 252], [412, 252]],
  },
  testing: {
    x: 82, y: 296, node: 'L', label: [82, 308],
    props: [{ sprite: 'dummy', x: 56, y: 296 }, { sprite: 'dummy', x: 108, y: 296 }],
    spots: [[82, 300], [32, 300], [58, 312]],
  },
  camp: {
    x: 240, y: 296, node: 'E', label: [240, 309],
    props: [{ sprite: 'campfire', x: 240, y: 296 }, { sprite: 'log', x: 204, y: 303 }, { sprite: 'log', x: 276, y: 303 }],
    spots: [[196, 302], [284, 302], [214, 302], [266, 302], [224, 314], [256, 314]],
    sit: true,
  },
  waiting: {
    x: 400, y: 300, node: 'R', label: [408, 308],
    props: [{ sprite: 'lantern-post', x: 392, y: 300 }],
    spots: [[378, 304], [432, 304], [406, 312]],
  },
};

// Team tents flank the campfire in two rows: two columns west of the fire seats, three east of them, so ten
// pitch without touching (nearest the fire first). Beyond ten, tents fill the gaps between those, then
// keep packing in, so there's no limit, just a crowded camp. `x, y` is the doorway at ground level (the
// tent sprite's anchor); `node` is the path node members walk from.
const TENT_GRID = [
  [170, 288], [309, 288], [170, 306], [309, 306], [148, 288],
  [331, 288], [148, 306], [331, 306], [353, 288], [353, 306],
];
const TENT_GAPS = [[159, 297], [320, 297], [342, 297], [159, 315], [320, 315], [342, 315]];
// Doorway x stays within each side's band, clear of the fire seats and the neighbouring stations.
const TENT_BANDS = { west: [131, 172], east: [307, 360] };
export const TENT_SPACIOUS = TENT_GRID.length;

export function tentSlot(i) {
  let x;
  let y;
  if (i < TENT_GRID.length) [x, y] = TENT_GRID[i];
  else if (i < TENT_GRID.length + TENT_GAPS.length) [x, y] = TENT_GAPS[i - TENT_GRID.length];
  else {
    // Further laps over every spot, each nudged along a golden-angle spiral so tents don't stack exactly.
    const all = [...TENT_GRID, ...TENT_GAPS];
    const k = i - all.length;
    const lap = 1 + Math.floor(k / all.length);
    [x, y] = all[k % all.length];
    const a = lap * 2.399963;
    const r = 3 + Math.min(lap, 4);
    x += Math.round(Math.cos(a) * r);
    y += Math.round(Math.sin(a) * r * 0.6);
    const [lo, hi] = x < 240 ? TENT_BANDS.west : TENT_BANDS.east;
    x = Math.min(hi, Math.max(lo, x));
    y = Math.min(318, Math.max(283, y));
  }
  return { x, y, node: x < 240 ? 'D' : 'F' };
}

// Forum huddles: at review stations each group (one task's forum) stands together around its own centre.
// Centres fill in order; offsets are per member (feet positions relative to the centre).
export const HUDDLES = {
  'plan-review': {
    centers: [[334, 190], [436, 190], [384, 202]],
    offsets: [[-13, -3], [13, -3], [-6, 6], [7, 6], [0, 12]],
  },
  'code-review': {
    centers: [[346, 250], [446, 250], [396, 264]],
    offsets: [[-13, -3], [13, -3], [-6, 6], [7, 6], [0, 12]],
  },
};

export function huddleSpot(station, groupIndex, memberIndex) {
  const h = HUDDLES[station];
  const c = h.centers[groupIndex % h.centers.length];
  const lap = Math.floor(groupIndex / h.centers.length);
  const [ox, oy] = h.offsets[memberIndex % h.offsets.length];
  const extra = Math.floor(memberIndex / h.offsets.length);
  return [c[0] + ox + extra * 6, c[1] + oy + lap * 10 + extra * 6];
}

// Walkable graph. Coordinates are agent feet positions.
export const NODES = {
  A: [156, 198], B: [240, 198], C: [324, 198],
  D: [156, 266], E: [240, 266], F: [324, 266],
  K: [240, 232],
  L: [88, 266], R: [392, 266],
  planning: [96, 198], 'plan-review': [384, 198],
  gate: [504, 266],
};

export const EDGES = [
  ['A', 'B'], ['B', 'C'], ['D', 'E'], ['E', 'F'],
  ['A', 'D'], ['C', 'F'], ['B', 'K'], ['K', 'E'],
  ['D', 'L'], ['F', 'R'], ['R', 'gate'],
  ['A', 'planning'], ['C', 'plan-review'],
];

// Edges painted as dirt paths (the gate road runs off-screen to the right).
export const PATH_EDGES = EDGES;

const adjacency = (() => {
  const adj = Object.fromEntries(Object.keys(NODES).map((k) => [k, []]));
  for (const [a, b] of EDGES) {
    const d = Math.hypot(NODES[a][0] - NODES[b][0], NODES[a][1] - NODES[b][1]);
    adj[a].push([b, d]);
    adj[b].push([a, d]);
  }
  return adj;
})();

export function nearestNode(x, y) {
  let best = null;
  let bd = Infinity;
  for (const [id, [nx, ny]] of Object.entries(NODES)) {
    if (id === 'gate') continue;
    const d = Math.hypot(nx - x, ny - y);
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

// Dijkstra over the tiny graph; returns node ids from `from` to `to` inclusive.
export function route(from, to) {
  const dist = { [from]: 0 };
  const prev = {};
  const open = new Set([from]);
  while (open.size) {
    let u = null;
    for (const n of open) if (u === null || dist[n] < dist[u]) u = n;
    open.delete(u);
    if (u === to) break;
    for (const [v, w] of adjacency[u]) {
      const nd = dist[u] + w;
      if (nd < (dist[v] ?? Infinity)) { dist[v] = nd; prev[v] = u; open.add(v); }
    }
  }
  if (!(to in dist)) return [from];
  const path = [to];
  while (path[0] !== from) path.unshift(prev[path[0]]);
  return path;
}

// Full waypoint list from a position to a target spot via the path network.
export function planWalk(x, y, station, spot, end = STATION_LAYOUT[station].node) {
  const start = nearestNode(x, y);
  const pts = route(start, end).map((id) => NODES[id]);
  // Skip the first node when we're already past it toward the second.
  if (pts.length > 1) {
    const [ax, ay] = pts[0];
    const [bx, by] = pts[1];
    if (Math.hypot(bx - x, by - y) < Math.hypot(bx - ax, by - ay)) pts.shift();
  }
  return [...pts, spot];
}

export function gateWalk(x, y) {
  const pts = route(nearestNode(x, y), 'gate').map((id) => NODES[id]);
  return [...pts, [NODES.gate[0] + 8, NODES.gate[1]]];
}

export function spotFor(station, index) {
  const spots = STATION_LAYOUT[station].spots;
  if (index < spots.length) return spots[index];
  const [lx, ly] = spots[spots.length - 1];
  const k = index - spots.length + 1;
  return [lx + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 14, ly + 6];
}
