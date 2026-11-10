/**
 * Unified HostAdapter contract.
 *
 * An adapter is the ONLY piece of code that knows about a specific agent.
 * Its entire job is translation:
 *
 *   agent-specific transport  ->  service.handle({id, method, params})
 *   service tools()/events    ->  agent-specific tool list / notifications
 *
 * @typedef {object} HostAdapter
 * @property {string} name
 * @property {(ctx: {service: FileService, config: object, log: Function}) => Promise<any>} start
 * @property {() => Promise<void>} stop
 * @property {() => object} describe
 *
 * Adding a new agent = implement these 4 members and call defineAdapter().
 * No capability code, no command table, no validation may be duplicated.
 */

import { FilePluginError, ErrorCode } from '../protocol/errors.js';

const REGISTRY = new Map();

export function defineAdapter(name, factory) {
  if (typeof name !== 'string' || !name || typeof factory !== 'function') {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'adapter name and factory are required');
  }
  REGISTRY.set(name, factory);
  return factory;
}

export function validateAdapter(adapter) {
  if (!adapter || typeof adapter.name !== 'string' || typeof adapter.start !== 'function' || typeof adapter.stop !== 'function') {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'invalid host adapter');
  }
  return adapter;
}

export function createAdapter(name, options = {}) {
  const factory = REGISTRY.get(name);
  if (!factory) {
    throw new FilePluginError(
      ErrorCode.INVALID_REQUEST,
      `unknown adapter "${name}" (available: ${[...REGISTRY.keys()].join(', ')})`
    );
  }
  return validateAdapter(factory(options));
}

export function listAdapters() {
  return [...REGISTRY.keys()];
}

/** Shared NDJSON reader used by the zcode and MCP stdio adapters. */
export function readLineStream(stream, onLine, onError) {
  let buffer = '';
  const handler = (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        try {
          onLine(JSON.parse(line));
        } catch (error) {
          onError?.(error, line);
        }
      }
    }
  };
  stream.on('data', handler);
  return () => stream.off('data', handler);
}

/** Shared same-origin check for HTTP-like hosts (DSH / local HTTP). */
export function isSameOrigin(request) {
  const site = request.headers?.['sec-fetch-site'];
  if (site === 'cross-site' || site === 'cross-origin') return false;
  const origin = request.headers?.origin;
  if (!origin) return true;
  const host = request.headers?.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function jsonReply(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

export function readRequestBody(request, maxBytes = 8 * 1024 * 1024) {
  if (request.body !== undefined) {
    const body = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    if (Buffer.byteLength(body) > maxBytes) return Promise.reject(new FilePluginError(ErrorCode.INVALID_REQUEST, 'request body is too large'));
    return Promise.resolve(body);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    request.on('data', (chunk) => {
      if (failed) return;
      chunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        chunks.length = 0;
        reject(new FilePluginError(ErrorCode.INVALID_REQUEST, 'request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
    request.on('aborted', () => reject(new FilePluginError(ErrorCode.CANCELLED, 'request aborted')));
  });
}
