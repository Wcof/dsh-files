/**
 * Model Context Protocol adapter — the generic path for "similar agents".
 *
 * JSON-RPC 2.0 over NDJSON stdio. Implements initialize / ping / tools/list /
 * tools/call, and forwards FileService events as notifications. Tool names,
 * descriptions and input schemas come from the shared catalogue, so a new
 * MCP-compatible agent needs zero plugin changes.
 */

import { defineAdapter, readLineStream } from './adapter.js';
import { asFilePluginError, safeMessage } from '../protocol/errors.js';
import { callTool } from '../tool-definitions.js';

const MCP_PROTOCOL_VERSION = '2024-11-05';

defineAdapter('mcp', (options = {}) => {
  let service;
  let config;
  let detach;
  let unsubscribe;
  let input;
  let output;
  const prefix = options.prefix ?? 'file';

  function write(payload) {
    (output ?? process.stdout).write(`${JSON.stringify(payload)}\n`);
  }

  function error(id, code, message, data) {
    write({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
  }

  async function onMessage(message) {
    const id = message?.id ?? null;
    const method = message?.method;
    const params = message?.params ?? {};
    if (method?.startsWith('notifications/') || id === null) return; // notification: no reply

    try {
      switch (method) {
        case 'initialize':
          write({
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: MCP_PROTOCOL_VERSION,
              capabilities: { tools: { listChanged: true } },
              serverInfo: { name: options.serverName ?? '@dsh/files', version: config.pluginVersion },
            },
          });
          return;
        case 'ping':
          write({ jsonrpc: '2.0', id, result: {} });
          return;
        case 'tools/list':
          write({ jsonrpc: '2.0', id, result: { tools: service.tools() } });
          return;
        case 'tools/call': {
          const result = await callTool(service, params.name, params.arguments ?? {}, { prefix });
          write({
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
              isError: false,
            },
          });
          return;
        }
        case 'resources/list':
          write({ jsonrpc: '2.0', id, result: { resources: [] } });
          return;
        default:
          error(id, -32601, `Method not found: ${method}`);
      }
    } catch (caught) {
      const structured = asFilePluginError(caught);
      const message = safeMessage(structured, config.security);
      if (method === 'tools/call') {
        write({
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: message }], isError: true },
        });
      } else {
        error(id, -32000, message, structured.code);
      }
    }
  }

  return {
    name: 'mcp',
    async start({ service: fileService, config: pluginConfig, log }) {
      service = fileService;
      config = pluginConfig;
      input = options.input ?? process.stdin;
      output = options.output ?? process.stdout;
      let queue = Promise.resolve();
      detach = readLineStream(
        input,
        (message) => {
          queue = queue.then(() => onMessage(message)).catch(() => error(null, -32603, 'Internal error'));
        },
        () => write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      );
      unsubscribe = service.on('*', (event) => {
        write({ jsonrpc: '2.0', method: 'notifications/file/event', params: event });
      });
      return { input, output, onMessage };
    },
    async stop() {
      detach?.();
      unsubscribe?.();
      detach = undefined;
      unsubscribe = undefined;
    },
    describe() {
      return {
        transport: 'stdio',
        framing: 'NDJSON JSON-RPC 2.0',
        protocolVersion: MCP_PROTOCOL_VERSION,
        methods: ['initialize', 'ping', 'tools/list', 'tools/call'],
        notifications: ['notifications/file/event'],
      };
    },
  };
});
