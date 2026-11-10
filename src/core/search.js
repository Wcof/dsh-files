/**
 * Fuzzy filename / bounded content search.
 * Mirrors `native-file-host/src/search.rs` (depth 8, 100k results, 4s budget,
 * 2 MiB text / 20 MiB PDF content reads) without importing Natives modules.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { Operation } from './access-policy.js';
import { detectFileKind, naturalCompare } from './detect.js';
import { defaultRoots } from './entries.js';
import { FilePluginError, ErrorCode } from '../protocol/errors.js';

export function fuzzyNameScore(name, query) {
  const haystack = name.toLowerCase();
  const needle = query.toLowerCase().trim();
  if (!needle) return 1;
  const index = haystack.indexOf(needle);
  if (index >= 0) return Math.max(1, 100 - index * 2 - (haystack.length - needle.length));
  // Subsequence fallback keeps "df" matching "draft-file".
  let cursor = 0;
  let score = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, cursor);
    if (found < 0) return 0;
    score += Math.max(1, 10 - (found - cursor));
    cursor = found + 1;
  }
  return score;
}

async function contentMatches(full, kind, query, config, systemTools) {
  const info = await fsp.stat(full).catch(() => null);
  if (!info || !info.isFile()) return null;
  const lower = query.toLowerCase();
  if (kind === 'text' && info.size <= config.limits.maxFullRead) {
    const text = await fsp.readFile(full, 'utf8');
    const lines = text.split('\n');
    const matched = lines.filter((line) => line.toLowerCase().includes(lower)).slice(0, 20);
    return { matchCount: matched.length, matchLines: matched };
  }
  if (kind === 'pdf' && info.size <= 20 * 1024 * 1024 && systemTools?.pdfText) {
    const text = await systemTools.pdfText(full);
    const hits = text.split('\n').filter((line) => line.toLowerCase().includes(lower));
    return { matchCount: hits.length, matchLines: hits.slice(0, 20) };
  }
  return null;
}

export async function runSearch(policy, params, config, ctx, helpers = {}) {
  const { systemTools, locate = false } = helpers;
  const query = params.query ?? '';
  if (!query) throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'query is required');
  const started = Date.now();
  const maxResults = config.limits.maxSearchResults;
  const maxDuration = config.limits.maxSearchDurationMs;
  const maxDepth = params.recursive === false ? 1 : config.limits.maxSearchDepth;
  const offset = params.offset ?? 0;
  const limit = Math.min(params.limit ?? 100, config.limits.maxListLimit);
  const showHidden = params.showHidden ?? false;
  const wantContent = params.content === true;

  let searchRoots;
  if (params.path) {
    searchRoots = [policy.authorize(params.path, Operation.SEARCH).path];
  } else if (locate) {
    searchRoots = defaultRoots(config).map((root) => policy.authorize(root.path, Operation.SEARCH).path);
  } else {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'path is required');
  }

  const found = [];
  let truncated = false;
  let contentUnavailable = false;
  let visited = 0;

  // Optional host-provided accelerator (e.g. macOS mdfind). It is pure
  // optimisation: missing, disabled or failing hooks fall back to the built-in
  // bounded traversal below, and every returned path still passes the policy.
  if (locate && !params.path && !wantContent && params.recursive !== false && typeof systemTools?.locate === 'function') {
    let candidates = null;
    try {
      candidates = await systemTools.locate(query);
    } catch {
      candidates = null;
    }
    if (Array.isArray(candidates) && candidates.length > 0) {
      for (const raw of candidates) {
        if (ctx.signal?.aborted) throw new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled');
        if (found.length >= maxResults) {
          truncated = true;
          break;
        }
        try {
          const full = policy.authorize(raw, Operation.READ).path;
          if (!showHidden && full.split(path.sep).some((part) => part.startsWith('.'))) continue;
          const meta = await fsp.lstat(full);
          const isDir = meta.isDirectory() && !meta.isSymbolicLink();
          found.push({
            name: path.basename(full),
            path: full,
            isDir,
            kind: isDir ? 'dir' : detectFileKind(full),
            hidden: path.basename(full).startsWith('.'),
            size: isDir ? 4096 : meta.size,
            mtime: meta.mtimeMs ?? 0,
            btime: meta.birthtimeMs ?? 0,
            dirHint: path.dirname(full),
            match: path.basename(full),
            matchCount: 1,
            matchLines: [],
            searchScore: fuzzyNameScore(path.basename(full), query),
          });
        } catch {
          /* unauthorized, vanished or unreadable: skip */
        }
      }
      found.sort((a, b) => (b.searchScore ?? 0) - (a.searchScore ?? 0) || naturalCompare(a.name, b.name));
      return {
        entries: found.slice(offset, offset + limit),
        hasMore: offset + limit < found.length,
        truncated,
        contentUnavailable: false,
      };
    }
  }

  const queue = searchRoots.map((root) => ({ dir: root, depth: 0 }));
  while (queue.length > 0) {
    if (ctx.signal?.aborted) throw new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled');
    if (Date.now() - started > maxDuration || found.length >= maxResults || visited >= maxResults * 4) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift();
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      if (ctx.signal?.aborted) throw new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled');
      if (found.length >= maxResults || visited >= maxResults * 4 || Date.now() - started > maxDuration) {
        truncated = true;
        break;
      }
      if (dirent.name === '.DS_Store' || (!showHidden && dirent.name.startsWith('.'))) continue;
      visited += 1;
      const full = path.join(dir, dirent.name);
      let meta;
      try {
        policy.authorize(full, Operation.READ);
        meta = await fsp.lstat(full);
      } catch {
        continue;
      }
      const isDir = meta.isDirectory() && !meta.isSymbolicLink();
      const kind = isDir ? 'dir' : detectFileKind(dirent.name);
      const score = fuzzyNameScore(dirent.name, query);
      let contentHit;
      if (!isDir && wantContent && score === 0) {
        try {
          contentHit = await contentMatches(full, kind, query, config, systemTools);
        } catch {
          contentUnavailable = true;
        }
      }
      if (score > 0 || (contentHit && contentHit.matchCount > 0)) {
        // Results must not escape the sandbox via a symlinked directory.
        let authorized = true;
        try {
          policy.authorize(full, Operation.READ);
        } catch {
          authorized = false;
        }
        if (authorized) {
          found.push({
            name: dirent.name,
            path: full,
            isDir,
            kind,
            hidden: dirent.name.startsWith('.'),
            size: isDir ? 4096 : meta.size,
            mtime: meta.mtimeMs ?? 0,
            btime: meta.birthtimeMs ?? 0,
            dirHint: dir,
            match: dirent.name,
            matchCount: contentHit?.matchCount ?? (score > 0 ? 1 : 0),
            matchLines: contentHit?.matchLines ?? [],
            searchScore: score,
          });
        }
      }
      if (isDir && depth + 1 < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }

  found.sort(
    (a, b) => (b.searchScore ?? 0) - (a.searchScore ?? 0) || naturalCompare(a.name, b.name)
  );
  const page = found.slice(offset, offset + limit);
  return {
    entries: page,
    hasMore: offset + limit < found.length,
    truncated,
    contentUnavailable,
  };
}
