#!/usr/bin/env node
// Checks an evidence folder the way Grove does when a verify step is submitted.
// Usage: node check-evidence.mjs <evidence folder>
import path from 'node:path';
import { validateEvidence } from '../../../extensions/grove-agent-monitor/lib/process/evidence.mjs';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('Usage: node check-evidence.mjs <evidence folder>\n');
  process.exit(2);
}
const result = await validateEvidence(path.resolve(dir));
if (!result.ok) {
  process.stderr.write(`evidence is not valid: ${result.reason}\n`);
  process.exit(1);
}
process.stdout.write(`evidence ok: ${result.items.length} item(s)\n${result.items.map((it) => `- ${it.file}: ${it.caption}${it.criterion ? ` (proves: ${it.criterion})` : ''}`).join('\n')}\n`);
