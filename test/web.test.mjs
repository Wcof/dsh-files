import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { registerFilesPage } from '../src/adapters/dsh-web.js';
import { upload, toBase64 } from '../web/api.js';
import { messages } from '../web/locale.js';
import { makeSandbox, cleanSandbox } from './helpers.mjs';

test('file page serves only bundled assets and rejects cross-origin or mutating requests', async (t) => {
  let route;
  registerFilesPage({ webServer: { register(value) { route = value; return () => {}; } } });
  const server = http.createServer(route.handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/dsh-files/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  const html = await page.text();
  for (const file of [...html.matchAll(/(?:src|href)="\.\/([^"\s]+)"/g)].map(match => match[1]).concat(['icons.js', 'view-state.js', 'places-state.js', 'sidebar.js', 'locale.js', 'api.js'])) assert.equal((await fetch(`${base}/dsh-files/${file}`)).status, 200);
  assert.equal((await fetch(`${base}/dsh-files`, { redirect: 'manual' })).status, 308);
  assert.equal((await fetch(`${base}/dsh-files/app.js`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${base}/dsh-files/`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/dsh-files/`, { headers: { Origin: 'https://invalid.example' } })).status, 403);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate' };
  // fetch owns Sec-Fetch-Mode; exercise the route with real navigation headers.
  const response = { writeHead(status) { this.status = status; }, end() {} };
  await route.handler({ method: 'GET', url: '/dsh-files/', headers: Object.fromEntries(Object.entries(navigation).map(([key, value]) => [key.toLowerCase(), value])) }, response);
  assert.equal(response.status, 200);
  await route.handler({ method: 'GET', url: '/dsh-files/app.js', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }, response);
  assert.equal(response.status, 403);
  for (const suffix of ['../package.json', '%2e%2e%2fpackage.json', 'api.js/../../package.json', 'missing.js']) assert.equal((await fetch(`${base}/dsh-files/${suffix}`)).status, 404);
});

test('browser entry registers a matching files sidebar and main panel with localized labels', async () => {
  let registration;
  vm.runInNewContext(await fs.readFile(new URL('../client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(value) { registration = value; } } } });
  assert.equal(registration.id, '@dsh/files');
  const plugin = registration.factory(name => { assert.equal(name, 'react'); return { createElement() {} }; });
  const slots = [], copies = new Map();
  plugin.apply({
    effect: fn => fn(),
    locale: { register: (ns, dict) => { copies.set(ns, dict); return () => {}; }, bind: ns => key => copies.get(ns).zh[key] },
    slots: { inject: (_name, fn) => fn(), register: (entry, component) => { slots.push({ ...entry, component }); return () => {}; } },
  });
  assert.equal(slots[0].name, 'sidebar.panellist'); assert.equal(slots[0].label(), '文件');
  assert.equal(slots[1].name, 'main'); assert.equal(slots[0].id, slots[1].key);
  assert.equal(typeof slots[1].component, 'function');
  assert.deepEqual(Object.keys(messages.zh).sort(), Object.keys(messages.en).sort());
});

test('browser uploads preserve Unicode bytes and cancel unfinished sessions before commit', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const methods = [], chunks = [];
  globalThis.fetch = async (_url, options) => {
    const request = JSON.parse(options.body); methods.push(request.method);
    if (request.method === 'import_chunk') chunks.push(Buffer.from(request.params.data, 'base64'));
    return Response.json({ ok: true, result: request.method === 'import_begin' ? { name: '中文.txt' } : {} });
  };
  const data = '你好，文件。'.repeat(5000);
  const file = new File([data], '中文.txt');
  const limits = { maxImportBytes: 2000000, maxImportChunkBase64: 4096 };
  await upload(file, '/fixture', limits, new AbortController().signal, () => {});
  assert.equal(Buffer.concat(chunks).toString(), data); assert.equal(methods.at(-1), 'import_end');
  assert.equal(Buffer.from(toBase64(new TextEncoder().encode('测试🙂')), 'base64').toString(), '测试🙂');
  methods.length = 0;
  const controller = new AbortController();
  await assert.rejects(upload(file, '/fixture', limits, controller.signal, () => controller.abort()), { name: 'AbortError' });
  assert.equal(methods.at(-1), 'import_cancel'); assert.equal(methods.includes('import_end'), false);
});

async function pageHarness(overrides = {}) {
  const nodes = new Map();
  const document = {
    documentElement: { dataset: {} },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { classList: { toggle() {} }, setAttribute(key, value) { this[key] = value; }, querySelector() { return null; } });
      return nodes.get(id);
    },
    querySelectorAll() { return []; },
  };
  const source = (await fs.readFile(new URL('../web/app.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '').replace('void boot();', '');
  const context = vm.createContext({
    document, TextEncoder, AbortController, URL,
    navigator: { pdfViewerEnabled: true },
    rawPreviewUrl: value => `/raw?path=${encodeURIComponent(value)}`,
    toBase64, parentOf: value => value.slice(0, value.lastIndexOf('/')), t: key => key,
    ...overrides,
  });
  vm.runInContext(`${source}\nrenderPreview = () => {}; load = async () => {}; globalThis.page = { state, controls, saveText, dirty, choose, closePreview, actionDisabled, menuLabels: MENU_LABELS };`, context);
  return { ...context.page, nodes };
}

test('page re-enables row selection after a file operation completes', async () => {
  const page = await pageHarness();
  page.state.busy = true; page.controls();
  assert.equal(page.nodes.get('rows')['aria-disabled'], 'true');
  page.state.busy = false; page.controls();
  assert.equal(page.nodes.get('rows')['aria-disabled'], 'false');
});

test('disabled OS integration permits folder navigation but disables default-app actions', async () => {
  const page = await pageHarness();
  const entry = { path: '/fixture', isDir: false };
  page.state.entries = [entry]; page.state.selected.add(entry.path);
  page.controls(); assert.equal(page.nodes.get('open').disabled, true);
  entry.isDir = true; page.controls(); assert.equal(page.nodes.get('open').disabled, false);
});

test('edits typed while a save is in flight remain an unsaved draft', async () => {
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  let request;
  const page = await pageHarness({ call: async (method, params) => { request = { method, params }; return response; } });
  page.state.info = { security: { allowWrite: true } };
  page.state.preview = { editing: true, entry: { path: '/fixture/note.txt', name: 'note.txt' }, result: { content: 'original', mtime: 1 }, draft: 'submitted' };
  const saving = page.saveText();
  page.state.preview.draft = 'typed during save';
  finish({ conflict: false, mtime: 2 }); await saving;
  assert.equal(request.method, 'write_file');
  assert.equal(Buffer.from(request.params.data, 'base64').toString(), 'submitted');
  assert.equal(page.state.preview.result.content, 'submitted');
  assert.equal(page.state.preview.draft, 'typed during save');
  assert.equal(page.dirty(), true);
  assert.equal(page.nodes.get('save-text').disabled, false);
});

test('binary previews use the whole-file stream and ignore the tool size limit', async () => {
  const calls = [];
  const page = await pageHarness({ call: async method => { calls.push(method); return { content: 'hello', kind: 'text', truncated: false, size: 5, mtime: 1 }; } });
  page.state.info = { limits: { maxPreviewBytes: 512 * 1024, maxPaths: 200 }, security: { allowWrite: true }, backendCapabilities: { osIntegration: true } };
  await page.choose({ path: '/fixture/big.png', name: 'big.png', kind: 'image', size: 5 * 1024 * 1024, isDir: false });
  assert.equal(calls.includes('image_preview'), false, 'large images must not be rejected before rendering');
  assert.match(page.state.preview.result.url, /^\/raw\?path=/);
  assert.equal(page.state.preview.hint, undefined);
  await page.choose({ path: '/fixture/note.txt', name: 'note.txt', kind: 'text', size: 5, isDir: false });
  assert.equal(calls.at(-1), 'read_file', 'text reads keep the existing command');
});

test('PDF without a native viewer still produces a renderable preview source', async () => {
  const page = await pageHarness({ navigator: { pdfViewerEnabled: false }, call: async () => ({}) });
  await page.choose({ path: '/fixture/doc.pdf', name: 'doc.pdf', kind: 'pdf', size: 8 * 1024 * 1024, isDir: false });
  assert.match(page.state.preview.result.url, /^\/raw\?path=/);
  assert.equal(page.state.preview.hint, 'pdfUnavailable');
});

test('closing the preview pane is not blocked by a running file operation', async () => {
  const page = await pageHarness();
  page.state.previewOpen = true; page.state.busy = true;
  await page.closePreview();
  assert.equal(page.state.previewOpen, false);
  assert.equal(page.nodes.get('preview').hidden, true);
  await page.closePreview();
  assert.equal(page.state.previewOpen, false);
});

test('context menu labels and disabled states are complete in both languages', async () => {
  const page = await pageHarness();
  const ids = Object.keys(page.menuLabels);
  assert.ok(ids.length >= 18);
  for (const key of Object.values(page.menuLabels)) {
    assert.ok(messages.zh[key], `missing zh label ${key}`);
    assert.ok(messages.en[key], `missing en label ${key}`);
  }
  for (const key of ['openFolder', 'recycle', 'editText', 'selectAll', 'upload']) {
    assert.ok(messages.zh[key] && messages.en[key], `missing label ${key}`);
  }
  const disabled = page.actionDisabled();
  for (const id of ids) assert.equal(typeof disabled[id], 'boolean', `missing disabled state for ${id}`);
});

test('page event subscriptions return structured errors for inaccessible directories', async () => {
  const sandbox = await makeSandbox();
  try {
    const routes = [];
    await sandbox.plugin.attach({ name: 'dsh', options: { hostContext: {
      webServer: { register(route) { routes.push(route); return () => {}; } }, effect() {},
    } } });
    const route = routes.find(item => item.path.endsWith('/events'));
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = body; } };
    await route.handler({ method: 'GET', url: `/agent/files/events?path=${encodeURIComponent(sandbox.dir + '/missing')}`, headers: {} }, response);
    assert.ok(response.status >= 400);
    assert.equal(JSON.parse(response.body).ok, false);
  } finally { await cleanSandbox(sandbox); }
});
