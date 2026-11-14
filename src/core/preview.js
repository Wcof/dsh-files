/**
 * Text reads and bounded binary previews.
 * Mirrors `file-manager-core/src/file_manager/{ops,preview}.rs` and the
 * base64 envelope produced by `native-file-host/src/dispatch.rs:114-146`.
 */

import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { FilePluginError, ErrorCode } from '../protocol/errors.js';
import { Operation } from './access-policy.js';
import { detectFileKind, mimeTypeFor, hasRecognizedHeader } from './detect.js';

export async function readTextFile(policy, rawPath, config, signal) {
  const handle = policy.authorize(rawPath, Operation.READ);
  const canon = handle.path;
  if (detectFileKind(canon) !== 'text') {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'not a text file');
  }
  const info = await fsp.stat(canon);
  if (signal?.aborted) throw new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled');
  const truncated = info.size > config.limits.maxFullRead;
  const readLength = truncated ? config.limits.maxTruncatedRead : info.size;
  const handleFd = await fsp.open(canon, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(Math.min(readLength, info.size));
    await handleFd.read(buffer, 0, buffer.length, 0);
  } finally {
    await handleFd.close();
  }
  if (signal?.aborted) throw new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled');
  let content = buffer.toString('utf8');
  if (truncated) {
    // Align to a character boundary: drop a trailing replacement character.
    content = content.replace(/\uFFFD+$/, '');
  }
  return {
    content,
    truncated,
    size: info.size,
    mtime: info.mtimeMs,
    kind: 'text',
    encoding: 'utf-8',
  };
}

/**
 * Bounded binary preview. Binary payloads are never decoded as text and the
 * header is checked so an arbitrary file cannot be served as an image/PDF.
 */
export async function readBinaryPreview(policy, rawPath, expectedKind, config) {
  const handle = policy.authorize(rawPath, Operation.PREVIEW);
  const canon = handle.path;
  const kind = detectFileKind(canon);
  const matches = expectedKind === 'media' ? kind === 'audio' || kind === 'video' : kind === expectedKind;
  if (!matches) {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'wrong preview kind');
  }
  const info = await fsp.stat(canon);
  const length = Math.min(info.size, config.limits.maxPreviewBytes);
  const fd = await fsp.open(canon, 'r');
  let buffer;
  try {
    buffer = Buffer.alloc(length);
    await fd.read(buffer, 0, buffer.length, 0);
  } finally {
    await fd.close();
  }
  if (expectedKind === 'image' || expectedKind === 'pdf') {
    if (!hasRecognizedHeader(buffer)) {
      throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'unrecognized file header');
    }
  } else if (buffer.length < 4) {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'media file is too small');
  }
  return {
    data: buffer.toString('base64'),
    mimeType: mimeTypeFor(kind, path.basename(canon)),
    size: info.size,
    mtime: info.mtimeMs,
  };
}

const PAGE_PREVIEW_KINDS = new Set(['image', 'pdf', 'audio', 'video']);
const HTML_EXTS = new Set(['.html', '.htm']);

/**
 * Open a whole-file, same-origin preview stream for the bundled file page.
 *
 * `readBinaryPreview()` is a bounded base64 tool result; it cannot render a
 * photo, PDF or video larger than `limits.maxPreviewBytes`. The page instead
 * loads media from a same-origin GET URL so the browser can request only the
 * byte ranges it needs. Authorization is identical to the preview commands.
 * SVG is excluded because it may contain script when loaded as a document;
 * the page falls back to the base64 blob for that type.
 *
 * HTML pages are served as `text/html` with a `CSP: sandbox` response header
 * (see the DSH adapter), so the document runs in an opaque origin that cannot
 * reach the same-origin file API — including on direct top-level navigation.
 */
export async function openPagePreview(policy, rawPath) {
  const handle = policy.authorize(rawPath, Operation.PREVIEW);
  const canon = handle.path;
  const kind = detectFileKind(canon);
  const ext = path.extname(canon).toLowerCase();
  if (kind === 'text' && HTML_EXTS.has(ext)) {
    const info = await statRegular(canon);
    return { size: info.size, mimeType: 'text/html; charset=utf-8', html: true, read(start, end) { return createReadStream(canon, { start, end }); } };
  }
  if (!PAGE_PREVIEW_KINDS.has(kind) || ext === '.svg') {
    throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'unsupported preview kind');
  }
  const info = await statRegular(canon);
  return {
    size: info.size,
    mimeType: mimeTypeFor(kind, path.basename(canon)),
    read(start, end) {
      return createReadStream(canon, { start, end });
    },
  };
}

async function statRegular(target) {
  const info = await fsp.stat(target);
  if (!info.isFile()) throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'not a regular file');
  return info;
}
