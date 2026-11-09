/**
 * Composition root. Nothing above this file knows how files work, and nothing
 * below it knows which agent is calling.
 *
 *   config -> AccessPolicy + SystemTools -> Backend -> FileService -> Adapter(s)
 */

import { resolveConfig, describeConfig } from './config.js';
import { AccessPolicy } from './core/access-policy.js';
import { createSystemTools } from './core/tools.js';
import { createLocalBackend } from './core/local-backend.js';
import { createNativesCoreBackend } from './core/natives-core-backend.js';
import { FileService } from './core/service.js';
import { FilePluginError, ErrorCode } from './protocol/errors.js';
import { createAdapter } from './adapters/index.js';

function assertBackendShape(backend) {
  if (!backend || typeof backend.handle !== 'function' || typeof backend.dispose !== 'function') {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'backend must implement handle() and dispose()');
  }
  return backend;
}

export function createFilePlugin(input = {}, env = process.env) {
  const config = resolveConfig(input, env);
  const policy = input.accessPolicy ?? new AccessPolicy(config);
  const systemTools = createSystemTools(config);
  let service;
  // Late-bound: watchers emit only after start(), by which time service exists.
  const emit = (type, payload) => service?.emit(type, payload);

  let backend;
  if (config.backend === 'local') {
    backend = createLocalBackend(config, { policy, systemTools, emit });
  } else if (config.backend === 'natives-core') {
    backend = createNativesCoreBackend(config);
  } else {
    backend = assertBackendShape(config.backend);
  }

  service = new FileService({
    config,
    backend,
    policy,
    systemTools,
    toolOptions: input.toolOptions ?? {},
  });

  const started = [];

  const plugin = {
    config,
    policy,
    systemTools,
    backend,
    service,

    /** Structured call (throws FilePluginError). */
    call(method, params, options) {
      return service.call(method, params, options);
    },
    /** Original AiNative wire call (never throws). */
    handle(request) {
      return service.handle(request);
    },
    tools() {
      return service.tools();
    },
    describe() {
      return { ...service.describe(), config: describeConfig(config) };
    },

    /**
     * Attach one or more agent adapters. Accepts a name ('dsh' | 'zcode' |
     * 'mcp' | 'http' | 'in-process'), a `{name, options}` descriptor, or an
     * already-built adapter object.
     */
    async attach(adapters) {
      const list = Array.isArray(adapters) ? adapters : [adapters];
      const handles = [];
      for (const entry of list) {
        const adapter =
          typeof entry === 'string'
            ? createAdapter(entry)
            : entry && typeof entry.start === 'function'
              ? entry
              : createAdapter(entry.name, entry.options ?? {});
        const handle = await adapter.start({ service, config, log: config.log });
        started.push(adapter);
        handles.push(handle);
      }
      return handles.length === 1 ? handles[0] : handles;
    },

    /** Convenience: attach everything declared in config.adapters. */
    async start() {
      if (config.adapters.length === 0) return plugin;
      await plugin.attach(config.adapters);
      return plugin;
    },

    async dispose() {
      for (const adapter of started.reverse()) await adapter.stop?.();
      started.length = 0;
      await service.dispose();
    },
  };

  return plugin;
}
