import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFilePlugin, defaultCommandRunner, ErrorCode } from '../src/index.js';

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
