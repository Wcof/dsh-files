/**
 * @dsh/files — a host-agnostic, reusable file capability plugin.
 *
 *   import { createFilePlugin } from '@dsh/files';
 *   const plugin = createFilePlugin({ homeDir: '/Users/me' });
 *   const result = await plugin.call('list_dir', { path: '~' });
 *
 * See docs/PLUGIN_CONTRACT.md for the full boundary / interface / IO /
 * dependency / configuration contract.
 */

export { createFilePlugin } from './host.js';
export { apply, inject, name } from './dsh-plugin.js';

// Configuration
export {
  resolveConfig,
  describeConfig,
  validateConfig,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  DEFAULT_LIMITS,
  DEFAULTS,
} from './config.js';

// Protocol (single source of truth for commands and validation)
export {
  COMMANDS,
  METHODS,
  METHOD_SET,
  COMMAND_BY_NAME,
  PARAMS_BY_METHOD,
  MUTATING_METHODS,
  OS_DEPENDENT_METHODS,
  isFileMethod,
  getCommand,
} from './protocol/commands.js';
export { validateRequest, describeProtocol, makeRequest } from './protocol/validate.js';
export { FilePluginError, ErrorCode, safeMessage, httpStatus, asFilePluginError } from './protocol/errors.js';

// Core (swappable pieces)
export { AccessPolicy, AuthorizedPath, Operation } from './core/access-policy.js';
export { FileService } from './core/service.js';
export { createLocalBackend } from './core/local-backend.js';
export { createNativesCoreBackend } from './core/natives-core-backend.js';
export { createSystemTools, defaultCommandRunner } from './core/tools.js';
export { detectFileKind, naturalCompare } from './core/detect.js';

// Uniform tool catalogue
export {
  buildToolDefinitions,
  callTool,
  toolNameToMethod,
  toDshManifest,
} from './tool-definitions.js';

// Unified agent adapter contract
export {
  defineAdapter,
  createAdapter,
  validateAdapter,
  listAdapters,
} from './adapters/index.js';
