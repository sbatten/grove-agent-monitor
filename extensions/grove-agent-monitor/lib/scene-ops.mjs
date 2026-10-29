// Pure scene mutations shared by agent actions, the page's controls and the demo.
import { GroveError, MAX_AGENTS, MAX_COUNCIL, ROLE_NAMES, ROBE_NAMES } from './schema.mjs';

function find(scene, id) {
  const a = scene.agents.find((x) => x.id === id);
  if (!a) throw new GroveError('not_found', `No agent "${id}" in scene "${scene.scene}". Hire it first.`);
  return a;
}

function leaveCouncil(scene, id) {
  if (!scene.council) return;
  scene.council.members = scene.council.members.filter((m) => m !== id);
  if (!scene.council.members.length) scene.council = null;
}

export function hire(scene, f, now = Date.now()) {
  if (scene.agents.some((a) => a.id === f.id)) throw new GroveError('already_hired', `Agent "${f.id}" is already hired; use updateAgent.`);
  if (scene.agents.length >= MAX_AGENTS) throw new GroveError('too_many_agents', `A grove holds at most ${MAX_AGENTS} agents; dismiss someone first.`);
  const agent = {
    id: f.id, name: f.name || f.id, role: f.role,
    ...(f.palette ? { palette: f.palette } : {}),
    activity: f.activity ?? 'idle', task: f.task ?? '', error: '', hiredAt: now, updatedAt: now,
  };
  scene.agents.push(agent);
  return agent;
}

export function update(scene, f, now = Date.now()) {
  const a = find(scene, f.id);
  if (f.name !== undefined) a.name = f.name || a.id;
  if (f.role !== undefined) a.role = f.role;
  if (f.palette !== undefined) a.palette = f.palette;
  if (f.task !== undefined) a.task = f.task;
  if (f.activity !== undefined && f.activity !== a.activity) {
    if (a.activity === 'council') leaveCouncil(scene, a.id);
    delete a.prevActivity;
    a.activity = f.activity;
    if (f.error === undefined) a.error = '';
  }
  if (f.error !== undefined) a.error = f.error;
  a.updatedAt = now;
  return a;
}

export function dismiss(scene, id) {
  find(scene, id);
  leaveCouncil(scene, id);
  scene.agents = scene.agents.filter((a) => a.id !== id);
}

export function convene(scene, { topic, members }, now = Date.now()) {
  const agents = members.map((id) => find(scene, id));
  const all = new Set([...(scene.council?.members ?? []), ...members]);
  if (all.size > MAX_COUNCIL) throw new GroveError('council_full', `The council ring seats at most ${MAX_COUNCIL}.`);
  for (const a of agents) {
    if (a.activity !== 'council') {
      a.prevActivity = a.activity;
      a.activity = 'council';
    }
    a.error = '';
    a.updatedAt = now;
  }
  scene.council = { topic, members: [...all], startedAt: scene.council?.startedAt ?? now };
  return scene.council;
}

export function resolveCouncil(scene, { decision, next }, now = Date.now()) {
  if (!scene.council) throw new GroveError('no_council', 'No council is in session.');
  for (const id of scene.council.members) {
    const a = scene.agents.find((x) => x.id === id);
    if (!a) continue;
    a.activity = next ?? a.prevActivity ?? 'idle';
    delete a.prevActivity;
    a.updatedAt = now;
  }
  scene.lastDecision = { topic: scene.council.topic, decision: decision ?? '', decidedAt: now };
  scene.council = null;
}

export function configure(scene, { theme, stations }) {
  if (theme) scene.theme = theme;
  if (stations) Object.assign(scene.stations, stations);
}

export function clear(scene) {
  scene.agents = [];
  scene.council = null;
}

// ---- Demo party ----

const DEMO = [
  ['orion', 'Orion', 'orchestrator', 'violet', 'idle', 'Coordinating the migration'],
  ['quill', 'Quill', 'planner', 'azure', 'planning', 'Drafting the migration plan'],
  ['pip', 'Pip', 'planner', 'rose', 'plan-review', 'Reviewing the rollout plan'],
  ['bolt', 'Bolt', 'implementer', 'dusk', 'implementing', 'Auth middleware'],
  ['ember', 'Ember', 'implementer', 'rose', 'implementing', 'Session store'],
  ['iris', 'Iris', 'reviewer', 'teal', 'code-review', 'Reviewing PR #128'],
  ['sage', 'Sage', 'reviewer', 'moss', 'idle', 'Reviewing schema'],
  ['thorn', 'Thorn', 'tester', 'moss', 'testing', 'Integration suite'],
  ['wren', 'Wren', 'researcher', 'teal', 'research', 'Mapping the API surface'],
  ['lark', 'Lark', 'engineer', 'dusk', 'implementing', 'Writing the migration'],
  ['moss', 'Moss', 'generalist', 'dusk', 'waiting', 'Approve npm install?'],
  ['dax', 'Dax', 'implementer', 'violet', 'done', 'Shipped PR #127'],
];
const RESERVE = [['finch', 'Finch', 'tester', 'azure'], ['nyx', 'Nyx', 'researcher', 'violet'], ['rook', 'Rook', 'implementer', 'teal']];
const TASKS = {
  planning: ['Breaking down the epic', 'Sequencing the rollout', 'Drafting the API plan'],
  'plan-review': ['Checking plan for risks', 'Reviewing the rollout plan'],
  implementing: ['Writing the migration', 'Wiring the auth flow', 'Refactoring the store', 'Adding caching'],
  'code-review': ['Reviewing PR #131', 'Reading the diff', 'Checking edge cases'],
  testing: ['Running unit tests', 'Integration suite', 'Reproducing the bug'],
  research: ['Reading the docs', 'Surveying prior art', 'Tracing the call graph'],
  waiting: ['Approve the deploy?', 'Which region?', 'OK to delete old data?'],
  idle: ['Waiting for work'],
  done: ['Finished the task'],
};
const TOPICS = ['Postgres or SQLite?', 'Ship behind a flag?', 'REST or GraphQL?', 'Split the PR?'];
const DECISIONS = ['Use Postgres', 'Ship behind a flag', 'Keep REST for now', 'Split into two PRs'];
const ERRORS = ['3 type errors', 'Test timeout', 'Merge conflict'];
const pick = (rand, list) => list[Math.floor(rand() * list.length)];

