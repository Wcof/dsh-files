/**
 * Contract gate: keeps the command table, generated tool catalogue, docs and
 * package version from drifting apart. Runs via `npm run check`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COMMANDS,
  METHODS,
  buildToolDefinitions,
  PLUGIN_VERSION,
} from '../src/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== PLUGIN_VERSION) {
  problems.push(`package.json version ${pkg.version} != config PLUGIN_VERSION ${PLUGIN_VERSION}`);
}
if (pkg.license && !fs.existsSync(path.join(root, 'LICENSE'))) {
  problems.push('package.json declares a license but LICENSE is missing');
}
const typesEntry = pkg.exports?.['.']?.types ?? pkg.types;
if (!typesEntry || !fs.existsSync(path.join(root, typesEntry))) {
  problems.push('package.json type entry is missing or points to a non-existent file');
}
const declarations = fs.readFileSync(path.join(root, 'src/protocol/types.d.ts'), 'utf8');
if (declarations.includes("import('../core/service.js')")) {
  problems.push('types.d.ts must not import JS modules without declarations');
}

const names = new Set();
for (const command of COMMANDS) {
  if (names.has(command.name)) problems.push(`duplicate command: ${command.name}`);
  names.add(command.name);
  const schemaKeys = Object.keys(command.schema ?? {});
  for (const key of schemaKeys) {
    if (!command.params.includes(key)) problems.push(`${command.name}: schema key not in params: ${key}`);
  }
  for (const key of command.params) {
    if (!schemaKeys.includes(key)) problems.push(`${command.name}: param missing from schema: ${key}`);
  }
  for (const key of command.required ?? []) {
    if (!command.params.includes(key)) problems.push(`${command.name}: required param not allowlisted: ${key}`);
  }
  if (!command.output) problems.push(`${command.name}: missing output contract`);
}

const tools = buildToolDefinitions();
const toolNames = new Set();
for (const tool of tools) {
  if (toolNames.has(tool.name)) problems.push(`duplicate tool: ${tool.name}`);
  toolNames.add(tool.name);
  if (tool.name.length > 64) problems.push(`tool name too long: ${tool.name}`);
  if (tool.inputSchema.type !== 'object') problems.push(`${tool.name}: inputSchema must be an object`);
}

const matrix = fs.readFileSync(path.join(root, 'docs/CAPABILITY_MATRIX.md'), 'utf8');
for (const method of METHODS) {
  if (!matrix.includes(`\`${method}\``)) problems.push(`CAPABILITY_MATRIX.md missing row for ${method}`);
}
for (const file of ['docs/PLUGIN_CONTRACT.md', 'docs/AGENT_ADAPTERS.md', 'src/protocol/types.d.ts']) {
  if (!fs.existsSync(path.join(root, file))) problems.push(`missing contract artefact: ${file}`);
}

if (problems.length > 0) {
  process.stderr.write(`contract check failed (${problems.length}):\n- ${problems.join('\n- ')}\n`);
  process.exit(1);
}
process.stdout.write(
  `contract ok: ${COMMANDS.length} commands, ${tools.length} agent tools, ${names.size} unique methods, v${PLUGIN_VERSION}\n`
);
