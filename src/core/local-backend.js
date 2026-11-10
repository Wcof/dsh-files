/**
 * Default, dependency-free capability backend.
 *
 * This object is the complete "file ability" of the plugin. It knows nothing
 * about DSH, zcode, AiNative, ports, sessions or products: it only receives
 * (method, params, context) and returns a JSON value. Swap it for any object
 * with the same 3-method shape via `config.backend`.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { FilePluginError, ErrorCode } from '../protocol/errors.js';
import { Operation } from './access-policy.js';
import { defaultRoots, listDir, statPath, diskUsage } from './entries.js';
import { readTextFile, readBinaryPreview } from './preview.js';
import { runSearch } from './search.js';
import { watchDirectory } from './watch.js';
import {
  writeFileAtomic, createEntry, renameEntry, copyEntry,
  moveEntry, duplicateEntry, runBatch, ImportManager, resolveTarget,
} from './ops.js';

export function createLocalBackend(config, { policy, systemTools, emit }) {
  const imports = new ImportManager({ config, policy });
  const watchers = new Map();
  const writes = new Map();

  async function write(params, signal) {
    const target = resolveTarget(policy, params.parent, params.name);
    const previous = writes.get(target) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => {
      if (signal?.aborted) throw new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled');
      return writeFileAtomic(policy, params, config);
    });
    writes.set(target, pending);
    try { return await pending; }
    finally { if (writes.get(target) === pending) writes.delete(target); }
  }

  function watch(target, ctx) {
    for (const [key, watcher] of watchers) if (watcher.closed) watchers.delete(key);
    if (watchers.has(target)) {
      watchers.get(target).owners.add(ctx.owner);
      return { ok: true };
    }
    if (watchers.size >= config.limits.maxWatchers) throw new FilePluginError(ErrorCode.TOO_MANY_TASKS, 'too many filesystem watches');
    const watcher = watchDirectory(target, config, emit);
    watcher.owners = new Set([ctx.owner]);
    watchers.set(target, watcher);
    return { ok: true };
  }

  function stopWatch(target, owner) {
    const watcher = watchers.get(target);
    if (!watcher) return { ok: true };
    watcher.owners.delete(owner);
    if (watcher.owners.size) return { ok: true };
    watcher.close();
    watchers.delete(target);
    return { ok: true };
  }

  async function osCall(hook, ...args) {
    // The guard lives in createSystemTools so injected handlers still work
    // when system commands are disabled.
    return systemTools[hook](...args);
  }

  async function authorizeArchiveSources(sources, signal) {
    const queue = [...sources];
    let count = 0;
    while (queue.length) {
      if (signal?.aborted) throw new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled');
      if (++count > config.limits.maxDiskUsageEntries) throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'archive input is too large');
      const target = queue.pop();
      policy.authorize(target, Operation.READ);
      const info = await fsp.lstat(target);
      if (info.isSymbolicLink()) throw new FilePluginError(ErrorCode.PATH_DENIED, 'archive input contains a symlink');
      if (info.isDirectory()) {
        for (const child of await fsp.readdir(target)) queue.push(path.join(target, child));
      }
    }
  }

  async function handle(method, params, ctx = {}) {
    const signal = ctx.signal;
    switch (method) {
      case 'version':
        return {
          protocolVersion: config.protocolVersion,
          hostVersion: config.pluginVersion,
          pluginVersion: config.pluginVersion,
          backend: 'local',
        };
      case 'roots':
        return defaultRoots(config);
      case 'list_dir':
        return listDir(policy, params.path, params, config);
      case 'stat':
        return statPath(policy, params.path);
      case 'disk_usage':
        return diskUsage(policy, params.path, config, signal);
      case 'read_file':
        return readTextFile(policy, params.path, config, signal);
      case 'image_preview':
        return readBinaryPreview(policy, params.path, 'image', config);
      case 'pdf_preview':
        return readBinaryPreview(policy, params.path, 'pdf', config);
      case 'media_preview':
        return readBinaryPreview(policy, params.path, 'media', config);
      case 'search':
        return runSearch(policy, params, config, ctx, { systemTools });
      case 'locate':
        return runSearch(policy, params, config, ctx, { systemTools, locate: true });

      case 'archive_list': {
        const target = policy.authorize(params.path, Operation.READ).path;
        return osCall('archiveList', target, signal);
      }
      case 'create_zip': {
        if (!policy.validName(params.name)) {
          throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'invalid archive name');
        }
        const dest = policy.authorize(params.dest, Operation.WRITE).path;
        const sources = params.paths.map((raw) => policy.authorize(raw, Operation.READ).path);
        await authorizeArchiveSources(sources, signal);
        return osCall('createZip', sources, dest, params.name, signal);
      }
      case 'extract_archive': {
        const source = policy.authorize(params.path, Operation.READ).path;
        const dest = policy.authorize(params.dest, Operation.WRITE).path;
        return osCall('extractArchive', source, dest, (member) => policy.authorize(path.join(dest, member), Operation.WRITE), signal);
      }

      case 'create_folder':
        return createEntry(policy, params.parent, params.name, 'folder');
      case 'create_file':
        return createEntry(policy, params.parent, params.name, 'file');
      case 'write_file':
        return write(params, signal);
      case 'rename':
        return renameEntry(policy, params.path, params.name);
      case 'copy':
        return copyEntry(
          policy,
          params.from ?? params.source,
          params.to ?? params.target,
          { signal }
        );
      case 'move':
        return moveEntry(
          policy,
          params.from ?? params.source,
          params.to ?? params.target,
          { signal }
        );
      case 'duplicate':
        return duplicateEntry(policy, params.path, { signal });
      case 'copy_batch':
      case 'move_batch':
      case 'duplicate_batch':
      case 'trash_batch':
        return runBatch(policy, params, config, ctx, method, systemTools);
      case 'trash': {
        const target = policy.authorize(params.path, Operation.WRITE).path;
        await osCall('trash', [target]);
        return { ok: true };
      }

      case 'open':
      case 'editor':
      case 'reveal': {
        const target = policy.authorize(params.path, Operation.REVEAL).path;
        const mode = method === 'reveal' ? 'reveal' : method === 'editor' ? 'editor' : 'default';
        return osCall('open', target, mode);
      }
      case 'open_trash':
        return osCall('openTrash');
      case 'copy_paths': {
        for (const raw of params.paths) policy.authorize(raw, Operation.READ);
        return osCall('clipboardCopyFiles', params.paths);
      }
      case 'copy_image': {
        const target = policy.authorize(params.path, Operation.READ).path;
        return osCall('clipboardCopyImage', target);
      }

      case 'watch_start': {
        const target = policy.authorize(params.path, Operation.READ).path;
        return watch(target, ctx);
      }
      case 'watch_stop': {
        const target = policy.authorize(params.path, Operation.READ).path;
        return stopWatch(target, ctx.owner);
      }

      case 'import_probe':
        return imports.probe(params);
      case 'import_begin':
        return imports.begin(params);
      case 'import_chunk':
        return imports.chunk(params);
      case 'import_end':
        return imports.end(params);
      case 'import_cancel':
        return imports.cancel(params);

      case 'search_cancel':
      case 'locate_cancel':
      case 'preview_cancel':
      case 'batch_cancel':
        // Cancellation is owned by FileService; reaching here means no task matched.
        return { cancelled: false };

      default:
        throw new FilePluginError(ErrorCode.UNSUPPORTED_METHOD, 'unsupported method');
    }
  }

  return {
    name: 'local',
    capabilities: Object.freeze({
      protocolVersion: config.protocolVersion,
      osIntegration: config.security.allowSystemCommands,
      watch: true,
      import: true,
      write: config.security.allowWrite,
    }),
    async init() {
      await imports.init();
      await fsp.mkdir(config.stateDir, { recursive: true });
    },
    handle,
    async dispose() {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      await imports.dispose();
    },
  };
}
