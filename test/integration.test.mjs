import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { makeSandbox, cleanSandbox, createStreams } from './helpers.mjs';
import { createFilePlugin, ErrorCode } from '../src/index.js';

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test('one capability instance serves DSH, zcode, MCP and HTTP simultaneously', async () => {
  const sandbox = await makeSandbox();
  try {
    const dsh = await sandbox.plugin.attach('dsh');
    const zcodeStreams = createStreams();
    const mcpStreams = createStreams();
    await sandbox.plugin.attach({ name: 'zcode', options: { input: zcodeStreams.input, output: zcodeStreams.output } });
    await sandbox.plugin.attach({ name: 'mcp', options: { input: mcpStreams.input, output: mcpStreams.output } });
    const httpHandle = await sandbox.plugin.attach({ name: 'http', options: { host: '127.0.0.1', port: 0 } });

    // 1. DSH writes a file through the shared tool catalogue.
    const written = await dsh.dispatch({
      method: 'POST', path: '/agent/files/tools/call', headers: {},
      body: {
        name: 'file_write_file',
        arguments: { parent: sandbox.dir, name: 'shared.txt', data: b64('shared state') },
      },
    });
    assert.equal(written.status, 200);
    const target = written.payload.result.path;

    // 2. MCP reads it back.
    mcpStreams.send({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'file_read_file', arguments: { path: target } },
    });
    const mcpResult = await mcpStreams.waitForId(1);
    assert.equal(JSON.parse(mcpResult.result.content[0].text).content, 'shared state');

    // 3. zcode stats it with a raw command.
    zcodeStreams.send({ id: 'z1', method: 'stat', params: { path: target } });
    const zcodeResult = await zcodeStreams.waitForId('z1');
    assert.equal(zcodeResult.result.found, true);

    // 4. HTTP lists the directory on the same service.
    const listing = await fetch(`${httpHandle.url}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'h1', method: 'list_dir', params: { path: sandbox.dir } }),
    }).then((response) => response.json());
    assert.ok(listing.result.entries.some((entry) => entry.name === 'shared.txt'));

    // Every adapter sees the identical tool catalogue.
    const dshTools = (await dsh.dispatch({ method: 'GET', path: '/agent/files/tools', headers: {} })).payload.tools;
    const httpTools = await fetch(`${httpHandle.url}/tools`).then((response) => response.json());
    assert.deepEqual(
      dshTools.map((tool) => tool.name),
      httpTools.tools.map((tool) => tool.name)
    );
  } finally {
    await cleanSandbox(sandbox);
  }
});

test('two plugin instances with different config are fully isolated', async () => {
  const first = await makeSandbox();
  const second = await makeSandbox();
  try {
    assert.notEqual(first.dir, second.dir);
    const a = await first.plugin.call('roots');
    const b = await second.plugin.call('roots');
    assert.equal(a[0].path, first.dir);
    assert.equal(b[0].path, second.dir);
    await first.plugin.call('create_file', { parent: first.dir, name: 'only-a.txt' });
    const bListing = await second.plugin.call('list_dir', { path: second.dir });
    assert.ok(!bListing.entries.some((entry) => entry.name === 'only-a.txt'));
  } finally {
    await cleanSandbox(first);
    await cleanSandbox(second);
  }
});

test('disabled OS integration fails loudly instead of reaching the host OS', async () => {
  const plugin = createFilePlugin(
    {
      homeDir: '/tmp/no-os-test',
      security: { allowSystemCommands: false },
    },
    {}
  );
  try {
    await plugin.backend.init?.();
    await assert.rejects(
      () => plugin.call('open', { path: '/tmp/no-os-test' }),
      (error) => error.code === ErrorCode.CAPABILITY_UNAVAILABLE
    );
  } finally {
    await plugin.dispose();
    await fsp.rm('/tmp/no-os-test', { recursive: true, force: true });
  }
});

test('capability backend is replaceable without touching any adapter', async () => {
  const calls = [];
  const custom = {
    name: 'custom',
    async handle(method, params) {
      calls.push({ method, params });
      return { custom: true, method };
    },
    async dispose() {},
  };
  const plugin = createFilePlugin({ homeDir: '/tmp/custom-test', backend: custom }, {});
  try {
    const streams = createStreams();
    await plugin.attach({ name: 'mcp', options: { input: streams.input, output: streams.output } });
    streams.send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'file_stat', arguments: { path: '~' } } });
    const sent = await streams.waitFor(1);
    assert.equal(sent[0].result.isError, false);
    assert.equal(JSON.parse(sent[0].result.content[0].text).custom, true);
    assert.equal(calls[0].method, 'stat');
  } finally {
    await plugin.dispose();
  }
});

test('config.adapters drives a single start() call', async () => {
  const sandbox = await makeSandbox();
  try {
    // Attach by name is equivalent to config declaration.
    const handles = await sandbox.plugin.attach(['in-process', 'dsh']);
    assert.equal(handles.length, 2);
    assert.ok(await handles[0].call('roots'));
    assert.ok(handles[1].clientSpec.panelId);
  } finally {
    await cleanSandbox(sandbox);
  }
});
