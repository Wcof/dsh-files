/**
 * Configuration is the *only* place where environment-specific knowledge
 * lives. Nothing in src/core or src/adapters reads process.env, hardcodes a
 * home directory, a port, an agent name or a product data root.
 */

import os from 'node:os';
import path from 'node:path';
import { FilePluginError, ErrorCode } from './protocol/errors.js';

export const PLUGIN_VERSION = '0.2.0';
export const PROTOCOL_VERSION = 1;

export const DEFAULT_LIMITS = Object.freeze({
  /** Mirrors file-manager-core constants. */
  maxFullRead: 2 * 1024 * 1024,
  maxTruncatedRead: 256 * 1024,
  maxImportBytes: 2 * 1024 * 1024 * 1024,
  maxImportChunkBase64: 700_000,
  maxStringParam: 4 * 1024 * 1024,
  maxPathEntry: 4 * 1024,
  maxPaths: 200,
  maxListLimit: 2_000,
  maxOffset: 100_000,
  maxSearchResults: 100_000,
  maxSearchDurationMs: 4_000,
  maxSearchDepth: 8,
  maxPreviewBytes: 512 * 1024,
  maxDiskUsageEntries: 100_000,
  maxConcurrentTasks: 8,
  maxConcurrentImports: 4,
  maxWatchEvents: 1024,
  maxWatchers: 64,
  watchDebounceMs: 250,
  defaultListLimit: 500,
  defaultPageWindow: 100_001,
  commandTimeoutMs: 30_000,
});

export const DEFAULTS = Object.freeze({
  backend: 'local',
  homeDir: os.homedir(),
  tempDir: os.tmpdir(),
  allowedRoots: [],
  deniedNames: ['.ssh', '.gnupg', '.aws', '.config/gh', '.kube'],
  externalVolumePrefixes: ['/Volumes', '/media', '/mnt'],
  allowExternalVolumes: true,
  limits: DEFAULT_LIMITS,
  security: {
    safeErrors: true,
    allowWrite: true,
    allowSystemCommands: true,
    allowControlCommands: true,
  },
});

function boolEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value.toLowerCase() === 'true') return true;
  if (value === '0' || value.toLowerCase() === 'false') return false;
  return fallback;
}

function intEnv(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Build the effective configuration.
 *
 * @param {object} input explicit options (wins over env)
 * @param {NodeJS.ProcessEnv} env injected environment (never read globally elsewhere)
 */
export function resolveConfig(input = {}, env = process.env) {
  const homeDir = input.homeDir ?? env.DSH_FILES_HOME ?? DEFAULTS.homeDir;
  const stateDir =
    input.stateDir ?? env.DSH_FILES_STATE_DIR ?? path.join(homeDir, '.dsh', 'files');

  const config = {
    pluginVersion: PLUGIN_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    backend: input.backend ?? env.DSH_FILES_BACKEND ?? DEFAULTS.backend,
    backendOptions: {
      endpoint: env.DSH_FILES_CORE_RPC_URL ?? 'http://127.0.0.1:8770/web/rpc',
      timeoutMs: 30_000,
      headers: {},
      ...(input.backendOptions ?? {}),
    },
    homeDir,
    stateDir,
    tempDir: input.tempDir ?? env.DSH_FILES_TMP ?? DEFAULTS.tempDir,
    allowedRoots: [...(input.allowedRoots ?? DEFAULTS.allowedRoots)],
    deniedNames: [...(input.deniedNames ?? DEFAULTS.deniedNames)],
    externalVolumePrefixes: [
      ...(input.externalVolumePrefixes ?? DEFAULTS.externalVolumePrefixes),
    ],
    allowExternalVolumes:
      input.allowExternalVolumes ?? DEFAULTS.allowExternalVolumes,
    limits: { ...DEFAULT_LIMITS, ...(input.limits ?? {}) },
    security: {
      ...DEFAULTS.security,
      ...(input.security ?? {}),
      allowSystemCommands:
        input.security?.allowSystemCommands ??
        boolEnv(env.DSH_FILES_ALLOW_SYSTEM_COMMANDS, DEFAULTS.security.allowSystemCommands),
      allowWrite:
        input.security?.allowWrite ??
        boolEnv(env.DSH_FILES_ALLOW_WRITE, DEFAULTS.security.allowWrite),
    },
    tools: { ...(input.tools ?? {}) },
    events: { ...(input.events ?? {}) },
    adapters: [...(input.adapters ?? [])],
    http: {
      host: '127.0.0.1',
      port: intEnv(env.DSH_FILES_HTTP_PORT, 0),
      token: env.DSH_FILES_HTTP_TOKEN ?? '',
      ...(input.http ?? {}),
    },
    log: input.log ?? (() => {}),
  };

  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'config must be an object');
  }
  if (typeof config.homeDir !== 'string' || !path.isAbsolute(config.homeDir)) {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'homeDir must be an absolute path');
  }
  for (const key of ['stateDir', 'tempDir']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) throw new FilePluginError(ErrorCode.INVALID_REQUEST, `${key} must be an absolute path`);
  }
  for (const [key, value] of Object.entries(config.limits)) {
    if (!(key in DEFAULT_LIMITS) || !Number.isSafeInteger(value) || value <= 0) throw new FilePluginError(ErrorCode.INVALID_REQUEST, `invalid limit: ${key}`);
  }
  for (const [key, value] of Object.entries(config.security)) {
    if (!(key in DEFAULTS.security) || typeof value !== 'boolean') throw new FilePluginError(ErrorCode.INVALID_REQUEST, `invalid security option: ${key}`);
  }
  if (!['local', 'natives-core'].includes(config.backend) && typeof config.backend !== 'object') {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'unknown backend');
  }
  for (const root of config.allowedRoots) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
      throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'allowedRoots entries must be absolute paths');
    }
  }
  if (config.http.port !== 0 && (!Number.isInteger(config.http.port) || config.http.port < 1 || config.http.port > 65535)) {
    throw new FilePluginError(ErrorCode.INVALID_REQUEST, 'http.port must be a valid port');
  }
  return config;
}

/** Public, redacted view of the effective config (safe to hand to an agent). */
export function describeConfig(config) {
  return {
    pluginVersion: config.pluginVersion,
    protocolVersion: config.protocolVersion,
    backend: typeof config.backend === 'string' ? config.backend : 'custom',
    homeDir: config.homeDir,
    stateDir: config.stateDir,
    tempDir: config.tempDir,
    allowedRoots: [...config.allowedRoots],
    deniedNames: [...config.deniedNames],
    externalVolumePrefixes: [...config.externalVolumePrefixes],
    allowExternalVolumes: config.allowExternalVolumes,
    limits: { ...config.limits },
    security: { ...config.security },
    capabilities: Object.keys(config.tools),
  };
}
