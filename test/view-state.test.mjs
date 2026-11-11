import test from 'node:test';
import assert from 'node:assert/strict';
import { parentPath, pathSegments, normalizePathInput, readView, writeView, selectionFor, shortcutAction } from '../web/view-state.js';
import { validWindowsName } from '../src/core/access-policy.js';
import { makeSandbox, cleanSandbox, writeText } from './helpers.mjs';
import path from 'node:path';

test('navigation preserves POSIX, Windows drive and UNC roots', () => {
  for (const [input, expected] of [['/', '/'], ['/Users/name', '/Users'], ['C:\\', 'C:\\'], ['C:\\文档', 'C:\\'], ['D:/Notes', 'D:/'], ['\\\\server\\share\\文件', '\\\\server\\share\\'], ['//server/share/file', '//server/share/']]) assert.equal(parentPath(input), expected);
  assert.deepEqual(pathSegments('C:\\Users\\name').map(p => p.path), ['C:\\', 'C:\\Users', 'C:\\Users\\name']);
  assert.equal(normalizePathInput('"C:\\My Documents"'), 'C:\\My Documents');
  assert.equal(normalizePathInput('file:///C:/My%20Documents'), 'C:\\My Documents');
  assert.equal(normalizePathInput('file://server/share/My%20File'), '\\\\server\\share\\My File');
  assert.equal(normalizePathInput('/tmp/100%20.txt'), '/tmp/100%20.txt');
});

test('view preferences persist only valid presentation fields and tolerate blocked storage', () => {
  let stored;
  const storage = { setItem(_key, value) { stored = value; }, getItem() { return stored; } };
  writeView(storage, { view: 'list', size: 'large', sortBy: 'kind', theme: 'dark', path: '/private', preview: true, draft: 'secret' });
  assert.equal(readView(storage).view, 'list'); assert.equal(readView(storage).preview, true);
  assert.ok(!stored.includes('private') && !stored.includes('secret'));
  stored = '{broken'; assert.equal(readView(storage).view, 'grid');
  stored = JSON.stringify({ view: 'bad', sortDir: 'bad', theme: 'bad' }); assert.equal(readView(storage).sortDir, 'asc');
  writeView({ setItem() { throw Error('blocked'); } }, {});
  assert.equal(readView({ getItem() { throw Error('blocked'); } }).size, 'medium');
});

test('Finder and Explorer selection supports replacement, toggling, range and limits', () => {
  const entries = ['a', 'b', 'c', 'd'].map(path => ({ path }));
  const choose = (old, index, anchor, event, platform = 'darwin', limit = 4) => selectionFor(entries, new Set(old), index, anchor, event, platform, limit);
  assert.deepEqual([...choose(['a','b'], 0, 0, {}).selected], ['a']);
  assert.deepEqual([...choose(['a'], 2, 0, { metaKey: true }).selected], ['a','c']);
  assert.deepEqual([...choose(['a','c'], 0, 0, { metaKey: true }).selected], ['c']);
  assert.deepEqual([...choose(['a'], 2, 0, { ctrlKey: true }, 'win32').selected], ['a','c']);
  assert.deepEqual([...choose(['a'], 2, 0, { shiftKey: true }).selected], ['a','b','c']);
  assert.equal(choose(['a'], 3, 0, { shiftKey: true }, 'win32', 2), null);
});

test('keyboard conventions respect platform and never hijack editor copy or delete', () => {
  assert.equal(shortcutAction({ key: 'Enter' }, 'darwin'), 'rename');
  assert.equal(shortcutAction({ key: 'Enter' }, 'win32'), 'activate');
  assert.equal(shortcutAction({ key: 'F2' }, 'win32'), 'rename');
  assert.equal(shortcutAction({ key: 'Backspace', metaKey: true }, 'darwin'), 'trash');
  assert.equal(shortcutAction({ key: 'Delete' }, 'win32'), 'trash');
  assert.equal(shortcutAction({ key: 'Delete', shiftKey: true }, 'win32'), null);
  assert.equal(shortcutAction({ key: 'c', metaKey: true }, 'darwin', true), null);
  assert.equal(shortcutAction({ key: 'Delete' }, 'win32', true), null);
  assert.equal(shortcutAction({ key: 's', ctrlKey: true }, 'win32', true), 'save');
});

test('Windows filenames reject device names, streams and lossy trailing characters', () => {
  for (const name of ['CON', 'nul.txt', 'COM1.log', 'lpt²', 'report.', 'report ', 'a:b', 'a?b', 'a\u0001b']) assert.equal(validWindowsName(name), false, name);
  for (const name of ['中文.txt', 'console.txt', 'COM10.txt', 'my note.md']) assert.equal(validWindowsName(name), true, name);
});

test('directory and search sorting happens before pagination with folders first', async () => {
  const sandbox = await makeSandbox();
  try {
    const root = path.join(sandbox.dir, 'sorting');
    writeText(path.join(root, 'match-10.txt'), 'longer text'); writeText(path.join(root, 'match-2.txt'), 'x');
    writeText(path.join(root, 'match-3.png'), 'png'); writeText(path.join(root, 'match-folder', 'child.txt'), 'nested');
    const list = await sandbox.plugin.call('list_dir', { path: root, sortBy: 'kind', sortDir: 'asc' });
    assert.deepEqual(list.entries.map(e => e.name), ['match-folder', 'match-3.png', 'match-2.txt', 'match-10.txt']);
    for (const method of ['search', 'locate']) {
      const params = { path: root, query: 'match', recursive: false, sortBy: 'size', sortDir: 'desc', limit: 1 };
      const first = await sandbox.plugin.call(method, params), next = await sandbox.plugin.call(method, { ...params, offset: 1 });
      assert.equal(first.entries[0].name, 'match-folder'); assert.equal(next.entries[0].name, 'match-10.txt'); assert.equal(first.hasMore, true);
    }
    await assert.rejects(sandbox.plugin.call('search', { path: root, query: 'match', sortBy: 'invalid' }));
  } finally { await cleanSandbox(sandbox); }
});
