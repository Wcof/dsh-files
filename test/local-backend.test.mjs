import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { makeSandbox, cleanSandbox, writeText } from './helpers.mjs';
import { ErrorCode, FilePluginError } from '../src/index.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('version and roots derive from the injected home', async () => {
  const sandbox = await makeSandbox();
  try {
    const version = await sandbox.plugin.call('version');
    assert.equal(version.protocolVersion, 1);
    assert.equal(version.backend, 'local');
    const roots = await sandbox.plugin.call('roots');
    assert.equal(roots[0].id, 'home');
    assert.equal(roots[0].path, sandbox.dir);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('create / write / read / stat / list round trip', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    assert.deepEqual(await plugin.call('create_folder', { parent: dir, name: 'demo' }), { ok: true });
    const written = await plugin.call('write_file', { parent: path.join(dir, 'demo'), name: 'note.txt', data: b64('Hello 文件') });
    assert.equal(written.conflict, false);
    const read = await plugin.call('read_file', { path: written.path });
    assert.equal(read.content, 'Hello 文件');
    assert.equal(read.encoding, 'utf-8');
    assert.equal(read.truncated, false);
    const stat = await plugin.call('stat', { path: written.path });
    assert.equal(stat.found, true);
    assert.equal(stat.kind, 'text');
    const listing = await plugin.call('list_dir', { path: path.join(dir, 'demo') });
    assert.equal(listing.entries.length, 1);
    assert.equal(listing.entries[0].name, 'note.txt');
    assert.equal(listing.hasMore, false);
    assert.equal((await plugin.call('stat', { path: path.join(dir, 'missing') })).found, false);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('listing keeps Finder grouping, natural sort and bounded paging', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    const folder = path.join(dir, 'sorted');
    await fsp.mkdir(folder);
    for (const name of ['file10.txt', 'file2.txt', 'file1.txt']) writeText(path.join(folder, name), name);
    await fsp.mkdir(path.join(folder, 'zeta-dir'));
    const first = await plugin.call('list_dir', { path: folder, offset: 0, limit: 2 });
    assert.equal(first.entries[0].isDir, true);
    assert.equal(first.hasMore, true);
    const second = await plugin.call('list_dir', { path: folder, offset: 2, limit: 2 });
    const names = [...first.entries, ...second.entries].filter((entry) => !entry.isDir).map((entry) => entry.name);
    assert.deepEqual(names, ['file1.txt', 'file2.txt', 'file10.txt'].slice(0, names.length));
    const descending = await plugin.call('list_dir', { path: folder, sortBy: 'name', sortDir: 'desc' });
    // Folder grouping is invariant under sort direction (same as the Rust sort_entries).
    assert.equal(descending.entries[0].name, 'zeta-dir');
    assert.equal(descending.entries[1].name, 'file10.txt');
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('atomic write honours expectedMtime and reports conflicts', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    const first = await plugin.call('write_file', { parent: dir, name: 'lock.txt', data: b64('v1') });
    const conflict = await plugin.call('write_file', {
      parent: dir, name: 'lock.txt', data: b64('v2'), expectedMtime: first.mtime - 5000,
    });
    assert.equal(conflict.conflict, true);
    assert.equal((await plugin.call('read_file', { path: first.path })).content, 'v1');
    const accepted = await plugin.call('write_file', {
      parent: dir, name: 'lock.txt', data: b64('v3'), expectedMtime: first.mtime,
    });
    assert.equal(accepted.conflict, false);
    assert.equal((await plugin.call('read_file', { path: first.path })).content, 'v3');
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('rename, copy, move, duplicate and batch operations', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    const source = await plugin.call('write_file', { parent: dir, name: 'a.txt', data: b64('A') });
    const renamed = await plugin.call('rename', { path: source.path, name: 'b.txt' });
    assert.equal(path.basename(renamed.path), 'b.txt');
    const copied = await plugin.call('copy', { from: renamed.path, to: path.join(dir, 'c.txt') });
    assert.equal((await plugin.call('read_file', { path: copied.path })).content, 'A');
    const duplicated = await plugin.call('duplicate', { path: renamed.path });
    assert.notEqual(duplicated.path, renamed.path);

    const dest = path.join(dir, 'inbox');
    await fsp.mkdir(dest);
    const batch = await plugin.call('copy_batch', { paths: [renamed.path, copied.path], dest });
    assert.equal(batch.count, 2);
    assert.equal(batch.ok, true);
    const moved = await plugin.call('move_batch', { paths: [duplicated.path], dest });
    assert.equal(moved.count, 1);
    const trashed = await plugin.call('trash_batch', { paths: [copied.path] });
    assert.equal(trashed.count, 1);
    assert.equal((await plugin.call('stat', { path: copied.path })).found, false);
    const single = await plugin.call('trash', { path: renamed.path });
    assert.equal(single.ok, true);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('search matches names and bounded text content', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    const folder = path.join(dir, 'searchable');
    await fsp.mkdir(folder);
    writeText(path.join(folder, 'draft.md'), 'alpha\nneedle in haystack\nomega');
    writeText(path.join(folder, 'other.txt'), 'nothing here');
    const byName = await plugin.call('search', { path: folder, query: 'draft' });
    assert.equal(byName.entries.length, 1);
    assert.equal(byName.entries[0].name, 'draft.md');
    const byContent = await plugin.call('search', { path: folder, query: 'needle', content: true });
    assert.equal(byContent.entries.length, 1);
    assert.ok(byContent.entries[0].matchCount >= 1);
    const located = await plugin.call('locate', { query: 'draft', limit: 10 });
    assert.ok(located.entries.length >= 1);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('binary previews are base64, bounded and magic-byte checked', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    const png = path.join(dir, 'pixel.png');
    await fsp.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
    const preview = await plugin.call('image_preview', { path: png });
    assert.equal(preview.mimeType, 'image/png');
    assert.equal(Buffer.from(preview.data, 'base64').subarray(0, 4).toString('hex'), '89504e47');
    const fake = path.join(dir, 'fake.png');
    writeText(fake, 'not really a png');
    await assert.rejects(() => plugin.call('image_preview', { path: fake }), FilePluginError);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('chunked import commits atomically and can be cancelled', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    assert.deepEqual(await plugin.call('import_probe', { parent: dir, name: 'up.txt' }), { exists: false });
    const begun = await plugin.call('import_begin', { uploadId: 'u1', parent: dir, name: 'up.txt', size: 11 });
    assert.equal(begun.renamed, false);
    const part1 = b64('Hello ');
    const part2 = b64('world');
    await plugin.call('import_chunk', { uploadId: 'u1', offset: 0, data: part1 });
    const progress = await plugin.call('import_chunk', { uploadId: 'u1', offset: 6, data: part2 });
    assert.equal(progress.received, 11);
    const done = await plugin.call('import_end', { uploadId: 'u1' });
    assert.equal((await plugin.call('read_file', { path: done.path })).content, 'Hello world');

    await plugin.call('import_begin', { uploadId: 'u2', parent: dir, name: 'gone.txt', size: 3 });
    assert.deepEqual(await plugin.call('import_cancel', { uploadId: 'u2' }), { uploadId: 'u2', cancelled: true });
    assert.equal((await plugin.call('stat', { path: path.join(dir, 'gone.txt') })).found, false);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('access policy is enforced for reads, writes and batch entries', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    await assert.rejects(
      () => plugin.call('list_dir', { path: '/etc' }),
      (error) => error.code === ErrorCode.PATH_DENIED
    );
    await assert.rejects(
      () => plugin.call('create_file', { parent: '/etc', name: 'x' }),
      (error) => error.code === ErrorCode.PATH_DENIED
    );
    await assert.rejects(
      () => plugin.call('write_file', { parent: dir, name: '../escape.txt', data: b64('x') }),
      (error) => error.code === ErrorCode.INVALID_PARAMETER || error.code === ErrorCode.PATH_DENIED
    );
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('disk usage is bounded and never follows symlinks', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    const folder = path.join(dir, 'usage');
    await fsp.mkdir(folder);
    writeText(path.join(folder, 'a.txt'), 'x'.repeat(100));
    await fsp.symlink(path.join(folder, 'a.txt'), path.join(folder, 'link.txt'));
    const usage = await plugin.call('disk_usage', { path: folder });
    assert.ok(usage.bytes >= 100);
    assert.ok(usage.files >= 1);
    assert.equal(usage.truncated, false);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('OS integration is injected, not hardcoded', async () => {
  const sandbox = await makeSandbox();
  try {
    const result = await sandbox.plugin.call('open', { path: sandbox.dir });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'default');
    assert.equal(result.target, await fsp.realpath(sandbox.dir));
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('injected locate accelerator is used, sandboxed and falls back when broken', async () => {
  let dirRef;
  const sandbox = await makeSandbox({
    tools: {
      locateHandler: () => [
        path.join(dirRef, 'needle.txt'),
        '/etc/passwd',                       // outside the policy: must be dropped
        path.join(dirRef, 'vanished.txt'),   // missing: must be dropped
      ],
    },
  });
  dirRef = sandbox.dir;
  try {
    writeText(path.join(sandbox.dir, 'needle.txt'), 'needle');
    const injected = await sandbox.plugin.call('locate', { query: 'needle' });
    assert.equal(injected.entries.length, 1);
    assert.equal(injected.entries[0].name, 'needle.txt');
    assert.ok(!injected.entries.some((entry) => entry.path.includes('passwd')));

    // A failing hook must not break locate: built-in traversal takes over.
    sandbox.tools.locateHandler = () => {
      throw new Error('mdfind unavailable');
    };
    // Scope the fallback to the sandbox so the built-in traversal stays small.
    const fallback = await sandbox.plugin.call('locate', { query: 'needle', path: sandbox.dir });
    assert.ok(fallback.entries.some((entry) => entry.name === 'needle.txt'));
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('locate falls back to traversal when every accelerator path is unauthorized', async () => {
  // Spotlight indexes the whole disk; a home-scoped policy rejects most of it.
  // The accelerator must not report an empty search in that case.
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-locate-out-'));
  const sandbox = await makeSandbox({
    tools: {
      locateHandler: () => [
        path.join(outside, 'needle.txt'),
        '/etc/passwd',
      ],
    },
  });
  try {
    writeText(path.join(sandbox.dir, 'needle.txt'), 'needle');
    writeText(path.join(outside, 'needle.txt'), 'outside');
    const result = await sandbox.plugin.call('locate', { query: 'needle' });
    assert.ok(result.entries.some((entry) => entry.name === 'needle.txt'), 'built-in traversal must run');
    assert.ok(result.entries.every((entry) => !entry.path.startsWith(outside)), 'unauthorized candidates stay out');
  } finally {
    await cleanSandbox(sandbox);
    await fsp.rm(outside, { recursive: true, force: true });
  }
});

test('write_file and import_chunk reject non-canonical base64', async () => {
  const sandbox = await makeSandbox();
  try {
    const { plugin, dir } = sandbox;
    // Node's Buffer silently drops invalid characters; the original host used
    // the Rust STANDARD engine, which rejects all of these.
    for (const bad of ['!!!not base64!!!', 'abc', 'a=', 'AA=AA=', 'ab**', 'QQ==QQ==']) {
      await assert.rejects(
        () => plugin.call('write_file', { parent: dir, name: 'x.txt', data: bad }),
        (error) => error.code === ErrorCode.INVALID_PARAMETER,
        `expected rejection for ${JSON.stringify(bad)}`
      );
    }
    assert.equal(await fsp.stat(path.join(dir, 'x.txt')).then(() => true, () => false), false);
    for (const good of ['', b64('hello'), b64('a'), b64('ab'), b64('abc')]) {
      await plugin.call('write_file', { parent: dir, name: 'x.txt', data: good });
    }
    const written = await plugin.call('read_file', { path: path.join(dir, 'x.txt') });
    assert.equal(written.content, 'abc');

    await plugin.call('import_begin', { uploadId: 'u1', parent: dir, name: 'u.txt', size: 4 });
    await assert.rejects(
      () => plugin.call('import_chunk', { uploadId: 'u1', offset: 0, data: '%%%' }),
      (error) => error.code === ErrorCode.INVALID_PARAMETER
    );
    await plugin.call('import_cancel', { uploadId: 'u1' });
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('the task budget gates heavy calls only, never plain writes', async () => {
  const sandbox = await makeSandbox({ config: { limits: { maxConcurrentTasks: 1 } } });
  try {
    const { plugin, dir } = sandbox;
    // native-file-host only admits search/locate/read_file/archive/*_batch
    // (main.rs:328-340); write_file, list_dir and stat were never queued.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        plugin.call('write_file', { parent: dir, name: `p-${index}.txt`, data: b64(`v${index}`) })
      )
    );
    assert.equal(results.length, 12);
    assert.equal(results.every((item) => item.conflict === false), true);
    const listed = await Promise.all(
      Array.from({ length: 12 }, () => plugin.call('list_dir', { path: dir, limit: 5 }))
    );
    assert.equal(listed.length, 12);
    await plugin.call('stat', { path: dir });
    // No temp files may survive a completed atomic write.
    const strays = (await fsp.readdir(dir)).filter((name) => name.startsWith('.dsh-files-write-'));
    assert.deepEqual(strays, []);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('maxConcurrentImports bounds in-flight import sessions', async () => {
  const sandbox = await makeSandbox({ config: { limits: { maxConcurrentImports: 1 } } });
  try {
    const { plugin, dir } = sandbox;
    await plugin.call('import_begin', { uploadId: 'a', parent: dir, name: 'a.txt', size: 3 });
    await assert.rejects(
      () => plugin.call('import_begin', { uploadId: 'b', parent: dir, name: 'b.txt', size: 3 }),
      (error) => error.code === ErrorCode.TOO_MANY_TASKS
    );
    await plugin.call('import_cancel', { uploadId: 'a' });
    const again = await plugin.call('import_begin', { uploadId: 'b', parent: dir, name: 'b.txt', size: 3 });
    assert.equal(again.uploadId, 'b');
    await plugin.call('import_cancel', { uploadId: 'b' });
  } finally {
    await cleanSandbox(sandbox);
  }
});
