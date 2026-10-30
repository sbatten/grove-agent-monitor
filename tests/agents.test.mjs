// Run: node tests/agents.test.mjs
// Agent front matter must be valid YAML, or the host silently drops the agent. The usual trap is an
// unquoted ": " inside a value.
// Every agent sets its model (see lib/process/models.mjs).
// Specialists must not declare a `tools:` allowlist: with one, tool search finds deferred tools (browser,
// screenshots, MCP, skills) but cannot load them, so verification and testing get stuck.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseModels } from '../extensions/grove-agent-monitor/lib/process/models.mjs';

const root = new URL('../', import.meta.url);
const plugin = JSON.parse(await fs.readFile(new URL('.plugin/plugin.json', root), 'utf8'));
assert.equal(plugin.name, 'grove-agent-monitor', 'the plugin has a stable install identity');
assert.match(plugin.version, /^\d+\.\d+\.\d+$/, 'the plugin declares a semantic version');
assert.ok(plugin.description?.trim(), 'the plugin has a description');
for (const component of ['agents', 'skills', 'extensions']) {
  assert.equal(plugin[component], `${component}/`, `${component}: register the bundled directory relative to the plugin root`);
  assert.ok((await fs.stat(new URL(plugin[component], root))).isDirectory(), `${component}: directory exists`);
}
const extensionsDir = new URL(plugin.extensions, root);
const extensions = (await fs.readdir(extensionsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory());
assert.ok(extensions.some((entry) => entry.name === 'grove-agent-monitor'), 'the canvas extension is bundled');
for (const extension of extensions) {
  assert.ok((await fs.stat(new URL(`${extension.name}/extension.mjs`, extensionsDir))).isFile(), `${extension.name}: SDK entry point exists`);
}

const dir = new URL(plugin.agents, root);
const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.agent.md'));
assert.ok(files.includes('grove-engineer.agent.md'), 'each task\'s engineer has an agent file');
for (const gone of ['grove-lead', 'grove-planner', 'grove-researcher', 'grove-implementer', 'grove-verifier']) {
  assert.ok(!files.includes(`${gone}.agent.md`), `${gone}: the engineer does that work now, with a skill`);
}
for (const f of files) {
  const text = await fs.readFile(new URL(f, dir), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, `${f}: missing front matter`);
  const keys = new Set();
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    assert.ok(kv, `${f}: unexpected front matter line "${line}"`);
    const [, key, value] = kv;
    keys.add(key);
    if (!/^['"[]/.test(value)) assert.ok(!/:\s/.test(value) && !/^[&*!|>%@`#]/.test(value), `${f}: quote the "${key}" value; it contains YAML syntax`);
  }
  for (const k of ['name', 'description', 'model']) assert.ok(keys.has(k), `${f}: missing ${k}`);
  // Every role names its model; Grove passes it on each hire, so no session falls back to the creator's model.
  assert.ok(parseModels(text).length, `${f}: model must name at least one model id`);
  if (f === 'chief-of-staff.agent.md') assert.ok(keys.has('tools'), 'the Chief keeps its coordination-only toolset');
  else assert.ok(!keys.has('tools'), `${f}: specialists get the full toolset; remove the tools allowlist`);
  assert.ok(path.basename(f).startsWith('grove-') || f === 'chief-of-staff.agent.md', `${f}: unexpected agent file`);
}

// The engineer loads one skill per kind of step; reviewers get grove-review in their brief. Each skill's front
// matter must parse, and its name must match its folder.
const skillsDir = new URL(plugin.skills, root);
for (const name of ['grove-plan', 'grove-research', 'grove-execute', 'grove-verify', 'grove-review']) {
  const text = await fs.readFile(new URL(`${name}/SKILL.md`, skillsDir), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, `${name}: missing front matter`);
  assert.match(m[1], new RegExp(`^name: ${name}$`, 'm'), `${name}: name matches the folder`);
  const desc = /^description: (.*)$/m.exec(m[1])?.[1] ?? '';
  assert.ok(/^'.*'$/.test(desc) && !/[^']'[^']/.test(desc.slice(1, -1)), `${name}: description is one single-quoted YAML string`);
}
const { skillInstructions, personaInstructions } = await import('../extensions/grove-agent-monitor/lib/process/prompts.mjs');
assert.match(skillInstructions('grove-review'), /VERDICT: APPROVE/, 'reviewer briefs carry the review skill');
assert.match(personaInstructions('grove-engineer'), /grove_submit/, 'the engineer brief carries its standing instructions');
assert.equal(skillInstructions('../etc'), '', 'only grove skills are read');
console.log(`plugin manifest ok (${extensions.length} extensions), agent front matter ok (${files.length} agents), skills ok`);
