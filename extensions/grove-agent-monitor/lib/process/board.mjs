// Shared Grove board. One board belongs to one Chief of Staff session and lives in that session's data
// folder (`files/grove/`), next to the verification evidence. Each task's engineer runs in its own session
// (and so in its own extension process), so every file has exactly one writer:
//
//   board.json            Chief: task numbering, engineer hand-off tokens, notifications already sent.
//   tasks/<T>.json        The task's owner: the Chief until its engineer claims it, then that engineer.
//   decisions/<T>.json    Chief: the human's decisions, applied by whoever owns the task.
//   results/<ticket>.json The reviewer session working that ticket: progress heartbeats and its final review.
//
// A registry entry in <copilot-home>/extension-data/grove-agent-monitor/boards/<board-id>.json maps a board
// id (the Chief's session id) to its folder, so engineers can find it from the id in their hand-off prompt.
//
// Format version 2 is the one-engineer-per-task process. Boards from version 1 (a task lead with a persona
// session per step) aren't migrated: they're left untouched, and the human starts a new Chief of Staff chat.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveDataDirectory } from '../store.mjs';

const VERSION = 2;
const FORMATS = Object.freeze({
  board: 'grove-agent-monitor/board',
  task: 'grove-agent-monitor/task',
  decisions: 'grove-agent-monitor/decisions',
  link: 'grove-agent-monitor/board-link',
  result: 'grove-agent-monitor/result',
});
const TICKET_ID = /^T\d{1,6}-[a-z0-9-]{1,40}$/;
export const isTicketId = (id) => typeof id === 'string' && TICKET_ID.test(id);
const BOARD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TASK_ID = /^T\d{1,6}$/;

export class BoardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const isBoardId = (id) => typeof id === 'string' && BOARD_ID.test(id);
export const isTaskId = (id) => typeof id === 'string' && TASK_ID.test(id);

// Boards only ever live in a session's data folder (<session>/files/grove), so a registry entry cannot
// point engineers at an arbitrary directory.
async function canonicalBoardRoot(root) {
  let real;
  try {
    real = await fs.realpath(root);
  } catch {
    throw new BoardError('not_found', `Grove board folder ${root} is missing.`);
  }
  if (path.basename(real) !== 'grove' || path.basename(path.dirname(real)) !== 'files') {
    throw new BoardError('invalid_board', `${root} is not a session data folder; refusing to use it as a Grove board.`);
  }
  return real;
}

export function registryDir() {
  return path.join(resolveDataDirectory(), 'boards');
}

async function readJson(file, format) {
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new BoardError('storage_failed', `Could not read ${file}: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BoardError('storage_corrupt', `${file} is not valid JSON; leaving it untouched.`);
  }
  if (data?.format !== format) throw new BoardError('storage_corrupt', `${file} is not a recognized Grove file; leaving it untouched.`);
  if (typeof data.version === 'number' && data.version < VERSION) {
    throw new BoardError('storage_older', `${file} is from an earlier Grove process (format version ${data.version}; this Grove uses version ${VERSION}). Old boards aren't migrated: start a new Chief of Staff chat for a fresh board. The old files are left untouched.`);
  }
  if (data.version !== VERSION) throw new BoardError('storage_newer', `${file} uses format version ${data.version}, but this Grove understands version ${VERSION}; leaving it untouched.`);
  return data;
}

async function writeJson(file, data) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw new BoardError('storage_failed', `Could not write ${file}: ${err.message}`);
  }
}

function validMeta(m) {
  return m && isBoardId(m.id) && Number.isInteger(m.nextTask) && m.nextTask >= 1
    && m.handoffs && typeof m.handoffs === 'object' && m.notified && typeof m.notified === 'object';
}

function validTask(t) {
  return t && isTaskId(t.id) && typeof t.stage === 'string' && typeof t.owner === 'string'
    && Array.isArray(t.tickets) && Array.isArray(t.history) && (Array.isArray(t.steps) || (t.forum?.plan && t.forum?.code));
}

export class Board {
  constructor(root, meta, log = () => {}) {
    this.root = root;
    this.meta = meta;
    this.log = log;
    this.writes = Promise.resolve();
    this.reported = new Set();
  }

  get id() {
    return this.meta.id;
  }

  static metaFile(root) {
    return path.join(root, 'board.json');
  }

  static async exists(root) {
    try {
      await fs.access(Board.metaFile(root));
      return true;
    } catch {
      return false;
    }
  }

