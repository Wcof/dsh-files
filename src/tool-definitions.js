/**
 * The single tool catalogue used by *every* agent adapter.
 *
 * DSH, zcode, MCP and HTTP all consume this one list, so adding a command in
 * COMMANDS automatically makes it available to all agents with the same
 * description, parameter schema and validation. This is the "uniform way to
 * adapt to DeepSeek, zcode and similar agents" the plugin promises.
 */

import { COMMANDS, COMMAND_BY_NAME } from './protocol/commands.js';
import { FilePluginError, ErrorCode } from './protocol/errors.js';

export function buildToolDefinitions({ prefix = 'file', include, exclude } = {}) {
  const includeSet = include ? new Set(include) : null;
  const excludeSet = new Set(exclude ?? []);
  return COMMANDS.filter((command) => {
    if (excludeSet.has(command.name)) return false;
    if (includeSet) return includeSet.has(command.name);
    return command.tool === true;
  }).map((command) => {
    const inputSchema = {
      type: 'object',
      properties: command.schema ?? {},
      required: command.required ?? [],
      additionalProperties: false,
    };
    if (command.anyOf) inputSchema.anyOf = command.anyOf;
    return {
      name: `${prefix}_${command.name}`,
      method: command.name,
      description: command.summary,
      inputSchema,
      annotations: {
        readOnlyHint: !command.mutates,
        destructiveHint: command.mutates,
      },
    };
  });
}

export function toolNameToMethod(toolName, { prefix = 'file' } = {}) {
  const expected = `${prefix}_`;
  if (typeof toolName !== 'string' || !toolName.startsWith(expected)) {
    throw new FilePluginError(ErrorCode.UNSUPPORTED_METHOD, `unknown tool: ${toolName}`);
  }
  const method = toolName.slice(expected.length);
  if (!COMMAND_BY_NAME.has(method)) {
    throw new FilePluginError(ErrorCode.UNSUPPORTED_METHOD, `unknown tool: ${toolName}`);
  }
  return method;
}

/** Shared implementation of MCP `tools/call` / zcode `tools.call`. */
export async function callTool(service, toolName, args = {}, options = {}) {
  const tool = service.tools().find((entry) => entry.name === toolName);
  if (!tool) throw new FilePluginError(ErrorCode.UNSUPPORTED_METHOD, `unknown tool: ${toolName}`);
  return service.call(tool.method, args, options);
}

/** Flatten the catalogue into the manifest shape DSH hosts expect. */
export function toDshManifest(tools, { routePrefix = '/agent/files' } = {}) {
  return {
    routePrefix,
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      readOnly: tool.annotations.readOnlyHint,
    })),
  };
}
