import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { promises as fs, createReadStream } from 'node:fs';
import { renderReport } from './process/report.mjs';
import { ProcessError } from './process/engine.mjs';
import { BoardError } from './process/board.mjs';
import { INBOX_ACTION_NAMES } from './process/integration.mjs';
import { SceneStore } from './store.mjs';
import {
  GroveError, parseOpenInput, parseAgentFields, parseId, parseConvene, parseResolve, parseConfigure, parseDemo, parseView, parseSnapshotInput,
} from './schema.mjs';
import * as ops from './scene-ops.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors *";
// Task reports are static pages: inline styles, the task's own evidence, no scripts.
const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors *";
const TASK_ID = /^T\d{1,6}$/;
const REPORT_ROUTE = /^\/report\/(T\d{1,6})(\/.*)?$/;
const SNAPSHOT_TIMEOUT_MS = 6000;
const DEMO_STEP_MS = 4500;

export class GroveRuntime {
  constructor({ webDir, dataDir, log }) {
    this.webDir = path.resolve(webDir);
    this.store = new SceneStore(dataDir);
    this.log = log;
    this.instances = new Map();
    this.scenes = new Map();
    this.locks = new Map();
    this.demoTimers = new Map();
    this.process = null;
    this.processTimer = null;
  }

  // Attach the Chief-of-Staff process; its agents, council and task board overlay every scene.
  setProcess(proc) {
    this.process = proc;
  }

  processChanged() {
    if (this.processTimer) return;
    this.processTimer = setTimeout(() => {
      this.processTimer = null;
      for (const sceneId of new Set([...this.instances.values()].map((i) => i.sceneId))) this.broadcast(sceneId);
    }, 120);
    this.processTimer.unref?.();
  }

  view(data) {
    const base = publicState(data);
    base.agents = base.agents.map((a) => (ops.isDemo(a) ? { ...a, ...ops.demoTeam(a) } : a));
    if (!this.process) return base;
    const live = this.process.liveView();
    return {
      ...base,
      agents: [...base.agents, ...live.agents],
      council: base.council ?? live.council,
      lastDecision: [base.lastDecision, live.lastDecision].filter(Boolean).sort((a, b) => b.decidedAt - a.decidedAt)[0] ?? null,
      process: live.process,
    };
  }

