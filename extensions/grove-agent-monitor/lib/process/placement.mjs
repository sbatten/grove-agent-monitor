import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const DESTINATION_MODES = ['scratch', 'new-worktree', 'existing-worktree', 'read-only'];
export class PlacementError extends Error {}

export function localPath(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new PlacementError('workspace must be an absolute local folder.');
  if (/(^|[\\/])(?:\.|%2e){2}([\\/]|$)/i.test(value)) throw new PlacementError('workspace must not contain parent traversal.');
  let folder;
  try {
    folder = value.startsWith('file:') ? fileURLToPath(value) : value;
  } catch (err) {
    throw new PlacementError(`Invalid workspace URI: ${err.message}`);
  }
  if (!path.isAbsolute(folder) || folder.split(/[\\/]/).includes('..')) throw new PlacementError('workspace must be absolute, without parent traversal.');
  return path.normalize(folder);
}

export function destination(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !DESTINATION_MODES.includes(value.mode)) {
    throw new PlacementError(`destination is required: mode must be ${DESTINATION_MODES.join(', ')}.`);
  }
  if (Object.keys(value).some((k) => !['mode', 'workspace'].includes(k))) throw new PlacementError('destination accepts only mode and workspace.');
  if (value.mode === 'scratch') {
    if (value.workspace !== undefined) throw new PlacementError('scratch destination must omit workspace.');
    return { mode: 'scratch' };
  }
  return { mode: value.mode, workspace: localPath(value.workspace) };
}

export function engineerPlacement(task, override) {
  const intent = destination(override ?? task.destination);
  const previous = task.lastVerifiedPlacement;
  if (!override && intent.mode === 'new-worktree' && previous?.repository && previous.directory) {
    return { workspace: previous.directory, worktree: false };
  }
  return intent.mode === 'scratch' ? {} : { workspace: intent.workspace, worktree: intent.mode === 'new-worktree' };
}

export function reviewerPlacement(task, ticket) {
  if (!ticket.worktree) return {};
  if (task.placement?.status !== 'verified' || !task.placement.repository) throw new PlacementError('Separate review requires a verified repository attachment.');
  return { workspace: task.placement.directory, worktree: true };
}

async function canonical(folder) {
  const real = await fs.realpath(localPath(folder));
  if (!(await fs.stat(real)).isDirectory()) throw new PlacementError(`${folder} is not a directory.`);
  return real;
}

async function git(folder, args, options = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[k];
  return exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-C', folder, ...args], {
    env, timeout: 10000, maxBuffer: 1024 * 1024, ...options,
  });
}

export async function gitIdentity(folder) {
  const directory = await canonical(folder);
  const read = async (...args) => (await git(directory, ['rev-parse', ...args])).stdout.trim();
  const [root, common, branch, head, worktrees] = await Promise.all([
    read('--show-toplevel'), read('--path-format=absolute', '--git-common-dir'),
    read('--abbrev-ref', 'HEAD'), read('--verify', 'HEAD^{commit}'), git(directory, ['worktree', 'list', '--porcelain']),
  ]);
  const primary = /^worktree (.+)$/m.exec(worktrees.stdout)?.[1];
  if (!primary || !/^[a-f0-9]{40,64}$/.test(head)) throw new PlacementError('Git checkout identity is unavailable.');
  return { directory, root: await canonical(root), repository: await fs.realpath(common), primary: await canonical(primary), branch, head };
}

