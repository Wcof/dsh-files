/**
 * Optional compatibility backend.
 *
 * When a host already runs the original AiNative Core, this backend forwards
 * the *unchanged* file commands to it, so behaviour is literally the original
 * Rust implementation. The plugin still does not import any AiNative module:
 * the host injects an `rpc(request)` function (or an HTTP endpoint + headers).
 *
 * Disabled by default. `backend: 'local'` is the standalone, zero-dependency
 * implementation.
 */

import { FilePluginError, ErrorCode } from '../protocol/errors.js';
import { METHOD_SET } from '../protocol/commands.js';

function defaultRpc(config) {
  const { endpoint, headers, timeoutMs } = config.backendOptions;
  return async function rpc(request, ctx) {
    if (typeof globalThis.fetch !== 'function') {
      throw new FilePluginError(ErrorCode.BACKEND_UNAVAILABLE, 'fetch is unavailable in this runtime');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(request),
        signal: ctx?.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal,
      });
      if (!response.ok) {
        throw new FilePluginError(ErrorCode.BACKEND_UNAVAILABLE, `core rpc returned ${response.status}`);
      }
      return response.json();
    } catch (error) {
      if (error instanceof FilePluginError) throw error;
      throw new FilePluginError(ErrorCode.BACKEND_UNAVAILABLE, 'core rpc failed', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * @param {object} config resolved config
 * @param {object} [deps] optional overrides for tests
 */
export function createNativesCoreBackend(config, deps = {}) {
  const rpc = config.backendOptions.rpc ?? deps.rpc ?? defaultRpc(config);
  return {
    name: 'natives-core',
    capabilities: Object.freeze({
      protocolVersion: config.protocolVersion,
      osIntegration: true,
      watch: true,
      import: true,
      write: true,
      forwardsTo: 'AiNative native-file-host',
    }),
    async init() {},
    async handle(method, params, ctx = {}) {
      if (!METHOD_SET.has(method)) {
        throw new FilePluginError(ErrorCode.UNSUPPORTED_METHOD, 'unsupported method');
      }
      const request = {
        id: ctx.requestId ?? `fwd-${Date.now().toString(36)}`,
        method,
        params,
      };
      let response;
      try {
        response = await rpc(request, ctx);
      } catch (error) {
        if (error instanceof FilePluginError) throw error;
        throw new FilePluginError(ErrorCode.BACKEND_UNAVAILABLE, 'core rpc failed', { cause: error });
      }
      if (!response || typeof response !== 'object') {
        throw new FilePluginError(ErrorCode.BACKEND_UNAVAILABLE, 'invalid core rpc response');
      }
      if (response.ok === false) {
        throw new FilePluginError(ErrorCode.INTERNAL, String(response.error ?? 'core rpc error'));
      }
      return response.result ?? {};
    },
    async dispose() {},
  };
}
