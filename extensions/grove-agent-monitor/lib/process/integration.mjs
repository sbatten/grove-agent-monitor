// Wires the Grove process into a Copilot session. Every session (chat) runs its own copy of this extension
// and plays one role:
//
//   chief   The Chief of Staff. It owns the board, creates tasks and hands each one to a new engineer
//           session (create_session), so it never blocks. The engineer messages it when a task needs the
//           human, and the Chief records the human's decision and messages the engineer.
//   lead    The task's engineer: a session started from a hand-off prompt. It owns the task's state, does
//           each step's work itself (loading the step's skill), submits each step's output with grove_submit,
//           and hires the step's reviewers (create_session the first time, send_message after that). In the
//           code this role is still called `lead`: the session that owns the task.
//   member  A reviewer session started from a hire marker. Grove expands the marker into the full brief,
//           checks the final message for a verdict when the turn ends (sending it back if needed), and
//           records the review. Every reviewer reports back to the engineer with send_message when it's done.
//   none    Any other session. Hooks stay out of the way; a canvas opened here shows the latest board.
//
// One session = one sprite in the grove. The engineer's sprite walks between workstations as its steps
// (and the skills it loads) change.
//
// Hand-offs between sessions are messages one model sends another with the host's send_message tool, so
// every turn is visible in VS Code: reviewers report to the engineer, the engineer tells the Chief when the
// human is needed, and the Chief passes the human's decision back to the engineer. Grove's own wake-ups
// (session.send) are only a fallback when an expected message doesn't arrive in time: hosts may not show
// turns an extension starts, and some host tools (tool search) don't run in them.
//
// Session layout in the host: each engineer is its own top-level session (the Chief starts it with
// relationship "independent" at the task's destination), and every reviewer is a nested chat inside its
// engineer's session (relationship "currentSession"). So a task's whole team is grouped under its engineer.
// Grove's preToolUse hook enforces both by correcting the create_session arguments.
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import {
  ProcessEngine, ProcessError, MAX_ROUNDS, MAX_BLOCKS, memberTitle, stepLabel, stageLabel, KIND_LABELS, STEP_KINDS, TEMPLATES, REVIEWER_FOCUS, LEAD,
  WAITING_STAGES, PAUSED_STAGES, SHIPPING_STAGES, DECISIONS, TASK_KINDS, KIND_SKILLS, STAGE_LABELS, SHELVABLE, prLine, currentStep,
} from './engine.mjs';
import { execFile } from 'node:child_process';
import {
  briefFor, hireInstruction, engineerHandoff, engineerBrief, engineerContext, engineerWake, relayDelivery, DELIVERY_FALLBACK, stepAssignment, chiefNotice, chiefAnswer,
  memberContext, memberRevive, LEAD_MARKER, MEMBER_MARKER, RELAY_MARKER, reportMessage, noticeMessage, decisionMessage,
} from './prompts.mjs';
import { validateEvidence } from './evidence.mjs';
import { memberModel, engineerModel } from './models.mjs';
import {
  PlacementError, DESTINATION_MODES, destination, engineerPlacement, reviewerPlacement,
  observePlacement, prepareReviewer, repairTarget, confirmationForm, localPath,
} from './placement.mjs';
import { taskName, taskLabel, taskTag, findTask } from './names.mjs';
import { writeReport, reportPath, evidenceRel } from './report.mjs';
import { TASK_COLORS } from '../../web/model.mjs';
import { Board, BoardError, newHandoffToken, readLeadLink, writeLeadLink, readMemberLink, writeMemberLink } from './board.mjs';

const SUBAGENT_TOOLS = /^(task|agent|runsubagent|run_subagent|custom-agent|launch_agent|subagent)$/i;
const HIRE_TOOLS = new Set(['create_session', 'send_message']);
// Where the engineer works for each kind of step, and where it meets its reviewers.
const KIND_ACTIVITY = { plan: 'planning', research: 'research', execute: 'implementing', verify: 'testing' };
const SPECIALTY_ROBE = { security: 'rose', tests: 'teal', code: 'violet', architecture: 'azure', accuracy: 'moss' };
const ROLE_NAMES = { chief: 'the Chief of Staff', lead: 'the task\'s engineer', member: 'a reviewer' };
const TERMINAL = new Set(['done', 'cancelled']);
const WAITING = WAITING_STAGES;
// Stages in which the engineer has nothing to do until the human (or GitHub) moves.
const LEAD_IDLE = new Set([...WAITING_STAGES, ...PAUSED_STAGES, ...SHIPPING_STAGES, 'shelved']);
const PR_POLL_MS = 2 * 60 * 1000;
const PR_FIELDS = 'state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefOid,url,number';
const DECISION_OUTCOMES = {
  question: 'asked', hold: 'on hold', resume: 'back to work', retry: 'back to work', merge: 'being merged', note: 'passed on',
  shelve: 'on the shelf', unshelve: 'back in the inbox',
};
// Decisions the engineer has nothing to do for: its Grove applies them from the board without waking it.
const QUIET_DECISIONS = new Set(['shelve', 'unshelve']);

// What a decision does to the task, in a few words.
function decisionOutcome(t, before, decision, ship) {
  if (decision === 'cancel') return 'cancelled';
  if (before === 'shelved' && !QUIET_DECISIONS.has(decision)) before = t.shelf?.from ?? before;
  if (decision === 'merge' || (decision === 'approve' && before === 'ready-to-merge')) return 'being merged';
  if (decision === 'approve' && before === 'awaiting-approval') return t.delivery?.ship && ship !== false ? 'shipping' : 'done';
  if (decision === 'changes' && before === 'done') return 'reopened';
  return DECISION_OUTCOMES[decision] ?? 'back to work';
}

// What GitHub says about a PR, through the gh CLI.
function ghPrStatus(url) {
  return new Promise((resolve, reject) => {
    execFile('gh', ['pr', 'view', url, '--json', PR_FIELDS], { timeout: 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || err.message).trim().split('\n')[0] || 'gh failed'));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('gh returned something other than JSON'));
      }
    });
  });
}

// Two links name the same session when they match before any ?chat=.
function sameSession(a, b) {
  const base = (x) => String(x ?? '').trim().split('?')[0].replace(/\/+$/, '');
  return !!a && !!b && base(a) === base(b);
}
const IN_FLIGHT = new Set(['dispatched', 'running']);
// The Chief coordinates: tasks, sessions, the canvas. Everything else (git, GitHub, files, research) is a
// task for a team, so it stays available to the human.
const CHIEF_TOOLS = new Set([
  'create_session', 'send_message', 'get_current_session', 'list_sessions', 'get_session_context', 'report_intent', 'rename_chat',
  'open_canvas', 'invoke_canvas_action', 'list_canvas_capabilities', 'add_artifact_or_reference', 'list_artifacts_and_references',
]);
const isDiscoveryTool = (name) => /tool_?search|search_?tools|find_?tools?|discover_?tools?/i.test(name);
const MAX_STOP_BLOCKS = 3;
const MAX_REVIVES = 2;
const HEARTBEAT_MS = 30 * 1000;
const POLL_MS = 1000;
// How long to wait for an expected message before Grove wakes a session itself.
const GRACE_MS = 45 * 1000;
const SESSION_LINK = /agent-host-session:\/\/[^\s)"'\]]+/;
const isSessionLink = (v) => typeof v === 'string' && /^agent-host-session:\/\/[^\s]+$/.test(v);
const LATEST_EVERY = 5;
// create_session reports the new chat's own link, which carries a chat id.
const CHAT_LINK = /agent-host-session:\/\/[^\s)"'\]]+[?&]chat=[A-Za-z0-9-]+/;
const MAX_LEAD_WAKES = 3;
const INBOX_WORDS = { approve: 'signed off', merge: 'asked to merge', cancel: 'dismissed', shelve: 'shelved', unshelve: 'took off the shelf' };
const INBOX_ACTIONS = { complete: 'approve', merge: 'merge', dismiss: 'cancel', shelve: 'shelve', unshelve: 'unshelve' };
// The buttons the Grove inbox may send (the canvas server checks requests against this).
export const INBOX_ACTION_NAMES = Object.freeze(Object.keys(INBOX_ACTIONS));
export { TASK_COLORS };
export function taskColor(taskId) {
  const n = Number(String(taskId).replace(/\D/g, '')) || 1;
  return TASK_COLORS[(n - 1) % TASK_COLORS.length];
}

export function resolveFilesRoot(session) {
  if (session.workspacePath) return path.join(session.workspacePath, 'files');
  const home = process.env.COPILOT_HOME ? process.env.COPILOT_HOME : path.join(os.homedir(), '.copilot');
  return path.join(home, 'session-state', session.sessionId, 'files');
}

function isSubagentCall(toolName, args) {
  if (SUBAGENT_TOOLS.test(String(toolName ?? ''))) return true;
  return !!args && typeof args === 'object' && typeof args.prompt === 'string' && ('agent_type' in args || 'agentName' in args || 'subagent_type' in args);
}

function hireTextOf(toolName, args) {
  if (!args || typeof args !== 'object') return '';
  return String(toolName === 'send_message' ? args.message ?? '' : args.prompt ?? '');
}

function resultText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result.content === 'string') return result.content;
  if (Array.isArray(result.content)) return result.content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('\n');
  return typeof result.textResultForLlm === 'string' ? result.textResultForLlm : JSON.stringify(result);
}

// What the engineer's sprite says it's doing.
function engineerLine(t) {
  if (t.stage === 'shelved') return 'resting: on the shelf until you bring it back';
  if (t.stage === 'on-hold') return `on hold${t.pause?.note ? `: ${t.pause.note}` : ''}`;
  if (t.stage === 'blocked') return `blocked: ${t.pause?.need ?? 'needs the human'}`;
  if (t.ship?.pr && SHIPPING_STAGES.has(t.stage)) return `${t.stage === 'ready-to-merge' ? 'ready to merge' : 'watching'} ${prLine(t.ship.pr)}`;
  if (WAITING_STAGES.has(t.stage)) return `waiting on you: ${stageLabel(t).toLowerCase()}`;
  const step = currentStep(t);
  const detour = t.lead?.phase && step && t.lead.phase.step === step.id ? ` (${KIND_LABELS[t.lead.phase.kind].toLowerCase()} for it)` : '';
  if (step?.status === 'reviewing') return `${stepLabel(step)}: with its reviewers`;
  if (step) return `${stepLabel(step)}${detour}`;
  const u = t.updates?.at(-1);
  return u ? clipText(u.text, 140) : `choosing the next steps for "${t.title}"`;
}

// What a sprite shows for an error, or '' when there is none.
function errorText(e) {
  if (!e?.message) return '';
  return `Session error${e.count > 1 ? ` (×${e.count})` : ''}: ${e.message}`;
}

// A reviewer's error: its hire failed, its session is hitting errors, or a retry is waiting to start.
function memberError(k) {
  if (k.status === 'failed') return `Failed: ${k.failure ?? 'unknown error'}`;
  if (k.sessionError?.message) return errorText(k.sessionError);
  if (k.previousFailure && (k.status === 'issued' || k.status === 'dispatched')) return `Retrying (attempt ${k.attempt}) after: ${k.previousFailure}`;
  return '';
}

// A call the preToolUse hook refused never ran; its completion says nothing about the ticket.
function wasDenied(d) {
  return d?.success === false && /denied by pretooluse hook/i.test(String(d.error?.message ?? d.error ?? ''));
}

const cap = (w) => `${w[0].toUpperCase()}${w.slice(1)}`;

function clipText(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function text(obj) {
  return JSON.stringify(obj, null, 2);
}

// Tool hooks also fire for the tool calls of subagents, which carry an agentId and their own (child)
// session id. Grove's role rules apply only to the session's own agent.
function isRootCall(input, selfId) {
  if (input?.agentId) return false;
  return !input?.sessionId || !selfId || input.sessionId === selfId;
}

// Grove decides how sessions nest. Engineers use structured task destinations, never the Chief cwd.
// Reviewers are nested and share by default; an explicit ticket can request separate isolation.
// Grove also sets each session's model (the engineer's from the task's kind, a reviewer's from its agent
// file), overriding whatever the caller passed (or left out), so a session never inherits a lighter model
// from the chat that created it.
function withModel(args, model) {
  if (!model) return args;
  const { model: _m, ...rest } = args;
  return { ...rest, model };
}

function placeLead(args, task, model, override) {
  const { relationship, workspace, worktree, ...rest } = withModel(args, model);
  return { ...rest, relationship: 'independent', ...engineerPlacement(task, override) };
}

function placeMember(args, model, task, ticket) {
  const { relationship, workspace: _ws, worktree: _wt, ...rest } = withModel(args, model);
  return { ...rest, relationship: 'currentSession', ...reviewerPlacement(task, ticket) };
}

function deny(reason) {
  return { permissionDecision: 'deny', permissionDecisionReason: reason };
}

// Identifies the notice the Chief has (or has not) been sent for a task's current wait.
function noticeKey(t) {
  if (t.stage === 'awaiting-approval') return `deliver-${t.deliveries ?? 1}`;
  if (t.stage === 'escalated') return `escalated-${t.escalation?.at ?? 0}`;
  if (t.stage === 'blocked') return `blocked-${t.pause?.at ?? 0}`;
  if (t.stage === 'ready-to-merge') return `merge-${t.ship?.readyAt ?? 0}`;
  return null;
}
// The latest answer to the human's question, which the engineer sends the Chief like any notice.
function answerKey(t) {
  const q = [...(t.questions ?? [])].reverse().find((x) => x.answer);
  return q ? `answer-${q.seq}` : null;
}

// Boards written by Grove before 0.10 recorded notices as "approve:1" / "escalated:<at>".
function wasNotified(notified, key) {
  return notified === key || notified === key.replace('-', ':');
}

// The last assistant message in a transcript file (JSONL session events), for when the event stream
// did not deliver it before the turn ended.
async function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const lines = (await fs.readFile(transcriptPath, 'utf8')).trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e?.type === 'assistant.message' && !e.agentId && typeof e.data?.content === 'string' && e.data.content.trim()) return e.data.content;
      } catch {
        /* not JSON */
      }
    }
  } catch {
    /* unreadable */
  }
  return '';
}

export class GroveProcess {
  constructor({ log, onChange, pollMs = POLL_MS, graceMs = GRACE_MS, prPollMs = PR_POLL_MS, prStatus = ghPrStatus }) {
    this.log = log;
    this.onChange = onChange;
    this.pollMs = pollMs;
    this.graceMs = graceMs;
    this.prPollMs = prPollMs;
    this.prStatus = prStatus;
    this.prPolledAt = 0;
    this.seen = new Map(); // pending hand-off → when this session first saw it pending
    this.leadCalls = new Map(); // chief: create_session call → task id (to learn each engineer's link)
    this.role = 'none';
    this.board = null;
    this.engine = null;
    this.leadTaskId = null;
    this.work = null; // reviewer: { boardId, ticketId, token, revivals, resolved, blocks, lastBeat }
    this.lastText = '';
    this.stopping = Promise.resolve();
    this.busy = false;
    this.stopBlocks = 0;
    this.lastSig = null;
    this.polls = 0;
    this.polling = null;
    this.error = null;
    this.warned = new Set();
    this.outbox = [];
    this.wokenFor = new Map(); // engineer: pending item id → times this session was woken for it
    this.inboxLog = []; // chief: what the human decided in the Grove inbox since the Chief's last turn
    this.inboxPending = new Map(); // chief: task id → inbox decision its engineer hasn't applied yet
    this.attached = new Map(); // chief: task id → when the human attached it to their next message
    this.sessionError = null; // { message, at, count }: this session's last error, until a turn goes through
    this.turnActed = true; // whether the current turn said or did anything
    this.catchUp = false; // engineer: took over a task under way and hasn't submitted yet
    this.confirmation = null;
    this.inputCall = null;
    this.metadataCalls = new Set();
  }

