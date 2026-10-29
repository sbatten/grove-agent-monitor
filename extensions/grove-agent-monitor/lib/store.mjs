// Private durable scene storage under <copilot-home>/extension-data/grove-agent-monitor/.
// Files are versioned, validated on every read, and written atomically.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { GroveError, VIEWS, THEMES, STATIONS, MAX_AGENTS, ROBE_NAMES, isValidStoredAgent, isValidSceneId } from './schema.mjs';

export const CANVAS_ID = 'grove-agent-monitor';
const FORMAT = 'grove-agent-monitor/scene';
const VERSION = 2;

export function resolveDataDirectory() {
  const home = process.env.COPILOT_HOME ? process.env.COPILOT_HOME : path.join(os.homedir(), '.copilot');
  return path.join(home, 'extension-data', CANVAS_ID);
}

export function emptyScene(sceneId) {
  return {
    format: FORMAT, version: VERSION, scene: sceneId, view: 'scene', theme: 'night',
    stations: Object.fromEntries(STATIONS.map((s) => [s, true])),
    agents: [], council: null, lastDecision: null, updatedAt: Date.now(),
  };
}

// v1 agents had a single `state`; map it onto a station activity.
function migrateV1(data) {
  const ACT = { idle: 'idle', thinking: 'planning', working: 'implementing', waiting: 'waiting', done: 'done', error: 'implementing' };
  if (!Array.isArray(data.agents)) return data;
  const next = emptyScene(data.scene);
  next.view = VIEWS.includes(data.view) ? data.view : 'scene';
  next.agents = data.agents.slice(0, MAX_AGENTS).map((a) => ({
    id: a.id, name: a.name ?? a.id, role: 'generalist',
    ...(ROBE_NAMES.includes(a.palette) ? { palette: a.palette } : {}),
    activity: ACT[a.state] ?? 'idle', task: a.task ?? '', error: a.state === 'error' ? 'Error' : '',
    hiredAt: a.updatedAt ?? Date.now(), updatedAt: a.updatedAt ?? Date.now(),
  }));
  return next;
}

function validate(data, sceneId) {
  if (data === null || typeof data !== 'object') return 'not an object';
  if (data.format !== FORMAT) return `unrecognized format ${JSON.stringify(data.format)}`;
  if (data.version !== VERSION) return `unsupported version ${JSON.stringify(data.version)}`;
  if (data.scene !== sceneId) return 'scene id mismatch';
  if (!VIEWS.includes(data.view)) return 'invalid view';
  if (!THEMES.includes(data.theme)) return 'invalid theme';
  if (!data.stations || typeof data.stations !== 'object') return 'invalid stations';
  for (const s of STATIONS) if (typeof data.stations[s] !== 'boolean') return `invalid station flag ${s}`;
  if (Object.keys(data.stations).length !== STATIONS.length) return 'unknown station flag';
  if (!Array.isArray(data.agents) || data.agents.length > MAX_AGENTS) return 'invalid agents list';
  if (!data.agents.every(isValidStoredAgent)) return 'invalid agent record';
  const ids = new Set(data.agents.map((a) => a.id));
  if (ids.size !== data.agents.length) return 'duplicate agent ids';
  if (data.council !== null) {
    const c = data.council;
    if (!c || typeof c.topic !== 'string' || !Array.isArray(c.members) || !Number.isFinite(c.startedAt)) return 'invalid council';
    if (!c.members.every((m) => ids.has(m))) return 'council member not in scene';
  }
  if (data.lastDecision !== null) {
    const d = data.lastDecision;
    if (!d || typeof d.topic !== 'string' || typeof d.decision !== 'string' || !Number.isFinite(d.decidedAt)) return 'invalid lastDecision';
  }
  return null;
}

export class SceneStore {
  constructor(dir = resolveDataDirectory()) {
    this.dir = path.join(dir, 'scenes');
  }

  file(sceneId) {
    if (!isValidSceneId(sceneId)) throw new GroveError('invalid_input', 'invalid scene id');
    return path.join(this.dir, `${sceneId}.json`);
  }

  async mtime(sceneId) {
    try {
      return (await fs.stat(this.file(sceneId))).mtimeMs;
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw new GroveError('storage_failed', `Could not stat scene "${sceneId}": ${err.message}`);
    }
  }

  async load(sceneId) {
    const file = this.file(sceneId);
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { data: emptyScene(sceneId), mtimeMs: 0 };
      throw new GroveError('storage_failed', `Could not read scene "${sceneId}": ${err.message}`);
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new GroveError('storage_corrupt', `Scene file ${file} is not valid JSON; leaving it untouched.`);
    }
    if (data?.format === FORMAT && data.version === 1 && data.scene === sceneId) data = migrateV1(data);
    if (data?.format === FORMAT && Number.isInteger(data.version) && data.version > VERSION) {
      throw new GroveError('storage_newer', `Scene "${sceneId}" was saved by a newer Grove (format v${data.version}); this provider only reads v${VERSION}. An outdated copy of the plugin is loaded. Reload the window or run \`copilot plugin update grove-agent-monitor\`. The file was left untouched.`);
    }
    const problem = validate(data, sceneId);
    if (problem) throw new GroveError('storage_corrupt', `Scene file ${file} is unrecognized (${problem}); leaving it untouched.`);
    return { data, mtimeMs: await this.mtime(sceneId) };
  }

  async save(data) {
    const problem = validate(data, data.scene);
    if (problem) throw new GroveError('storage_failed', `Refusing to write invalid scene: ${problem}`);
    const file = this.file(data.scene);
    const tmp = path.join(this.dir, `.${data.scene}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw new GroveError('storage_failed', `Could not save scene "${data.scene}": ${err.message}`);
    }
    return this.mtime(data.scene);
  }
}
