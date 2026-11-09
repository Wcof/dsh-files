/**
 * Verifies the *optional, additive* integration in the original AiNative repo.
 * Skipped automatically when that checkout is not a sibling of this one, so
 * the plugin repository stays independently testable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativesFiles = path.resolve(pluginRoot, '../AiNative/Natives/integrations/dsh/files');
const bridgePath = path.join(nativesFiles, 'agent-tools.js');
const available = fs.existsSync(bridgePath);

function makeResponse() {
  return {
    status: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

function makeRequest(method, url, body) {
  const request = { method, url, headers: { host: '127.0.0.1' } };
  if (body !== undefined) {
    request[Symbol.asyncIterator] = async function* () {
      yield Buffer.from(JSON.stringify(body));
    };
  }
  return request;
}

test('AiNative bridge registers only additive routes and works with the standalone plugin', { skip: !available }, async () => {
  const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-bridge-'));
  const previous = {
    root: process.env.DSH_FILES_PLUGIN_ROOT,
    home: process.env.DSH_FILES_HOME,
    state: process.env.DSH_FILES_STATE_DIR,
  };
  process.env.DSH_FILES_PLUGIN_ROOT = pluginRoot;
  process.env.DSH_FILES_HOME = sandbox;
  process.env.DSH_FILES_STATE_DIR = path.join(sandbox, '.state');
  try {
    const { attachAgentTools } = await import(`${pathToFileURL(bridgePath).href}?t=${Date.now()}`);
    const routes = new Map();
    const ctx = {
      webServer: {
        register(route) {
          routes.set(route.path, route.handler);
          return () => routes.delete(route.path);
        },
      },
      effect(fn) {
        return fn();
      },
    };
    assert.equal(attachAgentTools(ctx), true);
    assert.equal(routes.size, 4);
    // The pre-existing URL route is NOT registered or replaced by the bridge.
    assert.equal(routes.has('/natives/files/url'), false);
    assert.ok([...routes.keys()].every((route) => route.startsWith('/natives/files/agent/')));

    const toolsResponse = makeResponse();
    await routes.get('/natives/files/agent/tools')(
      makeRequest('GET', '/natives/files/agent/tools'),
      toolsResponse
    );
    assert.equal(toolsResponse.status, 200);
    assert.ok(toolsResponse.json().tools.some((tool) => tool.name === 'file_list_dir'));

    const rpcResponse = makeResponse();
    await routes.get('/natives/files/agent/rpc')(
      makeRequest('POST', '/natives/files/agent/rpc', { id: 'bridge-1', method: 'roots', params: {} }),
      rpcResponse
    );
    assert.equal(rpcResponse.status, 200);
    assert.equal(rpcResponse.json().ok, true);
    assert.equal(rpcResponse.json().result[0].path, sandbox);

    const callResponse = makeResponse();
    await routes.get('/natives/files/agent/tools/call')(
      makeRequest('POST', '/natives/files/agent/tools/call', {
        name: 'file_stat', arguments: { path: sandbox },
      }),
      callResponse
    );
    assert.equal(callResponse.status, 200);
    assert.equal(callResponse.json().result.found, true);
  } finally {
    for (const [key, value] of Object.entries({
      DSH_FILES_PLUGIN_ROOT: previous.root,
      DSH_FILES_HOME: previous.home,
      DSH_FILES_STATE_DIR: previous.state,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.promises.rm(sandbox, { recursive: true, force: true });
  }
});

test('AiNative bridge is a no-op when the standalone plugin is absent', { skip: !available }, () => {
  const script = `
    import { pathToFileURL } from 'node:url';
    const { attachAgentTools } = await import(${JSON.stringify(pathToFileURL(bridgePath).href)});
    const routes = new Map();
    const ctx = {
      webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
      effect(fn) { return fn(); },
    };
    attachAgentTools(ctx);
    const handler = routes.get('/natives/files/agent/tools');
    const response = {
      status: 0, body: '',
      writeHead(status) { this.status = status; },
      end(body) { this.body = body; },
    };
    await handler({ method: 'GET', url: '/natives/files/agent/tools', headers: { host: '127.0.0.1' } }, response);
    process.stdout.write(JSON.stringify({ routes: [...routes.keys()], status: response.status, body: JSON.parse(response.body) }));
  `;
  const env = { ...process.env };
  delete env.DSH_FILES_PLUGIN_ROOT;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: nativesFiles,
    env,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output);
  assert.equal(parsed.status, 503);
  assert.equal(parsed.body.code, 'plugin-missing');
  assert.equal(parsed.routes.length, 4);
  assert.equal(parsed.routes.includes('/natives/files/url'), false);
});