  get ready() {
    return !!this.session;
  }

  // ---------- binding ----------

  async attach(session) {
    this.session = session;
    this.selfId = session.sessionId;
    this.filesRoot = resolveFilesRoot(session);
    this.chiefRoot = path.join(this.filesRoot, 'grove');
    this.leadFile = path.join(this.filesRoot, 'grove-lead.json');
    this.memberFile = path.join(this.filesRoot, 'grove-member.json');
    session.on((ev) => {
      try {
        this.onEvent(ev);
      } catch (err) {
        this.log(`Grove event handling failed: ${err.message}`, 'warning');
      }
    });
    try {
      if (await Board.exists(this.chiefRoot)) {
        await this.becomeChief();
        await this.relayToChief();
      } else {
        const lead = await readLeadLink(this.leadFile);
        if (lead) await this.becomeLead(lead, { resume: true });
        else {
          const member = await readMemberLink(this.memberFile);
          if (member) await this.resumeMember(member);
        }
      }
      if (!this.board) await this.viewLatest();
    } catch (err) {
      this.error = err.message;
      this.log(`Grove process unavailable: ${err.message}`, 'error');
    }
    if (this.pollMs > 0) {
      this.timer = setInterval(() => void this.poll(), this.pollMs);
      this.timer.unref?.();
    }
  }

  dispose() {
    clearInterval(this.timer);
    return this.board?.flush();
  }

  async bind(board, role) {
    const engine = new ProcessEngine({ board, selfId: this.selfId, log: this.log, onChange: this.onChange, validateEvidence });
    await engine.load();
    this.board = board;
    this.engine = engine;
    this.role = role;
    this.error = null;
    this.lastSig = await board.signature();
    this.onChange();
  }

  async becomeChief() {
    const board = await Board.openOrCreate(this.chiefRoot, { id: this.selfId, chiefSessionId: this.selfId, log: this.log });
    await this.bind(board, 'chief');
  }

  async becomeLead({ boardId, taskId, token }, { resume }) {
    const board = await Board.resolve(boardId, this.log);
    if (!resume && board.meta.handoffs?.[taskId] !== token) {
      throw new ProcessError('stale_handoff', `This hand-off for ${taskId} is out of date; the Chief of Staff has issued a newer one.`);
    }
    await this.bind(board, 'lead');
    const task = this.engine.task(taskId);
    const recovering = !resume && !!task.lead;
    this.leadTaskId = taskId;
    if (resume) {
      if (!this.engine.owns(task)) {
        this.retire();
        return task;
      }
      await this.invalidateRepair(task);
      await this.collectResults();
      await this.applyLeadDecisions({ wake: true });
      await this.checkPlacement({ force: true });
      await this.continueLead();
      return task;
    }
    try {
      this.engine.claim(taskId, token);
      if (board.meta.destinations?.[taskId]) task.destination = destination(board.meta.destinations[taskId]);
      await board.flush();
      if (!this.engine.owns(this.engine.task(taskId)) || this.engine.claimingFrom.has(taskId)) throw new ProcessError('stale_handoff', `${taskId} was taken by another session.`);
    } catch (err) {
      this.role = 'none';
      this.leadTaskId = null;
      throw err;
    }
    await writeLeadLink(this.leadFile, { boardId, taskId });
    await this.invalidateRepair(task);
    // An engineer taking over a task that's under way catches up from the board: grove_next includes the
    // finished steps' results until it submits something.
    this.catchUp = this.engine.task(taskId).steps.some((x) => x.status === 'done' && x.output);
    await this.collectResults();
    await this.applyLeadDecisions({ wake: false });
    await this.checkPlacement({ force: true, continuation: recovering });
    return task;
  }

  async invalidateRepair(task) {
    this.repairAuthorityReady = false;
    this.confirmation = null;
    const hadRepair = !!task.workspaceRepair;
    delete task.workspaceRepair;
    const decisions = await this.board.readDecisions(task.id);
    const through = Math.max(task.repairInvalidatedThrough ?? 0, ...decisions.map((d) => d.seq));
    if (hadRepair || through !== (task.repairInvalidatedThrough ?? 0)) {
      task.repairInvalidatedThrough = through;
      this.engine.changed(task, 'Workspace repair authority invalidated on attachment/restart; a fresh human decision is required.');
      await this.board.flush();
    }
    this.repairAuthorityReady = true;
  }

  // Another engineer took the task over: this session goes back to watching.
  retire() {
    this.log(`Grove: ${this.leadTaskId} now has another engineer session.`, 'info');
    this.role = 'none';
    this.leadTaskId = null;
  }

  async viewLatest() {
    const board = await Board.latest(this.log);
    if (!board || board.id === this.board?.id) return;
    await this.bind(board, 'none');
  }

  leadTask() {
    if (this.role !== 'lead' || !this.engine) return null;
    return this.engine.state.tasks.find((t) => t.id === this.leadTaskId) ?? null;
  }

  // ---------- reviewer sessions ----------

  // A hire marker arrived in this chat: it becomes (or stays) that specialty's reviewer session.
  async bindMember({ boardId, ticketId, token }) {
    if (this.role === 'chief' || this.role === 'lead') throw new ProcessError('wrong_session', `This chat is already the ${this.role === 'chief' ? 'Chief of Staff' : `engineer for ${this.leadTaskId}`}.`);
    const board = this.board?.id === boardId ? this.board : await Board.resolve(boardId, this.log);
    const engine = new ProcessEngine({ board, selfId: this.selfId, log: this.log, onChange: this.onChange, validateEvidence });
    await engine.load();
    const found = engine.findTicket(ticketId);
    if (!found || found.ticket.token !== token) throw new ProcessError('stale_hire', `Grove assignment ${ticketId} is not valid any more.`);
    if (TERMINAL.has(found.task.stage) || !['issued', 'dispatched', 'running'].includes(found.ticket.status)) {
      throw new ProcessError('stale_hire', `Grove assignment ${ticketId} is ${found.ticket.status}; there is nothing to do.`);
    }
    // One assignment at a time: a new one may only replace work that is finished.
    if (this.work && !this.work.resolved && this.work.ticketId !== ticketId) {
      const prev = engine.findTicket(this.work.ticketId);
      if (prev && IN_FLIGHT.has(prev.ticket.status) && prev.ticket.token === this.work.token) {
        throw new ProcessError('busy', `This chat is still working on ${this.work.ticketId}. Finish it first.`);
      }
    }
    await this.bind(board, 'member');
    this.work = { boardId, ticketId, token, submissionVersion: found.ticket.version, revivals: 0, resolved: false, blocks: 0, lastBeat: 0 };
    this.lastText = '';
    await writeMemberLink(this.memberFile, this.work);
    if (found.task.destination) {
      try {
        await prepareReviewer(found.task, found.ticket, this.workingDirectory ?? this.session?.workingDirectory);
      } catch (err) {
        this.work.setupError = `Reviewer setup failed: ${err.message}`;
        this.log(`Grove reviewer setup failed: ${err.message}`, 'warning');
      }
      await writeMemberLink(this.memberFile, this.work);
      await this.checkPlacement({ force: true });
    }
    await this.beat(true);
    return found;
  }

  async resumeMember(link) {
    const board = await Board.resolve(link.boardId, this.log);
    await this.bind(board, 'member');
    const found = this.engine.findTicket(link.ticketId);
    const prior = found && (await board.readResult(link.ticketId).catch(() => null));
    const open = found && found.ticket.token === link.token && !TERMINAL.has(found.task.stage)
      && IN_FLIGHT.has(found.ticket.status) && prior?.status !== 'done' && prior?.status !== 'failed';
    this.work = { ...link, submissionVersion: link.submissionVersion ?? found?.ticket.version, resolved: !open, blocks: 0, lastBeat: 0 };
    await this.checkPlacement({ force: true });
    if (!open) return;
    await this.beat(true);
    await this.revive('was interrupted when Grove restarted');
  }

  currentWork() {
    if (this.role !== 'member' || !this.work || !this.engine) return null;
    const found = this.engine.findTicket(this.work.ticketId);
    return found && found.ticket.token === this.work.token ? found : null;
  }

  // Tell the engineer this reviewer is (still) working.
  async beat(force = false) {
    const w = this.work;
    if (!w || w.resolved || this.role !== 'member') return;
    if (!force && Date.now() - w.lastBeat < HEARTBEAT_MS) return;
    // Strictly increasing, so the engineer never mistakes a new beat (an error, or its clearing) for an old one.
    const t = Math.max(Date.now(), (w.lastBeat ?? 0) + 1);
    w.lastBeat = t;
    const found = this.currentWork();
    await this.board.writeResult({ ticket: w.ticketId, token: w.token, status: 'running', sessionId: this.selfId, heartbeat: t,
      ...(found?.task.destination ? { placement: this.memberPlacement, submissionVersion: w.submissionVersion } : {}),
      ...(this.sessionError ? { sessionError: this.sessionError } : {}) });
  }

  // The engineer's Grove cancelled this reviewer's ticket (task cancelled, escalated or paused): stop.
  async checkMemberStillNeeded() {
    const w = this.work;
    if (!w || w.resolved) return;
    const found = this.engine.findTicket(w.ticketId);
    // "issued" counts as live: the engineer may have delivered this ticket before its Grove recorded it.
    if (found && (found.ticket.status === 'issued' || IN_FLIGHT.has(found.ticket.status)) && !TERMINAL.has(found.task.stage) && !WAITING.has(found.task.stage)) return;
    w.resolved = true;
    if (!this.busy) return;
    try {
      await this.session.abort?.();
    } catch {
      /* the turn may already be over */
    }
    this.log(`Grove: stopped ${w.ticketId}; it is no longer needed (${found ? stageLabel(found.task) : 'task removed'}).`, 'info');
  }

  async finishWork(status, fields) {
    const w = this.work;
    if (!w || w.resolved) return;
    w.resolved = true;
    await this.checkPlacement({ force: true });
    const found = this.currentWork();
    await this.board.writeResult({ ticket: w.ticketId, token: w.token, status, sessionId: this.selfId,
      ...(found?.task.destination ? { placement: this.memberPlacement, submissionVersion: w.submissionVersion } : {}), ...fields });
    await this.board.flush();
  }

  // The reviewer's turn ended. Accept its review, send it back, or give up so the engineer can retry.
  async memberStopped(transcriptPath) {
    const w = this.work;
    if (w?.reportDue) return this.reportBlock();
    const found = this.currentWork();
    if (!found || w.resolved) return undefined;
    const reply = this.lastText.trim() || (await lastAssistantText(transcriptPath));
    const checked = await this.engine.checkOutput(found.task, found.ticket, reply);
    if (checked.ok) {
      await this.finishWork('done', { text: reply });
      return this.reportBlock(found, { status: 'done', text: reply });
    }
    w.blocks += 1;
    if (w.blocks > MAX_BLOCKS) {
      const error = `Output still invalid after ${MAX_BLOCKS} corrections: ${checked.reason}`;
      await this.finishWork('failed', { error });
      return this.reportBlock(found, { status: 'failed', text: error });
    }
    return { decision: 'block', reason: `${checked.reason} (Grove ticket ${w.ticketId}; correction ${w.blocks} of ${MAX_BLOCKS})` };
  }

  // The review is on the board: the reviewer tells the engineer with send_message before it stops, which
  // wakes the engineer with a visible turn.
  async reportBlock(found, outcome) {
    const w = this.work;
    if (found && outcome) {
      const link = await this.leadLinkFor(found.task.id);
      if (!link) return undefined;
      w.reportDue = { link, message: reportMessage(this.board.id, found.task, found.ticket, outcome), delivery: relayDelivery('report'), tries: 0, sent: false };
    }
    const due = w?.reportDue;
    if (!due || due.sent || due.tries >= 2) {
      if (w) w.reportDue = null;
      return undefined;
    }
    due.tries += 1;
    return {
      decision: 'block',
      reason: `Grove: your work is recorded. Now report back to the task's engineer: call send_message with delivery "${due.delivery ?? 'steer'}", session "${due.link}" and message exactly:\n${due.message}\nThen end your turn with one short line. ${DELIVERY_FALLBACK}`,
    };
  }

  // The engineer's own chat, for reviewers and the Chief to message.
  async leadLinkFor(taskId) {
    await this.engine.refresh();
    const t = this.engine.state.tasks.find((x) => x.id === taskId);
    if (t?.lead?.link) return t.lead.link;
    const meta = await this.board.reloadMeta();
    return meta.leadLinks?.[taskId] ?? null;
  }

  // The reviewer's turn ended without a review (an error, or Grove restarted). Continue in this same chat:
  // its transcript still has everything done so far.
  async revive(why) {
    const found = this.currentWork();
    const w = this.work;
    if (!found || w.resolved) return;
    if (w.revivals >= MAX_REVIVES) {
      await this.finishWork('failed', { error: `stopped without a report ${w.revivals + 1} times (${why})` });
      return;
    }
    w.revivals += 1;
    await writeMemberLink(this.memberFile, w);
    await this.wake(memberRevive(found.ticket, why));
  }

  // ---------- polling: other sessions' writes ----------

  poll() {
    if (!this.polling) this.polling = this.pollOnce().finally(() => { this.polling = null; });
    return this.polling;
  }

  async pollOnce() {
    try {
      this.polls += 1;
      await this.flushOutbox();
      if (this.role === 'none' && this.polls % LATEST_EVERY === 0) await this.viewLatest();
      if (!this.board) return;
      if (this.role === 'member') await this.beat();
      if (this.role === 'lead') {
        this.engine.sweep();
        await this.watchPr();
        await this.continueLead();
      }
      if (this.role === 'chief') await this.relayToChief();
      const sig = await this.board.signature();
      if (sig === this.lastSig) return;
      this.lastSig = sig;
      const { changed, lost } = await this.engine.refresh();
      if (this.role === 'lead' && lost.includes(this.leadTaskId)) this.retire();
      if (this.role === 'member') await this.checkMemberStillNeeded();
      if (this.role === 'lead') {
        await this.collectResults();
        await this.applyLeadDecisions();
      }
      if (this.role === 'chief') await this.relayToChief();
      if (changed.length || lost.length) this.onChange();
    } catch (err) {
      const msg = `Grove could not read the board: ${err.message}`;
      if (!this.warned.has(msg)) {
        this.warned.add(msg);
        this.log(msg, 'warning');
      }
    }
  }

  // Engineer: while its change ships, Grove (not the engineer) watches the PR, so the engineer isn't woken
  // until checks fail, a reviewer asks for changes, or the PR is ready to merge.
  async watchPr({ force = false } = {}) {
    const task = this.leadTask();
    const stage = task?.stage === 'shelved' ? task.shelf?.from : task?.stage;
    const draft = stage === 'awaiting-approval' && task.ship?.phase === 'draft';
    if (!task || !this.engine.owns(task) || !(SHIPPING_STAGES.has(stage) || draft) || !task.ship?.pr) return;
    const t = Date.now();
    if (!force && task.ship.pr.checkedAt && t - this.prPolledAt < this.prPollMs) return;
    this.prPolledAt = t;
    let status;
    try {
      status = await this.prStatus(task.ship.pr.url);
    } catch (err) {
      this.engine.prError(task, err?.message ?? String(err));
      return;
    }
    if (draft) this.engine.observePr(task, status);
    else this.engine.applyPrStatus(task, status);
  }

