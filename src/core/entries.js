/**
 * Read side: quick-access roots, FileEntry construction, Finder-like sorting,
 * bounded pagination, stat and disk usage.
 * Mirrors `file-manager-core/src/file_manager/{system,listing,detect}.rs`.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { FilePluginError, ErrorCode } from '../protocol/errors.js';
import {
  detectFileKind,
  detectProjectBadge,
  naturalCompare,
} from './detect.js';
import { Operation } from './access-policy.js';

const HOME_ROOT_NAMES = ['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures'];

export function defaultRoots(config) {
  const home = config.homeDir;
  const platform = config.tools?.platform ?? process.platform;
  const candidates = [
    ['home', 'Home', home],
    ['desktop', 'Desktop', path.join(home, 'Desktop')],
    ['documents', 'Documents', path.join(home, 'Documents')],
    ['downloads', 'Downloads', path.join(home, 'Downloads')],
    ['pictures', 'Pictures', path.join(home, 'Pictures')],
    ['projects', 'Projects', path.join(home, 'Projects')],
    ['movies', platform === 'win32' ? 'Videos' : 'Movies', path.join(home, platform === 'win32' ? 'Videos' : 'Movies')],
    ['music', 'Music', path.join(home, 'Music')],
  ];
  const roots = [];
  for (const [id, name, candidate] of candidates) {
    // macOS TCC: never probe protected home children, show them optimistically.
    if (platform === 'darwin' && HOME_ROOT_NAMES.includes(path.basename(candidate)) || isDirectorySyncSafe(candidate)) {
      roots.push({ id, name, path: candidate });
    }
  }
  if (isDirectorySyncSafe(config.tempDir)) roots.push({ id: 'tmp', name: 'tmp', path: config.tempDir });
  return roots;
}

function isDirectorySyncSafe(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function sortEntries(entries, options = {}) {
  const ascending = options.sortDir !== 'desc';
  const key = options.sortBy ?? 'name';
  return entries.sort((a, b) => {
    // Finder-like folder grouping is invariant under the selected key.
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp = 0;
    if (key === 'mtime') cmp = a.mtime - b.mtime;
    else if (key === 'size') cmp = a.size - b.size;
    else if (key === 'kind') cmp = naturalCompare(a.kind, b.kind);
    else cmp = naturalCompare(a.name, b.name);
    if (!ascending) cmp = -cmp;
    return cmp === 0 ? naturalCompare(a.name, b.name) : cmp;
  });
}

async function buildEntry(dir, dirent, options) {
  const full = path.join(dir, dirent.name);
  let meta;
  try {
    meta = await fsp.lstat(full);
  } catch {
    return null;
  }
  const isLink = meta.isSymbolicLink();
  let effective = meta;
  let symlink;
  if (isLink) {
    symlink = await fsp.readlink(full).catch(() => undefined);
    effective = await fsp.stat(full).catch(() => meta);
  }
  const isDir = effective.isDirectory();
  const entry = {
    name: dirent.name,
    path: full,
    isDir,
    kind: isDir ? 'dir' : detectFileKind(dirent.name),
    hidden: dirent.name.startsWith('.'),
    size: isDir ? 4096 : effective.size,
    mtime: effective.mtimeMs ?? 0,
    btime: effective.birthtimeMs ?? 0,
  };
  if (symlink !== undefined) entry.symlink = symlink;
  if (options.probeProjects && isDir && !entry.hidden) {
    try {
      const inner = await fsp.readdir(full, { withFileTypes: true });
      const badge = detectProjectBadge(inner.map((item) => item.name));
      if (badge) entry.projectBadge = badge;
    } catch {
      /* TCC / permission: badge is best-effort */
    }
  }
  return entry;
}