  // Open the Chief's board in its own session folder, creating it (and its registry link) on first use.
  static async openOrCreate(root, { id, chiefSessionId, log }) {
    if (!isBoardId(id)) throw new BoardError('invalid_board', `"${id}" is not a valid board id.`);
    let meta = await readJson(Board.metaFile(root), FORMATS.board);
    if (meta && !validMeta(meta)) throw new BoardError('storage_corrupt', `${Board.metaFile(root)} is malformed; leaving it untouched.`);
    const board = new Board(root, meta, log);
    if (!meta) {
      board.meta = { format: FORMATS.board, version: VERSION, id, chiefSessionId, nextTask: 1, handoffs: {}, notified: {}, createdAt: Date.now(), updatedAt: Date.now() };
      await board.saveMeta();
    } else {
      await board.link();
    }
    return board;
  }

  static async open(root, log) {
    const meta = await readJson(Board.metaFile(root), FORMATS.board);
    if (!meta) throw new BoardError('not_found', `No Grove board in ${root}.`);
    if (!validMeta(meta)) throw new BoardError('storage_corrupt', `${Board.metaFile(root)} is malformed; leaving it untouched.`);
    return new Board(root, meta, log);
  }

  // Find a board by id through the registry. The registry only points at folders that contain a board
  // whose own id matches, so a hand-off prompt can never redirect writes to an arbitrary folder.
  static async resolve(id, log) {
    if (!isBoardId(id)) throw new BoardError('invalid_board', `"${id}" is not a valid board id.`);
    const link = await readJson(path.join(registryDir(), `${id}.json`), FORMATS.link);
    if (!link || typeof link.root !== 'string' || !path.isAbsolute(link.root)) throw new BoardError('not_found', `Grove board ${id} is not registered on this machine.`);
    const root = await canonicalBoardRoot(link.root);
    const board = await Board.open(root, log);
    if (board.id !== id) throw new BoardError('not_found', `Grove board ${id} is not registered on this machine.`);
    return board;
  }