  // Engineer: apply its reviewers' reports for this task.
  async collectResults() {
    const task = this.leadTask();
    if (!task || !this.engine.owns(task)) return 0;
    let n = 0;
    const open = new Set(task.tickets.filter((k) => IN_FLIGHT.has(k.status) || k.status === 'issued').map((k) => k.id));
    if (!open.size) return n;
    for (const r of await this.board.readResults()) {
      if (!open.has(r.ticket)) continue;
      if (await this.engine.applyResult(r)) n += 1;
    }
    return n;
  }

  // Chief: post a notice for every task that newly needs the human. Each wait is announced once.
  async relayToChief() {
    if (this.role !== 'chief') return;
    const notified = this.board.meta.notified;
    const sends = [];
    // Fallback: the engineer normally messages this chat; if it hasn't within the grace period, wake ourselves.
    const now = Date.now();
    for (const item of this.engine.humanActions()) {
      const key = noticeKey(this.engine.task(item.taskId));
      if (!key || wasNotified(notified[item.taskId], key)) continue;
      const id = `notice:${item.taskId}:${key}`;
      if (!this.seen.has(id)) this.seen.set(id, now);
      if (now - this.seen.get(id) < this.graceMs) continue;
      notified[item.taskId] = key;
      sends.push({ id: item.taskId, text: chiefNotice(await this.withReport(item)) });
    }
    // Answers to the human's questions, and PRs that merged, are told once too.
    this.board.meta.answered ??= {};
    for (const t of this.engine.state.tasks) {
      const ak = answerKey(t);
      if (ak && this.board.meta.answered[t.id] !== ak) {
        const id = `notice:${t.id}:${ak}`;
        if (!this.seen.has(id)) this.seen.set(id, now);
        if (now - this.seen.get(id) >= this.graceMs) {
          this.board.meta.answered[t.id] = ak;
          sends.push({ id: null, text: chiefAnswer(t, t.questions.find((q) => `answer-${q.seq}` === ak)) });
        }
      }
      const mk = t.ship?.phase === 'merged' && t.ship.mergedAt ? `merged-${t.ship.mergedAt}` : null;
      if (mk && notified[t.id] !== mk) {
        notified[t.id] = mk;
        sends.push({ id: null, text: `[Grove → Chief of Staff] ${taskLabel(t)} "${t.title}": ${prLine(t.ship.pr)} is merged, so the task is done. Tell the human in one line (link the PR: ${t.ship.pr.url}) and end your turn.` });
      }
    }
    for (const t of this.engine.activeTasks()) {
      if (!t.stalled) continue;
      const key = `stalled:${t.stalled.at}`;
      if (notified[t.id] === key) continue;
      notified[t.id] = key;
      sends.push({ id: t.id, text: `[Grove → Chief of Staff] ${taskLabel(t)} "${t.title}" has stalled: its engineer stopped responding (${t.stalled.tickets.join(', ')}). Call grove_handoff for ${t.id} and start a new engineer with create_session using the returned fields; it picks the task up from the board. Then tell the human in one line and end your turn.` });
    }
    // An inbox decision normally reaches the engineer through its own poll of the board. If its session
    // isn't running, the Chief has to message it.
    for (const [taskId, p] of this.inboxPending) {
      const t = this.engine.state.tasks.find((x) => x.id === taskId);
      if (!t || (t.decisionsApplied ?? 0) >= p.seq || TERMINAL.has(t.stage)) { this.inboxPending.delete(taskId); continue; }
      if (now - p.at < this.graceMs || p.relayed) continue;
      p.relayed = true;
      if (p.message) sends.push({ id: null, text: `[Grove] The human ${INBOX_WORDS[p.action]} ${taskLabel(t)} "${t.title}"${p.via === 'chat' ? '' : ' in the Grove inbox'}, but its engineer hasn't picked that up. Send the engineer this message with send_message, exactly as given:\nsession: ${p.message.session}\ndelivery: queue\nmessage: ${p.message.message}\nThen end your turn without further comment.` });
    }
    if (!sends.length) return;
    // Send before recording: after a crash a notice may repeat, but it is never lost.
    for (const s of sends) if (!(await this.wake(s.text, { retry: false })) && s.id) delete notified[s.id];
    await this.board.saveMeta();
  }

  // Engineer: apply the human's decisions recorded by the Chief. The Chief normally messages this chat too;
  // `wake` is for resuming after a restart, when that message may have been missed.
  async applyLeadDecisions({ wake = false } = {}) {
    const task = this.leadTask();
    if (!task || !this.engine.owns(task)) return [];
    const applied = this.engine.applyDecisions(task, await this.board.readDecisions(task.id));
    if (!applied.length) return applied;
    this.stopBlocks = 0;
    await this.writeTaskReport(task);
    // Decisions made in the Grove inbox come with no message from the Chief, so the engineer wakes itself.
    const fromGrove = applied.filter((d) => d.via === 'grove' && !QUIET_DECISIONS.has(d.action)).at(-1);
    if (fromGrove && !wake && !TERMINAL.has(task.stage)) {
      await this.wake(engineerWake(task, await this.unreadDecisions(task, applied)));
      return applied;
    }
    if (wake && (await this.leadPending(task)).length) {
      for (const p of await this.leadPending(task)) this.noteWake(p.id);
      await this.wake(engineerWake(task, await this.unreadDecisions(task, applied)));
    }
    return applied;
  }

  // Engineer: the messages it has to send (tell the Chief the human is needed, or give it an answer).
  async leadMessages(task) {
    const out = [];
    if (!task || TERMINAL.has(task.stage)) return out;
    const meta = await this.board.reloadMeta();
    if (!task.lead?.link && meta.leadLinks?.[task.id] && this.engine.owns(task)) {
      task.lead.link = meta.leadLinks[task.id];
      this.engine.changed(task, null);
    }
    const nk = noticeKey(task);
    if (nk && task.noticeSent !== nk && isSessionLink(meta.chiefLink)) {
      out.push({ id: `notice:${nk}`, tool: 'send_message', session: meta.chiefLink, message: noticeMessage(this.board.id, task, nk), purpose: 'tell the Chief of Staff the human is needed' });
    }
    const ak = answerKey(task);
    if (ak && task.answerSent !== ak && meta.answered?.[task.id] !== ak && isSessionLink(meta.chiefLink)) {
      out.push({ id: `notice:${ak}`, tool: 'send_message', session: meta.chiefLink, message: noticeMessage(this.board.id, task, ak), purpose: 'give the Chief of Staff the answer to the human\'s question' });
    }
    return out;
  }

  // Engineer: everything it still has to do (its step, hires, messages, decisions, answers).
  async leadPending(task) {
    const step = currentStep(task);
    const work = step?.status === 'working' && task.stage === 'working' ? [{ id: `work:${step.id}:${step.startedAt ?? 0}`, kind: 'work' }] : [];
    const hires = this.engine.issuedTickets([task], LEAD).map((x) => ({ id: x.ticket.id, kind: 'hire' }));
    const msgs = (await this.leadMessages(task)).map((m) => ({ id: m.id, kind: 'message' }));
    // Choosing the next steps (or delivering) is the engineer's job whenever nothing is in progress.
    const decide = task.stage === 'routing' ? [{ id: `route:${task.routingSince ?? 0}`, kind: 'decide' }] : [];
    // The human's question waits for the engineer's answer.
    const q = this.engine.openQuestion(task);
    const answer = q && !PAUSED_STAGES.has(task.stage) ? [{ id: `question:${q.seq}`, kind: 'answer' }] : [];
    return [...work, ...hires, ...msgs, ...decide, ...answer];
  }

  noteWake(ticketId) {
    this.wokenFor.set(ticketId, (this.wokenFor.get(ticketId) ?? 0) + 1);
  }

  // Engineer fallback: reviewers normally wake the engineer by messaging it, and the engineer works its
  // steps in its own turns. If it still has something to do once the grace period has passed and it isn't
  // working, Grove wakes it. If it keeps ignoring that, the Chief is told the task stalled.
  async continueLead({ idle = false } = {}) {
    const task = this.leadTask();
    if (this.busy || !task || !this.engine.owns(task) || TERMINAL.has(task.stage)) return;
    const pending = await this.leadPending(task);
    const now = Date.now();
    for (const p of pending) if (!this.seen.has(p.id)) this.seen.set(p.id, now);
    const due = pending.filter((p) => now - this.seen.get(p.id) >= this.graceMs && (this.wokenFor.get(p.id) ?? 0) < MAX_LEAD_WAKES);
    if (!due.length) {
      const exhausted = pending.length && pending.every((p) => (this.wokenFor.get(p.id) ?? 0) >= MAX_LEAD_WAKES);
      if (idle && exhausted && !task.stalled) {
        task.stalled = { at: now, tickets: pending.map((p) => p.id) };
        this.engine.changed(task, `The engineer stopped responding (${task.stalled.tickets.join(', ')}).`);
      }
      return;
    }
    for (const p of due) {
      this.noteWake(p.id);
      this.seen.set(p.id, now);
    }
    const working = due.find((p) => p.kind === 'work');
    await this.wake(working && due.length === 1
      ? `[Grove] ${task.id} (${stageLabel(task)}): your step isn't finished. Call grove_next for the assignment, carry on from where you stopped, and submit it with grove_submit.`
      : `[Grove] ${task.id} (${stageLabel(task)}): ${due.length} thing(s) waiting (${due.map((p) => p.id).join(', ')}). Call grove_next and do them.`);
  }

  // Post a message into this session; it starts a turn now or queues behind the current one. Failed
  // posts are retried on the next poll unless the caller handles the failure.
  async wake(prompt, { retry = true } = {}) {
    try {
      await this.session.send({ prompt, source: 'system' });
      return true;
    } catch {
      try {
        await this.session.send(prompt);
        return true;
      } catch (err) {
        this.log(`Grove could not post to this session: ${err.message}`, 'warning');
        if (retry) this.outbox.push(prompt);
        return false;
      }
    }
  }

  async flushOutbox() {
    while (this.outbox.length) {
      const prompt = this.outbox.shift();
      if (!(await this.wake(prompt, { retry: false }))) {
        this.outbox.unshift(prompt);
        return;
      }
    }
  }

  // ---------- session errors ----------

  // This session hit an error (the model returned nothing, a request failed…). It shows on the session's
  // sprite until a turn goes through again: the Chief's directly, an engineer's on its task, a reviewer's
  // through its heartbeat.
  noteError(message) {
    const text = clipText(String(message ?? '').replace(/\s+/g, ' ').trim() || 'unknown error', 240);
    this.sessionError = { message: text, at: Date.now(), count: (this.sessionError?.message === text ? this.sessionError.count : 0) + 1 };
    void this.reportError().catch((err) => this.log(`Grove could not record an error: ${err.message}`, 'warning'));
  }

  clearError() {
    if (!this.sessionError) return;
    this.sessionError = null;
    void this.reportError().catch((err) => this.log(`Grove could not clear an error: ${err.message}`, 'warning'));
  }

  async reportError() {
    if (this.role === 'member') return this.beat(true);
    const task = this.role === 'lead' ? this.leadTask() : null;
    if (task?.lead && this.engine.owns(task)) {
      const e = this.sessionError;
      const first = e && task.lead.error?.message !== e.message;
      if (e) task.lead.error = e;
      else delete task.lead.error;
      this.engine.changed(task, first ? `The engineer hit an error: ${e.message}` : null);
      return undefined;
    }
    this.onChange();
    return undefined;
  }

  // ---------- session events ----------

  onEvent(ev) {
    const d = ev?.data ?? {};
    if (!ev?.agentId) {
      if (ev?.type === 'session.error') this.noteError(d.message);
      else if (ev?.type === 'tool.execution_start' || (ev?.type === 'assistant.message' && typeof d.content === 'string' && d.content.trim())) {
        this.turnActed = true;
        this.clearError();
      }
    }
    switch (ev?.type) {
      case 'assistant.turn_start':
        if (!ev.agentId) this.turnActed = false;
        if (!ev.agentId && !this.busy) { this.busy = true; this.onChange(); }
        return;
      case 'assistant.message':
        if (!ev.agentId && typeof d.content === 'string' && d.content.trim()) this.lastText = d.content;
        return;
      case 'user.message':
        if (this.role === 'member') this.lastText = '';
        return;
      case 'session.idle':
        if (this.busy) { this.busy = false; this.onChange(); }
        if (this.role === 'lead') void this.continueLead({ idle: true }).catch(() => {});
        // A reviewer whose turn ended without a review is revived, unless the human stopped it on purpose.
        if (this.role === 'member' && !d.aborted) {
          setTimeout(() => void this.stopping.then(() => this.revive('ended without a report')).catch(() => {}), 1500).unref?.();
        }
        return;
      case 'skill.invoked':
        // The engineer loaded a skill: a phase skill shows where it's working.
        if (!ev.agentId && this.role === 'lead') {
          const task = this.leadTask();
          if (task && this.engine.owns(task)) this.engine.noteSkill(task, d.name);
        }
        return;
      default:
        break;
    }
    if (this.role === 'lead' && !ev.agentId) {
      if (ev.type === 'tool.execution_start' && d.toolName === 'get_current_session') this.metadataCalls.add(d.toolCallId);
      if (ev.type === 'tool.execution_complete' && this.metadataCalls.delete(d.toolCallId) && d.success !== false) {
        try {
          const metadata = typeof d.result?.workingDirectory === 'string' ? d.result : JSON.parse(resultText(d.result));
          if (typeof metadata.workingDirectory === 'string') this.metadataDirectory = metadata.workingDirectory;
        } catch (err) {
          this.log(`Grove could not read current-session placement metadata: ${err.message}`, 'warning');
        }
      }
      if (ev.type === 'tool.execution_start' && d.toolName === 'ask_user') this.inputCall = d.toolCallId;
      if (ev.type === 'tool.execution_complete' && this.confirmation?.call === d.toolCallId) {
        let answer = d.result;
        if (!answer?.workspaceConfirmation) {
          try {
            answer = JSON.parse(resultText(d.result));
          } catch {
            answer = null;
          }
        }
        this.confirmation.confirmed = d.success !== false && !wasDenied(d) && answer?.workspaceConfirmation === true;
        if (!this.confirmation.confirmed) {
          this.confirmation = null;
          const task = this.leadTask();
          if (task?.workspaceRepair) {
            delete task.workspaceRepair;
            this.engine.changed(task, 'Workspace repair confirmation was not affirmative.');
          }
        }
      }
    }
    // Chief: remember each engineer's session link (from create_session's result) so the human's decisions
    // can be sent there.
    if (this.role === 'chief' && this.board) {
      if (ev.type === 'tool.execution_start' && d.toolName === 'create_session') {
        const m = LEAD_MARKER.exec(String(d.arguments?.prompt ?? ''));
        if (m && m[1] === this.board.id) this.leadCalls.set(d.toolCallId, m[2]);
      } else if (ev.type === 'tool.execution_complete' && this.leadCalls.has(d.toolCallId)) {
        const taskId = this.leadCalls.get(d.toolCallId);
        this.leadCalls.delete(d.toolCallId);
        const link = d.success !== false && !wasDenied(d) ? SESSION_LINK.exec(resultText(d.result))?.[0] : null;
        if (link) {
          this.board.meta.leadLinks = { ...(this.board.meta.leadLinks ?? {}), [taskId]: link.split('?')[0] };
          void this.board.saveMeta().catch((err) => this.log(`Grove could not save an engineer's link: ${err.message}`, 'warning'));
        }
      }
      return;
    }
    // The host emits tool.execution_start before the preToolUse hook runs, so every hire call is tracked
    // from its start, and calls the hook refused are ignored when they complete.
    if (this.role !== 'lead' || !this.engine) return;
    if (ev.type === 'tool.execution_start' && HIRE_TOOLS.has(d.toolName)) {
      const m = MEMBER_MARKER.exec(hireTextOf(d.toolName, d.arguments));
      if (m) this.engine.bindToolCall(d.toolCallId, m[2]);
    } else if (ev.type === 'tool.execution_complete' && this.engine.byToolCall.has(d.toolCallId)) {
      if (wasDenied(d)) {
        this.engine.byToolCall.delete(d.toolCallId);
        return;
      }
      const out = resultText(d.result);
      this.engine.dispatchEnded({
        toolCallId: d.toolCallId,
        success: d.success !== false,
        link: d.success !== false ? CHAT_LINK.exec(out)?.[0] : null,
        error: d.error?.message ?? (d.success === false ? out : ''),
      });
    }
  }