export function isDemo(a) {
  return a.id.startsWith('demo-');
}

// The demo party works in three teams, so the scene shows task pennants, review huddle banners and team
// tents at camp. Added when the scene is sent to the page; never stored. Orion and Moss stay unaffiliated.
const DEMO_TEAMS = {
  D1: { color: 'amber', name: 'Moonfern', title: 'Plan the database migration', members: ['quill', 'pip', 'sage', 'lark'] },
  D2: { color: 'cyan1', name: 'Glimmer', title: 'Harden the auth flow', members: ['bolt', 'ember', 'iris', 'thorn', 'dax', 'finch', 'rook'] },
  D3: { color: 'magenta1', name: 'Wisp', title: 'Map the public API surface', members: ['wren', 'nyx'] },
};

export function demoTeam(a) {
  const short = a.id.slice('demo-'.length);
  for (const [taskId, t] of Object.entries(DEMO_TEAMS)) {
    if (t.members.includes(short)) return { taskId, taskName: t.name, taskColor: t.color, team: t.title };
  }
  return null;
}

export function summonDemo(scene, now = Date.now()) {
  scene.agents = scene.agents.filter((a) => !isDemo(a));
  if (scene.council && scene.council.members.some((m) => m.startsWith('demo-'))) scene.council = null;
  DEMO.forEach(([id, name, role, palette, activity, task], i) => {
    if (scene.agents.length >= MAX_AGENTS) return;
    scene.agents.push({ id: `demo-${id}`, name, role, palette, activity, task, error: '', hiredAt: now - (DEMO.length - i) * 1000, updatedAt: now - 60000 });
  });
  const ember = scene.agents.find((a) => a.id === 'demo-ember');
  if (ember) ember.error = 'Type errors in session.ts';
  const members = ['demo-orion', 'demo-sage'].filter((id) => scene.agents.some((a) => a.id === id));
  if (!scene.council && members.length) convene(scene, { topic: 'Postgres or SQLite?', members }, now);
}

// One random, plausible change to the demo party.
export function demoStep(scene, rand, now = Date.now()) {
  const demo = scene.agents.filter(isDemo);
  if (!demo.length) return false;
  const free = demo.filter((a) => a.activity !== 'council');
  const r = rand();
  if (scene.council && now - scene.council.startedAt > 14000 && r < 0.3) {
    const idx = TOPICS.indexOf(scene.council.topic);
    resolveCouncil(scene, { decision: DECISIONS[idx >= 0 ? idx : 0] }, now);
    return true;
  }
  if (!scene.council && free.length >= 3 && r < 0.2) {
    const members = [...free].sort(() => rand() - 0.5).slice(0, 2 + Math.floor(rand() * 2)).map((a) => a.id);
    convene(scene, { topic: pick(rand, TOPICS), members }, now);
    return true;
  }
  if (r < 0.27) {
    const reserve = RESERVE.find(([id]) => !scene.agents.some((a) => a.id === `demo-${id}`));
    if (reserve && scene.agents.length < MAX_AGENTS) {
      const [id, name, role, palette] = reserve;
      hire(scene, { id: `demo-${id}`, name, role, palette, activity: pick(rand, ['research', 'testing', 'implementing']), task: 'Just hired' }, now);
      return true;
    }
    const leaver = free.filter((a) => a.role !== 'orchestrator' && ['done', 'idle'].includes(a.activity));
    if (leaver.length) { dismiss(scene, pick(rand, leaver).id); return true; }
  }
  if (!free.length) return false;
  const a = pick(rand, free);
  const byRole = {
    orchestrator: ['planning', 'plan-review', 'waiting', 'idle'],
    planner: ['planning', 'plan-review', 'research'],
    implementer: ['implementing', 'implementing', 'testing', 'done'],
    reviewer: ['code-review', 'plan-review', 'idle'],
    tester: ['testing', 'testing', 'idle'],
    researcher: ['research', 'research', 'planning'],
    generalist: ['implementing', 'research', 'waiting', 'idle'],
    // The engineer shapeshifts into each station's class as it works through its steps.
    engineer: ['planning', 'research', 'implementing', 'testing', 'plan-review'],
  }[ROLE_NAMES.includes(a.role) ? a.role : 'generalist'];
  const activity = pick(rand, byRole.filter((x) => x !== a.activity));
  const f = { id: a.id, activity, task: pick(rand, TASKS[activity]) };
  if (['implementing', 'testing'].includes(activity) && rand() < 0.15) f.error = pick(rand, ERRORS);
  if (!ROBE_NAMES.includes(a.palette)) f.palette = pick(rand, ROBE_NAMES);
  update(scene, f, now);
  return true;
}
