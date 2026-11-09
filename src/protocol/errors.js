/**
 * Error model for the file plugin.
 *
 * Wire compatibility: the original AiNative native-messaging protocol returns
 * `error` as a *plain string* inside `{ id, ok:false, error }`. We keep that
 * shape on the wire while using structured codes internally so adapters can
 * map them to MCP errors, HTTP status, DSH toasts, etc.
 */

export const ErrorCode = Object.freeze({
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNSUPPORTED_METHOD: 'UNSUPPORTED_METHOD',
  UNKNOWN_PARAMETER: 'UNKNOWN_PARAMETER',
  INVALID_PARAMETER: 'INVALID_PARAMETER',
  PATH_DENIED: 'PATH_DENIED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  BACKEND_UNAVAILABLE: 'BACKEND_UNAVAILABLE',
  TOO_MANY_TASKS: 'TOO_MANY_TASKS',
  FORBIDDEN: 'FORBIDDEN',
  INTERNAL: 'INTERNAL',
});

/** Non-fatal business errors may be shown verbatim; everything else is masked. */
const EXPOSABLE = new Set([
  ErrorCode.INVALID_REQUEST,
  ErrorCode.UNSUPPORTED_METHOD,
  ErrorCode.UNKNOWN_PARAMETER,
  ErrorCode.INVALID_PARAMETER,
  ErrorCode.NOT_FOUND,
  ErrorCode.CANCELLED,
  ErrorCode.CAPABILITY_UNAVAILABLE,
  ErrorCode.FORBIDDEN,
]);

export class FilePluginError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'FilePluginError';
    this.code = code;
    this.detail = options.detail;
    this.cause = options.cause;
    this.expose = options.expose ?? EXPOSABLE.has(code);
  }
}

export function fail(code, message, options) {
  throw new FilePluginError(code, message, options);
}

export function asFilePluginError(error) {
  if (error instanceof FilePluginError) return error;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled', { cause: error });
  }
  const code = error?.code;
  if (code === 'ENOENT') {
    return new FilePluginError(ErrorCode.NOT_FOUND, 'file not found', { cause: error });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new FilePluginError(ErrorCode.PATH_DENIED, 'permission denied', { cause: error });
  }
  if (code === 'EEXIST') {
    return new FilePluginError(ErrorCode.CONFLICT, 'target already exists', { cause: error });
  }
  return new FilePluginError(ErrorCode.INTERNAL, String(error?.message ?? error), { cause: error });
}

/**
 * Port of native-file-host `protocol.rs::safe_error`: IO / internal errors and
 * anything containing a path separator are replaced with a generic message so
 * absolute paths never leak to an agent or a renderer page.
 */
export function safeMessage(error, { safeErrors = true } = {}) {
  const structured = asFilePluginError(error);
  if (!safeErrors) return structured.message;
  if (structured.code === ErrorCode.INTERNAL || structured.code === ErrorCode.BACKEND_UNAVAILABLE) {
    return '文件操作失败';
  }
  const text = structured.message;
  if (
    text.startsWith('IO error:') ||
    text.startsWith('Internal error:') ||
    text.startsWith('Notify error:') ||
    text.includes('/') ||
    text.includes('\\')
  ) {
    return '文件操作失败';
  }
  return text;
}

/** Maps a plugin error to an HTTP status for the HTTP / DSH adapters. */
export function httpStatus(error) {
  const structured = asFilePluginError(error);
  switch (structured.code) {
    case ErrorCode.INVALID_REQUEST:
    case ErrorCode.UNKNOWN_PARAMETER:
    case ErrorCode.INVALID_PARAMETER:
      return 400;
    case ErrorCode.FORBIDDEN:
    case ErrorCode.PATH_DENIED:
      return 403;
    case ErrorCode.NOT_FOUND:
      return 404;
    case ErrorCode.CONFLICT:
      return 409;
    case ErrorCode.CAPABILITY_UNAVAILABLE:
      return 501;
    case ErrorCode.BACKEND_UNAVAILABLE:
      return 503;
    case ErrorCode.TOO_MANY_TASKS:
      return 429;
    case ErrorCode.UNSUPPORTED_METHOD:
      return 404;
    default:
      return 500;
  }
}
