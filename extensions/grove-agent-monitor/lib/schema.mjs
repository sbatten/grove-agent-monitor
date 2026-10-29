import { ROBE_NAMES } from '../web/engine/palette.mjs';
import { ACTIVITIES, STATIONS, ROLE_NAMES, THEMES } from '../web/model.mjs';

export { ROBE_NAMES, ACTIVITIES, STATIONS, ROLE_NAMES, THEMES };

export class GroveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const VIEWS = Object.freeze(['scene', 'gallery']);
export const MAX_AGENTS = 24;
export const MAX_COUNCIL = 6;

const SCENE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const AGENT_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export const openInputSchema = {
  type: 'object',
  properties: {
    scene: {
      type: 'string',
      pattern: SCENE_ID.source,
      description: 'Durable scene identity (kebab-case). Panels opened with the same scene share agents and settings. Defaults to "default".',
    },
  },
  additionalProperties: false,
};

const id = { type: 'string', pattern: AGENT_ID.source, description: 'Stable agent identifier (e.g. the subagent/task id).' };
const name = { type: 'string', maxLength: 32, description: 'Display name.' };
const role = {
  type: 'string', enum: [...ROLE_NAMES],
  description: 'Job the agent was hired for; sets its sprite class. orchestrator=archmage, planner=scribe, implementer=artificer, reviewer=seer, tester=warden, researcher=scout, generalist=mage.',
};
const palette = { type: 'string', enum: [...ROBE_NAMES], description: 'Robe color. Defaults to a stable hash of id.' };
const activity = {
  type: 'string', enum: ACTIVITIES.filter((a) => a !== 'council'),
  description: 'What the agent is doing; it walks to the matching workstation. idle/done rest at camp; waiting = needs the user. Use convene for council.',
};
const task = { type: 'string', maxLength: 200, description: 'Short description of the current work.' };