  // Serialize work per scene inside this process.
  withLock(sceneId, fn) {
    const prev = this.locks.get(sceneId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(sceneId, next.catch(() => {}));
    return next;
  }

  async loadScene(sceneId) {
    const cached = this.scenes.get(sceneId);
    const mtimeMs = await this.store.mtime(sceneId);
    if (cached && cached.mtimeMs === mtimeMs) return cached.data;
    const loaded = await this.store.load(sceneId);
    this.scenes.set(sceneId, loaded);
    return loaded.data;
  }

  mutate(sceneId, fn) {
    return this.withLock(sceneId, async () => {
      const current = await this.loadScene(sceneId);
      const next = structuredClone(current);
      fn(next);
      next.updatedAt = Date.now();
      const mtimeMs = await this.store.save(next);
      this.scenes.set(sceneId, { data: next, mtimeMs });
      this.broadcast(sceneId);
      return next;
    });
  }

  broadcast(sceneId) {
    const data = this.scenes.get(sceneId)?.data;
    if (!data) return;
    for (const inst of this.instances.values()) {
      if (inst.sceneId !== sceneId) continue;
      for (const res of inst.clients) sse(res, 'state', this.view(data));
    }
  }

  async open(instanceId, input) {
    const { scene } = parseOpenInput(input);
    const existing = this.instances.get(instanceId);
    const sceneId = scene ?? existing?.sceneId ?? 'default';
    const data = await this.withLock(sceneId, () => this.loadScene(sceneId));
    if (existing?.server.listening) {
      if (existing.sceneId !== sceneId) {
        existing.sceneId = sceneId;
        this.broadcast(sceneId);
      }
      return this.openResult(existing, data);
    }
    const inst = { instanceId, sceneId, clients: new Set(), pending: new Map(), server: null, port: 0 };
    inst.server = http.createServer((req, res) => {
      this.handle(inst, req, res).catch((err) => {
        this.log(`Grove request failed: ${err.message}`, 'error');
        if (!res.headersSent) json(res, err instanceof GroveError ? 400 : 500, { error: err.message });
        else res.end();
      });
    });
    await new Promise((resolve, reject) => {
      inst.server.once('error', reject);
      inst.server.listen(0, '127.0.0.1', resolve);
    });
    inst.port = inst.server.address().port;
    inst.heartbeat = setInterval(() => { for (const res of inst.clients) res.write(': hb\n\n'); }, 25000);
    inst.heartbeat.unref();
    this.instances.set(instanceId, inst);
    this.log(`Grove canvas "${instanceId}" serving scene "${sceneId}" on 127.0.0.1:${inst.port}`);
    return this.openResult(inst, data);
  }

  openResult(inst, data) {
    return {
      url: `http://127.0.0.1:${inst.port}/`,
      title: `Grove · ${inst.sceneId}`,
      status: `${data.agents.length} agent${data.agents.length === 1 ? '' : 's'}`,
    };
  }

  async close(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.instances.delete(instanceId);
    clearInterval(inst.heartbeat);
    for (const p of inst.pending.values()) p.reject(new GroveError('closed', 'Canvas closed'));
    for (const res of inst.clients) res.end();
    await new Promise((resolve) => inst.server.close(() => resolve()));
  }

  async dispose() {
    for (const t of this.demoTimers.values()) clearInterval(t);
    this.demoTimers.clear();
    await Promise.all([...this.instances.keys()].map((id) => this.close(id)));
  }

  instance(instanceId) {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new GroveError('not_open', `No open Grove canvas "${instanceId}". Call open_canvas first.`);
    return inst;
  }

  // ---- Agent-facing actions ----

  async invoke(instanceId, action, input) {
    const inst = this.instance(instanceId);
    const sceneId = inst.sceneId;
    const mutate = async (fn) => summarize(await this.mutate(sceneId, fn));
    switch (action) {
      case 'getState': {
        const data = await this.withLock(sceneId, () => this.loadScene(sceneId));
        return { ...this.view(data), viewers: inst.clients.size };
      }
      case 'hireAgent': {
        const f = parseAgentFields(input, { hire: true });
        return mutate((s) => ops.hire(s, f));
      }
      case 'updateAgent': {
        const f = parseAgentFields(input, { hire: false });
        return mutate((s) => ops.update(s, f));
      }
      case 'dismissAgent': {
        const id = parseId(input?.id);
        return mutate((s) => ops.dismiss(s, id));
      }
      case 'convene': {
        const c = parseConvene(input);
        return mutate((s) => ops.convene(s, c));
      }
      case 'resolveCouncil': {
        const r = parseResolve(input);
        return mutate((s) => ops.resolveCouncil(s, r));
      }
      case 'configureScene': {
        const c = parseConfigure(input);
        return mutate((s) => ops.configure(s, c));
      }
      case 'clearAgents':
        this.stopDemo(sceneId);
        return mutate((s) => ops.clear(s));
      case 'summonDemo': {
        const { cycle } = parseDemo(input);
        const out = await mutate((s) => ops.summonDemo(s));
        if (cycle) this.startDemo(sceneId); else this.stopDemo(sceneId);
        return { ...out, demoCycling: cycle };
      }
      case 'setView': {
        const view = parseView(input);
        return mutate((s) => { s.view = view; });
      }
      case 'snapshot':
        return this.snapshot(inst, parseSnapshotInput(input));
      default:
        throw new GroveError('unknown_action', `Unknown action "${action}"`);
    }
  }

  startDemo(sceneId) {
    if (this.demoTimers.has(sceneId)) return;
    const rand = Math.random;
    const timer = setInterval(() => {
      this.mutate(sceneId, (s) => {
        if (!s.agents.some(ops.isDemo)) throw new GroveError('demo_over', 'no demo agents');
        ops.demoStep(s, rand);
      }).catch((err) => {
        if (err.code !== 'demo_over') this.log(`Grove demo step failed: ${err.message}`, 'warning');
        this.stopDemo(sceneId);
      });
    }, DEMO_STEP_MS);
    timer.unref();
    this.demoTimers.set(sceneId, timer);
  }

  stopDemo(sceneId) {
    clearInterval(this.demoTimers.get(sceneId));
    this.demoTimers.delete(sceneId);
  }

  async snapshot(inst, { scale }) {
    const client = [...inst.clients].at(-1);
    if (!client) throw new GroveError('no_viewer', 'The Grove canvas is not currently displayed, so it cannot be captured. Open it with open_canvas and retry.');
    const requestId = crypto.randomUUID();
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inst.pending.delete(requestId);
        reject(new GroveError('snapshot_timeout', 'The canvas did not respond with a snapshot in time.'));
      }, SNAPSHOT_TIMEOUT_MS);
      inst.pending.set(requestId, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
    sse(client, 'snapshot', { requestId, scale });
    const shot = await result;
    const data = this.scenes.get(inst.sceneId)?.data;
    return {
      textResultForLlm: `Snapshot of Grove scene "${inst.sceneId}" (${shot.view} view, ${shot.width}x${shot.height}px at ${scale}x, ${data?.agents.length ?? 0} agents).`,
      binaryResultsForLlm: [{ data: shot.png, mimeType: 'image/png', type: 'image', description: `Grove ${shot.view} snapshot` }],
      resultType: 'success',
    };
  }

