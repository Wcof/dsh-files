import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFilePlugin, defaultCommandRunner, ErrorCode } from '../src/index.js';
import { createSystemTools } from '../src/core/tools.js';
import { resolveConfig } from '../src/config.js';

test('Windows open and recycle use OS APIs with paths passed as data', async () => {
  const calls = [];
  const system = createSystemTools(resolveConfig({ tools: { platform: 'win32', commandRunner: async (...args) => { calls.push(args); return { code: 0, stdout: '' }; } } }));
  const target = 'C:\\文档\\a & $(unsafe) %.txt';
  await system.open(target, 'reveal');
  assert.equal(calls[0][0], 'powershell.exe');
  const script = Buffer.from(calls[0][1].at(-1), 'base64').toString('utf16le');
  assert.match(script, /select,/); assert.ok(!script.includes(target));
  assert.equal(JSON.parse(calls[0][2].stdin).path, target);
  await system.trash([target]);
  const recycling = Buffer.from(calls[1][1].at(-1), 'base64').toString('utf16le');
  assert.match(recycling, /SendToRecycleBin/); assert.match(recycling, /ThrowException/);
  assert.deepEqual(JSON.parse(calls[1][2].stdin).paths, [target]);
});

test('Windows command failures are reported and ZIP uses the bundled tar interface', async () => {
  const failing = createSystemTools(resolveConfig({ tools: { platform: 'win32', commandRunner: async () => ({ code: 1, stdout: '' }) } }));
  await assert.rejects(failing.open('C:\\note.txt'), { code: ErrorCode.INTERNAL });
  await assert.rejects(failing.trash(['C:\\note.txt']), { code: ErrorCode.INTERNAL });
  const calls = [];
  const system = createSystemTools(resolveConfig({ tools: { platform: 'win32', commandRunner: async (...args) => { calls.push(args); return { code: 0, stdout: 'note.txt\nC:/escape\n../escape\nfolder/file:stream\n' }; } } }));
  const listing = await system.archiveList('C:\\bundle.zip');
  assert.equal(calls[0][0], 'tar'); assert.deepEqual(calls[0][1], ['-tf', 'C:\\bundle.zip']);
  assert.equal(listing.rejected, 3); assert.equal(listing.entries[0].name, 'note.txt');
  await system.createZip(['C:\\notes\\a.txt', 'C:\\notes\\b.txt'], 'C:\\out', 'bundle');
  assert.equal(calls[1][0], 'tar'); assert.deepEqual(calls[1][1], ['-a', '-cf', 'C:\\out\\bundle.zip', '--', 'a.txt', 'b.txt']);
  assert.equal(calls[1][2].cwd, 'C:\\notes');
  await assert.rejects(system.createZip(['C:\\a.txt', 'D:\\b.txt'], 'C:\\out', 'bundle'), { code: ErrorCode.INVALID_PARAMETER });
  assert.equal(calls.length, 2);
});

test('real zip roundtrip and unsafe symlink archives are rejected', { skip: process.platform === 'win32' }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-files-archive-'));
  const plugin = createFilePlugin({ homeDir: dir, stateDir: path.join(dir, '.state') }, {});
  try {
    const input = path.join(dir, 'note.txt');
    await fsp.writeFile(input, 'archive contents');
    const created = await plugin.call('create_zip', { paths: [input], dest: dir, name: 'bundle' });
    const listing = await plugin.call('archive_list', { path: created.path });
    assert.equal(listing.entries.filter((entry) => !entry.isDir).length, 1);
    assert.equal(listing.entries[0].path, 'note.txt');
    const dest = path.join(dir, 'out');
    await plugin.call('extract_archive', { path: created.path, dest });
    const extracted = path.join(dest, listing.entries.find((entry) => !entry.isDir).path);
    assert.equal(await fsp.readFile(extracted, 'utf8'), 'archive contents');
    await fsp.writeFile(extracted, 'keep existing');
    await plugin.call('extract_archive', { path: created.path, dest });
    assert.equal(await fsp.readFile(extracted, 'utf8'), 'keep existing');
    const denied = path.join(dir, 'source', '.ssh');
    await fsp.mkdir(denied, { recursive: true });
    await fsp.writeFile(path.join(denied, 'key'), 'private');
    await assert.rejects(plugin.call('create_zip', { paths: [path.join(dir, 'source')], dest: dir, name: 'denied' }), { code: ErrorCode.PATH_DENIED });

    const link = path.join(dir, 'link');
    await fsp.symlink('../outside', link);
    for (const [command, args, archive] of [
      ['tar', ['-cf', path.join(dir, 'unsafe.tar'), '-C', dir, 'link'], 'unsafe.tar'],
      ['zip', ['-y', path.join(dir, 'unsafe.zip'), 'link'], 'unsafe.zip'],
    ]) {
      assert.equal((await defaultCommandRunner(command, args, { cwd: dir })).code, 0);
      await assert.rejects(plugin.call('extract_archive', { path: path.join(dir, archive), dest: path.join(dir, 'unsafe-out') }), { code: ErrorCode.PATH_DENIED });
    }
  } finally { await plugin.dispose(); await fsp.rm(dir, { recursive: true, force: true }); }
});

test('command output overflow fails instead of returning a partial archive listing', async () => {
  await assert.rejects(defaultCommandRunner(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBuffer: 100 }),
    { code: ErrorCode.CAPABILITY_UNAVAILABLE });
});

test('command cancellation reaps the owned process before rejecting', async () => {
  const controller = new AbortController();
  const pending = defaultCommandRunner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: ErrorCode.CANCELLED });
});
