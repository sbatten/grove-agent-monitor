// Which model each Grove session runs on. Reviewers' models are set where people expect them: the `model:`
// field of each reviewer agent's front matter (agents/*.agent.md). Sessions aren't started as those custom
// agents (create_session can't pick one), so Grove reads the field and passes it as create_session's `model`
// for every hire, and its preToolUse hook enforces it. Nobody sets models by hand, and a session never falls
// back to the model of the chat that created it.
//
// `model:` takes one id, or a list. For the generic reviewer (custom focuses such as accuracy or privacy)
// a list is a rotation: each custom-focus seat on a step gets the next model, so a review mixes models.
//
// The engineer's model depends on the task's kind (ENGINEER_MODELS): code changes run on Opus, research and
// other work on Sol. grove-engineer.agent.md names the code model, for anyone who picks the agent by hand.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_TYPES, ENGINEER_AGENT } from './engine.mjs';

const AGENTS_DIR = fileURLToPath(new URL('../../../../agents/', import.meta.url));
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/ ()-]{0,79}$/;
const cache = new Map();

export const ENGINEER_MODELS = Object.freeze({ code: 'claude-opus-5.5', research: 'gpt-6.1-sol', other: 'gpt-6.1-sol' });

// The `model:` field of an agent file: a string, an inline list `[a, b]`, or a block list.
export function parseModels(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(String(text ?? ''));
  if (!fm) return [];
  const lines = fm[1].split('\n');
  const i = lines.findIndex((l) => /^model:/.test(l));
  if (i < 0) return [];
  const clean = (s) => s.trim().replace(/^['"]|['"]$/g, '').trim();
  const value = lines[i].slice('model:'.length).trim();
  let out;
  if (value.startsWith('[')) out = value.replace(/^\[|\]$/g, '').split(',').map(clean);
  else if (value) out = [clean(value)];
  else {
    out = [];
    for (const l of lines.slice(i + 1)) {
      const item = /^\s+-\s+(.*)$/.exec(l);
      if (!item) break;
      out.push(clean(item[1]));
    }
  }
  return out.filter((m) => MODEL_ID.test(m));
}

export function agentModels(agentType, dir = AGENTS_DIR) {
  const name = String(agentType ?? '').replace(/^[^:]+:/, '');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) return [];
  const key = `${dir}\u0000${name}`;
  if (!cache.has(key)) {
    let models = [];
    try {
      models = parseModels(fs.readFileSync(path.join(dir, `${name}.agent.md`), 'utf8'));
    } catch {
      /* not a Grove agent */
    }
    cache.set(key, models);
  }
  return cache.get(key);
}

// The model for a reviewer hire. A reviewer with a custom focus takes its turn in the generic reviewer's
// rotation.
export function memberModel(task, ticket, dir = AGENTS_DIR) {
  const models = agentModels(ticket.agentType, dir);
  if (!models.length) return null;
  if (models.length === 1) return models[0];
  const step = task.steps?.find((s) => s.id === ticket.step);
  const generic = (step?.reviewers ?? []).map((r) => r.name).filter((n) => AGENT_TYPES.reviewer(n) === ticket.agentType);
  const seat = Math.max(0, generic.indexOf(ticket.specialty));
  return models[seat % models.length];
}

// The engineer's model for a task of this kind.
export function engineerModel(kind, dir = AGENTS_DIR) {
  return ENGINEER_MODELS[kind] ?? agentModels(ENGINEER_AGENT, dir)[0] ?? null;
}
