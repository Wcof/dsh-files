import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createFilePlugin, callTool, ErrorCode } from '../src/index.js';
import { makeSandbox, cleanSandbox, writeText } from './helpers.mjs';

test('required and alternative arguments are rejected before backend dispatch', async () => {
  let calls = 0;
  const plugin = createFilePlugin({ backend: { name: 'probe', handle() { calls++; }, async dispose() {} } }, {});
  try {
    for (const [method, params] of [['write_file', { parent: '/tmp', name: 'x' }], ['copy', {}], ['import_begin', { parent: '/tmp', name: 'x', uploadId: 'u' }]]) {
      await assert.rejects(plugin.call(method, params), { code: ErrorCode.INVALID_PARAMETER });
    }
    assert.equal((await plugin.handle({ id: 'null', method: 'roots', params: null })).ok, false);
    assert.equal(calls, 0);
  } finally { await plugin.dispose(); }
});

test('tool calls obey the advertised catalogue and custom prefix', async () => {
  const sandbox = await makeSandbox({ config: { toolOptions: { prefix: 'docs', exclude: ['trash'] } } });
  try {
    assert.ok((await callTool(sandbox.plugin.service, 'docs_roots')).length);
    await assert.rejects(callTool(sandbox.plugin.service, 'docs_trash', { path: sandbox.dir }), { code: ErrorCode.UNSUPPORTED_METHOD });
    await assert.rejects(callTool(sandbox.plugin.service, 'docs_open', { path: sandbox.dir }), { code: ErrorCode.UNSUPPORTED_METHOD });
  } finally { await cleanSandbox(sandbox); }
});

test('read-only mode rejects import_begin before creating temporary data', async () => {
  const sandbox = await makeSandbox({ config: { security: { allowWrite: false } } });
  try {
    await assert.rejects(sandbox.plugin.call('import_begin', { uploadId: 'ro', parent: sandbox.dir, name: 'x', size: 0 }), { code: ErrorCode.FORBIDDEN });
    assert.deepEqual(await fsp.readdir(path.join(sandbox.dir, '.state', 'imports')), []);
  } finally { await cleanSandbox(sandbox); }
});

test('stale edits cannot recreate a deleted file or lose its executable mode', async () => {
  const sandbox = await makeSandbox();
  try {
    const file = path.join(sandbox.dir, 'run.sh');
    writeText(file, 'old');
    await fsp.chmod(file, 0o755);
    const { mtimeMs } = await fsp.stat(file);
    await fsp.unlink(file);
    const result = await sandbox.plugin.call('write_file', { parent: sandbox.dir, name: 'run.sh', data: 'bmV3', expectedMtime: mtimeMs });
    assert.equal(result.conflict, true);
    await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
    writeText(file, 'old');
    await fsp.chmod(file, 0o755);
    await sandbox.plugin.call('write_file', { parent: sandbox.dir, name: 'run.sh', data: 'bmV3' });
    assert.equal((await fsp.stat(file)).mode & 0o777, 0o755);
  } finally { await cleanSandbox(sandbox); }
});

test('rename refuses an existing target and preserves both files', async () => {
  const sandbox = await makeSandbox();
  try {
    writeText(path.join(sandbox.dir, 'a.txt'), 'a');
    writeText(path.join(sandbox.dir, 'b.txt'), 'b');
    await assert.rejects(sandbox.plugin.call('rename', { path: path.join(sandbox.dir, 'a.txt'), name: 'b.txt' }), { code: ErrorCode.CONFLICT });
    assert.equal(await fsp.readFile(path.join(sandbox.dir, 'a.txt'), 'utf8'), 'a');
    assert.equal(await fsp.readFile(path.join(sandbox.dir, 'b.txt'), 'utf8'), 'b');
  } finally { await cleanSandbox(sandbox); }
});

test('search authorizes directories and content before reading them', async () => {
  const reads = [];
  const sandbox = await makeSandbox({ tools: { pdfTextHandler: async (file) => { reads.push(file); return 'needle'; } } });
  try {
    writeText(path.join(sandbox.dir, '.ssh', 'private.pdf'), '%PDF-test');
    const result = await sandbox.plugin.call('search', { path: sandbox.dir, query: 'needle', content: true, showHidden: true });
    assert.deepEqual(result.entries, []);
    assert.deepEqual(reads, []);
  } finally { await cleanSandbox(sandbox); }
});