  // The most recently active registered board (used by canvases opened outside any Grove session).
  static async latest(log) {
    let names;
    try {
      names = await fs.readdir(registryDir());
    } catch {
      return null;
    }
    let best = null;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const link = await readJson(path.join(registryDir(), name), FORMATS.link);
        if (link && typeof link.root === 'string' && path.isAbsolute(link.root) && (!best || link.updatedAt > best.updatedAt)) best = link;
      } catch {
        /* skip unreadable links */
      }
    }
    if (!best) return null;
    try {
      return await Board.open(await canonicalBoardRoot(best.root), log);
    } catch {
      return null;
    }
  }

  async link() {
    await writeJson(path.join(registryDir(), `${this.id}.json`), { format: FORMATS.link, version: VERSION, id: this.id, root: this.root, updatedAt: Date.now() });
  }

  queue(fn) {
    const p = this.writes.then(fn);
    this.writes = p.catch(() => {});
    return p;
  }

  flush() {
    return this.writes;
  }

  saveMeta() {
    this.meta.updatedAt = Date.now();
    const snapshot = structuredClone(this.meta);
    return this.queue(async () => {
      await writeJson(Board.metaFile(this.root), snapshot);
      await this.link();
    });
  }

  async reloadMeta() {
    const meta = await readJson(Board.metaFile(this.root), FORMATS.board);
    if (validMeta(meta)) this.meta = meta;
    return this.meta;
  }

  taskFile(id) {
    return path.join(this.root, 'tasks', `${id}.json`);
  }

  resultFile(ticketId) {
    if (!isTicketId(ticketId)) throw new BoardError('invalid_ticket', `"${ticketId}" is not a ticket id.`);
    return path.join(this.root, 'results', `${ticketId}.json`);
  }

  // Member session only: report progress or the final result for its ticket.
  writeResult(result) {
    const data = { format: FORMATS.result, version: VERSION, ...result, at: Date.now() };
    return this.queue(() => writeJson(this.resultFile(result.ticket), data));
  }

  async readResult(ticketId) {
    return readJson(this.resultFile(ticketId), FORMATS.result);
  }

  async readResults() {
    let names;
    try {
      names = await fs.readdir(path.join(this.root, 'results'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new BoardError('storage_failed', `Could not list Grove results: ${err.message}`);
    }
    const out = [];
    for (const name of names) {
      const id = name.replace(/\.json$/, '');
      if (!name.endsWith('.json') || !isTicketId(id)) continue;
      try {
        const r = await this.readResult(id);
        if (r && r.ticket === id && typeof r.status === 'string') out.push(r);
      } catch (err) {
        this.warnOnce(name, err.message);
      }
    }
    return out;
  }

  decisionsFile(id) {
    return path.join(this.root, 'decisions', `${id}.json`);
  }

  // Fenced write: refused when the file on disk now belongs to someone other than `expectedOwner`
  // (another engineer took the task over), so a replaced engineer can never overwrite its successor.
  saveTask(task, expectedOwner = task.owner) {
    const snapshot = { format: FORMATS.task, version: VERSION, task: structuredClone(task) };
    return this.queue(async () => {
      const current = await readJson(this.taskFile(task.id), FORMATS.task).catch(() => null);
      if (current?.task && current.task.owner !== expectedOwner) throw new BoardError('not_owner', `${task.id} is now owned by another session.`);
      await writeJson(this.taskFile(task.id), snapshot);
    });
  }

  async readTasks() {
    let names;
    try {
      names = await fs.readdir(path.join(this.root, 'tasks'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw new BoardError('storage_failed', `Could not list Grove tasks: ${err.message}`);
    }
    const out = [];
    for (const name of names) {
      const m = /^(T\d{1,6})\.json$/.exec(name);
      if (!m) continue;
      try {
        const data = await readJson(this.taskFile(m[1]), FORMATS.task);
        if (data && validTask(data.task) && data.task.id === m[1]) out.push(data.task);
        else if (data) this.warnOnce(name, `Grove task file ${name} is malformed; skipping it.`);
      } catch (err) {
        this.warnOnce(name, err.message);
      }
    }
    return out.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }

  async readDecisions(taskId) {
    const data = await readJson(this.decisionsFile(taskId), FORMATS.decisions);
    if (!data) return [];
    if (!Array.isArray(data.items)) throw new BoardError('storage_corrupt', `${this.decisionsFile(taskId)} is malformed; leaving it untouched.`);
    return data.items.filter((d) => Number.isInteger(d?.seq) && typeof d.action === 'string');
  }

  // Chief only: append the human's decision for the task's owner to apply.
  // `via` is 'grove' when the human decided in the canvas inbox rather than in the Chief's chat.
  async appendDecision(taskId, { action, note, via = 'chat' }) {
    const items = await this.readDecisions(taskId);
    const item = { seq: (items.at(-1)?.seq ?? 0) + 1, action, note, via, at: Date.now() };
    items.push(item);
    await this.queue(() => writeJson(this.decisionsFile(taskId), { format: FORMATS.decisions, version: VERSION, task: taskId, items }));
    return item;
  }

  // Cheap change detector: names + mtimes of every board file.
  async signature() {
    const parts = [];
    for (const sub of ['', 'tasks', 'decisions', 'results']) {
      const dir = path.join(this.root, sub);
      let names;
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        if (!name.endsWith('.json')) continue;
        try {
          const st = await fs.stat(path.join(dir, name));
          parts.push(`${sub}/${name}:${st.mtimeMs}:${st.size}`);
        } catch {
          /* raced with a rename */
        }
      }
    }
    return parts.join('|');
  }

  warnOnce(key, message) {
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.log(message, 'warning');
  }
}

export function newHandoffToken() {
  return crypto.randomBytes(8).toString('hex');
}

// An engineer session remembers which board/task it works on in its own session folder.
const LEAD_FORMAT = 'grove-agent-monitor/lead';

export async function readLeadLink(file) {
  const data = await readJson(file, LEAD_FORMAT);
  if (!data) return null;
  if (!isBoardId(data.boardId) || !isTaskId(data.taskId)) throw new BoardError('storage_corrupt', `${file} is malformed; leaving it untouched.`);
  return { boardId: data.boardId, taskId: data.taskId };
}

export function writeLeadLink(file, { boardId, taskId }) {
  return writeJson(file, { format: LEAD_FORMAT, version: VERSION, boardId, taskId, at: Date.now() });
}

// A reviewer session remembers the ticket it is working on in its own session folder.
const MEMBER_FORMAT = 'grove-agent-monitor/member';

export async function readMemberLink(file) {
  const data = await readJson(file, MEMBER_FORMAT);
  if (!data) return null;
  if (!isBoardId(data.boardId) || !isTicketId(data.ticketId) || typeof data.token !== 'string') throw new BoardError('storage_corrupt', `${file} is malformed; leaving it untouched.`);
  return { boardId: data.boardId, ticketId: data.ticketId, token: data.token, revivals: Number.isInteger(data.revivals) ? data.revivals : 0 };
}

export function writeMemberLink(file, { boardId, ticketId, token, revivals = 0 }) {
  return writeJson(file, { format: MEMBER_FORMAT, version: VERSION, boardId, ticketId, token, revivals, at: Date.now() });
}