  // ---------- hooks ----------

  async checkPlacement({ force = false, continuation = false } = {}) {
    const found = this.role === 'member' ? this.currentWork() : null;
    const task = this.role === 'lead' ? this.leadTask() : found?.task;
    if (!task?.destination) return;
    const directory = this.workingDirectory ?? this.session?.workingDirectory ?? this.metadataDirectory;
    let key = directory;
    try {
      key = await fs.realpath(localPath(directory));
    } catch (err) {
      if (!(err instanceof PlacementError) && err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
    }
    const previous = found ? this.memberPlacement : task.placement;
    if (!force && !found?.ticket.worktree && previous && key === this.checkedDirectory) return previous;
    this.checkedDirectory = key;
    const observed = found && this.work.setupError
      ? { status: 'invalid', error: this.work.setupError, sessionId: this.selfId, at: Date.now() }
      : await observePlacement(task, directory, {
        reviewer: found?.ticket, sessionId: this.selfId, chiefDirectory: task.chiefDirectory, continuation,
      });
    const withoutTime = ({ at, ...fields }) => fields;
    const changed = !previous || JSON.stringify(withoutTime(previous)) !== JSON.stringify(withoutTime(observed));
    const p = changed ? observed : previous;
    if (found) {
      this.memberPlacement = p;
      return p;
    }
    if (!this.engine.owns(task)) return p;
    task.placement = p;
    if (p.status === 'verified') {
      task.lastVerifiedPlacement = p;
      if (task.stage === 'blocked' && task.pause?.placement) this.engine.unpause(task, 'Actual attachment verified; placement blocker resolved.');
    }
    if (changed) this.engine.changed(task, null);
    if (p.status !== 'verified' && !['blocked', 'on-hold', 'done', 'cancelled', 'awaiting-approval'].includes(task.stage)) {
      this.engine.block(task.id, { need: 'Confirm the intended attachment with the Chief; authorize supported workspace repair if required.', reason: p.error });
      task.pause.placement = true;
      this.engine.changed(task, null);
    }
    if (changed) await this.board.flush();
    return p;
  }

  placementGate(name, args) {
    const task = this.leadTask();
    if (this.confirmation && name !== 'set_workspace') {
      this.confirmation = null;
      if (task?.workspaceRepair) {
        delete task.workspaceRepair;
        this.engine.changed(task, 'Workspace confirmation invalidated by an intervening tool.');
      }
    }
    if (this.role === 'lead' && ['set_workspace', 'ask_user'].includes(name)) {
      const authority = task?.workspaceRepair;
      if (name === 'ask_user') {
        const properties = args.requestedSchema?.properties;
        const field = properties?.workspaceConfirmation;
        const valid = this.repairAuthorityReady && authority?.sessionId === this.selfId
          && args.message === 'Confirm the authorized workspace repair.'
          && properties && Object.keys(properties).length === 1
          && field && Object.keys(field).length === 3 && field.type === 'boolean' && field.default === false
          && field.title === confirmationForm(authority.target).title;
        if (!valid) return deny('Grove: ordinary questions and engineer-initiated workspace repair are not authorized. For a human prerequisite use grove_blocked; put ordinary decision questions in the delivery ask. Only the Chief can record an explicit human workspaceRepair decision.');
        this.confirmation = { seq: authority.seq, target: authority.target, call: this.inputCall, confirmed: false };
        return undefined;
      }
      const consent = this.confirmation;
      const matches = this.repairAuthorityReady && authority?.sessionId === this.selfId && consent?.confirmed && consent.seq === authority.seq
        && args.workspaceFolder === consent.target.workspaceFolder && args.isolation === consent.target.isolation;
      this.confirmation = null;
      if (authority) {
        delete task.workspaceRepair;
        this.engine.changed(task, 'Workspace repair authorization consumed.');
      }
      return matches ? undefined : deny('Grove: set_workspace requires an explicit human repair decision and immediately preceding affirmative confirmation of this exact workspace/isolation.');
    }
    if (['set_workspace', 'isolate_session', 'move_session', 'ask_user'].includes(name) && this.role === 'member') {
      return deny('Grove: reviewers cannot change their attachment or ask the human; report the placement prerequisite to the engineer.');
    }
    if (this.role === 'lead' && ['isolate_session', 'move_session'].includes(name)) return deny('Grove: use only the explicitly authorized, confirmed set_workspace repair route.');
    const p = this.role === 'lead' ? task?.placement : this.memberPlacement;
    const routed = task?.destination || this.currentWork()?.task.destination;
    if (routed && p?.status !== 'verified' && !(name.startsWith('grove_') || isDiscoveryTool(name)
      || ['get_current_session', 'list_sessions', 'get_session_context', 'send_message', 'report_intent'].includes(name))) {
      return deny(`Grove: work is gated until actual placement is verified. ${p?.error ?? 'Per-chat working directory is unknown.'}`);
    }
    return undefined;
  }

  hooks() {
    return {
      onUserPromptSubmitted: async (input) => {
        if (input?.workingDirectory) this.workingDirectory = input.workingDirectory;
        const prompt = String(input?.prompt ?? '');
        const hire = MEMBER_MARKER.exec(prompt);
        if (hire) return this.onHirePrompt(hire);
        // The Chief hears what the human decided in the Grove inbox since its last turn, and which tasks they
        // attached to this message. Grove's own relays and wake-ups don't use up attachments.
        const fromGrove = /^\s*\[(grove-|Grove\b)/.test(prompt);
        const inboxNote = this.role === 'chief' ? [this.takeInboxLog(), fromGrove ? '' : this.takeAttached()].filter(Boolean).join('\n\n') : '';
        const withNote = (ctx) => ({ additionalContext: [inboxNote, ctx].filter(Boolean).join('\n\n') });
        const relay = RELAY_MARKER.exec(prompt);
        if (relay && this.board && relay[2] === this.board.id) {
          const ctx = await this.onRelay(relay[1], relay[3]);
          if (ctx) return withNote(ctx);
        }
        const m = LEAD_MARKER.exec(prompt);
        if (m) {
          const [, boardId, taskId, token] = m;
          if (this.role === 'chief') return withNote('Grove: this chat is the Chief of Staff, so it cannot also be a task\'s engineer. Start the engineer in a new session with create_session.');
          if (this.role === 'member') return { additionalContext: `Grove: this chat is a reviewer (${this.work?.ticketId}), so it cannot also be a task's engineer.` };
          if (this.role === 'lead' && (this.leadTaskId !== taskId || this.board.id !== boardId)) {
            return { additionalContext: `Grove: this chat is already the engineer for ${this.leadTaskId}; an engineer works on one task. Tell the human the hand-off for ${taskId} needs its own session.` };
          }
          if (this.role !== 'lead') {
            try {
              const task = await this.becomeLead({ boardId, taskId, token }, { resume: false });
              return { modifiedPrompt: engineerBrief(task, { boardId, token }), additionalContext: engineerContext(task, { initial: true }) };
            } catch (err) {
              if (err instanceof ProcessError || err instanceof BoardError) return { additionalContext: `Grove could not make this chat the task's engineer: ${err.message} Tell the human, and stop.` };
              throw err;
            }
          }
        }
        const task = this.leadTask();
        if (task) return { additionalContext: engineerContext(task, { initial: false }) };
        const work = this.currentWork();
        if (work && !this.work.resolved) return { additionalContext: memberContext(work.task, work.ticket) };
        return inboxNote ? withNote('') : undefined;
      },
      onPreToolUse: async (input) => {
        if (!isRootCall(input, this.selfId)) return undefined;
        if (input?.workingDirectory) this.workingDirectory = input.workingDirectory;
        const name = String(input?.toolName ?? '');
        const args = input?.toolArgs && typeof input.toolArgs === 'object' ? input.toolArgs : {};
        if (this.role === 'chief') {
          if (isSubagentCall(name, args)) return deny('Grove: the Chief of Staff never hires agents or waits on them. Create a task with grove_create_task and start its engineer with create_session.');
          if (name === 'ask_user') return deny('Grove: the Chief of Staff stays available. Ask in your reply and end your turn instead of waiting on a form.');
          if (!(name.startsWith('grove_') || CHIEF_TOOLS.has(name) || isDiscoveryTool(name))) {
            return deny(`Grove: the Chief of Staff coordinates and never does the work itself, so "${name}" is not available. For anything to do or find out (a comment, a label, a merge, checking a PR, reading files), send it to a team: record it on the task it belongs to with grove_record_decision ("changes", "note" or "question"; "changes" reopens a finished task), or start a new task with grove_create_task. For how a task is going, use grove_status.`);
          }
          // Valid handoffs use the task's destination and model, not caller-supplied placement.
          const handoff = name === 'create_session' ? LEAD_MARKER.exec(String(args.prompt ?? '')) : null;
          if (handoff) {
            const t = this.engine?.state.tasks.find((x) => x.id === handoff[2]);
            if (handoff[1] !== this.board.id || !t || this.board.meta.handoffs?.[t.id] !== handoff[3]) return deny('Grove: invalid or stale engineer handoff.');
            try {
              return { modifiedArgs: placeLead(args, t, engineerModel(t.kind), this.board.meta.destinations?.[t.id]) };
            } catch (err) {
              if (err instanceof PlacementError) return deny(`Grove: ${err.message} Supply an explicit destination with grove_handoff.`);
              throw err;
            }
          }
          return undefined;
        }
        if (this.role === 'member') {
          await this.checkPlacement();
          const gate = this.placementGate(name, args);
          if (gate) return gate;
          if (name === 'send_message' && this.board && sameSession(args.session, this.board.meta.chiefLink)) {
            return deny('Grove: reviewers report to the task\'s engineer, not the Chief of Staff. Put everything in your final message (your review); if only the human can unblock you, end it with "BLOCKED: <what the human must do>".');
          }
          if (name === 'create_session') return deny('Grove: reviewers don\'t start other sessions. Do the review yourself in this chat.');
          if (name === 'send_message' && this.work?.reportDue) {
            const r = RELAY_MARKER.exec(String(args.message ?? ''));
            if (r?.[1] === 'report' && r[3] === this.work.ticketId) this.work.reportDue.sent = true;
          }
          return undefined;
        }
        if (this.role !== 'lead') return undefined;
        if (!['set_workspace', 'ask_user'].includes(name)) await this.checkPlacement({
          force: ['create_session', 'grove_submit', 'grove_deliver', 'grove_next'].includes(name),
        });
        const gate = this.placementGate(name, args);
        if (gate) return gate;
        // The engineer does the work itself, with every tool. Reviewers are hired only through Grove's tickets;
        // it may use subagents for side lookups, but they never count as reviews.
        if (HIRE_TOOLS.has(name)) return this.gateHire(name, args);
        return undefined;
      },
      onAgentStop: async (input) => {
        if (!isRootCall(input, this.selfId)) return undefined;
        if (this.role === 'member') {
          let release;
          this.stopping = new Promise((r) => { release = r; });
          try {
            return await this.memberStopped(input?.transcriptPath);
          } finally {
            release();
          }
        }
        const task = this.leadTask();
        if (!task || !this.engine.owns(task) || TERMINAL.has(task.stage)) return undefined;
        const pending = await this.leadPending(task);
        // A turn that said and did nothing isn't sent back: the engineer is declining (for example the Chief told
        // it to hold), and every reply-less turn shows as an error in its chat. Grove's wake-ups try again later.
        if (!pending.length || !this.turnActed || this.stopBlocks >= MAX_STOP_BLOCKS) return undefined;
        this.stopBlocks += 1;
        const step = currentStep(task);
        const only = pending.length === 1 ? pending[0].kind : null;
        return {
          decision: 'block',
          reason: only === 'work'
            ? `Grove: you're on ${step.id} (${KIND_LABELS[step.kind]}) and haven't submitted it. Finish the step and call grove_submit with its output (grove_next has the assignment). If only the human can unblock it, call grove_blocked.`
            : only === 'decide'
              ? `Grove: ${task.id} has no step in progress. Call grove_next and decide: plan steps with grove_plan_steps, or deliver with grove_deliver.`
              : `Grove: ${task.id} still has ${pending.length} thing(s) waiting (${pending.map((p) => p.id).join(', ')}). Call grove_next and do every one, then end your turn.`,
        };
      },
    };
  }

  // A hand-off message from another session arrived in this chat.
  async onRelay(kind, ref) {
    if (kind === 'report' && this.role === 'lead') {
      const before = this.leadTask();
      if (!before) return null;
      // A steered report can land in the middle of later work: one from a round that's over, whose result
      // Grove already recorded, must not pull the engineer off what it's doing now.
      const stale = this.engine.staleTicket(before, ref);
      const n = await this.collectResults();
      const task = this.leadTask();
      if (!task) return null;
      if (stale && !n && !(await this.unreadDecisions(task)).length) {
        return `${engineerContext(task, { initial: false })} This reviewer report is from an earlier review round, and Grove already recorded it. Carry on with what you were doing.`;
      }
      return `${engineerContext(task, { initial: false })} A reviewer reported back${n ? '; Grove recorded it' : ''}. Call grove_next now: its "reviews" field has the full review. Then do what it says.`;
    }
    if (kind === 'decision' && this.role === 'lead') {
      const task0 = this.leadTask();
      if (!task0 || !new RegExp(`^${task0.id}:(\\d+)$`).test(ref)) return null;
      await this.applyLeadDecisions();
      const task = this.leadTask();
      if (!task) return null;
      return `${engineerContext(task, { initial: false })} Grove applied the human's decision. Call grove_next now: its "decisions" field has the full decision. Then do what it says.`;
    }
    if (kind === 'notice' && this.role === 'chief') {
      const [taskId, key] = ref.split(':');
      await this.engine.refresh();
      const t = this.engine.state.tasks.find((x) => x.id === taskId);
      if (key?.startsWith('answer-')) {
        const q = t?.questions?.find((x) => `answer-${x.seq}` === key && x.answer);
        if (!q) return `Grove: there's no answer ${key} for ${taskId}. Check grove_status if unsure.`;
        this.board.meta.answered = { ...(this.board.meta.answered ?? {}), [taskId]: key };
        await this.board.saveMeta();
        return chiefAnswer(t, q);
      }
      const item = t && this.engine.humanActions([t])[0];
      if (!item || noticeKey(t) !== key) return `Grove: ${taskId} no longer needs the human for this. Check grove_status if unsure, and tell the human in one line.`;
      this.board.meta.notified[taskId] = key;
      await this.board.saveMeta();
      return chiefNotice(await this.withReport(item));
    }
    return null;
  }

  // Engineer: it sent one of its relay messages.
  noteLeadMessage(message) {
    const r = RELAY_MARKER.exec(message);
    const task = this.leadTask();
    if (!r || !task || r[2] !== this.board.id) return;
    if (r[1] === 'notice') {
      const [, key] = r[3].split(':');
      if (key.startsWith('answer-')) task.answerSent = key;
      else task.noticeSent = key;
      this.engine.changed(task, null);
    }
    this.stopBlocks = 0;
  }

  async onHirePrompt([, boardId, ticketId, token]) {
    let found;
    try {
      found = await this.bindMember({ boardId, ticketId, token });
    } catch (err) {
      if (err instanceof ProcessError || err instanceof BoardError) return { additionalContext: `Grove could not start this assignment: ${err.message} Say so in one line and stop.` };
      throw err;
    }
    const { task, ticket } = found;
    const brief = briefFor(task, ticket);
    return { modifiedPrompt: brief, additionalContext: memberContext(task, ticket) };
  }

  // Engineer: a create_session / send_message call carrying a hire must be a valid reviewer ticket.
  async gateHire(tool, args) {
    const m = MEMBER_MARKER.exec(hireTextOf(tool, args));
    if (!m) {
      if (tool !== 'send_message') return deny('Grove: the only sessions you start are your reviewers, from the hires grove_submit or grove_next return (pass the title, prompt and model exactly). Do the work yourself; use a subagent for a side lookup.');
      // The Chief's chat carries only what the human must see: Grove's notices. Progress goes on the board.
      const chief = this.board.meta.chiefLink ?? (await this.board.reloadMeta()).chiefLink;
      const relay = RELAY_MARKER.exec(String(args.message ?? ''));
      if (sameSession(args.session, chief) && relay?.[1] !== 'notice') {
        return deny('Grove: don\'t message the Chief of Staff with updates. Post progress with grove_update (the human sees it in the grove and the report). If only the human can unblock the task, call grove_blocked. To answer the human\'s question, call grove_answer. Grove tells the Chief when the human is needed.');
      }
      this.noteLeadMessage(String(args.message ?? ''));
      // The receiving session reads the board as soon as the message lands, so finish writing first.
      await this.board.flush();
      return undefined; // relays and ordinary messages are fine
    }
    const [, boardId, ticketId, token] = m;
    const found = this.engine.findTicket(ticketId);
    if (boardId !== this.board.id || !found || found.ticket.token !== token) return deny(`Grove: ${ticketId} is not a current ticket. Call grove_next for valid hires.`);
    try {
      this.engine.authorizeHire({ marker: ticketId, tool, target: args.session });
      await this.board.flush();
    } catch (err) {
      if (err instanceof ProcessError) return deny(`Grove: ${err.message}`);
      throw err;
    }
    this.stopBlocks = 0;
    return tool === 'create_session' ? { modifiedArgs: placeMember(args, memberModel(found.task, found.ticket), found.task, found.ticket) } : undefined;
  }

  // ---------- tools ----------

  tools() {
    const guarded = (roles, fn) => async (args) => {
      if (!this.session) return { textResultForLlm: 'Grove is still starting.', resultType: 'failure' };
      if (!roles.includes(this.role)) {
        const who = this.role === 'lead' ? `This chat is the engineer for ${this.leadTaskId}`
          : this.role === 'chief' ? 'This chat is the Chief of Staff'
            : this.role === 'member' ? `This chat is a reviewer (${this.work?.ticketId})`
              : 'This chat has no Grove tasks yet and isn\'t working on one';
        return { textResultForLlm: `Grove: ${who}; this tool is for ${roles.filter((r) => r !== 'none').map((r) => ROLE_NAMES[r]).join(' or ')}.`, resultType: 'failure' };
      }
      try {
        // The human calls tasks by name ("tell Moonfern…"), so tools take a name as well as an id.
        if (typeof args?.taskId === 'string' && this.engine) {
          const t = findTask(this.engine.state.tasks, args.taskId);
          if (t) args = { ...args, taskId: t.id };
        }
        return { textResultForLlm: text(await fn(args ?? {})), resultType: 'success' };
      } catch (err) {
        if (err instanceof ProcessError || err instanceof BoardError || err instanceof PlacementError) return { textResultForLlm: `Grove: ${err.message}`, resultType: 'failure' };
        throw err;
      }
    };
    const taskId = { type: 'string', description: 'The task\'s id such as "T1", or its name such as "Moonfern".' };
    const destinationSchema = {
      type: 'object', properties: {
        mode: { type: 'string', enum: DESTINATION_MODES },
        workspace: { type: 'string', description: 'Absolute authorized repository/folder or exact existing worktree; omit for scratch.' },
      }, required: ['mode'], additionalProperties: false,
    };
    const CHIEF = ['chief'];
    const LEAD = ['lead'];
    return [
      {
        name: 'grove_create_task',
        description: 'Chief of Staff: open a Grove task and get the hand-off that starts its engineer in a new session. The engineer tailors the steps to the task (plan, research, execute, verify, with reviewers where they matter), does the work, and delivers the result for the human\'s sign-off.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short title (≤ 80 chars).' },
            goal: { type: 'string', description: 'What the user wants, in full, including constraints and context.' },
            criteria: { type: 'array', items: { type: 'string' }, description: 'Acceptance criteria the human will validate.' },
            kind: { type: 'string', enum: [...TASK_KINDS], description: 'What the task is: "code" for a change to a repository (the engineer runs on Opus), "research" for finding things out (data, issues, docs), "other" for anything else, such as filing or labelling issues (both run on Sol).' },
            destination: destinationSchema,
            chiefSession: { type: 'string', description: 'Your own session link (the openLink from get_current_session), so the engineer can message you when the human is needed. Required for your first task; use "none" only if the host has no session tools.' },
          },
          required: ['title', 'goal', 'kind', 'destination'],
        },
        // The first task turns a plain session into the Chief of Staff.
        handler: guarded(['chief', 'none'], async ({ title, goal, criteria, kind, chiefSession, destination: intent }) => {
          if (!TASK_KINDS.includes(kind)) throw new ProcessError('invalid_input', `kind must be one of ${TASK_KINDS.join(', ')}: "code" for a change to a repository, "research" for finding things out, "other" for anything else.`);
          if (typeof title !== 'string' || !title.trim() || typeof goal !== 'string' || !goal.trim()) throw new ProcessError('invalid_input', 'title and goal are required.');
          if (criteria !== undefined && (!Array.isArray(criteria) || criteria.some((c) => typeof c !== 'string'))) throw new ProcessError('invalid_input', 'criteria must be an array of strings.');
          if (chiefSession !== undefined && chiefSession !== 'none' && !isSessionLink(chiefSession)) throw new ProcessError('invalid_input', 'chiefSession must be your session\'s openLink from get_current_session (agent-host-session://…).');
          if (!chiefSession && !(this.role === 'chief' && this.board.meta.chiefLink)) {
            throw new ProcessError('invalid_input', 'Pass chiefSession: call get_current_session and use its openLink, so the engineer can message you when the human is needed.');
          }
          const target = destination(intent);
          if (this.role !== 'chief') await this.becomeChief();
          if (isSessionLink(chiefSession)) this.board.meta.chiefLink = chiefSession.split('?')[0];
          const n = this.board.meta.nextTask++;
          const id = `T${n}`;
          const token = newHandoffToken();
          this.board.meta.handoffs[id] = token;
          await this.board.saveMeta();
          const t = this.engine.createTask({ id, name: taskName(this.board.id, n), title, goal, criteria: criteria ?? [], kind, destination: target, chiefDirectory: this.leadWorkspace() });
          await this.board.flush();
          return { task: id, name: t.name, handoff: this.handoff(t, token), guidance: this.handoffGuidance(t) };
        }),
      },
      {
        name: 'grove_handoff',
        description: 'Chief of Staff: get a fresh hand-off for a task whose engineer session never started, stalled or was lost. A new engineer takes the task over and picks it up from the board; the old hand-off stops working.',
        parameters: { type: 'object', properties: { taskId, destination: destinationSchema }, required: ['taskId'] },
        handler: guarded(CHIEF, async ({ taskId: id, destination: intent }) => {
          await this.engine.refresh();
          const t = this.engine.task(id);
          if (TERMINAL.has(t.stage)) throw new ProcessError('invalid_state', `${id} is ${t.stage}.`);
          const target = intent ? destination(intent) : t.lastVerifiedPlacement?.repository
            ? { mode: 'existing-worktree', workspace: t.lastVerifiedPlacement.directory }
            : destination(t.destination ?? this.board.meta.destinations?.[id]);
          const token = newHandoffToken();
          this.board.meta.handoffs[id] = token;
          this.board.meta.destinations = { ...this.board.meta.destinations, [id]: target };
          await this.board.saveMeta();
          return { task: id, ...(t.name ? { name: t.name } : {}), handoff: this.handoff(t, token), guidance: this.handoffGuidance(t) };
        }),
      },
      {
        name: 'grove_status',
        description: 'Status of Grove tasks: stage, engineer, reviewer sessions (with links), review votes, verification, and what is waiting on the human.',
        parameters: { type: 'object', properties: { taskId } },
        handler: guarded(['chief', 'lead', 'none'], async ({ taskId: id }) => {
          if (!this.engine) return { tasks: [], waitingOnHuman: [] };
          await this.engine.refresh();
          return this.status(id ?? (this.role === 'lead' ? this.leadTaskId : undefined));
        }),
      },
      {
        name: 'grove_record_decision',
        description: `Chief of Staff: record what the human decided, asked or said about a task, then send the message it returns to the task's engineer. Decisions:
- approve: sign off a delivered result (a code change then ships: the engineer publishes its PR and Grove watches it to merge; pass ship: false if they don't want a PR), accept an escalated step as is, or merge a PR that's ready.
- changes: send it back with their words (a delivered result, an escalated step, a PR under watch, or a finished task to reopen).
- note: pass their words to the engineer without changing anything.
- question: they asked something about the work that the engineer must answer (not a status question: answer those from grove_status yourself).
- hold / resume: stop everyone on the task / pick up where it stopped.
- retry: they fixed what a blocked task needed.
- merge: merge the task's PR.
- shelve: set a task that's waiting on them aside for later ("not now", "park it", "I'll come back to it"). It leaves their inbox, the engineer rests, and everything is kept.
- unshelve: put a shelved task back in their inbox. (Any other answer about a shelved task, such as "changes" to run it again, takes it off the shelf by itself.)
- cancel: drop the task.`,
        parameters: {
          type: 'object',
          properties: {
            taskId,
            decision: { type: 'string', enum: [...DECISIONS] },
            note: { type: 'string', description: 'The human\'s own words (required for changes, note and question).' },
            ship: { type: 'boolean', description: 'approve only: false to finish a code change without opening a PR.' },
            workspaceRepair: { type: 'boolean', description: 'retry/note only: the human explicitly requested attachment repair. Target/isolation derive from recorded destination, never note text.' },
          },
          required: ['taskId', 'decision'],
        },
        handler: guarded(CHIEF, async ({ taskId: id, decision, note, ship, workspaceRepair }) => {
          if (!DECISIONS.includes(decision)) throw new ProcessError('invalid_input', `decision must be one of ${DECISIONS.join(', ')}.`);
          if (ship !== undefined && typeof ship !== 'boolean') throw new ProcessError('invalid_input', 'ship must be true or false.');
          if (workspaceRepair !== undefined && (typeof workspaceRepair !== 'boolean' || !['retry', 'note'].includes(decision))) throw new ProcessError('invalid_input', 'workspaceRepair is boolean and valid only for explicit human retry/note.');
          const msg = typeof note === 'string' ? note.trim() : '';
          return this.recordDecision(id, decision, msg, { ship, workspaceRepair });
        }),
      },
      {
        name: 'grove_cancel_task',
        description: 'Chief of Staff: cancel a task the human no longer wants. Its engineer and reviewers stop.',
        parameters: { type: 'object', properties: { taskId, reason: { type: 'string' } }, required: ['taskId'] },
        handler: guarded(CHIEF, async ({ taskId: id, reason }) => this.recordDecision(id, 'cancel', typeof reason === 'string' ? reason.trim() : '')),
      },
      {
        name: 'grove_next',
        description: 'Engineer: what to do now. While a step is in progress, its assignment (the skill to load, the brief, review feedback to address, the evidence folder) for you to work on and then submit with grove_submit. Also lists reviewer hires (create_session with title/prompt/model for a new reviewer, or send_message with session/message for one who already has a chat) and messages to send with send_message; do those exactly as given. When no step is running, it shows the results and what to decide next.',
        parameters: { type: 'object', properties: {} },
        handler: guarded(LEAD, async () => this.next()),
      },
      {
        name: 'grove_plan_steps',
        description: `Engineer: choose or change the steps for your task. Kinds: ${STEP_KINDS.join(', ')}; attach reviewers to any step (built-in: ${Object.keys(REVIEWER_FOCUS).join(', ')}; other names need a focus). Templates: ${Object.keys(TEMPLATES).join(', ')}. New steps run after the ones already planned; "replace" drops steps that haven't started; "redoFrom" re-runs a finished step and every finished step after it, with "note" as feedback. Returns what to do next (like grove_next).`,
        parameters: {
          type: 'object',
          properties: {
            template: { type: 'string', enum: Object.keys(TEMPLATES), description: 'A ready-made route: code-change (plan → execute → verify, each reviewed) or research (research, reviewed for accuracy).' },
            steps: {
              type: 'array',
              description: 'Steps to add, in order (after the template\'s, if both are given).',
              items: {
                type: 'object',
                properties: {
                  kind: { type: 'string', enum: STEP_KINDS },
                  title: { type: 'string', description: 'Short name for the step.' },
                  brief: { type: 'string', description: 'What exactly this step should do or find out.' },
                  reviewers: {
                    type: 'array',
                    description: 'Who reviews this step\'s output (unanimous). A built-in name, or { name, focus } for your own.',
                    items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { name: { type: 'string' }, focus: { type: 'string' }, worktree: { type: 'boolean', description: 'Opt into a separate reviewer worktree; requires provider support and a committed code snapshot.' } }, required: ['name'] }] },
                  },
                },
                required: ['kind'],
              },
            },
            replace: { type: 'boolean', description: 'Drop planned steps that haven\'t started before adding these.' },
            redoFrom: { type: 'string', description: 'Re-run this finished step (e.g. "S2") and every finished step after it.' },
            note: { type: 'string', description: 'Why, or what to change; kept as feedback for the redone steps and shown to reviewers.' },
          },
        },
        handler: guarded(LEAD, async ({ template, steps, replace, redoFrom, note }) => {
          if (replace !== undefined && typeof replace !== 'boolean') throw new ProcessError('invalid_input', 'replace must be true or false.');
          if (redoFrom !== undefined && typeof redoFrom !== 'string') throw new ProcessError('invalid_input', 'redoFrom must be a step id such as "S2".');
          if (note !== undefined && typeof note !== 'string') throw new ProcessError('invalid_input', 'note must be a string.');
          this.engine.planSteps(this.leadTaskId, { template, steps, replace: !!replace, redoFrom, note: note ?? '' });
          await this.board.flush();
          return this.next();
        }),
      },
      {
        name: 'grove_submit',
        description: 'Engineer: submit the output of the step in progress (see grove_next for its contract). Grove checks it right away and returns what to fix if it falls short. If the step has reviewers, it returns their hires: make each exactly as given, then end your turn; they report back to this chat. Otherwise the next step starts and its assignment comes back.',
        parameters: {
          type: 'object',
          properties: {
            step: { type: 'string', description: 'The step id, e.g. "S2".' },
            output: { type: 'string', description: 'The step\'s output, in Markdown: the plan, the findings, the summary of what you did, or the verification report.' },
          },
          required: ['step', 'output'],
        },
        handler: guarded(LEAD, async ({ step, output }) => {
          if (typeof output !== 'string' || !output.trim()) throw new ProcessError('invalid_input', 'output is required.');
          if (step !== undefined && typeof step !== 'string') throw new ProcessError('invalid_input', 'step must be a step id such as "S2".');
          const task = this.leadTask();
          if (!task) throw new ProcessError('invalid_state', 'This chat is not working on a Grove task.');
          const submitted = currentStep(task);
          const loaded = submitted?.skills?.includes(KIND_SKILLS[submitted.kind]);
          await this.engine.submit(this.leadTaskId, step, output);
          await this.board.flush();
          this.stopBlocks = 0;
          this.catchUp = false;
          const out = await this.next();
          const reminder = submitted && !submitted.ship && !loaded
            ? `Note: Grove didn't see you load the ${KIND_SKILLS[submitted.kind]} skill for ${submitted.id}. Load each step's skill when you start it.`
            : null;
          if (reminder) this.log(`Grove: ${task.id} ${submitted.id} was submitted without the ${KIND_SKILLS[submitted.kind]} skill.`, 'info');
          return { submitted: submitted?.id ?? step, ...(reminder ? { reminder } : {}), ...out };
        }),
      },
      {
        name: 'grove_deliver',
        description: 'Engineer: hand the result to the human once the steps are done. Write a short summary (what was found or done, and anything they should know), list the key decisions you made, and say what you need from them. Grove writes the task report (your ask and summary, the PR, the evidence, criteria, decisions, every step and review) and attaches it. Then send the message it returns to the Chief of Staff.',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'A short summary for the human. Markdown.' },
            decisions: { type: 'array', items: { type: 'string' }, description: 'The key decisions made along the way, each with its reason (up to 12), e.g. "Kept the old API for one release, so existing callers don\'t break".' },
            ask: { type: 'string', description: 'The one thing you need from the human, in a sentence: the decision to make or the question to answer (e.g. "Approve the change, or say whether Reset should stay visible but disabled"). It heads the report. Defaults to a plain sign-off.' },
            ship: { type: 'boolean', description: 'Whether this is a code change for a pull request. Defaults to true when the task changed something (an execute step): you then open a draft PR before the human signs off, and approval publishes it and Grove watches it to merge. Pass false when the change isn\'t a code change for a PR, such as filing issues.' },
          },
          required: ['summary'],
        },
        handler: guarded(LEAD, async ({ summary, decisions, ship, ask }) => {
          if (typeof summary !== 'string') throw new ProcessError('invalid_input', 'summary is required.');
          if (decisions !== undefined && (!Array.isArray(decisions) || decisions.some((d) => typeof d !== 'string'))) throw new ProcessError('invalid_input', 'decisions must be an array of strings.');
          if (ship !== undefined && typeof ship !== 'boolean') throw new ProcessError('invalid_input', 'ship must be true or false.');
          if (ask !== undefined && typeof ask !== 'string') throw new ProcessError('invalid_input', 'ask must be a string.');
          const before = this.engine.task(this.leadTaskId);
          const shipping = !!before.ship?.pr && ['publish', 'watch', 'merge'].includes(before.ship.phase);
          const t = this.engine.deliver(this.leadTaskId, summary, { decisions, ship, ask });
          if (shipping) {
            await this.board.flush();
            return { task: t.id, stage: stageLabel(t), guidance: 'Grove is watching the PR again and wakes you if it needs more. Write one line and end your turn.' };
          }
          await this.board.flush();
          if (t.stage !== 'awaiting-approval') {
            return { task: t.id, stage: stageLabel(t), guidance: 'Grove added a step: open a draft pull request with the change, so the human can review it when they sign off. Call grove_next for the assignment, do it, and submit it with grove_submit. Once the PR is up, grove_next lists the message that tells the Chief of Staff.' };
          }
          const report = await this.writeTaskReport(t);
          const messages = await this.leadMessages(t);
          for (const m of messages) if (!this.wokenFor.has(m.id)) this.noteWake(m.id);
          return {
            delivered: t.id,
            ...(report ? { report } : {}),
            messages: messages.map(({ id, ...m }) => m),
            guidance: messages.length
              ? 'Now send the message below to the Chief of Staff with send_message, exactly as given. Then write a two-line summary and end your turn.'
              : 'Delivered. Grove tells the Chief of Staff. Write a two-line summary and end your turn.',
          };
        }),
      },
      {
        name: 'grove_update',
        description: 'Engineer: post a progress update on the task\'s status board (shown in the grove, the task view and the report). Use it instead of messaging the Chief of Staff: the Chief only hears what the human must act on.',
        parameters: { type: 'object', properties: { text: { type: 'string', description: 'What happened or changed, in a sentence or two.' } }, required: ['text'] },
        handler: guarded(LEAD, async ({ text: msg }) => {
          if (typeof msg !== 'string') throw new ProcessError('invalid_input', 'text is required.');
          this.engine.postUpdate(this.leadTaskId, msg);
          await this.board.flush();
          return { posted: true, guidance: 'Posted. Carry on (or end your turn if nothing else is waiting).' };
        }),
      },
      {
        name: 'grove_blocked',
        description: 'Engineer: the task can\'t go on until the human does something only they can (sign in, grant access, provide something). Everyone stops, and the Chief of Staff asks the human. Work resumes in the same chats when the human says it\'s done.',
        parameters: {
          type: 'object',
          properties: {
            need: { type: 'string', description: 'Exactly what the human must do, e.g. "Run az login --tenant <id> and tell the Chief of Staff when done".' },
            reason: { type: 'string', description: 'What failed and what was tried (errors, commands), briefly.' },
          },
          required: ['need'],
        },
        handler: guarded(LEAD, async ({ need, reason }) => {
          if (typeof need !== 'string') throw new ProcessError('invalid_input', 'need is required.');
          const t = this.engine.block(this.leadTaskId, { need, reason: typeof reason === 'string' ? reason : '' });
          await this.board.flush();
          const messages = await this.leadMessages(t);
          for (const m of messages) if (!this.wokenFor.has(m.id)) this.noteWake(m.id);
          return { blocked: t.id, messages: messages.map(({ id, ...m }) => m), guidance: 'Send the message below to the Chief of Staff with send_message, exactly as given. Then end your turn; the Chief messages this chat when the human has done it.' };
        }),
      },
      {
        name: 'grove_answer',
        description: 'Engineer: answer the question the human asked about this task (it appears in grove_next). Find out what you need first. Then send the message it returns to the Chief of Staff.',
        parameters: { type: 'object', properties: { text: { type: 'string', description: 'The answer, in plain language, with the evidence behind it.' } }, required: ['text'] },
        handler: guarded(LEAD, async ({ text: msg }) => {
          if (typeof msg !== 'string') throw new ProcessError('invalid_input', 'text is required.');
          const { task: t } = this.engine.answer(this.leadTaskId, msg);
          await this.board.flush();
          const messages = await this.leadMessages(t);
          for (const m of messages) if (!this.wokenFor.has(m.id)) this.noteWake(m.id);
          return { answered: t.id, messages: messages.map(({ id, ...m }) => m), guidance: 'Send the message below to the Chief of Staff with send_message, exactly as given, then end your turn.' };
        }),
      },
    ];
  }

  // Used only to detect accidental scratch sharing, never as a destination.
  leadWorkspace() {
    return this.workingDirectory || this.session?.workingDirectory || undefined;
  }

  handoff(task, token) {
    return {
      title: `${taskTag(task)} · ${task.title}`.slice(0, 120),
      prompt: engineerHandoff(task, { boardId: this.board.id, token }),
      relationship: 'independent',
      ...engineerPlacement(task, this.board.meta.destinations?.[task.id]),
      ...(engineerModel(task.kind) ? { model: engineerModel(task.kind) } : {}),
    };
  }

  handoffGuidance(t) {
    const label = taskLabel(t);
    return `Start the engineer now: call create_session with exactly these handoff fields, including workspace/worktree only when returned. Destination is structured, never the Chief's scratch directory or inferred from prose. The engineer verifies its actual attachment before work; existing-worktree redirection requires supported confirmed repair, not a new branch or a silent primary checkout. Then tell the human ${label} has started (link the new session)${t.name ? `, calling it by its name, ${t.name}, so they can refer to it that way` : ''}, and end your turn.`;
  }

  // ---------- reports and the Grove inbox ----------

  takeInboxLog() {
    if (!this.inboxLog.length) return '';
    const words = { cancelled: 'dismissed (cancelled)', 'back to work': 'accepted the stuck step as is (back to work)', done: 'completed (signed off; done)', shipping: 'signed off (the engineer publishes the pull request next)', 'being merged': 'asked to merge its pull request' };
    const lines = this.inboxLog.map((d) => `${d.label ?? d.taskId} "${d.title}": ${words[d.outcome] ?? d.outcome}`);
    this.inboxLog = [];
    return `Grove: since your last turn the human acted in the Grove inbox. ${lines.join('; ')}. Grove recorded these and told the engineers; don't ask the human about them again.`;
  }

  async writeTaskReport(task) {
    if (!this.engine || !task) return null;
    try {
      return await writeReport(task, { root: this.engine.root, boardId: this.board.id, color: taskColor(task.id) });
    } catch (err) {
      this.log(`Grove could not write the report for ${task.id}: ${err.message}`, 'warning');
      return null;
    }
  }

  // A human action item with its report written and linked.
  async withReport(item) {
    const t = this.engine.state.tasks.find((x) => x.id === item.taskId);
    return { ...item, report: (t && (await this.writeTaskReport(t))) ?? null };
  }

  // The report as served by the canvas, rendered from the board's current state.
  reportFor(taskId) {
    const t = this.engine?.state.tasks.find((x) => x.id === taskId);
    if (!t) return null;
    return { task: t, root: this.engine.root, boardId: this.board.id, color: taskColor(t.id) };
  }

  // Evidence files a report may link to: only those listed in one of this task's evidence.json files.
  evidenceFile(taskId, rel) {
    const t = this.engine?.state.tasks.find((x) => x.id === taskId);
    if (!t) return null;
    for (const s of t.steps) {
      for (const v of [s.verification, s.evidence]) {
        if (!v?.dir) continue;
        for (const it of v.items ?? []) if (evidenceRel(t, v, it.file) === rel) return { file: path.join(v.dir, it.file), type: it.type };
      }
    }
    return null;
  }

  // The human acted on a task from the Grove inbox: "complete" signs it off (or accepts an escalated step),
  // "dismiss" drops it. Only the Chief of Staff's own session records decisions.
  async inboxDecide(taskId, action) {
    if (this.role !== 'chief') throw new ProcessError('not_chief', 'Only the Chief of Staff\'s Grove can decide. Open the Grove from the Chief of Staff\'s chat.');
    const decision = INBOX_ACTIONS[action];
    if (!decision) throw new ProcessError('invalid_input', `action must be ${Object.keys(INBOX_ACTIONS).join(', ')}.`);
    await this.engine.refresh();
    const t = this.engine.task(taskId);
    if (decision === 'approve' && !['awaiting-approval', 'escalated'].includes(t.stage)) throw new ProcessError('invalid_state', `${taskId} isn't waiting for your sign-off.`);
    if (decision === 'merge' && t.stage !== 'ready-to-merge') throw new ProcessError('invalid_state', `${taskId}'s pull request isn't ready to merge.`);
    const before = t.stage;
    const note = {
      approve: before === 'escalated' ? 'Accepted as is from the Grove inbox.' : 'Signed off from the Grove inbox.', merge: 'Merge requested from the Grove inbox.',
      cancel: 'Dismissed from the Grove inbox.', shelve: '', unshelve: '',
    }[decision];
    const out = await this.recordDecision(taskId, decision, note, { via: 'grove' });
    // Stop the Chief relaying a notice for a wait the human has already answered.
    const key = noticeKey(t);
    if (key) this.board.meta.notified[taskId] = key;
    await this.board.saveMeta();
    if (!this.inboxPending.has(taskId) || this.inboxPending.get(taskId).seq !== out.recorded.seq) {
      this.inboxPending.set(taskId, { seq: out.recorded.seq, at: Date.now(), action: decision, message: out.message, via: 'grove' });
    }
    const outcome = decisionOutcome(t, before, decision);
    this.inboxLog.push({ taskId, label: taskLabel(t), title: t.title, action: decision, outcome });
    if (decision === 'cancel') this.attached.delete(taskId);
    this.onChange();
    return { task: taskId, decision, outcome };
  }

  // "Attach to chat" in the Grove inbox: the human's next message in the Chief's chat is about these tasks.
  // Hosts don't reliably show extension-pushed composer pills (VS Code doesn't), so Grove keeps the attached
  // tasks itself and adds them as context to the Chief's next human message (see onUserPromptSubmitted).
  // Only the Chief's own Grove can attach, because only its prompts pass through this process.
  async attachTask(taskId, { attach = true } = {}) {
    if (this.role !== 'chief') throw new ProcessError('not_chief', 'Only the Chief of Staff\'s Grove can attach tasks to its chat. Open the Grove from the Chief of Staff\'s chat.');
    this.engine.task(taskId);
    if (attach) this.attached.set(taskId, Date.now());
    else this.attached.delete(taskId);
    this.onChange();
    return { attached: [...this.attached.keys()] };
  }

  // The attached tasks, as context for the human's message. Clears them: they ride along once.
  takeAttached() {
    if (!this.attached.size || !this.engine) return '';
    const ids = [...this.attached.keys()];
    this.attached.clear();
    this.onChange();
    const blocks = [];
    const tasks = this.viewTasks();
    for (const id of ids) {
      const t = tasks.find((x) => x.id === id);
      if (!t) continue;
      const human = this.engine.humanActions([t])[0];
      const lines = [`### ${taskLabel(t)} "${t.title}" (${stageLabel(t)})`];
      if (human) {
        const what = { 'approve-result': 'sign-off on the delivered result', 'resolve-escalation': `input on an escalated step (${human.step})`, unblock: `them to unblock it: ${human.need}`, merge: `their go-ahead to merge ${prLine(human.pr)}` }[human.kind];
        lines.push(`Waiting on the human: ${what}.`);
      }
      if (t.pause?.kind === 'hold') lines.push('It is on hold; "resume" picks it up where it stopped.');
      if (t.stage === 'shelved') lines.push(`It is on the shelf: the human set it aside while it was "${STAGE_LABELS[t.shelf?.from] ?? 'waiting on them'}". Its engineer is resting with everything intact.`);
      if (t.ship?.pr && !human) lines.push(`Shipping: ${prLine(t.ship.pr)} (${t.ship.pr.url}).`);
      const latest = t.updates?.at(-1);
      if (latest) lines.push(`Latest update from the engineer: ${clipText(latest.text, 400)}`);
      if (human?.kind === 'resolve-escalation') lines.push(`Why: ${clipText(t.escalation?.reason ?? human.text, 600)}`);
      if (t.delivery?.summary) lines.push(`Engineer's summary: ${clipText(t.delivery.summary, 1500)}`);
      if (human) lines.push(`Report: ${reportPath(this.engine.root, t.id)}`);
      const lead = t.lead?.link ?? this.board.meta.leadLinks?.[t.id];
      if (lead) lines.push(`Engineer session: ${lead}`);
      if (TERMINAL.has(t.stage)) lines.push('This task has already finished; tell the human, and start a new task if they want more.');
      else if (t.stage === 'shelved') lines.push('Their message is probably about picking it up again. Record their answer as usual and it comes off the shelf: "approve", "changes" with their words (for example to run it again with new data: the same engineer redoes it in its own chat), "merge", "retry", "question" or "note". To just put it back in their inbox, record "unshelve"; to drop it, "cancel". Then send any returned message to the engineer.');
      else if (human?.kind === 'unblock') lines.push('If they say it\'s fixed, record "retry" with their words; otherwise answer them, or record "cancel" or "hold". Then send the returned message to the engineer.');
      else if (human?.kind === 'merge') lines.push('If they want it merged, record "merge"; "changes" with their words if they want more; then send the returned message to the engineer.');
      else if (human) lines.push(`Treat the message as the human's answer: record it with grove_record_decision ("approve", "changes" with their words, "shelve" if they want to come back to it later, or "cancel"), then send any returned message to the engineer.`);
      else lines.push('It is still in progress. If they ask how it is going, answer from grove_status and the latest updates without recording anything. If they ask something the engineer must answer, record "question"; to steer the work, "note"; to stop or restart everyone, "hold" or "resume"; to drop it, "cancel". Then send the returned message to the engineer.');
      blocks.push(lines.join('\n'));
    }
    if (!blocks.length) return '';
    return `Grove: the human attached ${blocks.length === 1 ? 'this task' : 'these tasks'} from the Grove inbox, so this message is about ${blocks.length === 1 ? 'it' : 'them'} even if it doesn't name ${blocks.length === 1 ? 'it' : 'them'}. Start your reply by naming the task${blocks.length === 1 ? '' : 's'} (they can't see the attachment in chat).\n\n${blocks.join('\n\n')}`;
  }

  // The Chief's inbox, shown when the human clicks the Chief in the grove.
  inboxView(human, tasks = this.engine.state.tasks) {
    return {
      canDecide: this.role === 'chief',
      canAttach: this.role === 'chief',
      attached: [...this.attached.keys()],
      // Tasks the human set aside: out of the inbox, the engineer resting, everything kept.
      shelf: tasks.filter((t) => t.stage === 'shelved').map((t) => ({
        taskId: t.id,
        name: t.name ?? null,
        title: t.title,
        color: taskColor(t.id),
        was: STAGE_LABELS[t.shelf?.from] ?? 'Waiting on you',
        summary: clipText(t.delivery?.summary ?? t.escalation?.reason ?? t.pause?.need ?? t.updates?.at(-1)?.text ?? t.goal, 240),
        since: t.shelf?.at ?? t.updatedAt,
        report: `report/${t.id}/`,
        ...(t.ship?.pr?.url ? { pr: t.ship.pr.url } : {}),
      })),
      items: human.map((h) => {
        const t = this.engine.state.tasks.find((x) => x.id === h.taskId);
        const kind = { 'approve-result': 'sign-off', 'resolve-escalation': 'input', unblock: 'blocked', merge: 'merge' }[h.kind] ?? 'input';
        const label = {
          'sign-off': t?.ship?.pr && t.ship.phase === 'draft' ? `Ready for sign-off · draft PR #${t.ship.pr.number}` : t?.delivery?.ship ? 'Ready for sign-off · then a PR' : 'Ready for sign-off',
          input: `Needs your input · ${h.step}`,
          blocked: `Blocked on you${h.by ? ` · ${h.by}` : ''}`,
          merge: `Ready to merge · PR #${h.pr?.number}`,
        }[kind];
        const summary = { 'sign-off': h.summary, input: t?.escalation?.reason ?? h.text, blocked: h.need, merge: prLine(h.pr) }[kind];
        const since = { 'sign-off': t?.delivery?.at, input: t?.escalation?.at, blocked: t?.pause?.at, merge: t?.ship?.readyAt }[kind];
        return {
          taskId: h.taskId,
          name: h.name ?? null,
          title: h.title,
          color: taskColor(h.taskId),
          kind,
          label,
          summary: clipText(summary ?? h.text, 320),
          evidence: h.evidence?.length ?? 0,
          since: since ?? t?.updatedAt ?? null,
          report: `report/${h.taskId}/`,
          ...(h.pr?.url ? { pr: h.pr.url } : {}),
          ...(kind === 'sign-off' && h.ask ? { ask: clipText(h.ask, 300) } : {}),
        };
      }),
    };
  }

  async recordDecision(id, decision, note, { via = 'chat', ship, workspaceRepair } = {}) {
    await this.engine.refresh();
    const t = this.engine.task(id);
    const err = this.engine.decisionError(t, decision, note, { ship });
    if (err) throw new ProcessError('invalid_state', err);
    const before = t.stage;
    let repair;
    if (workspaceRepair) {
      if (!t.lead?.sessionId) throw new PlacementError('Workspace repair needs an existing engineer.');
      const target = repairTarget(t);
      target.workspaceFolder = await fs.realpath(localPath(target.workspaceFolder));
      if (!(await fs.stat(target.workspaceFolder)).isDirectory()) throw new PlacementError('Repair target is not a directory.');
      repair = { sessionId: t.lead.sessionId, target };
    }
    const item = await this.board.appendDecision(id, { action: decision, note, via,
      ...(typeof ship === 'boolean' ? { ship } : {}), ...(repair ? { workspaceRepair: repair } : {}) });
    if (this.engine.owns(t)) this.engine.applyDecisions(t, await this.board.readDecisions(id));
    const outcome = decisionOutcome(t, before, decision, ship);
    const leadLink = t.lead?.link ?? this.board.meta.leadLinks?.[id];
    let message = t.lead && !this.engine.owns(t) && isSessionLink(leadLink)
      ? { tool: 'send_message', session: leadLink, message: decisionMessage(this.board.id, t, item) }
      : null;
    // Shelving needs nothing from the engineer: its Grove picks it up from the board, and the grove shows it at
    // once. The Chief only messages the engineer if that doesn't happen (its session isn't running).
    if (QUIET_DECISIONS.has(decision) && message) {
      this.inboxPending.set(id, { seq: item.seq, at: Date.now(), action: decision, message, via });
      message = null;
      this.onChange();
    }
    const tell = outcome === 'back to work' ? 'Tell the human what happens next'
      : outcome === 'passed on' ? `Tell the human their message was passed to ${id}'s engineer`
        : outcome === 'asked' ? `Tell the human ${id}'s engineer will answer, and you'll bring the answer back`
          : outcome === 'shipping' ? `Tell the human ${id}'s engineer will publish the pull request, and Grove will watch it through checks and review and come back when it's ready to merge or needs them`
            : outcome === 'on the shelf' ? `Tell the human ${id} is on the shelf: it's out of their inbox, its engineer is resting with everything intact, and they can bring it back from the shelf in the Grove (or by asking you) whenever they're ready${t.ship?.pr ? '; Grove keeps watching its PR and brings it back if the PR needs work' : ''}`
            : `Tell the human ${id} is ${outcome}`;
    const delivery = relayDelivery('decision', decision);
    return {
      recorded: { task: id, decision, seq: item.seq },
      message,
      ...(message ? { delivery, fallback: DELIVERY_FALLBACK } : {}),
      guidance: message
        ? `Recorded. Now send ${id}'s engineer the message below with send_message and delivery "${delivery}", exactly as given, so it picks the decision up. ${delivery === 'steer' ? `${DELIVERY_FALLBACK} ` : ''}Then ${tell[0].toLowerCase()}${tell.slice(1)} and end your turn.`
        : `Recorded. ${tell} and end your turn.`,
    };
  }

  async next() {
    const task = this.leadTask();
    if (!task) throw new ProcessError('invalid_state', 'This chat is not working on a Grove task.');
    await this.collectResults();
    // Apply decisions here too, in case their relay hasn't arrived (or never does): the engineer is reading now.
    if (this.engine.owns(task) && this.engine.applyDecisions(task, await this.board.readDecisions(task.id)).length) {
      this.stopBlocks = 0;
      await this.writeTaskReport(task);
    }
    const issued = this.engine.issuedTickets([task], LEAD);
    for (const { ticket } of issued) if (!this.wokenFor.has(ticket.id)) this.noteWake(ticket.id);
    const messages = await this.leadMessages(task);
    for (const m of messages) if (!this.wokenFor.has(m.id)) this.noteWake(m.id);
    if (task.stalled) {
      delete task.stalled;
      this.engine.changed(task, null);
    }
    const hires = issued.map(({ ticket }) => hireInstruction(task, ticket, { boardId: this.board.id, route: this.engine.route(task, ticket) }));
    const inFlight = task.tickets.filter((k) => IN_FLIGHT.has(k.status)).map((k) => ({ ticket: k.id, reviewer: memberTitle(k), status: k.status, session: task.members[k.member]?.link ?? null }));
    const step = currentStep(task);
    const working = step?.status === 'working' && task.stage === 'working' ? step : null;
    let guidance;
    let results;
    let work;
    const question = this.engine.openQuestion(task);
    const waitingHires = task.tickets.filter((k) => k.status === 'issued' && k.retryAt > Date.now());
    if (TERMINAL.has(task.stage)) guidance = `${task.id} is ${stageLabel(task)}. Nothing more to do here.`;
    else if (task.stage === 'shelved') guidance = `${task.id} is on the shelf: the human set it aside for later. Do nothing more: end your turn. When they pick it up again, the Chief of Staff messages this chat (or Grove wakes it).`;
    else if (task.stage === 'on-hold') guidance = `${task.id} is on hold: the human stopped the work${task.pause?.note ? ` ("${task.pause.note}")` : ''}. Do nothing more: end your turn. The Chief of Staff messages this chat when the human resumes it.`;
    else if (task.stage === 'blocked' && !messages.length) guidance = `${task.id} is blocked until the human does this: ${task.pause?.need}. The Chief of Staff has been told. Do nothing more: end your turn. Work picks up here when they've done it.`;
    else if (hires.length || messages.length) guidance = 'Do everything below now, in one turn: make each reviewer hire with the given tool (create_session or send_message), and send each message with send_message, all with exactly the given fields. Then end your turn; reviewers report back to this chat.';
    else if (working) {
      work = stepAssignment(task, working, { evidenceDir: this.engine.stepEvidenceDir(task, working) });
      guidance = `Work on ${working.id} now, in this chat: follow the assignment below, then submit with grove_submit.`;
      if (this.catchUp) {
        results = this.resultsFor(task);
        guidance += ' You took this task over from another engineer: the finished steps\' results are below, and the work so far is in the workspace.';
      }
    }
    else if (task.stage === 'routing') {
      results = this.resultsFor(task);
      guidance = this.routingGuidance(task);
    }
    else if (question) guidance = `The human asked: "${question.text}". Answer it with grove_answer (find out what you need first), then send the message it returns to the Chief of Staff.${inFlight.length ? ' Your reviewers are still working; they report back to this chat.' : ''}`;
    else if (inFlight.length) guidance = `${step ? `${step.id} is` : 'The work is'} with its reviewers in their own chats. End your turn; they report back to this chat.`;
    else if (SHIPPING_STAGES.has(task.stage)) guidance = `${task.id} is shipping: Grove is watching ${prLine(task.ship.pr)} and wakes you if checks fail, a reviewer asks for changes, or the human needs to decide. End your turn.`;
    else if (WAITING.has(task.stage)) guidance = `${task.id} is waiting on the human (${stageLabel(task)}), and the Chief of Staff has been told. Write a two-line summary and end your turn; the Chief messages this chat when the human decides.`;
    else if (waitingHires.length) guidance = `Hires ${waitingHires.map((k) => k.id).join(', ')} wait until the host's message limit resets (about ${new Date(Math.max(...waitingHires.map((k) => k.retryAt))).toISOString().slice(11, 16)} UTC). End your turn; Grove offers them again then.`;
    else guidance = 'Nothing to do right now.';
    if (question && !guidance.startsWith('The human asked')) guidance += ` The human also asked: "${question.text}". Answer it with grove_answer once you can.`;
    // The full text of what the human decided and what reviewers said: relays only point here, so nothing
    // depends on a relay arriving whole, in order or at all.
    const live = !TERMINAL.has(task.stage);
    const decisions = live ? await this.decisionsFor(task) : [];
    const reviews = live ? await this.reviewsFor(task) : [];
    if (decisions.length) guidance = `Read "decisions" first: the human decided something since you last looked${decisions.some((d) => d.historical) ? ' (entries marked historical are from before this list existed: check whether you already acted on them before acting)' : ''}. ${guidance}`;
    const out = { task: task.id, stage: stageLabel(task), guidance, ...(work ? { work } : {}),
      ...(task.destination ? { destination: task.destination, placement: task.placement ?? { status: 'unknown' } } : {}),
      ...(task.workspaceRepair ? { workspaceRepair: {
        target: task.workspaceRepair.target,
        confirmation: { message: 'Confirm the authorized workspace repair.', requestedSchema: {
          properties: { workspaceConfirmation: confirmationForm(task.workspaceRepair.target) },
        } },
      } } : {}),
      hires, messages: messages.map(({ id, ...m }) => m), inFlight, steps: this.stepsSummary(task), ...(results ? { results } : {}),
      ...(live ? { decisions, reviews } : {}) };
    this.consumeDecisions(task, decisions);
    return out;
  }

  // Engineer: the human's decisions it hasn't read in grove_next yet, oldest first (or just the given ones if
  // the board can't be read).
  async unreadDecisions(task, fallback = []) {
    const from = task.consumedDecisionSeq ?? 0;
    let all;
    try { all = await this.board.readDecisions(task.id); } catch { all = fallback; }
    const unread = all.filter((d) => d.seq > from && !QUIET_DECISIONS.has(d.action));
    return unread.length ? unread : fallback.filter((d) => !QUIET_DECISIONS.has(d.action));
  }

  // grove_next's "decisions": every decision past the engineer's read cursor, with the human's full words.
  async decisionsFor(task) {
    if (task.consumedDecisionSeq === undefined && this.engine.owns(task)) {
      // Tasks from before the cursor existed: show what's on the board once, flagged, rather than guess.
      task.consumedDecisionSeq = 0;
      task.decisionCursorLegacyMax = task.decisionsApplied ?? 0;
      this.engine.changed(task, null);
    }
    const from = task.consumedDecisionSeq ?? 0;
    const legacy = task.decisionCursorLegacyMax;
    return (await this.board.readDecisions(task.id)).filter((d) => d.seq > from).map((d) => ({
      seq: d.seq, action: d.action, note: d.note ?? '', at: d.at, applied: d.seq <= (task.decisionsApplied ?? 0),
      ...(legacy !== undefined && d.seq <= legacy ? { historical: true } : {}),
    }));
  }

  // Advance the read cursor once grove_next's answer is built, so a failure before then shows them again.
  consumeDecisions(task, decisions) {
    if (!this.engine.owns(task)) return;
    const max = Math.max(task.consumedDecisionSeq ?? 0, ...decisions.map((d) => d.seq));
    const legacy = task.decisionCursorLegacyMax !== undefined;
    if (max === (task.consumedDecisionSeq ?? 0) && !legacy) return;
    task.consumedDecisionSeq = max;
    delete task.decisionCursorLegacyMax;
    this.engine.changed(task, null);
  }

  // grove_next's "reviews": the full text of each finished review in the current round (or, between rounds,
  // the round that just closed). Earlier rounds, and cancelled or failed hires, are left out.
  async reviewsFor(task) {
    const cur = currentStep(task);
    const step = cur?.forum?.round > 0 ? cur
      : [...(task.steps ?? [])].filter((s) => s.forum?.round > 0 && s.status === 'done').at(-1);
    if (!step) return [];
    const round = step.forum.round;
    const out = [];
    for (const k of task.tickets) {
      if (k.step !== step.id || k.round !== round || k.status !== 'done') continue;
      let text;
      let clipped = false;
      let r = null;
      try { r = await this.board.readResult(k.id); } catch { r = null; }
      const post = step.forum.posts.filter((p) => p.kind === 'review' && p.role === k.specialty && p.round === round).at(-1);
      if (r && r.ticket === k.id && r.token === k.token && r.status === 'done' && typeof r.text === 'string') text = r.text;
      else {
        text = post?.text ?? '';
        clipped = text.length >= 12000;
      }
      out.push({ ticket: k.id, step: step.id, round, reviewer: memberTitle(k),
        verdict: post?.verdict ?? null, text, ...(clipped ? { clipped: true } : {}) });
    }
    return out;
  }

  // What the engineer should do when no step is in progress.
  routingGuidance(task) {
    if (task.ship?.pr && task.ship.attention) {
      return `${prLine(task.ship.pr)} needs work:\n- ${task.ship.attention.problems.join('\n- ')}\nPlan the fix with grove_plan_steps: usually one execute step in which you fix it on the PR's branch, push, and reply on the PR; add reviewers only if the fix is substantial. When the steps are done Grove goes back to watching the PR. If nothing needs changing, call grove_deliver with one line saying why. If only the human can fix it, call grove_blocked.`;
    }
    if (!task.steps.length) {
      return 'Choose the steps for this task with grove_plan_steps: a template ("code-change" or "research") and/or your own steps, each with a brief. Use only what the task needs.';
    }
    const human = [...task.feedback].reverse().find((f) => f.from === 'human');
    const failed = [...task.steps].reverse().find((s) => s.kind === 'verify' && s.status === 'done' && s.verification?.result === 'fail');
    const lastStep = task.steps.filter((s) => s.status === 'done').at(-1);
    if (task.deliveries && !task.delivery && human) {
      const pr = task.ship?.pr ? ` The change already has a draft PR (${task.ship.pr.url}); push fixes to its branch, and the PR is reused when you deliver again.` : '';
      return `The human asked for more: "${human.text}". Plan the steps that address it with grove_plan_steps (redoFrom to re-run a finished step with their feedback, or new steps), then call grove_next.${pr}`;
    }
    if (failed && failed === lastStep) {
      return `${failed.id} verification FAILED (see results). Plan the fix with grove_plan_steps, usually redoFrom the execute step, with a note on what to fix. Or, if it can't be fixed, deliver with grove_deliver and explain.`;
    }
    return 'All planned steps are done; the results are below. If they answer the task, call grove_deliver with a short summary for the human (what was found or done, and anything to watch out for). If not, add or redo steps with grove_plan_steps.';
  }

  // Outputs of finished steps, newest in full, for the engineer to judge and summarise.
  resultsFor(task) {
    const done = task.steps.filter((s) => s.status === 'done' && s.output && !s.ship);
    return done.map((s, i) => ({
      step: stepLabel(s),
      version: s.version,
      reviewed: s.reviewers.length ? s.reviewers.map((r) => r.name) : [],
      ...(s.verification ? { verification: s.verification.result, evidence: s.verification.items.length } : {}),
      output: i === done.length - 1 ? clipText(s.output, 12000) : clipText(s.output, 2500),
    }));
  }

  stepsSummary(t) {
    return t.steps.filter((s) => s.status !== 'skipped').map((s) => {
      const f = s.forum;
      const votes = {};
      for (const p of f.posts) if (p.kind === 'review' && p.round === f.round) votes[p.role] = p.verdict;
      return {
        id: s.id, kind: s.kind, title: s.title, status: s.status, version: s.version,
        ...(s.redoOf ? { redoOf: s.redoOf } : {}),
        ...(s.reviewers.length ? { review: { reviewers: s.reviewers.map((r) => r.name), round: f.round ? f.round - f.windowStart : 0, maxRounds: MAX_ROUNDS, votes: Object.fromEntries(s.reviewers.map((r) => [r.name, votes[r.name] ?? 'pending'])) } } : {}),
        ...(s.verification ? { verification: s.verification.result } : {}),
      };
    });
  }

  status(id) {
    const tasks = id ? [this.engine.task(id)] : this.engine.state.tasks;
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        ...(t.name ? { name: t.name } : {}),
        title: t.title,
        stage: stageLabel(t),
        kind: t.kind,
        ...(t.destination ? { destination: t.destination, placement: t.placement ?? { status: 'unknown' } } : {}),
        engineer: t.lead ? { session: t.lead.link ?? this.board.meta.leadLinks?.[t.id] ?? null, status: 'working in its own session' } : TERMINAL.has(t.stage) ? null : 'not started: call grove_handoff and create_session',
        ...(errorText(t.lead?.error) ? { engineerError: errorText(t.lead.error) } : {}),
        reviewers: Object.values(t.members ?? {}).map((m) => ({ reviewer: m.title, session: m.link, status: m.status, worktree: !!m.worktree })),
        steps: this.stepsSummary(t),
        delivery: t.delivery ? { summary: t.delivery.summary, ship: !!t.delivery.ship } : null,
        escalation: t.escalation,
        ...(t.shelf ? { shelved: { from: STAGE_LABELS[t.shelf.from] ?? t.shelf.from, since: new Date(t.shelf.at).toISOString() } } : {}),
        ...(t.pause ? { paused: { kind: t.pause.kind, need: t.pause.need ?? null, by: t.pause.by ?? null, since: new Date(t.pause.at).toISOString() } } : {}),
        ...(t.ship ? { shipping: { phase: t.ship.phase, pr: t.ship.pr ? { url: t.ship.pr.url, status: prLine(t.ship.pr), error: t.ship.pr.error ?? null } : null, needsWork: t.ship.attention?.problems ?? null } } : {}),
        updates: (t.updates ?? []).slice(-5).map((u) => ({ at: new Date(u.at).toISOString(), text: u.text })),
        ...(t.questions?.length ? { questions: t.questions.slice(-3).map((q) => ({ asked: q.text, answer: q.answer ?? '(not answered yet)' })) } : {}),
        tickets: t.tickets.filter((k) => k.status !== 'cancelled').slice(-10).map((k) => ({ id: k.id, reviewer: memberTitle(k), status: k.status, failure: k.failure, ...(memberError(k) && k.status !== 'failed' ? { error: memberError(k) } : {}) })),
        recent: t.history.slice(-6).map((h) => h.text),
      })),
      waitingOnHuman: this.engine.humanActions(tasks),
    };
  }

  // ---------- canvas view ----------

  // One sprite per session: the Chief, each task lead, and each member session. Members walk to their
  // station while they hold a ticket and rest at camp between rounds.
  // Tasks as the human last left them: a shelve or unshelve the engineer's Grove hasn't applied yet already
  // shows, so the inbox and the lantern react at once.
  viewTasks() {
    return this.engine.state.tasks.map((t) => {
      const p = this.inboxPending.get(t.id);
      if (!p || (t.decisionsApplied ?? 0) >= p.seq) return t;
      if (p.action === 'shelve' && t.stage !== 'shelved') return { ...t, stage: 'shelved', shelf: { from: t.stage, at: p.at, note: '' } };
      if (p.action === 'unshelve' && t.stage === 'shelved') return { ...t, stage: t.shelf?.from ?? 'awaiting-approval', shelf: null };
      return t;
    });
  }

  liveView() {
    if (!this.engine) return { agents: [], council: null, lastDecision: null, process: null };
    const s = { ...this.engine.state, tasks: this.viewTasks() };
    const human = this.engine.humanActions(s.tasks);
    const active = s.tasks.filter((t) => !TERMINAL.has(t.stage));
    const agents = [{
      id: 'grove-chief',
      name: 'Chief of Staff',
      role: 'orchestrator',
      palette: 'violet',
      activity: human.length ? 'waiting' : this.role === 'chief' && this.busy ? 'council' : 'idle',
      task: human.length ? `Waiting on you: ${human.map((h) => h.taskId).join(', ')}` : active.length ? `Delegated ${active.map((t) => t.id).join(', ')}` : 'Available',
      error: this.role === 'chief' ? errorText(this.sessionError) : '',
      updatedAt: s.updatedAt,
    }];
    for (const t of active) {
      const step = currentStep(t);
      const huddle = step?.status === 'reviewing' ? `${t.id}:${step.id}` : null;
      const huddleLabel = huddle ? `${t.id} R${step.forum.round - step.forum.windowStart}` : null;
      const reviewStation = (st) => (st?.kind === 'execute' || st?.kind === 'verify' ? 'code-review' : 'plan-review');
      if (t.lead) {
        const blockedHere = t.stage === 'blocked' && !t.pause?.ticket;
        const detour = t.lead.phase && step && t.lead.phase.step === step.id ? t.lead.phase.kind : null;
        const activity = blockedHere ? 'waiting'
          : LEAD_IDLE.has(t.stage) ? 'idle'
            : huddle ? reviewStation(step)
              : step?.status === 'working' ? (step.ship ? 'implementing' : KIND_ACTIVITY[detour ?? step.kind])
                : 'planning';
        agents.push({
          id: `grove-engineer-${t.id}`,
          name: 'Engineer',
          role: 'engineer',
          palette: 'dusk',
          activity,
          task: engineerLine(t),
          taskId: t.id,
          taskName: t.name ?? null,
          taskColor: taskColor(t.id),
          group: activity === 'plan-review' || activity === 'code-review' ? huddle : null,
          groupLabel: activity === 'plan-review' || activity === 'code-review' ? huddleLabel : null,
          error: errorText(t.lead.error) || (t.stalled ? `Stalled: stopped responding (${t.stalled.tickets.join(', ')})` : '') || (t.ship?.pr?.error ? `Can't read PR #${t.ship.pr.number}: ${t.ship.pr.error}` : ''),
          updatedAt: t.lead.claimedAt ?? s.updatedAt,
        });
      }
      // Latest ticket per reviewer session, and each reviewer's last verdict on this task.
      const latest = new Map();
      for (const k of t.tickets) if (k.status !== 'cancelled') latest.set(k.member, k);
      const verdicts = new Map();
      for (const st of t.steps) for (const p of st.forum.posts) if (p.kind === 'review') verdicts.set(`reviewer-${p.role}`, p.verdict);
      const blockedBy = t.stage === 'blocked' ? t.pause?.ticket : null;
      for (const [key, k] of latest) {
        const m = t.members?.[key];
        const working = IN_FLIGHT.has(k.status);
        if (!working && !m?.link && !memberError(k)) continue;
        const kStep = t.steps.find((x) => x.id === k.step);
        agents.push({
          id: `grove-${t.id}-${key}`,
          name: cap(k.specialty),
          role: 'reviewer',
          palette: SPECIALTY_ROBE[k.specialty] ?? 'dusk',
          activity: k.id === blockedBy ? 'waiting' : !working ? 'idle' : reviewStation(kStep),
          task: k.id === blockedBy ? `blocked: ${t.pause.need}` : working ? (kStep ? `reviewing ${stepLabel(kStep)}` : t.title) : 'waiting for the next review',
          taskId: t.id,
          taskName: t.name ?? null,
          taskColor: taskColor(t.id),
          group: working ? `${t.id}:${k.forum}` : null,
          groupLabel: working && kStep ? `${t.id} R${kStep.forum.round - kStep.forum.windowStart}` : null,
          ...(verdicts.has(key) ? { verdict: verdicts.get(key) } : {}),
          error: memberError(k),
          updatedAt: k.dispatchedAt ?? m?.since ?? s.updatedAt,
        });
      }
    }
    let lastDecision = null;
    for (const t of s.tasks) for (const step of t.steps) {
      const p = step.forum.posts.findLast((x) => x.kind === 'system' && x.verdict === 'approve');
      if (p && (!lastDecision || p.at > lastDecision.decidedAt)) lastDecision = { topic: `${t.id} ${step.id} review`, decision: `${t.id} ${KIND_LABELS[step.kind].toUpperCase()} APPROVED`, decidedAt: p.at };
    }
    return {
      agents,
      council: null,
      lastDecision,
      process: {
        tasks: s.tasks.map((t) => ({
          id: t.id, name: t.name ?? null, title: t.title, stage: t.stage, stageLabel: stageLabel(t), color: taskColor(t.id),
          steps: t.steps.filter((x) => x.status !== 'skipped').map((x) => ({
            id: x.id, kind: x.kind, label: stepLabel(x), status: x.status, version: x.version, output: x.output,
            reviewers: x.reviewers.map((r) => r.name), forum: x.forum,
            verification: x.verification ? { result: x.verification.result, artifacts: x.verification.items.length } : null,
          })),
          delivery: t.delivery?.summary ?? null,
          working: t.tickets.filter((k) => IN_FLIGHT.has(k.status)).length,
          kind: t.kind,
          engineer: TERMINAL.has(t.stage) ? null : t.lead ? 'active' : 'pending',
          shelf: t.shelf ? { from: t.shelf.from, fromLabel: STAGE_LABELS[t.shelf.from] ?? t.shelf.from, at: t.shelf.at } : null,
          waitingOnHuman: WAITING.has(t.stage),
          updates: (t.updates ?? []).slice(-20),
          pause: t.pause ? { kind: t.pause.kind, need: t.pause.need ?? null, by: t.pause.by ?? null, note: t.pause.note ?? null, at: t.pause.at } : null,
          ship: t.ship ? { phase: t.ship.phase, pr: t.ship.pr ? { url: t.ship.pr.url, number: t.ship.pr.number, line: prLine(t.ship.pr), error: t.ship.pr.error ?? null } : null } : null,
          questions: (t.questions ?? []).slice(-10),
          updatedAt: t.updatedAt,
        })),
        waitingOnHuman: human.map((h) => h.taskId),
        inbox: this.inboxView(human, s.tasks),
        maxRounds: MAX_ROUNDS,
        updatedAt: s.updatedAt,
      },
    };
  }
}
