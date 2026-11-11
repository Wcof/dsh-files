/**
 * Path authorization kernel.
 *
 * Port of `file-manager-core/src/file_manager/mod.rs::FileAccessPolicy`
 * (lines 206-405), with the previously hardcoded `dirs::home_dir()`,
 * allowlist and blocklist turned into injected configuration.
 *
 * The key invariant is unchanged: an operation receives an *AuthorizedPath
 * handle* (a canonicalized, allowlisted path), never the raw caller string,
 * so no caller can re-route an operation between authorization and use.
 */

import fs from 'node:fs';
import path from 'node:path';
import { FilePluginError, ErrorCode } from '../protocol/errors.js';

export const Operation = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  REVEAL: 'reveal',
  PREVIEW: 'preview',
  SEARCH: 'search',
});

export class AuthorizedPath {
  constructor(absolutePath, operation) {
    this.path = absolutePath;
    this.operation = operation;
    Object.freeze(this);
  }
  toString() {
    return this.path;
  }
}

function isWithin(candidate, root) {
  if (process.platform === 'win32') { candidate = candidate.toLowerCase(); root = root.toLowerCase(); }
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

export function validWindowsName(name) {
  return !/[<>:"|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name);
}

function canonicalOrSelf(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

/**
 * Canonicalize a path whose final components may not exist yet. Mirrors the
 * Rust helper: walk up until an existing ancestor is found, then re-append.
 * Dangling symlinks are rejected instead of being treated as plain names.
 */
export function canonicalizeWithExistingParent(target) {
  const absolute = path.resolve(target);
  const tail = [];
  let cursor = absolute;
  for (;;) {
    try {
      const real = fs.realpathSync.native(cursor);
      return path.resolve(real, ...tail.reverse());
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
      try {
        const info = fs.lstatSync(cursor);
        if (info.isSymbolicLink()) {
          throw new FilePluginError(ErrorCode.PATH_DENIED, 'dangling symlink is not allowed');
        }
      } catch (inner) {
        if (inner instanceof FilePluginError) throw inner;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      tail.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export class AccessPolicy {
  /** @param {object} config resolved plugin config */
  constructor(config) {
    this.config = config;
    this.home = canonicalOrSelf(path.resolve(config.homeDir));
    this.temp = canonicalOrSelf(path.resolve(config.tempDir));
    this.systemTmpPrefixes = (process.platform === 'win32' ? [] : ['/tmp', '/private/tmp', '/var/folders']).filter((prefix) =>
      path.isAbsolute(prefix)
    );
    this.allowedRoots = [
      this.home,
      this.temp,
      ...config.allowedRoots.map((root) => canonicalOrSelf(path.resolve(root))),
    ];
    this.externalVolumePrefixes = config.externalVolumePrefixes.map((prefix) =>
      prefix.endsWith(path.sep) ? prefix.slice(0, -1) : prefix
    );
  }

  /** Expand `~` and `~/...` using the *configured* home, not os.homedir(). */
  expandTilde(raw) {
    if (raw === '~') return this.config.homeDir;
    if (raw.startsWith('~/') || process.platform === 'win32' && raw.startsWith('~\\')) return path.join(this.config.homeDir, raw.slice(2));
    return raw;
  }

  /**
   * @param {string} rawPath caller-controlled path
   * @param {string} operation one of Operation
   * @returns {AuthorizedPath}
   */
  authorize(rawPath, operation = Operation.READ) {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'path is required');
    }
    if (rawPath.includes('\0')) {
      throw new FilePluginError(ErrorCode.PATH_DENIED, 'path contains null byte');
    }
    const expanded = this.expandTilde(rawPath);
    const segments = expanded.split(/[\\/]+/);
    if (segments.includes('..')) {
      throw new FilePluginError(ErrorCode.PATH_DENIED, "path must not contain '..'");
    }

    let canon;
    try {
      canon = canonicalizeWithExistingParent(expanded);
    } catch (error) {
      if (error instanceof FilePluginError) throw error;
      throw new FilePluginError(ErrorCode.PATH_DENIED, 'path could not be resolved', { cause: error });
    }

    for (const blocked of this.config.deniedNames) {
      const compare = process.platform === 'win32' ? canon.toLowerCase() : canon;
      const parts = (process.platform === 'win32' ? blocked.toLowerCase() : blocked).split('/');
      if (compare.endsWith(path.sep + parts.join(path.sep)) || compare.includes(path.sep + parts.join(path.sep) + path.sep)) {
        throw new FilePluginError(ErrorCode.PATH_DENIED, `access denied: ${blocked}`);
      }
    }

    const isAllowedRoot = this.allowedRoots.some((root) => isWithin(canon, root));
    // Only reads may target an ancestor of home (e.g. listing /Users).
    const isHomeAncestorRead = operation === Operation.READ && isWithin(this.home, canon);
    const isSystemTmp = this.systemTmpPrefixes.some((prefix) => isWithin(canon, prefix));
    const external = this.authorizeExternalVolume(canon, operation);

    if (!(isAllowedRoot || isHomeAncestorRead || isSystemTmp || external)) {
      throw new FilePluginError(ErrorCode.PATH_DENIED, 'path not in allowed directories');
    }
    return new AuthorizedPath(canon, operation);
  }

  /** External volumes are read-only at their mount root; descendants may be written. */
  authorizeExternalVolume(canon, operation) {
    if (!this.config.allowExternalVolumes) return false;
    for (const prefix of this.externalVolumePrefixes) {
      if (!isWithin(canon, prefix)) continue;
      const relative = canon.slice(prefix.length).replace(/^\//, '');
      // The mount root (/Volumes/NAME) is read-only; nested paths may be written.
      if (relative === '' || !relative.includes('/')) return operation === Operation.READ;
      return true;
    }
    return false;
  }

  /** Validate a single name component (mod.rs:408-417). */
  validName(name) {
    return (
      typeof name === 'string' &&
      name.length > 0 &&
      name.length <= 255 &&
      name !== '.' &&
      name !== '..' &&
      !name.includes('/') &&
      !name.includes('\\') &&
      !name.includes('\0') &&
      (process.platform !== 'win32' || validWindowsName(name))
    );
  }

  describe() {
    return {
      home: this.home,
      temp: this.temp,
      allowedRoots: this.allowedRoots,
      systemTmpPrefixes: this.systemTmpPrefixes,
      deniedNames: [...this.config.deniedNames],
      externalVolumePrefixes: [...this.externalVolumePrefixes],
      allowExternalVolumes: this.config.allowExternalVolumes,
    };
  }
}
