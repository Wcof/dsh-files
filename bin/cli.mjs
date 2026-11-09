#!/usr/bin/env node
/**
 * CLI entry point. Also the reference example of how an agent host embeds
 * the plugin: create -> attach adapter -> (optional) call.
 *
 *   dsh-files list-tools
 *   dsh-files describe
 *   dsh-files call roots
 *   dsh-files call list_dir '{"path":"~"}'
 *   dsh-files stdio      # zcode NDJSON dialect
 *   dsh-files mcp        # MCP JSON-RPC 2.0
 *   dsh-files http       # loopback HTTP server
 */

import { createFilePlugin, describeProtocol, PLUGIN_VERSION } from '../src/index.js';

const [command, ...args] = process.argv.slice(2);

function usage() {
  process.stdout.write(
    [
      `@dsh/files ${PLUGIN_VERSION}`,
      '',
      'Usage: dsh-files <command> [args]',
      '',
      '  list-tools              Print the shared tool catalogue (JSON)',
      '  describe                Print boundary, config, policy and capabilities',
      '  call <method> [json]    Invoke one file command and print its result',
      '  stdio                   zcode-compatible NDJSON over stdin/stdout',
      '  mcp                     MCP JSON-RPC 2.0 over stdin/stdout',
      '  http                    Loopback HTTP adapter (GET /tools, POST /rpc)',
      '',
      'Environment: DSH_FILES_HOME, DSH_FILES_STATE_DIR, DSH_FILES_BACKEND,',
      '  DSH_FILES_ALLOW_WRITE, DSH_FILES_ALLOW_SYSTEM_COMMANDS,',
      '  DSH_FILES_HTTP_PORT, DSH_FILES_HTTP_TOKEN, DSH_FILES_CORE_RPC_URL',
      '',
    ].join('\n')
  );
}

function print(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

const plugin = createFilePlugin();

switch (command) {
  case 'list-tools':
    print(plugin.tools());
    break;
  case 'describe':
    print({ ...plugin.describe(), protocol: describeProtocol(plugin.config) });
    break;
  case 'call': {
    const method = args[0];
    if (!method) {
      usage();
      process.exitCode = 2;
      break;
    }
    let params = {};
    if (args[1]) {
      try {
        params = JSON.parse(args[1]);
      } catch (error) {
        process.stderr.write(`invalid params JSON: ${error.message}\n`);
        process.exitCode = 2;
        break;
      }
    }
    try {
      await plugin.backend.init?.();
      print(await plugin.call(method, params));
    } catch (error) {
      process.stderr.write(`${error.code ?? 'ERROR'}: ${error.message}\n`);
      process.exitCode = 1;
    } finally {
      await plugin.dispose();
    }
    break;
  }
  case 'stdio':
  case 'mcp':
  case 'http': {
    await plugin.backend.init?.();
    const handle = await plugin.attach(command === 'stdio' ? 'zcode' : command);
    if (command === 'http') {
      process.stdout.write(`file plugin HTTP: ${handle.url}\n`);
    } else {
      process.stderr.write(`file plugin ${command} adapter ready\n`);
    }
    const shutdown = async () => {
      await plugin.dispose();
      process.exit(0);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    break;
  }
  default:
    usage();
    process.exitCode = command ? 2 : 0;
}
