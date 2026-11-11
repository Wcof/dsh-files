import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { makeSandbox, cleanSandbox, createStreams } from './helpers.mjs';
import { listAdapters, createAdapter, validateAdapter, FilePluginError } from '../src/index.js';

test('all built-in adapters are registered behind one contract', () => {
  const names = listAdapters();
  for (const expected of ['in-process', 'dsh', 'zcode', 'mcp', 'http']) {
    assert.ok(names.includes(expected), `missing adapter ${expected}`);
  }
  for (const name of names) {
    const adapter = createAdapter(name);
    assert.equal(validateAdapter(adapter), adapter);
    assert.equal(typeof adapter.start, 'function');
    assert.equal(typeof adapter.stop, 'function');
    assert.equal(typeof adapter.describe(), 'object');
  }
  assert.throws(() => createAdapter('does-not-exist'), FilePluginError);
});

test('in-process adapter exposes a plain JS API', async () => {
  const sandbox = await makeSandbox();
  try {
    const handle = await sandbox.plugin.attach('in-process');
    assert.ok((await handle.call('roots')).length > 0);
    assert.ok(handle.tools().some((tool) => tool.name === 'file_list_dir'));
    const response = await handle.handle({ id: '1', method: 'roots', params: {} });
    assert.equal(response.ok, true);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('zcode adapter speaks NDJSON and shares the same tools', async () => {
  const sandbox = await makeSandbox();
  try {
    const streams = createStreams();
    await sandbox.plugin.attach({ name: 'zcode', options: { input: streams.input, output: streams.output } });
    streams.send({ id: '1', method: 'initialize', params: { client: 'zcode' } });
    streams.send({ id: '2', method: 'tools/list' });
    streams.send({ id: '3', method: 'tools/call', params: { name: 'file_roots', arguments: {} } });
    streams.send({ id: '4', method: 'file_list_dir', params: { path: sandbox.dir } });
    streams.send({ id: '5', method: 'roots', params: {} });
    streams.send({ id: '6', method: 'tools/call', params: { name: 'file_nope', arguments: {} } });
    const sent = await streams.waitFor(6);
    const byId = (id) => sent.find((item) => item.id === id);
    assert.equal(byId('1').result.backend, 'local');
    assert.ok(byId('2').result.tools.length > 20);
    assert.equal(byId('3').result[0].id, 'home');
    assert.equal(byId('4').ok, true);
    assert.equal(byId('5').ok, true);
    assert.equal(byId('6').ok, false);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('zcode adapter accepts numeric request ids and echoes them unchanged', async () => {
  const sandbox = await makeSandbox();
  try {
    const streams = createStreams();
    await sandbox.plugin.attach({ name: 'zcode', options: { input: streams.input, output: streams.output } });
    streams.send({ id: 1, method: 'initialize' });
    streams.send({ id: 2, method: 'tools/call', params: { name: 'file_roots', arguments: {} } });
    streams.send({ id: 3, method: 'roots', params: {} });
    streams.send({ id: 4, method: 'file_roots', params: {} });
    streams.send({ id: 0, method: 'roots', params: {} });
    streams.send({ method: 'roots', params: {} });
    const sent = await streams.waitFor(6);
    assert.equal(sent[0].id, 1);
    assert.equal(sent[0].result.backend, 'local');
    assert.equal(sent[1].id, 2);
    assert.equal(sent[1].result[0].id, 'home');
    assert.equal(sent[2].id, 3, 'raw command with numeric id must not be rejected');
    assert.equal(sent[2].ok, true);
    assert.equal(sent[3].id, 4);
    assert.equal(sent[3].ok, true);
    assert.equal(sent[4].id, 0, 'numeric id 0 is still a valid id');
    assert.equal(sent[4].ok, true);
    assert.equal(sent[5].id, '');
    assert.equal(sent[5].ok, false, 'a frame with no id at all is rejected');
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('MCP adapter serves initialize / tools.list / tools.call with JSON-RPC 2.0', async () => {
  const sandbox = await makeSandbox();
  try {
    const streams = createStreams();
    await sandbox.plugin.attach({ name: 'mcp', options: { input: streams.input, output: streams.output } });
    streams.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    streams.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    streams.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'file_roots', arguments: {} } });
    streams.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'file_missing', arguments: {} } });
    streams.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const sent = await streams.waitFor(4);
    const byId = (id) => sent.find((item) => item.id === id);
    assert.equal(byId(1).result.protocolVersion, '2024-11-05');
    assert.ok(byId(2).result.tools.some((tool) => tool.name === 'file_list_dir'));
    assert.equal(byId(3).result.isError, false);
    assert.equal(byId(4).result.isError, true);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('DSH adapter registers only agent routes and never an AiNative iframe', async () => {
  const sandbox = await makeSandbox();
  try {
    const routes = new Map();
    const hostContext = {
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
    const handle = await sandbox.plugin.attach({
      name: 'dsh',
      options: { hostContext, panelId: 'test-files' },
    });
    assert.equal(routes.size, 6);
    assert.ok([...routes.keys()].every((path) => path.startsWith('/agent/files')));
    assert.ok(routes.has('/agent/files/raw'));
    assert.equal(handle.clientSpec.panelId, 'test-files');
    assert.equal(handle.clientSpec.rendering, 'host-owned');

    const tools = await handle.dispatch({ method: 'GET', path: '/agent/files/tools', headers: {} });
    assert.equal(tools.status, 200);
    assert.ok(tools.payload.tools.length > 20);
    const crossOrigin = await handle.dispatch({
      method: 'GET', path: '/agent/files/tools', headers: { origin: 'https://evil.example', host: '127.0.0.1' },
    });
    assert.equal(crossOrigin.status, 403);
    const call = await handle.dispatch({
      method: 'POST', path: '/agent/files/tools/call', headers: {},
      body: { name: 'file_stat', arguments: { path: sandbox.dir } },
    });
    assert.equal(call.status, 200);
    assert.equal(call.payload.result.found, true);
    const raw = await handle.dispatch({
      method: 'POST', path: '/agent/files/rpc', headers: {},
      body: { id: 'raw', method: 'roots', params: {} },
    });
    assert.equal(raw.payload.ok, true);
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('DSH preview stream serves whole media files with ranges and stays authorized', async () => {
  const sandbox = await makeSandbox();
  const routes = new Map();
  const hostContext = {
    webServer: {
      register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path); },
    },
    effect(fn) { return fn(); },
  };
  let server;
  try {
    await sandbox.plugin.attach({ name: 'dsh', options: { hostContext } });
    const photo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
    const photoPath = path.join(sandbox.dir, 'photo.png');
    await fs.writeFile(photoPath, photo);
    const textPath = path.join(sandbox.dir, 'note.txt');
    await fs.writeFile(textPath, 'plain text');
    const handler = routes.get('/agent/files/raw');
    assert.equal(typeof handler, 'function');
    server = http.createServer((request, response) => { void handler(request, response); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const url = `${base}/agent/files/raw?path=${encodeURIComponent(photoPath)}`;

    const full = await fetch(url);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'image/png');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(full.headers.get('content-disposition'), 'inline');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), photo);

    const ranged = await fetch(url, { headers: { Range: 'bytes=2-5' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 2-5/${photo.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), photo.subarray(2, 6));

    const wrongKind = await fetch(`${base}/agent/files/raw?path=${encodeURIComponent(textPath)}`);
    assert.equal(wrongKind.status, 400);
    const escape = await fetch(`${base}/agent/files/raw?path=${encodeURIComponent('../outside.png')}`);
    assert.equal(escape.status, 403);
    const crossOrigin = await fetch(url, { headers: { Origin: 'https://evil.example' } });
    assert.equal(crossOrigin.status, 403);
    const dispatch = await fetch(url, { method: 'POST' });
    assert.equal(dispatch.status, 405);
  } finally {
    server?.closeAllConnections?.();
    server?.close();
    await cleanSandbox(sandbox);
  }
});

test('HTTP adapter serves tools and rpc on loopback only', async () => {
  const sandbox = await makeSandbox();
  try {
    const handle = await sandbox.plugin.attach({ name: 'http', options: { host: '127.0.0.1', port: 0 } });
    const base = handle.url;
    assert.equal(handle.server.listening, true);
    const tools = await fetch(`${base}/tools`).then((response) => response.json());
    assert.ok(tools.tools.length > 20);
    const response = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'h1', method: 'stat', params: { path: sandbox.dir } }),
    }).then((item) => item.json());
    assert.equal(response.ok, true);
    assert.equal(response.result.found, true);
    const health = await fetch(`${base}/healthz`).then((item) => item.json());
    assert.equal(health.backend, 'local');
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('HTTP adapter can be embedded into a host-owned server without a socket', async () => {
  const sandbox = await makeSandbox();
  try {
    const adapter = createAdapter('http', { listen: false });
    const handle = await sandbox.plugin.attach(adapter);
    assert.equal(handle.listen, false);
    assert.equal(typeof handle.handler, 'function');
    assert.equal(adapter.describe().mode, 'injected-handler');
    assert.equal(adapter.describe().bind, 'none (host-owned server)');

    const response = {
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await handle.handler({ method: 'GET', url: '/tools', headers: { host: '127.0.0.1' } }, response);
    assert.equal(response.status, 200);
    assert.ok(JSON.parse(response.body).tools.length > 20);
  } finally {
    await cleanSandbox(sandbox);
  }
});
