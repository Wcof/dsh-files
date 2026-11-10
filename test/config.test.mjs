import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveConfig,
  describeConfig,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  DEFAULT_LIMITS,
  FilePluginError,
} from '../src/index.js';

test('invalid limits, boolean policies and state paths fail before startup', () => {
  for (const input of [
    { limits: { maxWatchers: 0 } }, { limits: { maxConcurrentTasks: Infinity } },
    { security: { allowWrite: 'false' } }, { stateDir: 'relative' },
  ]) assert.throws(() => resolveConfig(input, {}), FilePluginError);
});

test('defaults produce a self-contained config with no AiNative paths', () => {
  const config = resolveConfig({}, {});
  assert.equal(config.backend, 'local');
  assert.equal(config.protocolVersion, PROTOCOL_VERSION);
  assert.equal(config.pluginVersion, PLUGIN_VERSION);
  assert.equal(config.limits.maxFullRead, DEFAULT_LIMITS.maxFullRead);
  assert.ok(config.stateDir.endsWith('.dsh/files'));
  assert.ok(!JSON.stringify(config).includes('.natives'));
  // 8770 is only a configurable fallback URL for the optional compatibility
  // backend; no module imports or requires an AiNative process.
  assert.match(config.backendOptions.endpoint, /8770/);
});

test('environment overrides are explicit and injectable', () => {
  const config = resolveConfig(
    {},
    {
      DSH_FILES_HOME: '/tmp/plugin-home',
      DSH_FILES_STATE_DIR: '/tmp/plugin-state',
      DSH_FILES_BACKEND: 'natives-core',
      DSH_FILES_ALLOW_SYSTEM_COMMANDS: 'false',
      DSH_FILES_ALLOW_WRITE: '0',
      DSH_FILES_HTTP_PORT: '9876',
      DSH_FILES_CORE_RPC_URL: 'http://127.0.0.1:9999/rpc',
    }
  );
  assert.equal(config.homeDir, '/tmp/plugin-home');
  assert.equal(config.stateDir, '/tmp/plugin-state');
  assert.equal(config.backend, 'natives-core');
  assert.equal(config.security.allowSystemCommands, false);
  assert.equal(config.security.allowWrite, false);
  assert.equal(config.http.port, 9876);
  assert.equal(config.backendOptions.endpoint, 'http://127.0.0.1:9999/rpc');
});

test('explicit options win over environment', () => {
  const config = resolveConfig({ homeDir: '/tmp/explicit', security: { allowWrite: false } }, {
    DSH_FILES_HOME: '/tmp/env',
    DSH_FILES_ALLOW_WRITE: 'true',
  });
  assert.equal(config.homeDir, '/tmp/explicit');
  assert.equal(config.security.allowWrite, false);
});

test('invalid configuration is rejected with a structured error', () => {
  assert.throws(() => resolveConfig({ homeDir: 'relative' }, {}), FilePluginError);
  assert.throws(() => resolveConfig({ backend: 'magic' }, {}), FilePluginError);
  assert.throws(() => resolveConfig({ allowedRoots: ['relative'] }, {}), FilePluginError);
  assert.throws(() => resolveConfig({ http: { port: 99999 } }, {}), FilePluginError);
});

test('describeConfig exposes a redacted, serializable view', () => {
  const config = resolveConfig({ homeDir: '/tmp/x', tools: { openHandler: () => {} } }, {});
  const view = describeConfig(config);
  assert.equal(view.homeDir, '/tmp/x');
  assert.deepEqual(view.capabilities, ['openHandler']);
  assert.doesNotThrow(() => JSON.stringify(view));
});
