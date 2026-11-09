/**
 * FileService — the host-independent composition root of the capability.
 *
 * Responsibilities: validate, enforce write/capability policy, own cancellation
 * tokens and concurrency, dispatch to the backend, emit events, and translate
 * errors back into the original AiNative wire shape. It has no knowledge of
 * any agent, transport or product.
 */

import { validateRequest, describeProtocol } from '../protocol/validate.js';
import { MUTATING_METHODS } from '../protocol/commands.js';
import { asFilePluginError, FilePluginError, ErrorCode, safeMessage } from '../protocol/errors.js';
import { buildToolDefinitions } from '../tool-definitions.js';

const CANCEL_METHODS = new Set([
  'search_cancel', 'locate_cancel', 'preview_cancel', 'batch_cancel',
]);

export class FileService {
  constructor({ config, backend, policy, systemTools, toolOptions = {} }) {
    this.config = config;
    this.backend = backend;
    this.policy = policy;
    this.systemTools = systemTools;
    this.toolOptions = toolOptions;
    this.tasks = new Map();
    this.listeners = new Map();
    this.disposed = false;
  }

  on(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
    return () => this.off(type, listener);
  }

  off(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, payload) {
    for (const listener of this.listeners.get(type) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        this.config.log?.('event listener failed', type, error);
      }
    }
    const hookName = {
      fs_changed: 'onFsChanged',
      progress: 'onProgress',
      error: 'onError',
      changed: 'onChanged',
    }[type];
    const hook = hookName ? this.config.events?.[hookName] : undefined;
    if (typeof hook === 'function') {
      try {
        hook(payload);
      } catch (error) {
        this.config.log?.('config event hook failed', type, error);
      }
    }
    // Generic bus for adapters that forward every event.
    for (const listener of this.listeners.get('*') ?? []) listener({ type, payload });
  }

  /** Structured API: throws FilePluginError. Used by in-process and tool calls. */
  async call(method, params = {}, options = {}) {
    if (this.disposed) throw new FilePluginError(ErrorCode.BACKEND_UNAVAILABLE, 'service is disposed');
    const request = { id: options.requestId ?? `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, method, params };
    const { id, method: name, params: validated, command } = validateRequest(request, this.config);
    this.assertPolicy(name, command);

    if (CANCEL_METHODS.has(name)) {
      return this.cancel(validated.requestId);
    }

    if (this.tasks.size >= this.config.limits.maxConcurrentTasks) {
      throw new FilePluginError(ErrorCode.TOO_MANY_TASKS, 'too many concurrent file tasks');
    }
    const controller = new AbortController();
    const task = { id, controller, method: name };
    this.tasks.set(id, task);
    try {
      const result = await this.backend.handle(name, validated, {
        requestId: id,
        owner: options.owner,
        signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
        progress: (payload) => this.emit('progress', { requestId: id, ...payload }),
        emit: (type, payload) => this.emit(type, payload),
        config: this.config,
      });
      if (command.mutates) this.emit('changed', { requestId: id, method: name });
      return result;
    } catch (error) {
      const structured = asFilePluginError(error);
      if (structured.code === ErrorCode.INTERNAL) this.emit('error', { requestId: id, code: structured.code });
      throw structured;
    } finally {
      this.tasks.delete(id);
    }
  }

  /** Wire API: never throws, always returns the original response envelope. */
  async handle(request) {
    const id = typeof request?.id === 'string' ? request.id : '';
    try {
      const result = await this.call(request?.method, request?.params ?? {}, { requestId: id });
      return { id, ok: true, result };
    } catch (error) {
      const structured = asFilePluginError(error);
      return { id, ok: false, error: safeMessage(structured, { safeErrors: this.config.security.safeErrors }) };
    }
  }

  assertPolicy(method, command) {
    if (!this.config.security.allowWrite && MUTATING_METHODS.has(method)) {
      throw new FilePluginError(ErrorCode.FORBIDDEN, 'write operations are disabled');
    }
    if (!this.config.security.allowControlCommands && command.group === 'control') {
      throw new FilePluginError(ErrorCode.FORBIDDEN, 'control operations are disabled');
    }
  }

  cancel(requestId) {
    if (typeof requestId !== 'string' || !requestId) {
      throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'requestId is required');
    }
    const task = this.tasks.get(requestId) ?? [...this.tasks.values()].find((item) => item.id === requestId);
    if (!task) return { cancelled: false };
    task.controller.abort(new Error('cancelled by request'));
    return { cancelled: true };
  }

  /** The one tool catalogue shared by all agent adapters. */
  tools() {
    return buildToolDefinitions(this.toolOptions);
  }

  describe() {
    return {
      pluginVersion: this.config.pluginVersion,
      protocolVersion: this.config.protocolVersion,
      backend: this.backend.name,
      backendCapabilities: this.backend.capabilities ?? {},
      methods: describeProtocol(this.config).methods,
      tools: this.tools().map((tool) => tool.name),
      policy: this.policy.describe(),
      security: { ...this.config.security },
      limits: { ...this.config.limits },
    };
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const task of this.tasks.values()) task.controller.abort(new Error('service disposed'));
    this.tasks.clear();
    await this.backend.dispose?.();
  }
}
