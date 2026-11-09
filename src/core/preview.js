/**
 * Text reads and bounded binary previews.
 * Mirrors `file-manager-core/src/file_manager/{ops,preview}.rs` and the
 * base64 envelope produced by `native-file-host/src/dispatch.rs:114-146`.
 */

import fsp from 'node:fs/promises';
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
