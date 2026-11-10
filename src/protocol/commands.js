/**
 * Single source of truth for the plugin's external contract.
 *
 * The method names, parameter allowlists and wire shapes are a direct port of
 * AiNative `native-file-host/src/protocol.rs::validate_request` (lines 87-265)
 * and `dispatch.rs::handle`. Keeping them here means every agent adapter
 * (DSH / zcode / MCP / HTTP / in-process) exposes *the same* capabilities and
 * the same input validation, without importing a single AiNative module.
 */

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description, extra = {}) => ({ type: 'integer', minimum: 0, description, ...extra });
const B = (description) => ({ type: 'boolean', description });
const A = (description) => ({
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  maxItems: 200,
  description,
});

const PATH = S('Path (absolute or ~/...). Must pass the configured access policy.');
const PARENT = S('Parent directory path.');
const NAME = S('Single file/folder name (no separators, <= 255 chars, not . or ..).');
const PATHS = A('1..200 paths, each <= 4096 bytes.');
const DEST = S('Destination directory (batch) or destination path (single).');
const UPLOAD_ID = S('Opaque upload session id returned by import_begin.');

/** @type {ReadonlyArray<object>} */
export const COMMANDS = Object.freeze([
  // ---- meta -------------------------------------------------------------
  {
    name: 'version', group: 'meta', mutates: false, capability: 'core', tool: false,
    summary: 'Plugin/protocol version and backend identity.',
    params: ['extensionVersion'], required: [],
    schema: { extensionVersion: S('Optional caller version (handshake only).') },
    output: '{ protocolVersion, hostVersion, backend, pluginVersion }',
  },
  {
    name: 'roots', group: 'meta', mutates: false, capability: 'core', tool: true,
    summary: 'Quick-access roots derived from the configured home directory.',
    params: [], required: [], schema: {},
    output: 'Array<{ id, name, path }>',
  },

  // ---- browse -----------------------------------------------------------
  {
    name: 'list_dir', group: 'browse', mutates: false, capability: 'core', tool: true,
    summary: 'List a directory with stable sorting, optional hidden files, project badges and pagination.',
    params: ['path', 'offset', 'limit', 'sortBy', 'sortDir', 'showHidden', 'probeProjects'],
    required: ['path'],
    schema: {
      path: PATH,
      offset: N('Zero-based page offset (<= 100000).'),
      limit: N('Page size, 1..2000 (default 500).', { minimum: 1, maximum: 2000 }),
      sortBy: S('Sort key.', { enum: ['name', 'size', 'mtime'] }),
      sortDir: S('Sort direction.', { enum: ['asc', 'desc'] }),
      showHidden: B('Include dotfiles.'),
      probeProjects: B('Shallow-probe up to 80 subdirectories for project badges.'),
    },
    output: 'ListDirResult & { hasMore: boolean }',
  },
  {
    name: 'stat', group: 'browse', mutates: false, capability: 'core', tool: true,
    summary: 'Stat a path; missing paths return { found:false } instead of an error.',
    params: ['path'], required: ['path'], schema: { path: PATH },
    output: 'StatResult',
  },
  {
    name: 'disk_usage', group: 'browse', mutates: false, capability: 'core', tool: true,
    summary: 'Bounded recursive size scan; symlinks are counted but never followed.',
    params: ['path'], required: ['path'], schema: { path: PATH },
    output: '{ path, bytes, files, directories, truncated, errors, items: DiskUsageItem[] }',
  },

  // ---- read -------------------------------------------------------------
  {
    name: 'read_file', group: 'read', mutates: false, capability: 'core', tool: true,
    summary: 'Read a text file as UTF-8; files > 2 MiB are truncated to 256 KiB on a character boundary.',
    params: ['path'], required: ['path'], schema: { path: PATH },
    output: 'ReadFileResult',
  },
  {
    name: 'image_preview', group: 'read', mutates: false, capability: 'core', tool: true,
    summary: 'Read a bounded image preview (magic-byte checked) as base64.',
    params: ['path'], required: ['path'], schema: { path: PATH },
    output: 'PreviewResult',
  },
  {
    name: 'pdf_preview', group: 'read', mutates: false, capability: 'core', tool: true,
    summary: 'Read a bounded PDF preview as base64.',
    params: ['path'], required: ['path'], schema: { path: PATH },
    output: 'PreviewResult',
  },
  {
    name: 'media_preview', group: 'read', mutates: false, capability: 'core', tool: true,
    summary: 'Read a bounded audio/video preview as base64.',
    params: ['path'], required: ['path'], schema: { path: PATH },
    output: 'PreviewResult',
  },

  // ---- search -----------------------------------------------------------
  {
    name: 'search', group: 'search', mutates: false, capability: 'core', tool: true,
    summary: 'Fuzzy filename / bounded content search under a path.',
    params: ['path', 'query', 'offset', 'limit', 'recursive', 'content', 'showHidden'],
    required: ['path', 'query'],
    schema: {
      path: PATH, query: S('Search query.'),
      offset: N('Result offset.'), limit: N('Result limit, 1..2000.', { minimum: 1, maximum: 2000 }),
      recursive: B('Recurse into subdirectories (depth <= 8).'),
      content: B('Also match file contents (text <= 2 MiB).'),
      showHidden: B('Include dotfiles.'),
    },
    output: 'SearchResult',
  },
  {
    name: 'locate', group: 'search', mutates: false, capability: 'core', tool: true,
    summary: 'Fuzzy locate across the configured roots (bounded depth and result count).',
    params: ['path', 'query', 'offset', 'limit', 'recursive', 'content', 'showHidden'],
    required: ['query'],
    schema: {
      path: S('Optional root override.'), query: S('Search query.'),
      offset: N('Result offset.'), limit: N('Result limit, 1..2000.', { minimum: 1, maximum: 2000 }),
      recursive: B('Recurse into subdirectories.'), content: B('Also match contents.'),
      showHidden: B('Include dotfiles.'),
    },
    output: 'SearchResult',
  },

  // ---- archive ----------------------------------------------------------
  {
    name: 'archive_list', group: 'archive', mutates: false, capability: 'os', tool: true,
    summary: 'List archive members without extracting (path-escape members rejected).',
    params: ['path'], required: ['path'], schema: { path: PATH },
    output: '{ entries: ArchiveEntry[], truncated? }',
  },
  {
    name: 'create_zip', group: 'archive', mutates: true, capability: 'os', tool: true,
    summary: 'Create a zip from 1..200 paths.',
    params: ['paths', 'dest', 'name'], required: ['paths', 'dest', 'name'],
    schema: { paths: PATHS, dest: S('Destination directory.'), name: NAME },
    output: '{ path, count }',
  },
  {
    name: 'extract_archive', group: 'archive', mutates: true, capability: 'os', tool: true,
    summary: 'Extract an archive without overwriting existing files; symlink members rejected.',
    params: ['path', 'dest'], required: ['path', 'dest'],
    schema: { path: PATH, dest: DEST },
    output: '{ path, count }',
  },

  // ---- write ------------------------------------------------------------
  {
    name: 'create_folder', group: 'write', mutates: true, capability: 'core', tool: true,
    summary: 'Create a folder inside parent.',
    params: ['parent', 'name'], required: ['parent', 'name'],
    schema: { parent: PARENT, name: NAME }, output: '{ ok: true }',
  },
  {
    name: 'create_file', group: 'write', mutates: true, capability: 'core', tool: true,
    summary: 'Create an empty file inside parent.',
    params: ['parent', 'name'], required: ['parent', 'name'],
    schema: { parent: PARENT, name: NAME }, output: '{ ok: true }',
  },
  {
    name: 'write_file', group: 'write', mutates: true, capability: 'core', tool: true,
    summary: 'Atomically write base64 data; expectedMtime provides optimistic concurrency (conflict flag).',
    params: ['parent', 'name', 'data', 'expectedMtime'], required: ['parent', 'name', 'data'],
    schema: {
      parent: PARENT, name: NAME,
      data: S('Base64-encoded bytes (<= 700000 chars per import chunk; write_file bounded by maxStringParam).'),
      expectedMtime: { type: 'number', description: 'Expected previous mtime in ms; mismatch -> conflict:true.' },
    },
    output: '{ path, mtime, conflict }',
  },
  {
    name: 'rename', group: 'write', mutates: true, capability: 'core', tool: true,
    summary: 'Rename an entry within its parent directory.',
    params: ['path', 'name'], required: ['path', 'name'],
    schema: { path: PATH, name: NAME }, output: '{ path }',
  },
  {
    name: 'trash', group: 'write', mutates: true, capability: 'os', tool: true,
    summary: 'Move one entry to the OS trash (never deletes permanently).',
    params: ['path'], required: ['path'], schema: { path: PATH }, output: '{ ok: true }',
  },
  {
    name: 'copy', group: 'write', mutates: true, capability: 'core', tool: true,
    summary: 'Copy one entry; accepts from/to or source/target aliases.',
    params: ['from', 'to', 'source', 'target'], required: [],
    anyOf: [{ required: ['from', 'to'] }, { required: ['source', 'target'] }],
    schema: {
      from: S('Source path.'), to: S('Destination path.'),
      source: S('Alias of from.'), target: S('Alias of to.'),
    },
    output: '{ path }',
  },
  {
    name: 'move', group: 'write', mutates: true, capability: 'core', tool: true,
    summary: 'Move one entry (cross-volume safe); accepts from/to or source/target aliases.',
    params: ['from', 'to', 'source', 'target'], required: [],
    anyOf: [{ required: ['from', 'to'] }, { required: ['source', 'target'] }],
    schema: {
      from: S('Source path.'), to: S('Destination path.'),
      source: S('Alias of from.'), target: S('Alias of to.'),
    },
    output: '{ path }',
  },
  {
    name: 'duplicate', group: 'write', mutates: true, capability: 'core', tool: true,
    summary: 'Duplicate an entry with an auto-deduplicated name.',
    params: ['path'], required: ['path'], schema: { path: PATH }, output: '{ path }',
  },
  {
    name: 'duplicate_batch', group: 'write', mutates: true, capability: 'core', tool: true,
    summary: 'Duplicate many entries; per-entry failures are reported, not fatal.',
    params: ['paths'], required: ['paths'], schema: { paths: PATHS }, output: 'BatchResult',
  },
  {
    name: 'copy_batch', group: 'write', mutates: true, capability: 'core', tool: true,
    summary: 'Copy many entries into a destination directory.',
    params: ['paths', 'dest'], required: ['paths', 'dest'],
    schema: { paths: PATHS, dest: DEST }, output: 'BatchResult',
  },
  {
    name: 'move_batch', group: 'write', mutates: true, capability: 'core', tool: true,
    summary: 'Move many entries into a destination directory (skips no-ops and self-moves).',
    params: ['paths', 'dest'], required: ['paths', 'dest'],
    schema: { paths: PATHS, dest: DEST }, output: 'BatchResult',
  },
  {
    name: 'trash_batch', group: 'write', mutates: true, capability: 'os', tool: true,
    summary: 'Move many entries to the OS trash.',
    params: ['paths'], required: ['paths'], schema: { paths: PATHS }, output: 'BatchResult',
  },

  // ---- OS integration (injectable) --------------------------------------
  {
    name: 'copy_paths', group: 'system', mutates: false, capability: 'os', tool: false,
    summary: 'Copy file paths to the OS clipboard.',
    params: ['paths'], required: ['paths'], schema: { paths: PATHS }, output: '{ ok: true }',
  },
  {
    name: 'copy_image', group: 'system', mutates: false, capability: 'os', tool: false,
    summary: 'Copy an image to the OS clipboard.',
    params: ['path'], required: ['path'], schema: { path: PATH }, output: '{ ok: true }',
  },
  {
    name: 'open', group: 'system', mutates: false, capability: 'os', tool: false,
    summary: 'Open a path with the OS default application.',
    params: ['path'], required: ['path'], schema: { path: PATH }, output: '{ ok: true }',
  },
  {
    name: 'editor', group: 'system', mutates: false, capability: 'os', tool: false,
    summary: 'Open a path in the configured editor.',
    params: ['path'], required: ['path'], schema: { path: PATH }, output: '{ ok: true }',
  },
  {
    name: 'reveal', group: 'system', mutates: false, capability: 'os', tool: false,
    summary: 'Reveal a path in the OS file manager.',
    params: ['path'], required: ['path'], schema: { path: PATH }, output: '{ ok: true }',
  },
  {
    name: 'open_trash', group: 'system', mutates: false, capability: 'os', tool: false,
    summary: 'Open the OS trash without exposing its contents to the caller.',
    params: [], required: [], schema: {}, output: '{ ok: true }',
  },

  // ---- watch / import / cancellation ------------------------------------
  {
    name: 'watch_start', group: 'watch', mutates: false, capability: 'core', tool: false,
    summary: 'Start a bounded, debounced filesystem watch; emits fs_changed events.',
    params: ['path'], required: ['path'], schema: { path: PATH }, output: '{ ok: true }',
  },
  {
    name: 'watch_stop', group: 'watch', mutates: false, capability: 'core', tool: false,
    summary: 'Stop a filesystem watch.',
    params: ['path'], required: ['path'], schema: { path: PATH }, output: '{ ok: true }',
  },
  {
    name: 'import_probe', group: 'import', mutates: false, capability: 'core', tool: false,
    summary: 'Check whether an import target name already exists.',
    params: ['parent', 'name'], required: ['parent', 'name'],
    schema: { parent: PARENT, name: NAME }, output: '{ exists }',
  },
  {
    name: 'import_begin', group: 'import', mutates: true, capability: 'core', tool: false,
    summary: 'Begin a chunked import; conflict policy is rename (default) or skip.',
    params: ['uploadId', 'parent', 'name', 'size', 'conflict'],
    required: ['uploadId', 'parent', 'name', 'size'],
    schema: {
      uploadId: UPLOAD_ID, parent: PARENT, name: NAME,
      size: N('Total bytes (<= 2 GiB).'),
      conflict: S('Existing-target policy.', { enum: ['rename', 'skip'] }),
    },
    output: '{ uploadId, path, name, size, renamed }',
  },
  {
    name: 'import_chunk', group: 'import', mutates: true, capability: 'core', tool: false,
    summary: 'Append one base64 chunk at a contiguous offset.',
    params: ['uploadId', 'offset', 'data'], required: ['uploadId', 'data'],
    schema: {
      uploadId: UPLOAD_ID, offset: N('Byte offset; must equal bytes received.'),
      data: S('Base64 chunk (<= 700000 chars).'),
    },
    output: '{ uploadId, received, size }',
  },
  {
    name: 'import_end', group: 'import', mutates: true, capability: 'core', tool: false,
    summary: 'Atomically commit an import session.',
    params: ['uploadId'], required: ['uploadId'], schema: { uploadId: UPLOAD_ID },
    output: '{ path, size, mtime }',
  },
  {
    name: 'import_cancel', group: 'control', mutates: false, capability: 'core', tool: false,
    summary: 'Discard an import session and its temporary file.',
    params: ['uploadId'], required: ['uploadId'], schema: { uploadId: UPLOAD_ID },
    output: '{ uploadId, cancelled }',
  },
  {
    name: 'search_cancel', group: 'control', mutates: false, capability: 'core', tool: false,
    summary: 'Cancel a running search by requestId.',
    params: ['requestId'], required: ['requestId'],
    schema: { requestId: S('Request id to cancel.') }, output: '{ cancelled }',
  },
  {
    name: 'locate_cancel', group: 'control', mutates: false, capability: 'core', tool: false,
    summary: 'Cancel a running locate by requestId (compatibility: handled by the original main loop).',
    params: ['requestId'], required: ['requestId'],
    schema: { requestId: S('Request id to cancel.') }, output: '{ cancelled }',
  },
  {
    name: 'preview_cancel', group: 'control', mutates: false, capability: 'core', tool: false,
    summary: 'Cancel a running preview by requestId.',
    params: ['requestId'], required: ['requestId'],
    schema: { requestId: S('Request id to cancel.') }, output: '{ cancelled }',
  },
  {
    name: 'batch_cancel', group: 'control', mutates: false, capability: 'core', tool: false,
    summary: 'Cancel a running batch operation by requestId.',
    params: ['requestId'], required: ['requestId'],
    schema: { requestId: S('Request id to cancel.') }, output: '{ cancelled }',
  },
]);

export const METHODS = Object.freeze(COMMANDS.map((command) => command.name));
export const METHOD_SET = new Set(METHODS);
export const COMMAND_BY_NAME = new Map(COMMANDS.map((command) => [command.name, command]));
export const PARAMS_BY_METHOD = Object.freeze(
  Object.fromEntries(COMMANDS.map((command) => [command.name, [...command.params]]))
);

/** Write methods from the original extension (`files.js` writesInFlight set) + import chunks. */
export const MUTATING_METHODS = new Set(COMMANDS.filter((command) => command.mutates).map((command) => command.name));
export const OS_DEPENDENT_METHODS = new Set(
  COMMANDS.filter((command) => command.capability === 'os').map((command) => command.name)
);

export function isFileMethod(method) {
  return METHOD_SET.has(method);
}

export function getCommand(method) {
  const command = COMMAND_BY_NAME.get(method);
  if (!command) {
    throw new Error(`unknown file command: ${method}`);
  }
  return command;
}
