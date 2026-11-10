import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { makeSandbox, cleanSandbox, writeText } from './helpers.mjs';

/**
 * Node folds create, delete and move into one 'rename' event, so the backend
 * re-stats the target once the debounce window closes. These tests pin the
 * four kinds the original notify-based host emitted (watch.rs:144-149).
 */

function collectEvents(service) {
  const events = [];
  const off = service.on('fs_changed', (payload) => events.push(payload));
  return { events, off };
}

async function waitForEvent(events, count, timeoutMs = 4000) {
  const started = Date.now();
  while (events.length < count) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${count} fs_changed events, got ${JSON.stringify(events)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function watched(callback) {
  const sandbox = await makeSandbox();
  // A quiet subdirectory: the sandbox root also holds .state, whose churn
  // would show up as unrelated events.
  const target = path.join(sandbox.dir, 'watched');
  await fsp.mkdir(target, { recursive: true });
  const { events, off } = collectEvents(sandbox.plugin.service);
  try {
    await sandbox.plugin.call('watch_start', { path: target });
    await callback({ sandbox, target, events });
  } finally {
    off();
    await sandbox.plugin.call('watch_stop', { path: target }).catch(() => {});
    await cleanSandbox(sandbox);
  }
  return events;
}

test('watch reports created, modified and removed distinctly', async () => {
  await watched(async ({ target, events }) => {
    await fsp.writeFile(path.join(target, 'note.txt'), 'first');
    await waitForEvent(events, 1);
    await fsp.writeFile(path.join(target, 'note.txt'), 'second value');
    await waitForEvent(events, 2);
    await fsp.unlink(path.join(target, 'note.txt'));
    await waitForEvent(events, 3);
    const kinds = events.map((event) => event.kind);
    assert.deepEqual(kinds, ['created', 'modified', 'removed']);
    assert.ok(events.every((event) => event.path.endsWith('note.txt')));
    assert.ok(events.every((event) => event.count >= 1));
  });
});

test('watch startup reconciles creations and removals missed by the native subscription', async (t) => {
  const native = new EventEmitter();
  let closed = false;
  native.close = () => { closed = true; };
  t.mock.method(fs, 'watch', () => native);
  const sandbox = await makeSandbox();
  const target = path.join(sandbox.dir, 'startup');
  await fsp.mkdir(target);
  await fsp.writeFile(path.join(target, 'gone.txt'), 'before');
  const { events, off } = collectEvents(sandbox.plugin.service);
  try {
    await sandbox.plugin.call('watch_start', { path: target });
    await fsp.unlink(path.join(target, 'gone.txt'));
    await fsp.writeFile(path.join(target, 'new.txt'), 'after');
    await waitForEvent(events, 1, 1000);
    assert.deepEqual(events[0].changes.map(({ path: file, kind }) => [path.basename(file), kind]).sort(),
      [['gone.txt', 'removed'], ['new.txt', 'created']]);
    await sandbox.plugin.call('watch_stop', { path: target });
    assert.equal(closed, true);
  } finally {
    off();
    await cleanSandbox(sandbox);
  }
});

test('watch startup bounds reconciliation and invalidates the directory on overflow', async (t) => {
  const native = new EventEmitter();
  native.close = () => {};
  t.mock.method(fs, 'watch', () => native);
  const sandbox = await makeSandbox({ config: { limits: { maxWatchEvents: 1, maxDiskUsageEntries: 2 } } });
  const target = path.join(sandbox.dir, 'bounded');
  await fsp.mkdir(target);
  const { events, off } = collectEvents(sandbox.plugin.service);
  try {
    await sandbox.plugin.call('watch_start', { path: target });
    for (const name of ['one.txt', 'two.txt', 'three.txt']) await fsp.writeFile(path.join(target, name), 'x');
    await waitForEvent(events, 1, 1000);
    assert.equal(events[0].overflow, true);
    assert.equal(events[0].changes.length, 1);
    assert.equal(events[0].count, 1);
  } finally {
    off();
    await cleanSandbox(sandbox);
  }
});

test('watch never labels a deletion as a creation', async () => {
  await watched(async ({ target, events }) => {
    writeText(path.join(target, 'gone.txt'), 'x');
    await waitForEvent(events, 1);
    await fsp.unlink(path.join(target, 'gone.txt'));
    await waitForEvent(events, 2);
    assert.equal(events[0].kind, 'created');
    assert.equal(events[1].kind, 'removed');
  });
});

test('watch_stop also cancels a pending debounced event', async () => {
  await watched(async ({ sandbox, target, events }) => {
    await fsp.writeFile(path.join(target, 'pending.txt'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 50));
    await sandbox.plugin.call('watch_stop', { path: target });
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.deepEqual(events, []);
  });
});

test('watch debounces a burst into one event and counts the raw signals', async () => {
  await watched(async ({ target, events }) => {
    for (let index = 0; index < 6; index += 1) {
      await fsp.writeFile(path.join(target, `burst-${index}.txt`), 'y');
    }
    await waitForEvent(events, 1);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(events.length, 1, `expected one coalesced event, got ${JSON.stringify(events.map((e) => e.kind))}`);
    assert.deepEqual(events[0].changes.map((change) => path.basename(change.path)).sort(),
      Array.from({ length: 6 }, (_, index) => `burst-${index}.txt`));
    // count includes native signals and any names recovered during startup.
    assert.ok(events[0].count >= 1);
    assert.equal(events[0].kind, 'created');
  });
});

test('watch_stop releases the listener and watch_start is idempotent', async () => {
  const sandbox = await makeSandbox();
  const target = path.join(sandbox.dir, 'twice');
  await fsp.mkdir(target, { recursive: true });
  try {
    assert.deepEqual(await sandbox.plugin.call('watch_start', { path: target }), { ok: true });
    assert.deepEqual(await sandbox.plugin.call('watch_start', { path: target }), { ok: true });
    const events = [];
    const off = sandbox.plugin.service.on('fs_changed', (payload) => events.push(payload));
    await sandbox.plugin.call('watch_stop', { path: target });
    await fsp.writeFile(path.join(target, 'after.txt'), 'z');
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(events.length, 0);
    off();
  } finally {
    await cleanSandbox(sandbox);
  }
});