export async function listDir(policy, rawPath, params, config) {
  const handle = policy.authorize(rawPath, Operation.READ);
  const canon = handle.path;
  const info = await fsp.stat(canon).catch(() => {
    throw new FilePluginError(ErrorCode.NOT_FOUND, 'directory not found');
  });
  if (!info.isDirectory()) {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'not a directory');
  }
  const offset = params.offset ?? 0;
  const limit = Math.min(params.limit ?? config.limits.defaultListLimit, config.limits.maxListLimit);
  const showHidden = params.showHidden ?? false;
  const probeProjects = params.probeProjects ?? false;
  const dirents = await fsp.readdir(canon, { withFileTypes: true });
  const visible = dirents.filter(
    (item) => item.name !== '.DS_Store' && (showHidden || !item.name.startsWith('.'))
  );
  // Cap 80 shallow probes exactly like list_dir_detailed.
  const probeBudget = probeProjects && visible.length <= 80 ? visible.length : 0;
  let probed = 0;
  const entries = [];
  for (const dirent of visible) {
    const allowProbe = probeBudget > 0 && probed < 80;
    if (allowProbe) probed += 1;
    const entry = await buildEntry(canon, dirent, { probeProjects: allowProbe });
    if (entry) entries.push(entry);
  }
  sortEntries(entries, params);
  const cap = Math.min(offset + limit + 1, config.limits.defaultPageWindow);
  const hasMore = entries.length > offset + limit;
  return {
    path: canon,
    parent: path.dirname(canon),
    entries: entries.slice(offset, Math.min(offset + limit, cap)),
    project: detectProjectBadge(visible.map((item) => item.name)) ?? undefined,
    hasMore,
  };
}

export async function statPath(policy, rawPath) {
  const handle = policy.authorize(rawPath, Operation.READ);
  const canon = handle.path;
  let meta;
  try {
    meta = await fsp.lstat(canon);
  } catch {
    return { found: false, path: canon };
  }
  const isLink = meta.isSymbolicLink();
  let effective = meta;
  let symlink;
  if (isLink) {
    symlink = await fsp.readlink(canon).catch(() => undefined);
    effective = await fsp.stat(canon).catch(() => meta);
  }
  const isDir = effective.isDirectory();
  const result = {
    found: true,
    path: canon,
    name: path.basename(canon),
    isDir,
    kind: isDir ? 'dir' : detectFileKind(canon),
    size: isDir ? 4096 : effective.size,
    mtime: effective.mtimeMs ?? 0,
    btime: effective.birthtimeMs ?? 0,
    dirHint: path.dirname(canon),
  };
  if (symlink !== undefined) result.symlink = symlink;
  return result;
}

/** Bounded recursive usage scan; symlinks are counted, never followed. */
export async function diskUsage(policy, rawPath, config, signal) {
  const handle = policy.authorize(rawPath, Operation.READ);
  const root = handle.path;
  const limit = config.limits.maxDiskUsageEntries;
  const result = {
    path: root, bytes: 0, files: 0, directories: 0, truncated: false, errors: 0, items: [],
  };
  let visited = 0;

  async function sizeOf(target, depth) {
    if (signal?.aborted || visited >= limit) {
      result.truncated = true;
      return 0;
    }
    visited += 1;
    let meta;
    try {
      meta = await fsp.lstat(target);
    } catch {
      result.errors += 1;
      return 0;
    }
    if (meta.isSymbolicLink()) return 0;
    if (!meta.isDirectory()) {
      result.files += 1;
      result.bytes += meta.size;
      return meta.size;
    }
    result.directories += 1;
    let children;
    try {
      children = await fsp.readdir(target, { withFileTypes: true });
    } catch {
      result.errors += 1;
      return 4096;
    }
    let total = 4096;
    for (const child of children) {
      if (signal?.aborted || visited >= limit) {
        result.truncated = true;
        break;
      }
      total += await sizeOf(path.join(target, child.name), depth + 1);
    }
    return total;
  }

  const top = await fsp.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const child of top) {
    if (signal?.aborted || visited >= limit) {
      result.truncated = true;
      break;
    }
    const childPath = path.join(root, child.name);
    let meta;
    try {
      meta = await fsp.lstat(childPath);
    } catch {
      result.errors += 1;
      continue;
    }
    const isDir = meta.isDirectory() && !meta.isSymbolicLink();
    const size = await sizeOf(childPath, 1);
    result.items.push({ name: child.name, size, isDir });
  }
  result.items.sort((a, b) => b.size - a.size);
  return result;
}