test('DSH dispatcher rejects wrong methods and paths before running a command', async () => {
  const sandbox = await makeSandbox();
  try {
    const handle = await sandbox.plugin.attach('dsh');
    const request = { method: 'POST', headers: {}, body: { name: 'file_create_file', arguments: { parent: sandbox.dir, name: 'wrong.txt' } } };
    assert.equal((await handle.dispatch({ ...request, path: '/agent/files/tools' })).status, 405);
    assert.equal((await handle.dispatch({ ...request, path: '/unknown' })).status, 404);
    await assert.rejects(fsp.stat(path.join(sandbox.dir, 'wrong.txt')), { code: 'ENOENT' });
  } finally { await cleanSandbox(sandbox); }
});

test('DSH routes are disposed even when registered through host effects', async () => {
  const sandbox = await makeSandbox();
  const routes = new Map();
  try {
    await sandbox.plugin.attach({ name: 'dsh', options: { hostContext: {
      webServer: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path); } },
      effect(fn) { return fn(); },
    } } });
    assert.ok(routes.size > 0);
    await sandbox.plugin.dispose();
    assert.equal(routes.size, 0);
  } finally { await cleanSandbox(sandbox); }
});

test('event observer exceptions cannot turn a successful write into failure', async () => {
  const sandbox = await makeSandbox();
  try {
    sandbox.plugin.service.on('*', () => { throw new Error('observer failed'); });
    const result = await sandbox.plugin.call('write_file', { parent: sandbox.dir, name: 'x', data: 'eA==' });
    assert.equal(result.conflict, false);
  } finally { await cleanSandbox(sandbox); }
});

test('parallel import chunks with the same offset cannot corrupt a session', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    await plugin.call('import_begin', { uploadId: 'parallel', parent: dir, name: 'out.txt', size: 2 });
    const outcomes = await Promise.allSettled([
      plugin.call('import_chunk', { uploadId: 'parallel', offset: 0, data: 'YQ==' }),
      plugin.call('import_chunk', { uploadId: 'parallel', offset: 0, data: 'Yg==' }),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    await plugin.call('import_chunk', { uploadId: 'parallel', offset: 1, data: 'eg==' });
    const result = await plugin.call('import_end', { uploadId: 'parallel' });
    assert.equal(result.size, 2);
    assert.equal((await fsp.readFile(result.path, 'utf8')).slice(1), 'z');
  } finally { await cleanSandbox(sandbox); }
});

test('upload ids cannot introduce path components', async () => {
  const sandbox = await makeSandbox();
  try {
    await assert.rejects(sandbox.plugin.call('import_begin', {
      uploadId: 'nested/../../escaped', parent: sandbox.dir, name: 'out', size: 0,
    }), { code: ErrorCode.INVALID_PARAMETER });
  } finally { await cleanSandbox(sandbox); }
});

test('recursive copy cannot launder denied descendants through another folder', async () => {
  const sandbox = await makeSandbox();
  try {
    writeText(path.join(sandbox.dir, 'source', '.ssh', 'secret'), 'private');
    await assert.rejects(sandbox.plugin.call('copy', { from: path.join(sandbox.dir, 'source'), to: path.join(sandbox.dir, 'copy') }), { code: ErrorCode.PATH_DENIED });
    await assert.rejects(fsp.stat(path.join(sandbox.dir, 'copy', '.ssh', 'secret')), { code: 'ENOENT' });
  } finally { await cleanSandbox(sandbox); }
});

test('simultaneous edits using one revision cannot both overwrite the file', async () => {
  const sandbox = await makeSandbox();
  try {
    const file = path.join(sandbox.dir, 'shared.txt');
    writeText(file, 'original');
    // Give the previous revision a deterministic old timestamp.
    await fsp.utimes(file, 1000, 1000);
    const { mtimeMs } = await fsp.stat(file);
    const results = await Promise.all(Array.from({ length: 32 }, (_, index) => String(index)).map((text) => sandbox.plugin.call('write_file', {
      parent: sandbox.dir, name: 'shared.txt', expectedMtime: mtimeMs, data: Buffer.from(text).toString('base64'),
    })));
    assert.equal(results.filter((result) => !result.conflict).length, 1);
  } finally { await cleanSandbox(sandbox); }
});

test('batch changes are still emitted when skipped is an empty array', async () => {
  const sandbox = await makeSandbox();
  try {
    writeText(path.join(sandbox.dir, 'batch.txt'), 'x');
    const events = [];
    sandbox.plugin.service.on('changed', (event) => events.push(event));
    const result = await sandbox.plugin.call('copy_batch', { paths: [path.join(sandbox.dir, 'batch.txt')], dest: path.join(sandbox.dir, 'out') });
    assert.equal(result.count, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].method, 'copy_batch');
  } finally { await cleanSandbox(sandbox); }
});
