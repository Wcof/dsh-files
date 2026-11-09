/**
 * zcode-compatible adapter (NDJSON over stdio).
 *
 * zcode and similar CLI agents usually spawn a tool process and exchange one
 * JSON object per line. This adapter speaks that dialect while reusing the
 * exact same FileService, tool catalogue and validation as DSH and MCP.
 *
 * Accepted messages:
 *   {"id":"1","method":"initialize","params":{"client":"zcode"}}
 *   {"id":"2","method":"tools/list"}
 *   {"id":"3","method":"tools/call","params":{"name":"file_list_dir","arguments":{"path":"~"}}}
 *   {"id":"4","method":"list_dir","params":{"path":"~"}}      (raw command)
 *   {"id":"5","method":"file_list_dir","params":{"path":"~"}} (prefixed tool name)
 *   {"id":"6","method":"describe"}
 *
 * Requests and responses keep the host's own id shape — JSON-RPC style clients
 * commonly send numeric ids, so `{"id":1,...}` is answered with `"id":1`.
 *
 * Responses keep the original AiNative envelope: {id, ok, result?, error?}.
 */

import { defineAdapter, readLineStream } from './adapter.js';
import { asFilePluginError, safeMessage } from '../protocol/errors.js';
import { callTool, toolNameToMethod } from '../tool-definitions.js';

defineAdapter('zcode', (options = {}) => {
  let service;
  let config;
  let detach;
  const prefix = options.prefix ?? 'file';
  let input = options.input;
  let output = options.output;

  function write(payload) {
    const stream = output ?? process.stdout;
    stream.write(`${JSON.stringify(payload)}\n`);
  }

  // The wire contract only accepts a non-empty string id (protocol/validate.js),
  // while CLI hosts may send numbers. Echo the host's own id, hand the service a
  // string id, and reject frames that carry no usable id at all.
  function normalizeIds(rawId) {
    if (typeof rawId === 'string' && rawId.length > 0) return { replyId: rawId, wireId: rawId };
    if (typeof rawId === 'number' && Number.isFinite(rawId)) return { replyId: rawId, wireId: String(rawId) };
    return { replyId: '', wireId: '' };
  }

  async function onMessage(message) {
    const { replyId, wireId } = normalizeIds(message?.id);
    const method = message?.method;
    const params = message?.params ?? {};
    try {
      if (method === 'initialize') {
        write({ id: replyId, ok: true, result: { protocolVersion: config.protocolVersion, pluginVersion: config.pluginVersion, backend: service.backend.name, tools: service.tools().length } });
      } else if (method === 'tools/list' || method === 'tools.list') {
        write({ id: replyId, ok: true, result: { tools: service.tools() } });
      } else if (method === 'tools/call' || method === 'tools.call') {
        const result = await callTool(service, params.name, params.arguments ?? params.input ?? {}, { prefix });
        write({ id: replyId, ok: true, result });
      } else if (method === 'describe') {
        write({ id: replyId, ok: true, result: service.describe() });
      } else if (method === 'cancel') {
        write({ id: replyId, ok: true, result: service.cancel(params.requestId ?? wireId) });
      } else if (typeof method === 'string' && method.startsWith(`${prefix}_`)) {
        const command = toolNameToMethod(method, { prefix });
        write({ id: replyId, ok: true, result: await service.call(command, params, { requestId: wireId }) });
      } else {
        const { ok, result, error } = await service.handle({ id: wireId, method, params });
        write({ id: replyId, ok, ...(ok ? { result } : { error }) });
      }
    } catch (error) {
      write({ id: replyId, ok: false, error: safeMessage(asFilePluginError(error), config.security) });
    }
  }

  return {
    name: 'zcode',
    async start({ service: fileService, config: pluginConfig, log }) {
      service = fileService;
      config = pluginConfig;
      input = options.input ?? process.stdin;
      output = options.output ?? process.stdout;
      // Serialize frames so responses keep request order; some CLI agents
      // correlate by position rather than by id.
      let queue = Promise.resolve();
      detach = readLineStream(
        input,
        (message) => {
          queue = queue.then(() => onMessage(message)).catch((error) => log?.('zcode adapter frame failed', error));
        },
        (error, line) => {
          log?.('zcode adapter bad frame', error, line);
          write({ id: '', ok: false, error: 'invalid JSON frame' });
        }
      );
      return { input, output, onMessage };
    },
    async stop() {
      detach?.();
      detach = undefined;
      // Deliberately do not close process.stdin: the agent owns it.
    },
    describe() {
      return {
        transport: 'stdio',
        framing: 'NDJSON (one JSON object per line)',
        prefix,
        methods: ['initialize', 'tools/list', 'tools/call', 'describe', 'cancel', '<command>', '<prefix>_<command>'],
        response: '{ id, ok, result?, error? }',
      };
    },
  };
});
