import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSandbox, cleanSandbox } from './helpers.mjs';
import { createFilePlugin, FilePluginError, ErrorCode } from '../src/index.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function slowBackend() {
  return {
    name: 'slow',
    async handle(method, params, ctx) {
      if (method !== 'search') return { method, params };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ entries: [] }), 10_000);
        timer.unref?.();
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled'));
        });
      });
    },
    async dispose() {},
  };
}

test('handle() always returns the original wire envelope', async () => {
  const sandbox = await makeSandbox();
  try {
    const ok = await sandbox.plugin.handle({ id: 'a', method: 'roots', params: {} });
    assert.deepEqual(Object.keys(ok).sort(), ['id', 'ok', 'result']);
    assert.equal(ok.ok, true);
    const bad = await sandbox.plugin.handle({ id: 'b', method: 'list_dir', params: { path: '/etc' } });
    assert.equal(bad.ok, false);
    assert.equal(typeof bad.error, 'string');
    const unknown = await sandbox.plugin.handle({ id: 'c', method: 'workspace_session', params: {} });
    assert.equal(unknown.error, 'unsupported method');
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('call() throws structured errors while wire errors stay masked', async () => {
  const sandbox = await makeSandbox();
  try {
    await assert.rejects(
      () => sandbox.plugin.call('write_file', { parent: '/etc', name: 'x', data: 'AA==' }),
      (error) => error instanceof FilePluginError && error.code === ErrorCode.PATH_DENIED
    );
    const internal = await sandbox.plugin.handle({ id: 'x', method: 'list_dir', params: { path: '/etc', limit: 3 } });
    assert.ok(!internal.error.includes('/etc'));
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('write policy is enforced centrally for every caller', async () => {
  const sandbox = await makeSandbox({ config: { security: { allowWrite: false } } });
  try {
    await assert.rejects(
      () => sandbox.plugin.call('create_folder', { parent: sandbox.dir, name: 'x' }),
      (error) => error.code === ErrorCode.FORBIDDEN
    );
    assert.ok((await sandbox.plugin.call('roots')).length > 0);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('cancellation tokens are owned by the service, not the backend', async () => {
  const plugin = createFilePlugin(
    { homeDir: '/tmp/cancel-test', backend: slowBackend(), security: { allowWrite: false } },
    {}
  );
  try {
    const pending = plugin.call('search', { path: '~', query: 'x' }, { requestId: 'long-running' });
    await tick();
    const outcome = await plugin.call('search_cancel', { requestId: 'long-running' });
    assert.deepEqual(outcome, { cancelled: true });
    await assert.rejects(pending, (error) => error.code === ErrorCode.CANCELLED);
  } finally {
    await plugin.dispose();
  }
});

test('concurrency is bounded by configuration', async () => {
  const plugin = createFilePlugin(
    {
      homeDir: '/tmp/concurrency-test',
      backend: slowBackend(),
      limits: { maxConcurrentTasks: 1 },
      security: { allowWrite: false },
    },
    {}
  );
  try {
    const first = plugin.call('search', { path: '~', query: 'x' }, { requestId: 'one' });
    await tick();
    await assert.rejects(
      () => plugin.call('search', { path: '~', query: 'y' }, { requestId: 'two' }),
      (error) => error.code === ErrorCode.TOO_MANY_TASKS
    );
    await plugin.call('search_cancel', { requestId: 'one' });
    await assert.rejects(first, (error) => error.code === ErrorCode.CANCELLED);
  } finally {
    await plugin.dispose();
  }
});

test('service emits change and fs events to any adapter', async () => {
  const sandbox = await makeSandbox();
  try {
    const events = [];
    const off = sandbox.plugin.service.on('changed', (event) => events.push(event));
    await sandbox.plugin.call('create_file', { parent: sandbox.dir, name: 'event.txt' });
    assert.equal(events.length, 1);
    assert.equal(events[0].method, 'create_file');
    off();
    await sandbox.plugin.call('create_file', { parent: sandbox.dir, name: 'event2.txt' });
    assert.equal(events.length, 1);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('describe() exposes boundary, policy, limits and shared tools', async () => {
  const sandbox = await makeSandbox();
  try {
    const info = sandbox.plugin.describe();
    assert.equal(info.backend, 'local');
    assert.equal(info.methods.length, 43);
    assert.ok(info.tools.includes('file_list_dir'));
    assert.ok(info.policy.allowedRoots.length >= 1);
    assert.equal(info.config.security.allowSystemCommands, false);
    assert.doesNotThrow(() => JSON.stringify(info));
  } finally {
    await cleanSandbox(sandbox);
  }
});
