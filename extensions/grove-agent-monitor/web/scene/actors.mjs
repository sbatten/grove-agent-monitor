// Agent actors: turn logical agent state into on-screen walkers that move between stations.
// Task teams pitch a tent at camp: idle members walk into their task's tent and aren't drawn while inside.
import { ACTIVITY_STATION, ROLES, STATION_FORMS } from '../model.mjs';
import { STATION_LAYOUT, NODES, HUDDLES, planWalk, gateWalk, spotFor, huddleSpot, tentSlot } from './layout.mjs';

// Group order is stable by task number so huddles don't swap places as forums open and close.
function huddleAssignments(station, list) {
  const key = (a) => a.group ?? `~${a.id}`;
  const order = [...new Set(list.map(key))].sort((x, y) => (Number(x.replace(/\D/g, '')) || 1e9) - (Number(y.replace(/\D/g, '')) || 1e9) || x.localeCompare(y));
  const seen = new Map();
  return list.map((a) => {
    const g = order.indexOf(key(a));
    const m = seen.get(g) ?? 0;
    seen.set(g, m + 1);
    return huddleSpot(station, g, m);
  });
}

const SPEED = 1.3; // px per tick
const PITCH_TICKS = 36; // ticks to raise (or strike) a tent
export const MORPH_TICKS = 40; // ticks for a shapeshifter to change form

export class Actor {
  constructor(agent, x, y) {
    this.id = agent.id;
    this.agent = agent;
    this.x = x;
    this.y = y;
    this.path = [];
    this.station = null;
    this.spot = null;
    this.flip = false;
    this.leaving = false;
    this.tentId = null; // the task whose tent this actor is heading to or resting in
    this.inside = false;
    this.form = this.targetForm; // the sprite it shows
    this.morph = null; // { from, to, t }: changing form, t counts ticks up to MORPH_TICKS
  }

  // The sprite it should show: its class, or for a shapeshifter standing at a station, that station's class.
  get targetForm() {
    const role = ROLES[this.agent.role] ?? ROLES.generalist;
    const at = role.shapeshifter && !this.walking && !this.leaving && !this.inside ? STATION_FORMS[this.station] : null;
    return at ? ROLES[at].sprite : role.sprite;
  }

  // Advance a form change, or start one when the wanted form differs. A change of mind mid-morph starts
  // over from whichever form is showing more.
  updateForm() {
    const want = this.targetForm;
    if (this.morph) {
      if (this.morph.to !== want) {
        const showing = this.morph.t * 2 < MORPH_TICKS ? this.morph.from : this.morph.to;
        this.morph = showing === want ? null : { from: showing, to: want, t: 0 };
        this.form = showing === want ? want : this.form;
        return;
      }
      this.morph.t += 1;
      if (this.morph.t >= MORPH_TICKS) {
        this.form = want;
        this.morph = null;
      }
      return;
    }
    if (want !== this.form) this.morph = { from: this.form, to: want, t: 0 };
  }

  get walking() {
    return this.path.length > 0;
  }

  goTo(station, spot) {
    const sameStation = station === this.station && !this.tentId;
    this.exitTent();
    this.station = station;
    this.spot = spot;
    this.path = sameStation && !this.leaving ? [spot] : planWalk(this.x, this.y, station, spot);
  }

  // Walk to a tent's doorway and go in.
  goToTent(tent) {
    if (this.tentId === tent.taskId && !this.leaving) return;
    this.exitTent();
    this.station = 'camp';
    this.tentId = tent.taskId;
    this.spot = [tent.x, tent.y];
    this.path = planWalk(this.x, this.y, 'camp', this.spot, tent.node);
  }

  exitTent() {
    this.tentId = null;
    this.inside = false;
  }

  leave() {
    this.exitTent();
    this.leaving = true;
    this.station = null;
    this.path = gateWalk(this.x, this.y);
  }

  arrive() {
    if (this.tentId) this.inside = true;
    else this.faceStation();
  }