  // ---- HTTP ----

  async handle(inst, req, res) {
    const host = req.headers.host;
    if (host !== `127.0.0.1:${inst.port}` && host !== `localhost:${inst.port}`) return json(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, `http://${host}`);
    const route = url.pathname;

    if (req.method === 'GET') {
      if (route === '/' || route === '/index.html') return this.serveFile(res, 'index.html');
      if (route.startsWith('/static/')) return this.serveFile(res, decodeURIComponent(route.slice('/static/'.length)));
      if (route === '/api/state') return json(res, 200, this.view(await this.loadScene(inst.sceneId)));
      if (route === '/api/events') return this.openEvents(inst, req, res);
      const rep = REPORT_ROUTE.exec(route);
      if (rep) return this.serveReport(req, res, rep[1], rep[2]);
      return json(res, 404, { error: 'not found' });
    }

    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return json(res, 403, { error: 'cross-origin request rejected' });
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'expected application/json' });
    const body = await readJson(req, route === '/api/snapshot' ? 12 * 1024 * 1024 : 16 * 1024);
    const sceneId = inst.sceneId;

    switch (route) {
      case '/api/view':
        return json(res, 200, this.view(await this.mutate(sceneId, (s) => { s.view = parseView(body); })));
      case '/api/configure': {
        const c = parseConfigure(body);
        return json(res, 200, this.view(await this.mutate(sceneId, (s) => ops.configure(s, c))));
      }
      case '/api/demo': {
        const out = this.view(await this.mutate(sceneId, (s) => ops.summonDemo(s)));
        this.startDemo(sceneId);
        return json(res, 200, out);
      }
      case '/api/clear':
        this.stopDemo(sceneId);
        return json(res, 200, this.view(await this.mutate(sceneId, (s) => ops.clear(s))));
      case '/api/inbox/decide': {
        const taskId = parseTaskId(body?.taskId);
        if (!INBOX_ACTION_NAMES.includes(body?.action)) throw new GroveError('invalid_input', `action must be one of ${INBOX_ACTION_NAMES.join(', ')}`);
        const out = await this.processCall(() => this.process.inboxDecide(taskId, body.action));
        this.processChanged();
        return json(res, 200, out);
      }
      case '/api/inbox/attach': {
        const taskId = parseTaskId(body?.taskId);
        if (body?.attach !== undefined && typeof body.attach !== 'boolean') throw new GroveError('invalid_input', 'attach must be true or false');
        const out = await this.processCall(() => this.process.attachTask(taskId, { attach: body?.attach !== false }));
        this.processChanged();
        return json(res, 200, out);
      }
      case '/api/snapshot': {
        const p = typeof body?.requestId === 'string' && inst.pending.get(body.requestId);
        if (!p) return json(res, 404, { error: 'unknown snapshot request' });
        inst.pending.delete(body.requestId);
        if (typeof body.png !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.png)) {
          p.reject(new GroveError('snapshot_failed', 'Canvas returned an invalid image'));
          return json(res, 400, { error: 'invalid png' });
        }
        p.resolve({ png: body.png, width: Number(body.width) | 0, height: Number(body.height) | 0, view: body.view === 'gallery' ? 'gallery' : 'scene' });
        return json(res, 200, { ok: true });
      }
      default:
        return json(res, 404, { error: 'not found' });
    }
  }

  // Process errors (not the Chief, task not waiting…) are the caller's to fix, not server failures.
  async processCall(fn) {
    if (!this.process?.ready) throw new GroveError('no_process', 'The Grove process is not running in this session.');
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ProcessError || err instanceof BoardError) throw new GroveError(err.code, err.message);
      throw err;
    }
  }

  // GET /report/T3/ renders T3's report from the board; /report/T3/evidence/… serves its evidence files.
  async serveReport(req, res, taskId, rest) {
    if (!rest) {
      res.writeHead(308, { Location: `/report/${taskId}/`, 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (rest === '/') {
      const r = this.process?.reportFor(taskId);
      if (!r) return json(res, 404, { error: `no task ${taskId}` });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': REPORT_CSP, 'X-Content-Type-Options': 'nosniff' });
      return res.end(renderReport(r.task, r));
    }
    let rel;
    try {
      rel = decodeURIComponent(rest.slice(1));
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    const ev = this.process?.evidenceFile(taskId, rel);
    if (!ev) return json(res, 404, { error: 'not found' });
    let st;
    try {
      st = await fs.stat(ev.file);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    const headers = { 'Content-Type': ev.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" };
    // Videos seek with range requests.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return createReadStream(ev.file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    return createReadStream(ev.file).pipe(res);
  }

  async serveFile(res, rel) {
    const file = path.resolve(this.webDir, rel);
    const ext = path.extname(file);
    if (!file.startsWith(this.webDir + path.sep) || !MIME[ext]) return json(res, 404, { error: 'not found' });
    let body;
    try {
      body = await fs.readFile(file);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  }

  async openEvents(inst, req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 1500\n\n');
    inst.clients.add(res);
    req.on('close', () => inst.clients.delete(res));
    sse(res, 'state', this.view(await this.loadScene(inst.sceneId)));
  }
}

// Compact result for mutating actions: enough to confirm the change without echoing everything.
function summarize(data) {
  return {
    agents: data.agents.map((a) => `${a.id} (${a.role}) ${a.activity}${a.error ? ` ERROR: ${a.error}` : ''}`),
    council: data.council ? { topic: data.council.topic, members: data.council.members } : null,
    lastDecision: data.lastDecision,
    theme: data.theme,
    hiddenStations: Object.entries(data.stations).filter(([, v]) => !v).map(([k]) => k),
  };
}

function parseTaskId(v) {
  if (typeof v !== 'string' || !TASK_ID.test(v)) throw new GroveError('invalid_input', 'taskId must look like "T3"');
  return v;
}

function publicState(data) {
  const { format, version, ...rest } = data;
  return rest;
}

function sse(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(payload));
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new GroveError('too_large', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new GroveError('invalid_input', 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