export async function observePlacement(task, folder, { reviewer, sessionId, chiefDirectory, continuation = false } = {}) {
  try {
    const intent = destination(task.destination);
    const directory = await canonical(folder);
    if (intent.mode === 'scratch') {
      if (chiefDirectory && directory === await canonical(chiefDirectory)) throw new PlacementError('Engineer reused the Chief scratch folder.');
      if (reviewer && directory !== task.placement?.directory) throw new PlacementError('Reviewer does not share the engineer directory.');
      return { status: 'verified', directory, sessionId, at: Date.now() };
    }
    const actual = await gitIdentity(directory);
    const target = await gitIdentity(intent.workspace);
    if (actual.repository !== target.repository) throw new PlacementError('Attached checkout belongs to a different repository.');
    if (reviewer) {
      if (task.placement?.status !== 'verified') throw new PlacementError('Engineer attachment is not verified.');
      if (reviewer.worktree) {
        if (actual.root !== actual.directory || actual.root === actual.primary || actual.root === task.placement.root
          || actual.directory === task.placement.directory) throw new PlacementError('Isolated reviewer must use a separate linked worktree.');
        if (reviewer.snapshot && actual.head !== reviewer.snapshot) throw new PlacementError(`Reviewer HEAD ${actual.head} differs from submitted ${reviewer.snapshot}.`);
        if (await committedSnapshot(directory) !== actual.head) throw new PlacementError('Reviewer HEAD changed during content verification.');
        actual.clean = true;
      } else if (directory !== task.placement.directory) {
        throw new PlacementError('Reviewer does not share the engineer directory.');
      }
    } else {
      const previous = task.lastVerifiedPlacement;
      const exact = intent.mode === 'existing-worktree' || intent.mode === 'read-only' || previous?.directory;
      const expected = previous?.directory ?? target.directory;
      if (exact && directory !== expected) throw new PlacementError(`Host attached ${directory}; expected exact checkout ${expected}.`);
      if (intent.mode === 'new-worktree' && (actual.root === actual.primary || actual.root === target.root)) {
        throw new PlacementError('New repository task requires an isolated linked worktree, not the selected checkout.');
      }
      if (continuation && previous?.branch && actual.branch !== previous.branch) throw new PlacementError(`Continuation branch changed from ${previous.branch} to ${actual.branch}.`);
    }
    return { status: 'verified', ...actual, sessionId, at: Date.now() };
  } catch (err) {
    return { status: 'invalid', error: `Placement verification failed: ${err.message}`, sessionId, at: Date.now() };
  }
}

export async function committedSnapshot(folder) {
  const p = await gitIdentity(folder);
  for (const args of [['diff-index', '--quiet', '--no-ext-diff', 'HEAD', '--'], ['diff-files', '--quiet', '--no-ext-diff', '--']]) {
    try {
      await git(p.directory, args);
    } catch (err) {
      if (err.code === 1) throw new PlacementError('Isolated review requires committed content; tracked changes are present.');
      throw err;
    }
  }
  if ((await git(p.directory, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout) {
    throw new PlacementError('Isolated review requires committed content; untracked files are present.');
  }
  return p.head;
}

export async function prepareReviewer(task, ticket, folder) {
  if (!ticket.worktree || !ticket.snapshot) return;
  const p = await observePlacement(task, folder, { reviewer: { ...ticket, snapshot: null } });
  if (p.status !== 'verified') throw new PlacementError(p.error);
  await committedSnapshot(folder);
  if (p.head === ticket.snapshot) return;
  if (!/^[a-f0-9]{40,64}$/.test(ticket.snapshot)) throw new PlacementError('Invalid review commit.');
  const hooks = await fs.mkdtemp(path.join(os.tmpdir(), 'grove-review-hooks-'));
  try {
    await git(p.directory, ['-c', `core.hooksPath=${hooks}`, 'checkout', '--detach', ticket.snapshot]);
  } finally {
    await fs.rmdir(hooks);
  }
  const checked = await observePlacement(task, folder, { reviewer: ticket });
  if (checked.status !== 'verified') throw new PlacementError(checked.error);
}

export function repairTarget(task) {
  const intent = destination(task.destination);
  if (intent.mode === 'scratch') throw new PlacementError('Scratch tasks have no repository attachment to repair.');
  return { workspaceFolder: task.lastVerifiedPlacement?.directory ?? intent.workspace, isolation: !task.lastVerifiedPlacement && intent.mode === 'new-worktree' };
}

export function confirmationForm(target) {
  return { type: 'boolean', title: `Confirm workspace ${target.workspaceFolder}; isolation=${target.isolation}`, default: false };
}

export function reviewerMatches(task, ticket, placement) {
  if (!task.destination) return true; // Legacy tickets keep their existing contract.
  if (placement?.status !== 'verified' || task.placement?.status !== 'verified') return false;
  if (ticket.worktree) {
    return placement.clean === true && placement.repository === task.placement.repository && placement.root === placement.directory
      && placement.root !== placement.primary && placement.root !== task.placement.root
      && placement.directory !== task.placement.directory && (!ticket.snapshot || placement.head === ticket.snapshot);
  }
  return placement.directory === task.placement.directory;
}
