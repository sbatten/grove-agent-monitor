import { joinSession, createCanvas, CanvasError } from '@github/copilot-sdk/extension';
import { fileURLToPath } from 'node:url';
import { GroveRuntime } from './lib/runtime.mjs';
import { GroveError, openInputSchema, actionSchemas } from './lib/schema.mjs';
import { CANVAS_ID, resolveDataDirectory } from './lib/store.mjs';
import { GroveProcess } from './lib/process/integration.mjs';

let session;
const log = (message, level = 'info') => {
  if (!session) return;
  void session.log(message, { level }).catch((err) => process.stderr.write(`grove: ${err?.message ?? err}\n`));
};

const runtime = new GroveRuntime({
  webDir: fileURLToPath(new URL('./web/', import.meta.url)),
  dataDir: resolveDataDirectory(),
  log,
});

// Grove process: tools and hooks must be declared at join; the session's role (Chief of Staff, engineer,
// reviewer or neither) and the shared board bind once the session exists.
const grove = new GroveProcess({
  log,
  onChange: () => runtime.processChanged(),
});
runtime.setProcess(grove);

async function guarded(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CanvasError) throw err;
    if (err instanceof GroveError) throw new CanvasError(err.code, err.message);
    log(`Grove canvas failed: ${err?.stack ?? err}`, 'error');
    throw new CanvasError('grove_failed', err?.message ?? String(err));
  }
}

const actions = [
  { name: 'getState', description: 'Return agents, council, theme, station visibility and viewer count.' },
  { name: 'hireAgent', description: 'Hire an agent: it walks in along the road as its role\'s class (orchestrator=archmage, planner=scribe, implementer=artificer, reviewer=seer, tester=warden, researcher=scout, generalist=mage, engineer=mage).', inputSchema: actionSchemas.hireAgent },
  { name: 'updateAgent', description: 'Change an agent\'s activity (it walks to that workstation), task, error, name, role or robe color.', inputSchema: actionSchemas.updateAgent },
  { name: 'dismissAgent', description: 'Dismiss an agent; it walks out of the grove.', inputSchema: actionSchemas.dismissAgent },
  { name: 'convene', description: 'Gather agents at the council ring to discuss a topic and reach a decision.', inputSchema: actionSchemas.convene },
  { name: 'resolveCouncil', description: 'Announce the council\'s decision; members return to prior (or `next`) activities.', inputSchema: actionSchemas.resolveCouncil },
  { name: 'configureScene', description: 'Tweak the scene for the team: time of day theme and which workstations are shown.', inputSchema: actionSchemas.configureScene },
  { name: 'clearAgents', description: 'Dismiss everyone and end any council.' },
  { name: 'summonDemo', description: 'Hire a demo party covering every station; by default it keeps moving between stations.', inputSchema: actionSchemas.summonDemo },
  { name: 'setView', description: 'Switch between the live "scene" and the sprite "gallery".', inputSchema: actionSchemas.setView },
  { name: 'snapshot', description: 'Capture the visible canvas as a PNG image so you can see it. Requires the canvas to be displayed.', inputSchema: actionSchemas.snapshot },
];

session = await joinSession({
  tools: grove.tools(),
  hooks: grove.hooks(),
  canvases: [
    createCanvas({
      id: CANVAS_ID,
      displayName: 'Grove',
      description: 'A hi-detail pixel-art bioluminescent forest where hired agents walk between workstations (planning, review, forge, council…) to show what they are doing.',
      inputSchema: openInputSchema,
      actions: actions.map((a) => ({ ...a, handler: (ctx) => guarded(() => runtime.invoke(ctx.instanceId, a.name, ctx.input)) })),
      open: (ctx) => guarded(() => runtime.open(ctx.instanceId, ctx.input)),
      onClose: (ctx) => guarded(() => runtime.close(ctx.instanceId)),
    }),
  ],
});

try {
  await grove.attach(session);
} catch (err) {
  log(`Grove process unavailable: ${err?.message ?? err}`, 'error');
}

process.once('SIGTERM', () => {
  void Promise.allSettled([runtime.dispose(), grove.dispose()]).then(() => {}).catch((err) => log(`Grove shutdown failed: ${err?.message ?? err}`, 'error')).finally(() => process.exit(0));
});
