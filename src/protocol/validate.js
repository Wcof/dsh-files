/**
 * Request validation — a direct port of
 * `native-file-host/src/protocol.rs::validate_request` (lines 80-408).
 *
 * Every adapter funnels through this function, so DSH, zcode, MCP, HTTP and
 * in-process callers get byte-for-byte identical validation semantics.
 */

import {
  COMMANDS,
  COMMAND_BY_NAME,
  PARAMS_BY_METHOD,
  METHOD_SET,
} from './commands.js';
import { FilePluginError, ErrorCode } from './errors.js';

const MAX_ID_BYTES = 128;
const MAX_METHOD_BYTES = 64;
const STRING_PARAM_KEYS = [
  'path', 'parent', 'name', 'data', 'query', 'requestId', 'from', 'to',
  'source', 'target', 'dest', 'sortBy', 'sortDir', 'uploadId', 'conflict', 'extensionVersion',
];
const NUMBER_PARAM_KEYS = ['offset', 'limit', 'size'];
const BOOLEAN_PARAM_KEYS = ['showHidden', 'probeProjects', 'recursive', 'content'];

function invalid(message) {
  throw new FilePluginError(ErrorCode.INVALID_PARAMETER, message);
}

/**
 * @param {{id?:string, method?:string, params?:object}} request
 * @param {object} config resolved config
 * @returns {{id:string, method:string, params:object, command:object}}
 */
export function validateRequest(request, config) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'request must be an object');
  }
  const { id, method } = request;
  const params = request.params === undefined ? {} : request.params;

  if (typeof id !== 'string' || id.length === 0 || Buffer.byteLength(id) > MAX_ID_BYTES) {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'invalid request id');
  }
  if (typeof method !== 'string' || method.length === 0 || Buffer.byteLength(method) > MAX_METHOD_BYTES) {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'invalid request method');
  }
  if (!METHOD_SET.has(method)) {
    throw new FilePluginError(ErrorCode.UNSUPPORTED_METHOD, 'unsupported method');
  }
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'params must be an object');
  }

  const limits = config.limits;
  const allowed = PARAMS_BY_METHOD[method];
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) {
      throw new FilePluginError(ErrorCode.UNKNOWN_PARAMETER, `unknown parameter: ${key}`);
    }
  }

  const command = COMMAND_BY_NAME.get(method);
  for (const key of command.required ?? []) {
    if (!Object.hasOwn(params, key)) invalid(`missing required parameter: ${key}`);
  }
  if (command.anyOf && !command.anyOf.some((choice) => choice.required.every((key) => Object.hasOwn(params, key)))) {
    invalid('source and destination are required');
  }

  for (const key of STRING_PARAM_KEYS) {
    if (!(key in params)) continue;
    const value = params[key];
    if (typeof value !== 'string') invalid('parameter must be a string');
    if (value.length > limits.maxStringParam) invalid('parameter is too long');
    if (method === 'import_chunk' && key === 'data' && value.length > limits.maxImportChunkBase64) {
      invalid('import chunk is too large');
    }
  }

  for (const key of NUMBER_PARAM_KEYS) {
    if (!(key in params)) continue;
    const value = params[key];
    if (!Number.isInteger(value) || value < 0) invalid('parameter must be a number');
    if (key === 'limit' && (value === 0 || value > limits.maxListLimit)) invalid('invalid limit');
    if (key === 'offset') {
      const maxOffset = method === 'import_chunk' ? limits.maxImportBytes : limits.maxOffset;
      if (value > maxOffset) invalid('invalid offset');
    }
    if (key === 'size' && value > limits.maxImportBytes) invalid('import is too large');
  }

  for (const key of BOOLEAN_PARAM_KEYS) {
    if (key in params && typeof params[key] !== 'boolean') invalid('parameter must be a boolean');
  }

  if ('expectedMtime' in params) {
    const value = params.expectedMtime;
    if (typeof value !== 'number' || !Number.isFinite(value)) invalid('expectedMtime must be a finite number');
  }
  if ('sortBy' in params && !['name', 'size', 'mtime'].includes(params.sortBy)) invalid('invalid sortBy');
  if ('sortDir' in params && !['asc', 'desc'].includes(params.sortDir)) invalid('invalid sortDir');
  if ('conflict' in params && !['rename', 'skip'].includes(params.conflict)) {
    invalid('invalid import conflict policy');
  }
  if (method === 'import_chunk') {
    if (typeof params.uploadId !== 'string' || typeof params.data !== 'string') {
      invalid('uploadId and data are required');
    }
  }
  if ('paths' in params) validatePaths(params.paths, limits, method === 'create_zip');

  if ('uploadId' in params && !/^[a-zA-Z0-9_-]{1,128}$/.test(params.uploadId)) invalid('invalid uploadId');
  return { id, method, params, command };
}

function validatePaths(paths, limits, isCreateZip) {
  if (!Array.isArray(paths)) invalid('paths must be an array');
  if (paths.length === 0 || paths.length > limits.maxPaths) invalid('invalid paths');
  for (const entry of paths) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > limits.maxPathEntry) {
      invalid(isCreateZip ? 'invalid archive input path' : 'invalid path entry');
    }
  }
  if (isCreateZip && paths.length > 200) invalid('invalid archive input count');
}

/** Normalize a loose call (`method`, `params`) into a wire request. */
export function makeRequest(method, params = {}, id = undefined) {
  return {
    id: id ?? `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    method,
    params,
  };
}

/** Contract introspection for hosts and tooling. */
export function describeProtocol(config) {
  return {
    protocolVersion: config.protocolVersion,
    pluginVersion: config.pluginVersion,
    request: '{ id: string, method: string, params: object }',
    response: '{ id: string, ok: boolean, result?: any, error?: string }',
    methodCount: COMMANDS.length,
    methods: COMMANDS.map((command) => ({
      name: command.name,
      group: command.group,
      mutates: command.mutates,
      capability: command.capability,
      tool: command.tool,
      params: command.params,
      output: command.output,
    })),
  };
}
