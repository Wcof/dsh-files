/** Execute the plugin inside an isolated copy of the installed DSH runtime. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const modules = process.argv[2];
if (!modules) throw new Error('Usage: npm run check:dsh-runtime -- /absolute/path/to/dsh/node_modules [package-directory]');
const packageDir = path.resolve(process.argv[3] ?? fileURLToPath(new URL('..', import.meta.url)));
const requireRuntime = createRequire(path.join(path.resolve(modules), '..', 'package.json'));
const load = (name) => import(pathToFileURL(requireRuntime.resolve(name)).href);
const [{ Context }, { default: SystemPrompt }, { default: Tools }, Executor, { default: WebServer }, boot] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-tools'),
  load('@deepseek-ai/dsh-tool-executor-native'), load('@deepseek-ai/dsh-host-webserver'), load('@deepseek-ai/dsh-app-boot'),
]);
const pkg = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
const patchPaths = boot.bundlePatchPaths(packageDir, pkg.dsh.bundle);
const patches = boot.loadOptionalPatches('dsh-files-check', patchPaths[0]);
const entries = boot.composeEntries([patches]);
assert.equal(entries.length, 1);
assert.equal(entries[0].name, '@dsh/files/dsh');
const requirePlugin = createRequire(path.join(packageDir, 'package.json'));
const pluginModule = await import(pathToFileURL(requirePlugin.resolve(entries[0].name)).href);
const runtimeVersion = requireRuntime('@deepseek-ai/dsh-tools/package.json').version;
assert.equal(boot.evaluatePluginCompatibility(pkg, {}, runtimeVersion), undefined);
assert.ok(boot.evaluatePluginCompatibility(pkg, {}, '0.2.1'));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-files-runtime-'));
const ctx = new Context();
let reader;
try {
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(Tools);
  await ctx.plugin(Executor);
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  const fork = ctx.plugin(pluginModule, { homeDir: dir, stateDir: path.join(dir, '.state'), security: { allowSystemCommands: false } });
  await fork.await();
  assert.equal(ctx.tools.definitions().length, 25);
  let sequence = 0;
  async function call(name, args, signal = new AbortController().signal) {
    const result = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: `runtime-${++sequence}`, name, arguments: JSON.stringify(args) }], signal,
    });
    return result.results[0].result;
  }
  const written = await call('file_write_file', { parent: dir, name: 'note.txt', data: Buffer.from('runtime verified').toString('base64') });
  assert.equal(written.isError, false);
  const read = await call('file_read_file', { path: path.join(dir, 'note.txt') });
  assert.equal(read.isError, false);
  assert.match(JSON.stringify(read.value), /runtime verified/);
  assert.deepEqual(JSON.parse(read.content[0].text), read.value);
  assert.equal((await call('file_write_file', { parent: dir, name: 'missing.txt' })).isError, true);
  assert.equal((await call('file_read_file', { path: path.join(dir, '.ssh', 'secret') })).isError, true);
  const controller = new AbortController(); controller.abort();
  assert.equal((await call('file_create_file', { parent: dir, name: 'cancelled.txt' }, controller.signal)).isError, true);
  await assert.rejects(fs.stat(path.join(dir, 'cancelled.txt')), { code: 'ENOENT' });

  const base = ctx.webServer.getOrigin();
  // Optional service injection may settle one microtask after its owner.
  const deadline = Date.now() + 3000;
  while ((await fetch(`${base}/agent/files/tools`)).status === 404 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await fetch(`${base}/agent/files/tools`).then((r) => r.json())).tools.length, 25);
  assert.equal((await fetch(`${base}/agent/files/tools`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/agent/files/tools`, { headers: { Origin: 'https://invalid.example' } })).status, 403);
  assert.equal((await fetch(`${base}/agent/files/rpc`, { method: 'POST', body: '{' })).status, 400);

  const events = await fetch(`${base}/agent/files/events`);
  assert.equal(events.status, 200);
  reader = events.body.getReader();
  await reader.read(); // connected comment
  const changed = reader.read();
  await call('file_create_file', { parent: dir, name: 'event.txt' });
  assert.match(new TextDecoder().decode((await changed).value), /event: changed/);
  await fork.dispose();
  assert.equal(ctx.tools.definitions().length, 0);
  assert.equal((await fetch(`${base}/agent/files/tools`)).status, 404);
  assert.equal((await reader.read()).done, true);

  const readOnly = ctx.plugin(pluginModule, { homeDir: dir, stateDir: path.join(dir, '.state'), security: { allowWrite: false, allowSystemCommands: false } });
  await readOnly.await();
  assert.equal((await call('file_create_file', { parent: dir, name: 'forbidden.txt' })).isError, true);
  assert.equal((await call('file_roots', {})).isError, false);
  await readOnly.dispose();
  console.log(`DSH ${runtimeVersion}: bundle resolution, 25 tools, native read/write/errors/cancel/read-only, HTTP, SSE, unload/reload passed`);
} finally {
  await reader?.cancel().catch(() => {});
  await ctx.fiber.dispose();
  await fs.rm(dir, { recursive: true, force: true });
}