  step(speed) {
    while (this.path.length) {
      const [tx, ty] = this.path[0];
      const dx = tx - this.x;
      const dy = ty - this.y;
      const d = Math.hypot(dx, dy);
      if (d <= speed) {
        this.x = tx;
        this.y = ty;
        this.path.shift();
        if (!this.path.length) this.arrive();
        return;
      }
      this.x += (dx / d) * speed;
      this.y += (dy / d) * speed;
      if (Math.abs(dx) > 0.5) this.flip = dx < 0;
      return;
    }
  }

  faceStation() {
    const st = this.station && STATION_LAYOUT[this.station];
    if (st) this.flip = this.x > st.x;
  }
}

export class Cast {
  constructor() {
    this.actors = new Map();
    this.tents = new Map(); // taskId → { taskId, color, slot, x, y, node, raised: 0..1, standing }
    this.placed = false;
  }

  // A tent stands for every task with agents in the grove; there's no limit. It comes down once the team
  // has gone and nobody is left inside.
  syncTents(agents) {
    const teams = new Map();
    for (const a of agents) if (a.taskId && !teams.has(a.taskId)) teams.set(a.taskId, a.taskColor);
    for (const t of this.tents.values()) t.standing = teams.has(t.taskId);
    const order = [...teams.keys()].sort((x, y) => (Number(x.replace(/\D/g, '')) || 0) - (Number(y.replace(/\D/g, '')) || 0));
    for (const taskId of order) {
      const existing = this.tents.get(taskId);
      if (existing) { existing.color = teams.get(taskId) ?? existing.color; continue; }
      const used = new Set([...this.tents.values()].map((t) => t.slot));
      let slot = 0;
      while (used.has(slot)) slot += 1;
      const s = tentSlot(slot);
      this.tents.set(taskId, { taskId, color: teams.get(taskId), slot, x: s.x, y: s.y, node: s.node, raised: this.placed ? 0 : 1, standing: true });
    }
  }

  // Assign every agent a station + spot; actors walk there along the paths.
  sync(agents, council) {
    this.syncTents(agents);
    const groups = new Map();
    const resting = [];
    for (const a of agents) {
      const station = ACTIVITY_STATION[a.activity] ?? 'camp';
      // Idle team members rest in their task's tent instead of sitting at the fire. One with an error stays
      // out by the fire so its error shows.
      if (station === 'camp' && a.taskId && !a.error && this.tents.get(a.taskId)?.standing) { resting.push(a); continue; }
      if (!groups.has(station)) groups.set(station, []);
      groups.get(station).push(a);
    }
    if (groups.has('council') && council?.members) {
      const order = new Map(council.members.map((id, i) => [id, i]));
      groups.get('council').sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
    }
    const seen = new Set();
    for (const [station, list] of groups) {
      const spots = HUDDLES[station] ? huddleAssignments(station, list) : list.map((_, i) => spotFor(station, i));
      list.forEach((agent, i) => {
        seen.add(agent.id);
        const spot = spots[i];
        let actor = this.actors.get(agent.id);
        if (!actor) {
          const [sx, sy] = this.placed ? NODES.gate : spot;
          actor = new Actor(agent, sx, sy);
          this.actors.set(agent.id, actor);
          if (!this.placed) {
            actor.station = station;
            actor.spot = spot;
            actor.faceStation();
            actor.form = actor.targetForm; // already there when the grove first appears
            return;
          }
        }
        actor.agent = agent;
        const moved = actor.station !== station || actor.leaving || actor.tentId || !actor.spot || actor.spot[0] !== spot[0] || actor.spot[1] !== spot[1];
        if (moved) {
          actor.goTo(station, spot);
          actor.leaving = false;
        }
      });
    }
    for (const agent of resting) {
      seen.add(agent.id);
      const tent = this.tents.get(agent.taskId);
      let actor = this.actors.get(agent.id);
      if (!actor) {
        const [sx, sy] = this.placed ? NODES.gate : [tent.x, tent.y];
        actor = new Actor(agent, sx, sy);
        this.actors.set(agent.id, actor);
        if (!this.placed) {
          actor.station = 'camp';
          actor.tentId = tent.taskId;
          actor.spot = [tent.x, tent.y];
          actor.inside = true;
          continue;
        }
      }
      actor.agent = agent;
      if (actor.leaving) actor.leaving = false;
      actor.goToTent(tent);
    }
    for (const actor of this.actors.values()) if (!seen.has(actor.id) && !actor.leaving) actor.leave();
    this.placed = true;
  }

