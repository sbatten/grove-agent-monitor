// The Grove: composes the static world, workstations, walking agents, effects and UI.
//
// Draw order (back → front):
//   sky → stars/aurora/moon bloom → land → fog → moonwell → y-sorted world (stations, agents, owl)
//   → particles/fireflies → foreground → additive glow → UI (labels, bubbles, tags, HUD, tooltip)

import { PALETTE as P, ROBE_NAMES } from '../engine/palette.mjs';
import { mulberry32, makeCanvas, halo } from '../engine/dither.mjs';
import { drawSprite } from '../engine/sprites.mjs';
import { drawText, drawPanel, textWidth } from '../engine/font.mjs';
import { ROLES, STATIONS, STATION_LABELS, ACTIVITY_STATION } from '../model.mjs';
import { W, H, STATION_LAYOUT, COUNCIL, COUNCIL_STONES } from './layout.mjs';
import { THEME_LOOK, TREE_X, buildSky, buildLand, buildFore } from './world.mjs';
import { Cast, MORPH_TICKS } from './actors.mjs';

export { W, H };

const STATION_COLOR = {
  planning: P.cyan2, 'plan-review': P.violet2, implementing: P.magenta1, 'code-review': P.teal2,
  testing: P.teal1, research: P.cyan1, council: P.violet2, waiting: P.magenta1, camp: P.teal2,
};
// The Chief of Staff's sprite (from the Grove process); clicking it opens the inbox.
export const CHIEF_ID = 'grove-chief';
const DONE_BUBBLE_MS = 10000;
const DECISION_MS = 12000;
const EVENT_MS = 8000;

