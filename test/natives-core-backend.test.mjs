import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFilePlugin,
  createNativesCoreBackend,
  resolveConfig,
  FilePluginError,
  ErrorCode,
} from '../src/index.js';

test('compatibility backend forwards the original command verbatim', async () => {
  const seen = [];
  const rpc = async (request) => {
    seen.push(request);
    return { id: request.id, ok: true, result: { entries: [], path: '/somewhere' } };
  };
  const plugin = createFilePlugin(
    {
      homeDir: '/tmp/compat-test',
      backend: 'natives-core',
      backendOptions: { rpc },
    },
    {}
  );
  try {
    const result = await plugin.call('list_dir', { path: '~', limit: 10 });
    assert.deepEqual(result, { entries: [], path: '/somewhere' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, 'list_dir');
    assert.deepEqual(seen[0].params, { path: '~', limit: 10 });
    assert.equal(plugin.backend.name, 'natives-core');
  } finally {
    await plugin.dispose();
  }
});

test('compatibility backend maps core errors and refuses unknown methods', async () => {
  const backend = createNativesCoreBackend(
    resolveConfig({ homeDir: '/tmp/compat-test', backend: 'natives-core' }, {}),
    { rpc: async () => ({ ok: false, error: 'core failure' }) }
  );
  await assert.rejects(() => backend.handle('stat', { path: '~' }), (error) => error.code === ErrorCode.INTERNAL);
  await assert.rejects(
    () => backend.handle('workspace_session', {}),
    (error) => error instanceof FilePluginError && error.code === ErrorCode.UNSUPPORTED_METHOD
  );
});

test('compat backend is opt-in: default plugin has zero AiNative dependency', async () => {
  const plugin = createFilePlugin({ homeDir: '/tmp/compat-test' }, {});
  assert.equal(plugin.backend.name, 'local');
  assert.equal(plugin.config.backend, 'local');
  await plugin.dispose();
});