  // Team members of a task: who's resting in its tent and who's out.
  team(taskId) {
    const inside = [];
    const out = [];
    for (const a of this.actors.values()) {
      if (a.leaving || a.agent.taskId !== taskId) continue;
      (a.inside ? inside : out).push(a);
    }
    return { inside, out };
  }

  tentAt(x, y) {
    let best = null;
    for (const t of this.tents.values()) {
      if (t.raised < 0.5) continue;
      if (x >= t.x - 10 && x <= t.x + 11 && y >= t.y - 17 && y <= t.y + 1 && (!best || t.y > best.y)) best = t;
    }
    return best;
  }

  // Huddles currently formed at review stations: [{ station, group, label, color, members: Actor[] }].
  huddles() {
    const out = new Map();
    for (const a of this.actors.values()) {
      if (a.leaving || a.inside || !a.agent.group || !HUDDLES[a.station]) continue;
      const key = `${a.station}|${a.agent.group}`;
      if (!out.has(key)) out.set(key, { station: a.station, group: a.agent.group, label: a.agent.groupLabel ?? a.agent.group, color: a.agent.taskColor, members: [] });
      out.get(key).members.push(a);
    }
    return [...out.values()];
  }

  update(motion) {
    const speed = SPEED * Math.max(0.35, motion);
    for (const actor of [...this.actors.values()]) {
      actor.step(speed);
      if (actor.leaving && !actor.walking) this.actors.delete(actor.id);
      else actor.updateForm();
    }
    const rate = 1 / PITCH_TICKS;
    for (const t of [...this.tents.values()]) {
      if (t.standing) { t.raised = Math.min(1, t.raised + rate); continue; }
      // Strike once nobody is inside or still walking in.
      if ([...this.actors.values()].some((a) => a.tentId === t.taskId)) continue;
      t.raised -= rate;
      if (t.raised <= 0) this.tents.delete(t.taskId);
    }
  }

  // Jump every walker to its destination (used after the page was hidden/throttled).
  settle() {
    for (const actor of [...this.actors.values()]) {
      if (actor.leaving) { this.actors.delete(actor.id); continue; }
      if (actor.walking) {
        [actor.x, actor.y] = actor.path.at(-1);
        actor.path = [];
        actor.arrive();
      }
      actor.form = actor.targetForm;
      actor.morph = null;
    }
    for (const t of [...this.tents.values()]) {
      if (t.standing) t.raised = 1;
      else if (![...this.actors.values()].some((a) => a.tentId === t.taskId)) this.tents.delete(t.taskId);
    }
  }

  // Agents that have arrived at a station (used to light it up).
  occupancy() {
    const occ = new Map();
    for (const a of this.actors.values()) {
      if (a.walking || a.leaving || !a.station) continue;
      if (!occ.has(a.station)) occ.set(a.station, []);
      occ.get(a.station).push(a);
    }
    return occ;
  }

  hitTest(x, y) {
    let best = null;
    for (const a of this.actors.values()) {
      if (a.leaving || a.inside) continue;
      if (x >= a.x - 10 && x <= a.x + 11 && y >= a.y - 31 && y <= a.y + 2) {
        if (!best || a.y > best.y) best = a;
      }
    }
    return best?.id ?? null;
  }
}