function hash(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Word-wrap text to lines no wider than `max` pixels (as drawn, upper-cased).
function wrap(text, max) {
  const out = [];
  let cur = '';
  for (const w of String(text).split(/\s+/)) {
    const next = (cur + ' ' + w).trim();
    if (textWidth(next.toUpperCase()) > max && cur) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

export function robeFor(agent) {
  return ROBE_NAMES.includes(agent.palette) ? agent.palette : ROBE_NAMES[hash(agent.id) % ROBE_NAMES.length];
}

export function spriteFor(agent) {
  return (ROLES[agent.role] ?? ROLES.generalist).sprite;
}

export function describeActivity(agent) {
  if (agent.error) return 'ERROR';
  if (agent.activity === 'idle') return 'RESTING';
  if (agent.activity === 'done') return 'DONE';
  return STATION_LABELS[ACTIVITY_STATION[agent.activity]] ?? agent.activity.toUpperCase();
}

export class Grove {
  constructor(seed = 7) {
    this.seed = seed;
    this.rand = mulberry32(seed * 31 + 1);
    this.cast = new Cast();
    this.particles = [];
    this.event = null;
    this.state = null;
    this.theme = null;
    [this.glowCanvas, this.glow] = makeCanvas(W, H);
  }

  setTheme(theme) {
    if (theme === this.theme) return;
    this.theme = theme;
    this.look = THEME_LOOK[theme] ?? THEME_LOOK.night;
    const rand = mulberry32(this.seed);
    this.meta = {};
    this.sky = buildSky(theme);
    this.land = buildLand(rand, this.meta, theme);
    this.fore = buildFore(rand, this.meta);
    const r = mulberry32(this.seed + 99);
    this.stars = [];
    while (this.stars.length < this.look.stars) {
      const x = Math.floor(r() * W);
      const y = Math.floor(r() * 120);
      if (Math.hypot(x - this.look.moon.x, y - this.look.moon.y) < this.look.moon.r + 10) continue;
      if (x < 230 && y < 40) continue;
      this.stars.push({ x, y, big: r() < 0.08, tw: r() < 0.5, ph: r() * 6.28, sp: 0.02 + r() * 0.05 });
    }
    const colors = [P.teal1, P.cyan1, P.violet2, P.teal2, P.cyan2];
    this.fireflies = Array.from({ length: this.look.fireflies }, () => ({
      x: r() * W, y: 150 + r() * 160, ph: r() * 6.28, f1: 0.005 + r() * 0.01, f2: 0.004 + r() * 0.01,
      c: colors[Math.floor(r() * colors.length)], blink: 0.01 + r() * 0.03,
    }));
    this.flora = [
      ['shroom-tall', 16, 184, 'default'], ['shroom-small', 26, 186, 'violet'], ['shroom-small', 462, 190, 'cyan'],
      ['shroom-tall', 166, 226, 'violet'], ['shroom-small', 176, 228, 'teal'], ['shroom-small', 316, 226, 'cyan'],
      ['glowflower', 452, 246, 'default'], ['glowflower', 16, 248, 'cyan'], ['shroom-small', 374, 318, 'teal'],
      ['glowflower', 192, 317, 'rose'], ['shroom-tall', 470, 228, 'teal'], ['glowflower', 300, 176, 'violet'],
    ].map(([id, x, y, variant], i) => ({ id, x, y, variant, ph: i * 0.9 }));
  }

  setState(next, now = Date.now()) {
    if (this.state) this.diff(this.state, next, now);
    this.state = next;
    this.setTheme(next.theme ?? 'night');
    this.cast.sync(next.agents, next.council);
  }

  diff(prev, next, now) {
    const before = new Map(prev.agents.map((a) => [a.id, a]));
    const after = new Map(next.agents.map((a) => [a.id, a]));
    const say = (text, color = P.uiText) => { this.event = { text, color, at: now }; };
    for (const a of next.agents) {
      const b = before.get(a.id);
      const name = (a.name || a.id).toUpperCase();
      const who = a.taskId && !name.startsWith(a.taskId.toUpperCase()) ? `${(a.taskName ?? a.taskId).toUpperCase()} ${name}` : name;
      const color = (a.taskColor && P[a.taskColor]) || STATION_COLOR[ACTIVITY_STATION[a.activity]];
      if (!b) say(a.taskId ? `${who} -> ${describeActivity(a)}` : `HIRED ${name} THE ${(ROLES[a.role] ?? ROLES.generalist).title.toUpperCase()}`, a.taskId ? color : P.teal2);
      else if (a.error && a.error !== b.error) say(`${who}: ${a.error}`, P.ember1);
      else if (a.activity !== b.activity) say(`${who} -> ${describeActivity(a)}${a.task && !a.taskId ? `: ${a.task}` : ''}`, color);
    }
    for (const b of prev.agents) if (!after.has(b.id)) say(b.taskId ? `${(b.taskName ?? b.taskId).toUpperCase()} ${(b.name || b.id).toUpperCase()} FINISHED` : `${(b.name || b.id).toUpperCase()} LEFT THE GROVE`, P.uiTextDim);
    if (next.council && next.council.topic !== prev.council?.topic) say(`COUNCIL CONVENED: ${next.council.topic}`, P.violet2);
    if (next.lastDecision && next.lastDecision.decidedAt !== prev.lastDecision?.decidedAt) {
      say(`DECIDED: ${next.lastDecision.decision || next.lastDecision.topic}`, P.teal2);
    }
  }

  spawn(p) {
    if (this.particles.length < 220) this.particles.push(p);
  }

  update(tick, motion = 1) {
    if (!this.state) return;
    this.cast.update(motion);
    for (const f of this.fireflies) {
      f.x += Math.sin(tick * f.f1 + f.ph) * 0.3 * motion;
      f.y += Math.cos(tick * f.f2 + f.ph * 1.3) * 0.2 * motion;
      if (f.x < -6) f.x = W + 6;
      if (f.x > W + 6) f.x = -6;
      f.y = Math.max(140, Math.min(312, f.y));
    }
    if (motion > 0) this.spawnStationFx(tick);
    for (const p of this.particles) {
      p.x += p.vx * Math.max(motion, 0.2);
      p.y += p.vy * Math.max(motion, 0.2);
      p.life++;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
  }

  spawnStationFx(tick) {
    const occ = this.cast.occupancy();
    const r = this.rand;
    const has = (s) => occ.has(s) && occ.get(s).some((a) => !a.agent.error);
    if (has('implementing') && tick % 6 === 0) {
      this.spawn({ x: 64 + r() * 18, y: 218, vx: (r() - 0.3) * 0.9, vy: -0.7 - r() * 0.7, life: 0, max: 30, c: r() < 0.5 ? P.cyan2 : P.violet2, r: 2 });
    }
    if (has('planning') && tick % 18 === 0) {
      this.spawn({ x: 76 + r() * 40, y: 158, vx: 0, vy: -0.3, life: 0, max: 70, c: P.cyan2, r: 3 });
    }
    if (has('plan-review') && tick % 22 === 0) {
      this.spawn({ x: 374 + r() * 22, y: 144, vx: (r() - 0.5) * 0.2, vy: -0.3, life: 0, max: 70, c: P.violet2, r: 3 });
    }
    if (has('code-review') && tick % 20 === 0) {
      this.spawn({ x: 386 + r() * 20, y: 206 + r() * 16, vx: 0, vy: -0.24, life: 0, max: 60, c: P.teal2, r: 3 });
    }
    if (this.state.council && occ.has('council') && tick % 16 === 0) {
      const a = r() * Math.PI * 2;
      this.spawn({ x: COUNCIL.x + Math.cos(a) * 16, y: COUNCIL.y + Math.sin(a) * 4, vx: 0, vy: -0.4, life: 0, max: 80, c: P.violet2, r: 3 });
    }
    if (tick % 24 === 0) this.spawn({ x: 240 + (r() - 0.5) * 8, y: 280, vx: (r() - 0.5) * 0.16, vy: -0.4, life: 0, max: 55, c: P.teal2, r: 2 });
    // Sparkles in the task colour while a tent goes up or comes down.
    for (const t of this.cast.tents.values()) {
      if (t.raised >= 1 || tick % 3) continue;
      this.spawn({ x: t.x - 9 + r() * 19, y: t.y - Math.round(t.raised * 16) + r() * 2, vx: (r() - 0.5) * 0.3, vy: -0.35 - r() * 0.3, life: 0, max: 34, c: P[t.color] ?? P.uiText, r: 2 });
    }
    for (const a of this.cast.actors.values()) {
      // A shapeshifter changing form: a burst as it starts, then motes thrown off the rising ring.
      if (a.morph && !a.inside) {
        const ring = a.y + 1 - (a.morph.t / MORPH_TICKS) * 34;
        const c = () => [P.violet2, P.cyan2, P.magenta1, P.white][Math.floor(r() * 4)];
        if (a.morph.t === 1) {
          for (let i = 0; i < 10; i++) {
            const ang = r() * Math.PI * 2;
            this.spawn({ x: a.x + Math.cos(ang) * 6, y: a.y - 2 + Math.sin(ang) * 2, vx: Math.cos(ang) * 0.6, vy: -0.3 - r() * 0.5, life: 0, max: 26 + r() * 12, c: c(), r: 2 });
          }
        } else if (tick % 3 === 0) {
          this.spawn({ x: a.x - 9 + r() * 18, y: ring, vx: (r() - 0.5) * 0.4, vy: -0.25 - r() * 0.35, life: 0, max: 22, c: c(), r: 2 });
        }
      }
      if (a.agent.error && !a.walking && tick % 9 === 0) {
        this.spawn({ x: a.x + (r() - 0.5) * 14, y: a.y - 16, vx: (r() - 0.5) * 0.3, vy: -0.45, life: 0, max: 60, c: P.ember0, smoke: true });
      }
    }
  }

  addGlow(x, y, r, color, strength) {
    if (strength <= 0) return;
    this.glow.save();
    this.glow.globalCompositeOperation = 'lighter';
    this.glow.globalAlpha = Math.min(1, strength);
    this.glow.drawImage(halo(r, color, 1), Math.round(x) - r, Math.round(y) - r);
    this.glow.restore();
  }

  stationVisible(id, occ) {
    return this.state.stations?.[id] !== false || occ.has(id) || [...this.cast.actors.values()].some((a) => a.station === id);
  }

  // `quietId`: an agent whose canvas tooltip is replaced by a page panel (the Chief's inbox).
  draw(ctx, tick, { motion = 1, now = Date.now(), selectedId = null, hoverId = null, quietId = null } = {}) {
    if (!this.state) return;
    const T = tick / 60;
    const g = this.glow;
    const occ = this.cast.occupancy();
    g.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    ctx.drawImage(this.sky, 0, 0);
    this.drawStars(ctx, tick);
    if (this.look.aurora > 0) this.drawAurora(ctx, T * motion, this.look.aurora);
    ctx.globalCompositeOperation = 'lighter';
    const { x: mx, y: my, r: mr } = this.look.moon;
    const mh = mr * 3;
    ctx.drawImage(halo(mh, this.theme === 'dawn' ? P.dawn4 : P.violet1, 0.5), mx - mh, my - mh);
    ctx.globalCompositeOperation = 'source-over';

    ctx.drawImage(this.land, 0, 0);
    this.drawFog(ctx, T * motion);
    this.drawWell(ctx, T, occ);

    for (const [x, y, ph] of this.meta.vines) {
      const v = 0.5 + 0.5 * Math.sin(T * 1.6 + ph);
      ctx.fillStyle = v > 0.5 ? P.cyan2 : P.cyan1;
      ctx.fillRect(x, y, 1, 2);
      this.addGlow(x, y + 1, 6, P.cyan1, 0.3 + 0.4 * v);
    }

    // y-sorted world
    const items = [];
    for (const f of this.flora) {
      items.push({ y: f.y, draw: () => drawSprite(ctx, f.id, f.x, f.y, { variant: f.variant, glow: g, glowStrength: 0.4 + 0.3 * Math.sin(T * 1.1 + f.ph) }) });
    }
    for (const id of STATIONS) {
      if (!this.stationVisible(id, occ)) continue;
      this.queueStation(items, ctx, g, id, occ, tick, T, now);
    }
    for (const t of this.cast.tents.values()) items.push({ y: t.y, draw: () => this.drawTent(ctx, g, t, tick, hoverId === `tent:${t.taskId}` || selectedId === `tent:${t.taskId}`) });
    for (const a of this.cast.actors.values()) {
      if (a.inside) continue;
      items.push({ y: a.y + 0.5, draw: () => this.drawActor(ctx, g, a, tick, T, selectedId === a.id || hoverId === a.id) });
    }
    items.push({ y: this.meta.owl[1], draw: () => drawSprite(ctx, 'owl', this.meta.owl[0], this.meta.owl[1], { tick, glow: g }) });
    const books = this.inboxBooks(tick);
    if (books.length) items.push({ y: this.cast.actors.get(CHIEF_ID).y + 0.6, draw: () => this.drawInboxBooks(ctx, g, books, tick) });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();

    for (const p of this.particles) {
      const k = 1 - p.life / p.max;
      const x = Math.round(p.x);
      const y = Math.round(p.y);
      if (p.smoke) {
        ctx.globalAlpha = 0.35 * k;
        ctx.fillStyle = k > 0.5 ? P.ember0 : P.magenta0;
        ctx.fillRect(x - 1, y - 1, 3, 3);
        ctx.globalAlpha = 1;
        continue;
      }
      ctx.globalAlpha = Math.min(1, k * 1.5);
      ctx.fillStyle = p.c;
      ctx.fillRect(x, y, 1, 1);
      ctx.globalAlpha = 1;
      if (p.r) this.addGlow(x, y, p.r * 2, p.c, k * 0.6);
    }
    for (const f of this.fireflies) {
      const on = Math.sin(tick * f.blink + f.ph);
      if (on < -0.3) continue;
      const x = Math.round(f.x);
      const y = Math.round(f.y);
      ctx.fillStyle = on > 0.5 ? P.white : f.c;
      ctx.fillRect(x, y, 1, 1);
      if (on > 0.6) {
        ctx.fillStyle = f.c;
        ctx.fillRect(x - 1, y, 1, 1); ctx.fillRect(x + 1, y, 1, 1); ctx.fillRect(x, y - 1, 1, 1); ctx.fillRect(x, y + 1, 1, 1);
      }
      this.addGlow(x, y, 8, f.c, 0.35 + 0.5 * Math.max(0, on));
    }

    ctx.drawImage(this.fore, 0, 0);
    for (const [x, y, ph] of this.meta.moss) {
      const v = 0.5 + 0.5 * Math.sin(T * 1.2 + ph);
      ctx.fillStyle = v > 0.6 ? P.teal2 : P.teal1;
      ctx.fillRect(x, y, 1, 2);
      this.addGlow(x, y + 1, 6, P.teal1, 0.3 + 0.4 * v);
    }

    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(this.glowCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    this.drawLabels(ctx, occ);
    this.drawHuddleTags(ctx, tick);
    this.drawAgentUi(ctx, tick, now, selectedId);
    this.drawHud(ctx, tick, now);
    // Tents explain themselves on hover; an agent's details only show once it's clicked (selected), so they
    // don't flicker past while agents walk under the pointer.
    const tentId = hoverId?.startsWith('tent:') ? hoverId : selectedId?.startsWith('tent:') ? selectedId : null;
    const tent = tentId ? this.cast.tents.get(tentId.slice(5)) : null;
    if (tent) this.drawTentTooltip(ctx, tent);
    const focus = this.cast.actors.get(selectedId);
    if (focus && !focus.leaving && !focus.inside && selectedId !== quietId) this.drawTooltip(ctx, focus);
  }

  // Tasks waiting on the human float beside the Chief of Staff as books in their task colours, at head height
  // on its open side (away from the lantern and station labels): three at most, then a count.
  inboxBooks(tick = 0) {
    const items = this.state?.process?.inbox?.items ?? [];
    const chief = this.cast.actors.get(CHIEF_ID);
    if (!items.length || !chief || chief.leaving || chief.inside) return [];
    const shown = items.slice(0, 3);
    const side = chief.x > W / 2 ? -1 : 1;
    return shown.map((item, i) => ({
      item,
      x: Math.round(chief.x) + side * (17 + i * 12),
      y: Math.round(chief.y) - 12 - (i % 2) * 3 + Math.round(Math.sin(tick * 0.05 + i * 1.7) * 1.2),
      more: i === shown.length - 1 ? items.length - shown.length : 0,
      side,
    }));
  }

  drawInboxBooks(ctx, g, books, tick) {
    for (const [i, b] of books.entries()) {
      drawSprite(ctx, 'book', b.x, b.y, { anim: 'glow', variant: b.item.color, tick: tick + i * 23, glow: g, glowStrength: 0.9 });
      this.addGlow(b.x, b.y - 7, 11, P[b.item.color] ?? P.amber, 0.28);
      if (b.more > 0) drawText(ctx, `+${b.more}`, b.side < 0 ? b.x - 10 : b.x + 9, b.y - 11, { color: P.uiText, shadow: P.shadow, align: b.side < 0 ? 'right' : 'left' });
    }
  }

  // What's under a scene point: an agent's id, or "tent:<taskId>" for a team tent.
  hitTest(x, y) {
    if (this.inboxBooks().some((b) => x >= b.x - 7 && x <= b.x + 7 && y >= b.y - 17 && y <= b.y + 2)) return CHIEF_ID;
    const id = this.cast.hitTest(x, y);
    if (id) return id;
    const t = this.cast.tentAt(x, y);
    return t ? `tent:${t.taskId}` : null;
  }

  // A team tent, raised from the ground up while it's being pitched (and lowered when struck).
  drawTent(ctx, g, t, tick, focused) {
    const x = Math.round(t.x);
    const y = Math.round(t.y);
    const ease = t.raised * t.raised * (3 - 2 * t.raised);
    // A shelved task's team sleeps: the doorway goes dark and a "z" drifts up from the tent.
    const asleep = this.state.process?.tasks?.find((x) => x.id === t.taskId)?.stage === 'shelved';
    const lit = !asleep && this.cast.team(t.taskId).inside.length > 0;
    ctx.globalAlpha = 0.5 * ease;
    ctx.fillStyle = P.shadow;
    ctx.fillRect(x - 9, y, 21, 1);
    ctx.fillRect(x - 6, y + 1, 15, 1);
    ctx.globalAlpha = 1;
    if (focused) {
      ctx.fillStyle = P.uiFrameHi;
      for (let i = -10; i <= 11; i++) if ((i + (tick >> 3)) % 3 !== 0) ctx.fillRect(x + i, y + 2, 1, 1);
    }
    const opts = { anim: lit ? 'lit' : 'empty', variant: t.color, tick: tick + (hash(t.taskId) % 50), glow: g, glowStrength: (lit ? 0.75 : 0.4) * ease };
    if (ease >= 1) {
      drawSprite(ctx, 'tent', x, y, opts);
    } else {
      const shown = Math.max(1, Math.round(18 * ease));
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - 12, y + 1 - shown, 25, shown);
      ctx.clip();
      drawSprite(ctx, 'tent', x, y, opts);
      ctx.restore();
    }
    if (lit) this.addGlow(x, y - 4, 8, P.amber, 0.22 * ease);
    if (asleep && ease >= 1) this.drawSleep(ctx, x + 6, y - 18, tick + (hash(t.taskId) % 90));
  }

  // Two small z's rising and fading in turn over a sleeping tent.
  drawSleep(ctx, x, y, tick) {
    const Z = ['####', '..#.', '.#..', '####'];
    for (let i = 0; i < 2; i++) {
      const k = ((tick + i * 45) % 90) / 90;
      const zx = Math.round(x + i * 3 + Math.sin(k * Math.PI * 2) * 1.5);
      const zy = Math.round(y - k * 10);
      ctx.globalAlpha = Math.sin(k * Math.PI);
      ctx.fillStyle = P.violet2;
      Z.forEach((row, r) => { for (let c = 0; c < 4; c++) if (row[c] === '#') ctx.fillRect(zx + c, zy + r, 1, 1); });
      ctx.globalAlpha = 1;
      this.addGlow(zx + 2, zy + 2, 5, P.violet1, 0.25 * Math.sin(k * Math.PI));
    }
  }

  // Hovering a tent: the task, its stage, who's resting inside and who's out working.
  drawTentTooltip(ctx, t) {
    const task = this.state.process?.tasks?.find((x) => x.id === t.taskId);
    const { inside, out } = this.cast.team(t.taskId);
    const color = P[t.color] ?? P.uiText;
    const name = (a) => (a.agent.name || a.agent.id).replace(new RegExp(`^${t.taskId}\\s+`), '').toUpperCase();
    // Reviewers carry their last verdict on the task.
    const short = (a) => `${name(a)}${a.agent.verdict ? ` ${a.agent.verdict === 'approve' ? '(APPROVED)' : '(CHANGES)'}` : ''}`;
    const lines = [];
    const title = task?.title ?? [...inside, ...out].find((a) => a.agent.team)?.agent.team ?? 'TEAM TENT';
    // The task's name sits above its title, so the title keeps the room.
    const taskName = task?.name ?? [...inside, ...out].find((a) => a.agent.taskName)?.agent.taskName;
    lines.push({ t: taskName ? `${taskName} · ${t.taskId}` : t.taskId, c: color });
    for (const l of wrap(title, 170).slice(0, 2)) lines.push({ t: l, c: P.uiText });
    if (task?.stageLabel) lines.push({ t: task.stageLabel, c: task.pause ? P.ember1 : task.shelf ? P.violet2 : P.uiTextDim });
    if (task?.shelf) for (const l of wrap(`WAS: ${task.shelf.fromLabel}. BRING IT BACK FROM THE CHIEF'S INBOX.`, 170).slice(0, 2)) lines.push({ t: l, c: P.uiTextDim });
    if (task?.pause?.kind === 'blocked' && task.pause.need) for (const l of wrap(`NEEDS YOU: ${task.pause.need}`, 170).slice(0, 2)) lines.push({ t: l, c: P.amber });
    if (task?.ship?.pr) for (const l of wrap(task.ship.pr.error ? `PR #${task.ship.pr.number}: CAN'T READ IT` : task.ship.pr.line, 170).slice(0, 2)) lines.push({ t: l, c: P.cyan2 });
    const latest = task?.updates?.at(-1);
    if (latest) for (const l of wrap(`LATEST: ${latest.text}`, 170).slice(0, 2)) lines.push({ t: l, c: P.uiText });
    if (inside.length) for (const [i, l] of wrap(`INSIDE (${inside.length}): ${inside.map(short).join(', ')}`, 170).slice(0, 3).entries()) lines.push({ t: l, c: i ? P.uiText : P.amber });
    else lines.push({ t: 'NO ONE INSIDE', c: P.uiTextDim });
    if (out.length) for (const l of wrap(`OUT: ${out.map((a) => `${name(a)} (${a.walking && a.tentId ? 'HEADING IN' : describeActivity(a.agent)})`).join(', ')}`, 170).slice(0, 3)) lines.push({ t: l, c: P.uiTextDim });
    const w = Math.max(...lines.map((l) => textWidth(l.t.toUpperCase()))) + 14;
    const h = lines.length * 10 + 8;
    let x = Math.round(t.x) + 14;
    let y = Math.round(t.y) - 22 - h;
    if (x + w > W - 4) x = Math.max(4, Math.round(t.x) - 14 - w);
    if (y < 4) y = 4;
    if (y + h > H - 4) y = H - 4 - h;
    drawPanel(ctx, x, y, w, h);
    lines.forEach((l, i) => drawText(ctx, l.t, x + 7, y + 5 + i * 10, { color: l.c }));
  }

  queueStation(items, ctx, g, id, occ, tick, T, now) {
    const L = STATION_LAYOUT[id];
    const here = occ.get(id) ?? [];
    const active = here.length > 0;
    const pulse = 0.6 + 0.4 * Math.sin(T * 2);
    if (id === 'council') {
      const decided = this.state.lastDecision && now - this.state.lastDecision.decidedAt < DECISION_MS;
      const variant = this.state.council && active ? 'active' : decided ? 'decided' : 'idle';
      for (const [x, y] of COUNCIL_STONES) {
        items.push({ y, draw: () => drawSprite(ctx, 'council-stone', x, y, { variant, glow: g, glowStrength: variant === 'idle' ? 0 : pulse * 0.6 }) });
      }
      return;
    }
    for (const prop of L.props) {
      let variant = active ? 'active' : 'idle';
      if (prop.sprite === 'dummy' && active) {
        const failing = here.some((a) => a.agent.error);
        variant = failing ? 'fail' : (tick + prop.x * 7) % 90 < 6 ? 'hit' : 'active';
      }
      if (prop.sprite === 'campfire' || prop.sprite === 'log') variant = 'default';
      const strength = prop.sprite === 'campfire' ? 0.5 + 0.15 * Math.sin(T * 5) : active ? pulse * 0.85 : 0;
      items.push({ y: prop.y, draw: () => drawSprite(ctx, prop.sprite, prop.x, prop.y, { variant, tick, glow: g, glowStrength: strength }) });
    }
    if (id === 'camp') this.addGlow(240, 286, 30, P.teal0, 0.45 + 0.1 * Math.sin(T * 5));
    if (!active) return;
    if (id === 'research') {
      const y = 132 + Math.round(Math.sin(T * 1.5) * 3);
      items.push({ y: L.y + 0.1, draw: () => drawSprite(ctx, 'tome', TREE_X, y, { tick, glow: g }) });
    }
    if (id === 'waiting') this.addGlow(409, 282, 26, P.magenta0, 0.5 + 0.5 * Math.sin(T * 3));
    if (id === 'implementing') this.addGlow(66, 226, 24, P.violet0, pulse);
    if (id === 'code-review') this.addGlow(396, 216, 24, P.teal0, pulse * 0.8);
    if (id === 'planning') this.addGlow(96, 160, 26, P.cyan0, pulse * 0.6);
    if (id === 'plan-review') this.addGlow(384, 152, 20, P.violet0, pulse * 0.7);
  }

  drawWell(ctx, T, occ) {
    const live = this.state.council && occ.has('council');
    const ramp = live ? [P.violet0, P.violet1, P.violet2, P.violet3] : [P.teal0, P.cyan0, P.cyan1, P.cyan2];
    for (const [x, y, e, dx, dy] of this.meta.well) {
      const wave = Math.sin(Math.sqrt(e) * 11 - T * (live ? 4 : 2)) + Math.sin(dx * 0.3 + dy * 0.8 + T * 1.3) * 0.35;
      const depth = e > 0.8 ? -0.6 : 0;
      const v = Math.max(0, Math.min(3, Math.round(1.4 + wave * 1.1 + depth)));
      ctx.fillStyle = ramp[v];
      ctx.fillRect(x, y, 1, 1);
    }
    const pulse = 0.7 + 0.3 * Math.sin(T * 1.7);
    this.addGlow(COUNCIL.x, COUNCIL.y, 34, live ? P.violet0 : P.cyan0, pulse * (live ? 0.75 : 0.55));
  }

  drawActor(ctx, g, a, tick, T, focused) {
    const ag = a.agent;
    const x = Math.round(a.x);
    const y = Math.round(a.y);
    let anim = 'work';
    if (a.walking) anim = 'walk';
    else if (ag.error) anim = 'error';
    else if (a.station === 'camp') anim = 'sit';
    else if (a.station === 'waiting') anim = 'idle';
    else if (a.station === 'council') anim = this.isSpeaker(a, tick) ? 'talk' : 'idle';
    else if (ag.group) anim = this.isHuddleSpeaker(a, tick) ? 'talk' : 'work';
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = P.shadow;
    ctx.fillRect(x - 7, y, 15, 1);
    ctx.fillRect(x - 5, y + 1, 11, 1);
    ctx.globalAlpha = 1;
    if (focused) {
      ctx.fillStyle = P.uiFrameHi;
      for (let i = -10; i <= 10; i++) if ((i + (tick >> 3)) % 3 !== 0) ctx.fillRect(x + i, y + 2, 1, 1);
    }
    const flicker = ag.error ? (Math.sin(T * 17) > 0.2 ? 1 : 0.3) : 1;
    if (ag.taskColor && P[ag.taskColor]) this.drawPennant(ctx, x, y - (anim === 'sit' ? 5 : 0), a.flip, P[ag.taskColor], tick + (hash(ag.id) % 40));
    this.drawBody(ctx, g, a, x, y, {
      anim, tick: tick + (hash(ag.id) % 60), variant: robeFor(ag), flip: a.flip,
      glowStrength: (anim === 'sit' ? 0.5 : 0.9) * flicker,
    }, tick);
  }

  // The agent's sprite in its current form. A shapeshifter changing form is shown mid-change: a ring of light
  // rises from its feet to its head, the new form below the ring and the old one above.
  drawBody(ctx, g, a, x, y, opts, tick) {
    const m = a.morph;
    if (!m || a.inside) {
      drawSprite(ctx, a.form ?? spriteFor(a.agent), x, y, { ...opts, glow: g });
      return;
    }
    const k = m.t / MORPH_TICKS;
    const ring = y + 1 - Math.round(k * 34);
    const part = (id, top, bottom, glow) => {
      if (bottom <= top) return;
      for (const c of glow ? [ctx, glow] : [ctx]) {
        c.save();
        c.beginPath();
        c.rect(x - 30, top, 60, bottom - top);
        c.clip();
      }
      drawSprite(ctx, id, x, y, { ...opts, glow });
      ctx.restore();
      glow?.restore();
    };
    part(m.from, y - 48, ring, k < 0.5 ? g : null);
    part(m.to, ring, y + 8, k >= 0.5 ? g : null);
    const swirl = [P.white, P.violet2, P.cyan2, P.violet1];
    for (let i = -10; i <= 10; i++) {
      const edge = Math.abs(i) > 7;
      if (edge && (i + tick) % 2) continue;
      ctx.fillStyle = swirl[(i + 40 + (tick >> 1)) % swirl.length];
      ctx.fillRect(x + i, ring, 1, 1);
      if (!edge && (i + tick) % 3 === 0) {
        ctx.fillStyle = P.violet1;
        ctx.fillRect(x + i, ring + 1, 1, 1);
      }
    }
    this.addGlow(x, ring, 14, P.violet2, 0.35 + 0.4 * Math.sin(Math.PI * k));
    this.addGlow(x, ring, 8, P.cyan2, 0.3);
  }

  // Task pennant on a pole strapped to the agent's back (drawn behind the sprite), flapping gently.
  drawPennant(ctx, x, y, flip, color, tick) {
    const px = flip ? x + 5 : x - 5;
    const dir = flip ? 1 : -1;
    const top = y - 38;
    ctx.fillStyle = P.outline;
    ctx.fillRect(px - 1, top - 1, 3, 26);
    ctx.fillStyle = P.wood3;
    ctx.fillRect(px, top, 1, 25);
    const flap = (tick >> 4) & 1;
    const rows = flap ? [7, 7, 6, 5, 3, 1] : [7, 7, 7, 5, 4, 2];
    rows.forEach((w, i) => {
      for (let k = 1; k <= w; k++) {
        ctx.fillStyle = k === w ? P.outline : i === 0 ? P.white : color;
        ctx.fillRect(px + dir * k, top + i, 1, 1);
      }
    });
    ctx.fillStyle = P.outline;
    for (let k = 1; k <= rows.at(-1); k++) ctx.fillRect(px + dir * k, top + rows.length, 1, 1);
    this.addGlow(px + dir * 4, top + 3, 7, color, 0.35);
  }

  isHuddleSpeaker(actor, tick) {
    const g = actor.agent.group;
    const members = [...this.cast.actors.values()].filter((a) => a.agent.group === g && !a.walking && !a.leaving).sort((a, b) => a.id.localeCompare(b.id));
    if (members.length < 2) return false;
    return members[Math.floor((tick + (hash(g) % 150)) / 150) % members.length] === actor;
  }

  // Banner over each forum huddle: task colour + "T3 R1".
  drawHuddleTags(ctx, tick) {
    for (const h of this.cast.huddles()) {
      const settled = h.members.filter((a) => !a.walking);
      if (!settled.length) continue;
      const cx = Math.round(settled.reduce((s, a) => s + a.x, 0) / settled.length);
      const top = Math.round(Math.min(...settled.map((a) => a.y))) - 52;
      const label = h.label.toUpperCase();
      const w = textWidth(label) + 10;
      const x = Math.round(cx - w / 2);
      const color = P[h.color] ?? P.uiText;
      ctx.fillStyle = P.outline;
      ctx.fillRect(x, top, w, 12);
      ctx.fillStyle = P.uiBg;
      ctx.fillRect(x + 1, top + 1, w - 2, 10);
      ctx.fillStyle = color;
      ctx.fillRect(x + 1, top + 10, w - 2, 1);
      ctx.fillRect(x + 1, top + 1, 1, 9);
      drawText(ctx, label, x + 5, top + 2, { color, shadow: null });
      const d = (tick >> 4) % 4;
      for (let i = 0; i < 3; i++) if (i < d) ctx.fillRect(cx - 4 + i * 4, top + 14, 2, 2);
    }
  }

  isSpeaker(actor, tick) {
    const members = (this.state.council?.members ?? []).filter((id) => {
      const a = this.cast.actors.get(id);
      return a && !a.walking && a.station === 'council';
    });
    if (members.length < 2) return members[0] === actor.id;
    return members[Math.floor(tick / 150) % members.length] === actor.id;
  }

  drawLabels(ctx, occ) {
    for (const id of STATIONS) {
      if (!this.stationVisible(id, occ)) continue;
      const [lx, ly] = STATION_LAYOUT[id].label;
      const n = occ.get(id)?.length ?? 0;
      drawText(ctx, STATION_LABELS[id], lx, ly, { color: n ? STATION_COLOR[id] : P.stone2, shadow: n ? P.shadow : null, align: 'center' });
    }
  }

  drawAgentUi(ctx, tick, now, selectedId) {
    const bob = Math.round(Math.sin(tick * 0.08));
    for (const a of this.cast.actors.values()) {
      if (a.leaving || a.inside) continue;
      const ag = a.agent;
      const x = Math.round(a.x);
      const y = Math.round(a.y) - (a.station === 'camp' && !a.walking ? 5 : 0);
      let bubble = null;
      if (!a.walking) {
        if (ag.error) bubble = 'error';
        else if (a.station === 'waiting' && !(a.id === CHIEF_ID && this.state.process?.inbox?.items?.length)) bubble = 'waiting';
        else if (ag.activity === 'done' && now - (ag.updatedAt ?? 0) < DONE_BUBBLE_MS) bubble = 'done';
        else if (a.station === 'council' && this.isSpeaker(a, tick)) bubble = 'talk';
      }
      if (bubble) drawSprite(ctx, 'bubble', x + (a.flip ? -12 : 12), y - 30 + bob, { anim: bubble, variant: bubble, tick });
      const showName = selectedId === a.id;
      if (showName) {
        const name = `${ag.taskName ? `${ag.taskName} ` : ''}${ag.name || ag.id}`.slice(0, 22);
        drawText(ctx, name, x, y - (bubble ? 50 : 44), { color: ag.error ? P.ember1 : P.uiText, align: 'center' });
      }
    }
  }

  drawHud(ctx, tick, now) {
    const agents = this.state.agents;
    const working = agents.filter((a) => !['idle', 'done', 'waiting'].includes(a.activity) && !a.error).length;
    const tasks = (this.state.process?.tasks ?? []).filter((t) => !['done', 'cancelled'].includes(t.stage)).length;
    const parts = [`${agents.length} AGENT${agents.length === 1 ? '' : 'S'}`];
    if (tasks) parts.push(`${tasks} TASK${tasks === 1 ? '' : 'S'}`);
    else parts.push(`${working} AT WORK`);
    const line1 = agents.length ? `THE GROVE · ${parts.join(' · ')}` : 'THE GROVE · NO ONE HIRED YET';
    let line2 = null;
    let color = P.uiTextDim;
    if (this.event && now - this.event.at < EVENT_MS) { line2 = this.event.text; color = this.event.color; }
    else if (this.state.council) { line2 = `COUNCIL: ${this.state.council.topic}`; color = P.violet2; }
    const max = 210;
    if (line2) while (textWidth(line2) > max) line2 = `${line2.slice(0, -2)}…`;
    const pw = Math.max(textWidth(line1), line2 ? textWidth(line2) : 0) + 14;
    drawPanel(ctx, 5, 5, pw, line2 ? 26 : 16);
    drawText(ctx, line1, 12, 9, { color: P.uiText });
    if (line2) drawText(ctx, line2, 12, 18, { color });
  }

  drawTooltip(ctx, a) {
    const ag = a.agent;
    const cls = ROLES[ag.role] ?? ROLES.generalist;
    // A shapeshifter says which form it has taken.
    const shape = cls.shapeshifter && a.form && a.form !== cls.sprite ? Object.values(ROLES).find((r) => r.sprite === a.form && !r.shapeshifter)?.title : null;
    const role = `${cls.title}${shape ? ` in ${shape} form` : ''}`.toUpperCase();
    const name = (ag.name || ag.id).toUpperCase();
    const lines = [
      ...(ag.taskId ? [{ t: ag.taskName ? `${ag.taskName} · ${ag.taskId}` : ag.taskId, c: P[ag.taskColor] ?? P.uiTextDim }] : []),
      { t: name === cls.title.toUpperCase() ? role : `${name} · ${role}`, c: P.uiText },
      { t: a.walking ? `WALKING TO ${STATION_LABELS[a.station] ?? 'THE ROAD'}` : describeActivity(ag), c: ag.error ? P.ember1 : STATION_COLOR[a.station] ?? P.uiTextDim },
    ];
    const detail = ag.error || ag.task;
    if (detail) for (const t of wrap(detail, 150).slice(0, 3)) lines.push({ t, c: P.uiTextDim });
    const w = Math.max(...lines.map((l) => textWidth(l.t.toUpperCase()))) + 14;
    const h = lines.length * 10 + 8;
    let x = Math.round(a.x) + 16;
    let y = Math.round(a.y) - 36 - h;
    if (x + w > W - 4) x = Math.round(a.x) - 16 - w;
    if (y < 4) y = Math.round(a.y) + 6;
    if (y + h > H - 4) y = H - 4 - h;
    drawPanel(ctx, x, y, w, h);
    lines.forEach((l, i) => drawText(ctx, l.t, x + 7, y + 5 + i * 10, { color: l.c }));
  }

  drawStars(ctx, tick) {
    for (const s of this.stars) {
      const v = s.tw ? Math.sin(tick * s.sp + s.ph) : 0.2;
      if (v < -0.4) continue;
      ctx.globalAlpha = v > 0.55 ? 1 : 0.55 + v * 0.4;
      ctx.fillStyle = v > 0.55 ? P.star : P.starDim;
      ctx.fillRect(s.x, s.y, 1, 1);
      if (s.big && v > 0.55) {
        ctx.fillStyle = P.starDim;
        ctx.fillRect(s.x - 1, s.y, 1, 1); ctx.fillRect(s.x + 1, s.y, 1, 1);
        ctx.fillRect(s.x, s.y - 1, 1, 1); ctx.fillRect(s.x, s.y + 1, 1, 1);
        if (v > 0.9) { ctx.globalAlpha = 0.5; ctx.fillRect(s.x - 2, s.y, 1, 1); ctx.fillRect(s.x + 2, s.y, 1, 1); ctx.fillRect(s.x, s.y - 2, 1, 1); ctx.fillRect(s.x, s.y + 2, 1, 1); }
      }
    }
    ctx.globalAlpha = 1;
  }

  // Bioluminescent aurora: soft vertical curtains, additive.
  drawAurora(ctx, T, strength) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const hgt = 46;
    for (let x = 0; x < W; x += 2) {
      const yc = Math.round(62 + 12 * Math.sin(x * 0.014 + T * 0.3) + 6 * Math.sin(x * 0.041 - T * 0.5));
      const amp = (0.5 + 0.5 * Math.sin(x * 0.022 + T * 0.6)) * (0.6 + 0.4 * Math.sin(x * 0.16 + T * 1.1));
      if (amp <= 0.05) continue;
      const mix = Math.max(0, Math.min(1, (x - 120) / 240));
      for (let i = 0; i < hgt; i += 1) {
        const k = (1 - i / hgt) ** 1.6 * amp * strength;
        if (k < 0.03) continue;
        ctx.globalAlpha = k * (i < 3 ? 0.32 : 0.14);
        ctx.fillStyle = i < 18 ? (mix > 0.5 ? P.violet1 : P.teal1) : P.violet0;
        ctx.fillRect(x, yc - i, 1, 1);
      }
    }
    ctx.restore();
  }

  drawFog(ctx, T) {
    ctx.save();
    ctx.fillStyle = P.fog;
    const peak = this.look.fog;
    const off = T * 6;
    for (let y = 116; y <= 156; y++) {
      const k = peak * (1 - (Math.abs(y - 136) / 21) ** 2);
      if (k <= 0) continue;
      for (let x = 0; x < W; x += 2) {
        const wave = 0.55 + 0.45 * Math.sin((x + off) * 0.022 + y * 0.15) * Math.sin((x - off * 0.6) * 0.011);
        ctx.globalAlpha = Math.max(0, k * wave * 0.35);
        ctx.fillRect(x, y, 2, 1);
      }
    }
    ctx.restore();
  }
}
