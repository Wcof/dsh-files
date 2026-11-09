/**
 * Write side: atomic writes, CRUD, deduplication, batch operations and
 * chunked imports. Mirrors `file-manager-core/src/file_manager/{ops,trash,import}.rs`
 * and `native-file-host/src/{dispatch,import}.rs`.
 *
 * Every target path is authorized for WRITE before it is touched, including
 * batch entries and import destinations.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { FilePluginError, ErrorCode } from '../protocol/errors.js';
import { Operation } from './access-policy.js';

function rejectName(policy, name) {
  if (!policy.validName(name)) {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'invalid name');
  }
}

export function resolveTarget(policy, parent, name, operation = Operation.WRITE) {
  rejectName(policy, name);
  const parentHandle = policy.authorize(parent, operation);
  const target = path.join(parentHandle.path, name);
  return policy.authorize(target, operation).path;
}

export async function deduplicatePath(target) {
  if (!fs.existsSync(target)) return target;
  const dir = path.dirname(target);
  const ext = path.extname(target);
  const base = path.basename(target, ext);
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = path.join(dir, `${base} (${suffix})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new FilePluginError(ErrorCode.CONFLICT, 'could not deduplicate target name');
}

/** tmp -> fsync -> rename, with optimistic concurrency via expectedMtime. */
export async function writeFileAtomic(policy, params, config) {
  const target = resolveTarget(policy, params.parent, params.name);
  let data;
  try {
    data = Buffer.from(params.data, 'base64');
  } catch {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'invalid base64 data');
  }
  if (data.length > config.limits.maxStringParam) {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'payload is too large');
  }
  if (params.expectedMtime !== undefined) {
    const current = await fsp.stat(target).catch(() => null);
    if (current && Math.abs(current.mtimeMs - params.expectedMtime) > 1) {
      return { path: target, mtime: current.mtimeMs, conflict: true };
    }
  }
  const temporary = path.join(
    path.dirname(target),
    `.dsh-files-write-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  const fd = await fsp.open(temporary, 'wx', 0o600);
  try {
    await fd.writeFile(data);
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    await fsp.rename(temporary, target);
  } catch (error) {
    await fsp.unlink(temporary).catch(() => {});
    throw error;
  }
  const info = await fsp.stat(target);
  return { path: target, mtime: info.mtimeMs, conflict: false };
}

export async function createEntry(policy, parent, name, kind) {
  const target = resolveTarget(policy, parent, name);
  if (kind === 'folder') await fsp.mkdir(target, { recursive: false });
  else await fsp.writeFile(target, '', { flag: 'wx' });
  return { ok: true };
}

export async function renameEntry(policy, rawPath, name) {
  rejectName(policy, name);
  const source = policy.authorize(rawPath, Operation.WRITE).path;
  const target = policy.authorize(path.join(path.dirname(source), name), Operation.WRITE).path;
  if (source === target) return { path: source };
  await fsp.rename(source, target);
  return { path: target };
}

export async function copyRecursive(source, destination, signal) {
  const info = await fsp.lstat(source);
  if (signal?.aborted) throw new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled');
  if (info.isSymbolicLink()) {
    const link = await fsp.readlink(source);
    await fsp.symlink(link, destination);
    return;
  }
  if (!info.isDirectory()) {
    await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    return;
  }
  if (destination === source || destination.startsWith(source + path.sep)) {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'cannot copy a folder into itself');
  }
  await fsp.mkdir(destination, { recursive: false });
  const children = await fsp.readdir(source, { withFileTypes: true });
  for (const child of children) {
    await copyRecursive(path.join(source, child.name), path.join(destination, child.name), signal);
  }
}

async function removeRecursive(target) {
  await fsp.rm(target, { recursive: true, force: true });
}

export async function copyEntry(policy, from, to, { dedupe = true, signal } = {}) {
  const source = policy.authorize(from, Operation.READ).path;
  const rawTarget = to.startsWith('/') || to.startsWith('~') ? to : path.join(path.dirname(source), to);
  let target = policy.authorize(rawTarget, Operation.WRITE).path;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = policy.authorize(path.join(target, path.basename(source)), Operation.WRITE).path;
  }
  if (dedupe) target = await deduplicatePath(target);
  await copyRecursive(source, target, signal);
  return { path: target };
}

export async function moveEntry(policy, from, to, { signal } = {}) {
  const source = policy.authorize(from, Operation.WRITE).path;
  let target = policy.authorize(to, Operation.WRITE).path;
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    target = policy.authorize(path.join(target, path.basename(source)), Operation.WRITE).path;
  }
  if (target === source) return { path: source };
  if (target.startsWith(source + path.sep)) {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'cannot move a folder into itself');
  }
  target = await deduplicatePath(target);
  try {
    await fsp.rename(source, target);
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error;
    await copyRecursive(source, target, signal);
    await removeRecursive(source);
  }
  return { path: target };
}

export async function duplicateEntry(policy, rawPath, { signal } = {}) {
  const source = policy.authorize(rawPath, Operation.WRITE).path;
  const target = await deduplicatePath(source);
  await copyRecursive(source, target, signal);
  return { path: target };
}

/** Batch operations report per-entry failures instead of aborting the batch. */
export async function runBatch(policy, params, config, ctx, kind, systemTools) {
  const paths = params.paths;
  const dest = params.dest ? policy.authorize(params.dest, Operation.WRITE).path : undefined;
  if (dest) await fsp.mkdir(dest, { recursive: true });
  const ok = [];
  const skipped = [];
  const errors = [];
  let cancelled = false;
  for (const raw of paths) {
    if (ctx.signal?.aborted) {
      cancelled = true;
      break;
    }
    try {
      if (kind === 'trash_batch') {
        const source = policy.authorize(raw, Operation.WRITE).path;
        await systemTools.trash([source]);
        ok.push(source);
      } else if (kind === 'duplicate_batch') {
        ok.push((await duplicateEntry(policy, raw, { signal: ctx.signal })).path);
      } else if (kind === 'copy_batch') {
        ok.push((await copyEntry(policy, raw, dest, { signal: ctx.signal })).path);
      } else if (kind === 'move_batch') {
        const source = policy.authorize(raw, Operation.WRITE).path;
        if (path.dirname(source) === dest) {
          skipped.push(raw);
          continue;
        }
        ok.push((await moveEntry(policy, raw, dest, { signal: ctx.signal })).path);
      }
    } catch (error) {
      errors.push({ path: raw, error: String(error?.message ?? error) });
    }
    ctx.progress?.({ event: 'batch_progress', phase: kind, completed: ok.length + errors.length, total: paths.length, cancelled });
  }
  const key = {
    trash_batch: 'trashed', duplicate_batch: 'duplicated', copy_batch: 'copied', move_batch: 'moved',
  }[kind];
  return {
    ok: errors.length === 0 && !cancelled,
    [key]: ok,
    skipped,
    errors,
    count: ok.length,
    cancelled,
  };
}

/**
 * Chunked import sessions. Temp files live under the plugin state dir, are
 * written at contiguous offsets, and are atomically committed with hard_link
 * (same behaviour as `ImportWriter::finish`).
 */
export class ImportManager {
  constructor({ config, policy }) {
    this.config = config;
    this.policy = policy;
    this.sessions = new Map();
    this.dir = path.join(config.stateDir, 'imports');
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  probe(params) {
    const target = resolveTarget(this.policy, params.parent, params.name);
    return { exists: fs.existsSync(target) };
  }

  async begin(params) {
    const uploadId = params.uploadId || `up-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    if (this.sessions.has(uploadId)) {
      throw new FilePluginError(ErrorCode.CONFLICT, 'uploadId already in use');
    }
    if (this.sessions.size >= this.config.limits.maxConcurrentImports) {
      throw new FilePluginError(ErrorCode.TOO_MANY_TASKS, 'too many concurrent imports');
    }
    if (params.size > this.config.limits.maxImportBytes) {
      throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'import is too large');
    }
    let target = resolveTarget(this.policy, params.parent, params.name);
    const exists = fs.existsSync(target);
    let renamed = false;
    if (exists && params.conflict === 'skip') {
      return { uploadId, path: target, name: path.basename(target), size: params.size, renamed, skipped: true };
    }
    if (exists) {
      target = await deduplicatePath(target);
      renamed = true;
    }
    const temporary = path.join(this.dir, `.dsh-files-import-${uploadId}`);
    await fsp.writeFile(temporary, '', { flag: 'wx' });
    this.sessions.set(uploadId, {
      uploadId, target, temporary, size: params.size, received: 0, fd: null,
    });
    return {
      uploadId,
      path: target,
      name: path.basename(target),
      size: params.size,
      renamed,
    };
  }

  async chunk(params) {
    const session = this.sessions.get(params.uploadId);
    if (!session) throw new FilePluginError(ErrorCode.NOT_FOUND, 'unknown uploadId');
    const offset = params.offset ?? session.received;
    if (offset !== session.received) {
      throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'non-contiguous chunk offset');
    }
    const buffer = Buffer.from(params.data, 'base64');
    if (session.received + buffer.length > session.size) {
      throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'import exceeds declared size');
    }
    const fd = session.fd ?? (await fsp.open(session.temporary, 'r+'));
    session.fd = fd;
    await fd.write(buffer, 0, buffer.length, offset);
    session.received += buffer.length;
    return { uploadId: params.uploadId, received: session.received, size: session.size };
  }

  async end(params) {
    const session = this.sessions.get(params.uploadId);
    if (!session) throw new FilePluginError(ErrorCode.NOT_FOUND, 'unknown uploadId');
    if (session.fd) {
      await session.fd.sync();
      await session.fd.close();
      session.fd = null;
    }
    if (session.received !== session.size) {
      throw new FilePluginError(ErrorCode.CONFLICT, 'import is incomplete');
    }
    let target = session.target;
    if (fs.existsSync(target)) target = await deduplicatePath(target);
    try {
      await fsp.link(session.temporary, target);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      target = await deduplicatePath(target);
      await fsp.link(session.temporary, target);
    }
    await fsp.unlink(session.temporary).catch(() => {});
    this.sessions.delete(params.uploadId);
    const info = await fsp.stat(target);
    return { path: target, size: info.size, mtime: info.mtimeMs };
  }

  async cancel(params) {
    const session = this.sessions.get(params.uploadId);
    if (!session) return { uploadId: params.uploadId, cancelled: false };
    if (session.fd) await session.fd.close().catch(() => {});
    await fsp.unlink(session.temporary).catch(() => {});
    this.sessions.delete(params.uploadId);
    return { uploadId: params.uploadId, cancelled: true };
  }

  async dispose() {
    for (const uploadId of [...this.sessions.keys()]) await this.cancel({ uploadId });
  }
}