export const actionSchemas = {
  hireAgent: { type: 'object', properties: { id, name, role, palette, activity, task }, required: ['id', 'role'], additionalProperties: false },
  updateAgent: {
    type: 'object',
    properties: {
      id, name, role, palette, activity, task,
      error: { type: 'string', maxLength: 120, description: 'Set to show the agent failing at its station; empty string clears it.' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  dismissAgent: { type: 'object', properties: { id }, required: ['id'], additionalProperties: false },
  convene: {
    type: 'object',
    properties: {
      topic: { type: 'string', minLength: 1, maxLength: 80, description: 'What the council is deciding.' },
      members: { type: 'array', items: id, minItems: 1, maxItems: MAX_COUNCIL, uniqueItems: true, description: 'Agent ids that walk to the council ring. Adds to an in-session council.' },
    },
    required: ['topic', 'members'],
    additionalProperties: false,
  },
  resolveCouncil: {
    type: 'object',
    properties: {
      decision: { type: 'string', maxLength: 120, description: 'The outcome, shown to the user.' },
      next: { ...activity, description: 'Activity members go to next. Defaults to whatever each was doing before convening.' },
    },
    additionalProperties: false,
  },
  configureScene: {
    type: 'object',
    properties: {
      theme: { type: 'string', enum: [...THEMES], description: 'Time of day / mood.' },
      stations: {
        type: 'object',
        description: 'Show (true) or hide (false) workstations to fit the team. Occupied stations always show.',
        properties: Object.fromEntries(STATIONS.map((s) => [s, { type: 'boolean' }])),
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  summonDemo: {
    type: 'object',
    properties: { cycle: { type: 'boolean', description: 'Keep moving demo agents between stations (default true).' } },
    additionalProperties: false,
  },
  setView: { type: 'object', properties: { view: { type: 'string', enum: [...VIEWS] } }, required: ['view'], additionalProperties: false },
  snapshot: {
    type: 'object',
    properties: { scale: { type: 'integer', minimum: 1, maximum: 4, description: 'Nearest-neighbor upscale factor (default 3).' } },
    additionalProperties: false,
  },
};

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function obj(input, allowed, label) {
  if (input === undefined || input === null) input = {};
  if (!isObj(input)) throw new GroveError('invalid_input', `${label} input must be an object`);
  for (const k of Object.keys(input)) if (!allowed.includes(k)) throw new GroveError('invalid_input', `${label}: unknown property "${k}"`);
  return input;
}

function str(v, label, max, { min = 0 } = {}) {
  if (typeof v !== 'string' || v.length > max || v.trim().length < min) throw new GroveError('invalid_input', `${label} must be a string of ${min}–${max} chars`);
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function oneOf(v, list, label) {
  if (!list.includes(v)) throw new GroveError('invalid_input', `${label} must be one of ${list.join(', ')}`);
  return v;
}

export function parseId(v) {
  if (typeof v !== 'string' || !AGENT_ID.test(v)) throw new GroveError('invalid_input', 'id must match [A-Za-z0-9._:-]{1,64}');
  return v;
}

export function parseOpenInput(input) {
  const o = obj(input, ['scene'], 'open');
  if (o.scene !== undefined && (typeof o.scene !== 'string' || !SCENE_ID.test(o.scene))) {
    throw new GroveError('invalid_input', 'scene must be kebab-case (a-z, 0-9, -), max 48 chars');
  }
  return { scene: o.scene };
}

const WALKABLE = ACTIVITIES.filter((a) => a !== 'council');

export function parseAgentFields(input, { hire }) {
  const allowed = hire ? ['id', 'name', 'role', 'palette', 'activity', 'task'] : ['id', 'name', 'role', 'palette', 'activity', 'task', 'error'];
  const o = obj(input, allowed, hire ? 'hireAgent' : 'updateAgent');
  const out = { id: parseId(o.id) };
  if (o.name !== undefined) out.name = str(o.name, 'name', 32);
  if (o.role !== undefined || hire) out.role = oneOf(o.role, ROLE_NAMES, 'role');
  if (o.palette !== undefined) out.palette = oneOf(o.palette, ROBE_NAMES, 'palette');
  if (o.activity !== undefined) {
    if (o.activity === 'council') throw new GroveError('invalid_input', 'use the convene action to send agents to council');
    out.activity = oneOf(o.activity, WALKABLE, 'activity');
  }
  if (o.task !== undefined) out.task = str(o.task, 'task', 200);
  if (o.error !== undefined) out.error = str(o.error, 'error', 120);
  return out;
}

export function parseConvene(input) {
  const o = obj(input, ['topic', 'members'], 'convene');
  const topic = str(o.topic, 'topic', 80, { min: 1 });
  if (!Array.isArray(o.members) || o.members.length < 1 || o.members.length > MAX_COUNCIL) {
    throw new GroveError('invalid_input', `members must list 1–${MAX_COUNCIL} agent ids`);
  }
  const members = o.members.map(parseId);
  if (new Set(members).size !== members.length) throw new GroveError('invalid_input', 'members must be unique');
  return { topic, members };
}

export function parseResolve(input) {
  const o = obj(input, ['decision', 'next'], 'resolveCouncil');
  return {
    decision: o.decision === undefined ? '' : str(o.decision, 'decision', 120),
    next: o.next === undefined ? undefined : oneOf(o.next, WALKABLE, 'next'),
  };
}

export function parseConfigure(input) {
  const o = obj(input, ['theme', 'stations'], 'configureScene');
  const out = {};
  if (o.theme !== undefined) out.theme = oneOf(o.theme, THEMES, 'theme');
  if (o.stations !== undefined) {
    const s = obj(o.stations, STATIONS, 'stations');
    for (const [k, v] of Object.entries(s)) if (typeof v !== 'boolean') throw new GroveError('invalid_input', `stations.${k} must be boolean`);
    out.stations = s;
  }
  return out;
}

export function parseDemo(input) {
  const o = obj(input, ['cycle'], 'summonDemo');
  if (o.cycle !== undefined && typeof o.cycle !== 'boolean') throw new GroveError('invalid_input', 'cycle must be boolean');
  return { cycle: o.cycle !== false };
}

export function parseView(input) {
  const o = obj(input, ['view'], 'setView');
  return oneOf(o.view, VIEWS, 'view');
}

export function parseSnapshotInput(input) {
  const o = obj(input, ['scale'], 'snapshot');
  const scale = o.scale ?? 3;
  if (!Number.isInteger(scale) || scale < 1 || scale > 4) throw new GroveError('invalid_input', 'scale must be an integer 1–4');
  return { scale };
}

export function isValidStoredAgent(a) {
  return isObj(a)
    && typeof a.id === 'string' && AGENT_ID.test(a.id)
    && typeof a.name === 'string' && a.name.length <= 32
    && ROLE_NAMES.includes(a.role)
    && (a.palette === undefined || ROBE_NAMES.includes(a.palette))
    && ACTIVITIES.includes(a.activity)
    && (a.prevActivity === undefined || WALKABLE.includes(a.prevActivity))
    && typeof a.task === 'string' && a.task.length <= 200
    && typeof a.error === 'string' && a.error.length <= 120
    && Number.isFinite(a.hiredAt) && Number.isFinite(a.updatedAt);
}

export function isValidSceneId(v) {
  return typeof v === 'string' && SCENE_ID.test(v);
}
