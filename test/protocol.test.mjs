import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS,
  METHODS,
  PARAMS_BY_METHOD,
  isFileMethod,
  validateRequest,
  makeRequest,
  describeProtocol,
  buildToolDefinitions,
  toolNameToMethod,
  ErrorCode,
  FilePluginError,
  safeMessage,
  resolveConfig,
} from '../src/index.js';

const config = resolveConfig({ homeDir: '/tmp/protocol-test' }, {});

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof FilePluginError && error.code === code);
}

test('command table covers the original AiNative file surface', () => {
  // 42 commands from protocol.rs + locate_cancel (handled by the original main
  // loop but missing from its validate_request whitelist; kept for compatibility).
  assert.equal(COMMANDS.length, 43);
  assert.equal(new Set(METHODS).size, METHODS.length);
  for (const expected of [
    'version', 'roots', 'list_dir', 'disk_usage', 'search', 'locate', 'read_file',
    'image_preview', 'pdf_preview', 'media_preview', 'archive_list', 'extract_archive',
    'create_zip', 'stat', 'create_folder', 'create_file', 'write_file', 'rename',
    'trash', 'copy', 'move', 'duplicate', 'duplicate_batch', 'copy_batch',
    'move_batch', 'trash_batch', 'copy_paths', 'copy_image', 'open', 'editor',
    'reveal', 'open_trash', 'watch_start', 'watch_stop', 'import_probe',
    'import_begin', 'import_chunk', 'import_end', 'import_cancel',
    'search_cancel', 'locate_cancel', 'preview_cancel', 'batch_cancel',
  ]) {
    assert.ok(isFileMethod(expected), `missing ${expected}`);
  }
  assert.ok(!isFileMethod('workspace_session'));
  assert.ok(!isFileMethod('apps:list'));
});

test('parameter allowlists match protocol.rs', () => {
  assert.deepEqual(PARAMS_BY_METHOD.list_dir, [
    'path', 'offset', 'limit', 'sortBy', 'sortDir', 'showHidden', 'probeProjects',
  ]);
  assert.deepEqual(PARAMS_BY_METHOD.write_file, ['parent', 'name', 'data', 'expectedMtime']);
  assert.deepEqual(PARAMS_BY_METHOD.copy, ['from', 'to', 'source', 'target']);
  assert.deepEqual(PARAMS_BY_METHOD.import_chunk, ['uploadId', 'offset', 'data']);
  assert.deepEqual(PARAMS_BY_METHOD.roots, []);
});

test('validateRequest rejects unknown params and malformed envelopes', () => {
  expectCode(() => validateRequest({ id: '1', method: 'roots', params: { nope: 1 } }, config), ErrorCode.UNKNOWN_PARAMETER);
  expectCode(() => validateRequest({ id: '', method: 'roots' }, config), ErrorCode.INVALID_REQUEST);
  expectCode(() => validateRequest({ id: '1', method: 'nope' }, config), ErrorCode.UNSUPPORTED_METHOD);
  expectCode(() => validateRequest({ id: '1', method: 'roots', params: [] }, config), ErrorCode.INVALID_REQUEST);
  expectCode(() => validateRequest({ id: '1', method: 'list_dir', params: { path: '/tmp', limit: 0 } }, config), ErrorCode.INVALID_PARAMETER);
  expectCode(() => validateRequest({ id: '1', method: 'list_dir', params: { path: '/tmp', sortBy: 'random' } }, config), ErrorCode.INVALID_PARAMETER);
  expectCode(() => validateRequest({ id: '1', method: 'list_dir', params: { path: '/tmp', showHidden: 'yes' } }, config), ErrorCode.INVALID_PARAMETER);
  expectCode(() => validateRequest({ id: '1', method: 'write_file', params: { parent: '/tmp', name: 'a', data: 'AA==', expectedMtime: Number.NaN } }, config), ErrorCode.INVALID_PARAMETER);
  expectCode(() => validateRequest({ id: '1', method: 'import_chunk', params: { uploadId: 'u' } }, config), ErrorCode.INVALID_PARAMETER);
  expectCode(() => validateRequest({ id: '1', method: 'copy_batch', params: { paths: [], dest: '/tmp' } }, config), ErrorCode.INVALID_PARAMETER);
  expectCode(() => validateRequest({ id: '1', method: 'import_begin', params: { uploadId: 'u', parent: '/tmp', name: 'a', size: 1, conflict: 'overwrite' } }, config), ErrorCode.INVALID_PARAMETER);
});

test('import chunk and path-array budgets are enforced', () => {
  expectCode(
    () => validateRequest({ id: '1', method: 'import_chunk', params: { uploadId: 'u', data: 'x'.repeat(700_001) } }, config),
    ErrorCode.INVALID_PARAMETER
  );
  expectCode(
    () => validateRequest({ id: '1', method: 'copy_batch', params: { paths: ['x'.repeat(4097)], dest: '/tmp' } }, config),
    ErrorCode.INVALID_PARAMETER
  );
});

test('valid requests are normalized', () => {
  const request = makeRequest('list_dir', { path: '/tmp' });
  const normalized = validateRequest(request, config);
  assert.equal(normalized.command.name, 'list_dir');
  assert.equal(normalized.params.path, '/tmp');
  assert.equal(normalized.id, request.id);
});

test('safeMessage never leaks absolute paths from internal errors', () => {
  assert.equal(safeMessage(new Error('IO error: /Users/secret/file.txt')), '文件操作失败');
  assert.equal(safeMessage(new FilePluginError(ErrorCode.INTERNAL, '/private/etc/passwd')), '文件操作失败');
  assert.equal(safeMessage(new FilePluginError(ErrorCode.NOT_FOUND, 'file not found')), 'file not found');
});

test('one shared tool catalogue drives every agent', () => {
  const tools = buildToolDefinitions();
  assert.ok(tools.length > 20);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length);
  assert.ok(tools.every((tool) => tool.name.length <= 64));
  assert.ok(!tools.some((tool) => tool.method === 'version' || tool.method === 'watch_start'));
  assert.equal(toolNameToMethod('file_list_dir'), 'list_dir');
  assert.throws(() => toolNameToMethod('evil_roots'), FilePluginError);
  const protocol = describeProtocol(config);
  assert.equal(protocol.methodCount, 43);
  assert.equal(protocol.request, '{ id: string, method: string, params: object }');
});
