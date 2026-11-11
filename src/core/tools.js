/**
 * OS integration is an *injected capability*, not a dependency.
 *
 * The original Rust core called `zip`, `unzip`, `osascript`, `mdfind`,
 * `pdftotext`, `open`, `explorer` … directly. Here every such call goes
 * through a `CommandRunner` / hook that the host may replace (or disable with
 * `security.allowSystemCommands = false`). This is what lets the same plugin
 * run in a DSH host, a headless zcode agent, or a locked-down CI sandbox.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { FilePluginError, ErrorCode } from '../protocol/errors.js';

export function defaultCommandRunner(command, args = [], options = {}) {
  const { timeoutMs = 30_000, cwd, maxBuffer = 8 * 1024 * 1024 } = options;
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled'));
      return;
    }
    const hasStdin = typeof options.stdin === 'string' || Buffer.isBuffer(options.stdin);
    let child;
    try {
      child = spawn(command, args, { cwd, windowsHide: true, stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new FilePluginError(ErrorCode.CAPABILITY_UNAVAILABLE, `cannot start ${command}`, { cause: error }));
      return;
    }
    if (hasStdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(options.stdin);
    }
    const chunks = [];
    const errors = [];
    let size = 0;
    let settled = false;
    let failure;
    const abort = () => {
      failure = new FilePluginError(ErrorCode.CANCELLED, 'operation cancelled');
      child.kill('SIGKILL');
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      if (settled) return;
      failure = new FilePluginError(ErrorCode.TIMEOUT, `${command} timed out`);
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxBuffer) chunks.push(chunk);
      else {
        failure = new FilePluginError(ErrorCode.CAPABILITY_UNAVAILABLE, 'command output exceeds the configured limit');
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      if (errors.length < 64) errors.push(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      reject(new FilePluginError(ErrorCode.CAPABILITY_UNAVAILABLE, `cannot start ${command}`, { cause: error }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (failure) { reject(failure); return; }
      resolve({
        code,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errors).toString('utf8'),
      });
    });
  });
}

function unavailable(hook) {
  return new FilePluginError(
    ErrorCode.CAPABILITY_UNAVAILABLE,
    `OS capability "${hook}" is unavailable (inject config.tools.${hook} or enable security.allowSystemCommands)`
  );
}

/**
 * @param {object} config resolved config
 * @returns {object} system tools facade
 */
export function createSystemTools(config) {
  const injected = config.tools ?? {};
  const run = injected.commandRunner ?? defaultCommandRunner;
  const timeoutMs = config.limits.commandTimeoutMs;
  const platform = injected.platform ?? process.platform;
  const pathsApi = platform === 'win32' ? path.win32 : path;
  // Keep user paths out of executable source and cmd.exe metacharacter parsing.
  const powershell = (script, data) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(
    "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); $data = [Console]::In.ReadToEnd() | ConvertFrom-Json; " + script,
    'utf16le').toString('base64')], { timeoutMs, stdin: JSON.stringify(data) });

  const guard = (hook) => {
    if (injected[hook]) return false;
    if (!config.security.allowSystemCommands) throw unavailable(hook);
    return true;
  };

  const system = {
    commandRunner: run,
    platform,

    async open(target, mode = 'default') {
      if (injected.openHandler) return injected.openHandler(target, mode);
      guard('openHandler');
      if (platform === 'win32') {
        const result = await powershell(mode === 'reveal'
          ? '$start = New-Object System.Diagnostics.ProcessStartInfo; $start.FileName = "explorer.exe"; $start.Arguments = \'/select,"\' + $data.path + \'"\'; $start.UseShellExecute = $true; [System.Diagnostics.Process]::Start($start) | Out-Null'
          : '$start = New-Object System.Diagnostics.ProcessStartInfo; $start.FileName = $data.path; $start.UseShellExecute = $true; [System.Diagnostics.Process]::Start($start) | Out-Null', { path: target });
        if (result.code !== 0) throw new FilePluginError(ErrorCode.INTERNAL, 'open failed');
        return { ok: true };
      }
      const args =
        platform === 'darwin'
          ? mode === 'reveal' ? ['-R', target] : mode === 'editor' ? ['-a', injected.editorApp ?? 'TextEdit', target] : [target]
          : [target];
      const command = platform === 'darwin' ? 'open' : 'xdg-open';
      const result = await run(command, args, { timeoutMs });
      if (result.code !== 0) throw new FilePluginError(ErrorCode.INTERNAL, 'open failed');
      return { ok: true };
    },

    async openTrash() {
      if (injected.openTrashHandler) return injected.openTrashHandler();
      guard('openTrashHandler');
      const target =
        platform === 'darwin'
          ? path.join(config.homeDir, '.Trash')
          : platform === 'win32'
            ? 'shell:RecycleBinFolder'
            : path.join(config.homeDir, '.local', 'share', 'Trash', 'files');
      return system.open(target, 'default');
    },

    async clipboardCopyFiles(paths) {
      if (injected.clipboardHandler) return injected.clipboardHandler({ kind: 'paths', paths });
      guard('clipboardHandler');
      const text = paths.join('\n');
      if (platform === 'darwin') {
        const result = await run('pbcopy', [], { timeoutMs, stdin: text });
        if (result.code !== 0) throw new FilePluginError(ErrorCode.INTERNAL, 'clipboard copy failed');
      } else if (platform === 'linux') {
        const result = await run('wl-copy', [], { timeoutMs, stdin: text });
        if (result.code !== 0) throw new FilePluginError(ErrorCode.CAPABILITY_UNAVAILABLE, 'no clipboard provider');
      } else {
        throw unavailable('clipboardHandler');
      }
      return { ok: true };
    },

    async clipboardCopyImage(target) {
      if (injected.clipboardHandler) return injected.clipboardHandler({ kind: 'image', path: target });
      guard('clipboardHandler');
      if (platform !== 'darwin') throw unavailable('clipboardHandler');
      const script = `set the clipboard to (read (POSIX file "${target.replace(/"/g, '\\"')}") as «class PNGf»)`;
      const result = await run('osascript', ['-e', script], { timeoutMs });
      if (result.code !== 0) throw new FilePluginError(ErrorCode.INTERNAL, 'image clipboard copy failed');
      return { ok: true };
    },

    /**
     * Trash is a *move*, never an unlink. macOS uses ~/.Trash, Linux uses the
     * XDG trash dir, and hosts can inject a handler (e.g. the Rust `trash` crate).
     */
    async trash(targets) {
      if (injected.trashHandler) return injected.trashHandler(targets);
      guard('trashHandler');
      if (platform === 'win32') {
        const result = await powershell(`Add-Type -AssemblyName Microsoft.VisualBasic;
          foreach ($target in $data.paths) {
            if ([System.IO.Directory]::Exists($target)) {
              [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
            } else {
              [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target, 'OnlyErrorDialogs', 'SendToRecycleBin', 'ThrowException')
            }
          }`, { paths: targets });
        if (result.code !== 0) throw new FilePluginError(ErrorCode.INTERNAL, 'move to Recycle Bin failed');
        return targets;
      }
      const results = [];
      for (const target of targets) {
        if (!fs.existsSync(target)) {
          throw new FilePluginError(ErrorCode.NOT_FOUND, 'file not found');
        }
        const destinationDir =
          platform === 'darwin'
            ? path.join(config.homeDir, '.Trash')
            : path.join(config.homeDir, '.local', 'share', 'Trash', 'files');
        fs.mkdirSync(destinationDir, { recursive: true });
        let destination = path.join(destinationDir, path.basename(target));
        let suffix = 1;
        while (fs.existsSync(destination)) {
          destination = path.join(destinationDir, `${path.basename(target)}.${suffix++}`);
        }
        fs.renameSync(target, destination);
        results.push(destination);
      }
      return results;
    },

    async archiveList(archivePath, signal) {
      if (injected.archiveHandler) return injected.archiveHandler({ op: 'list', path: archivePath });
      guard('archiveHandler');
      const ext = path.extname(archivePath).toLowerCase();
      const isZip = ['.zip', '.jar'].includes(ext);
      const result = isZip && platform !== 'win32'
        ? await run('unzip', ['-Z1', archivePath], { timeoutMs, signal })
        : await run('tar', ['-tf', archivePath], { timeoutMs, signal });
      if (result.code !== 0) {
        throw new FilePluginError(ErrorCode.INTERNAL, 'archive listing failed');
      }
      const entries = result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((name) => ({
          name,
          path: name,
          isDir: name.endsWith('/'),
          size: 0,
          unsafe: /^[\\/]/.test(name) || /^[a-z]:/i.test(name) || name.split(/[\\/]/).includes('..') || platform === 'win32' && name.includes(':'),
        }));
      // Path-escape members are reported, never extracted (inspect.rs:617).
      return { entries: entries.filter((entry) => !entry.unsafe), rejected: entries.filter((entry) => entry.unsafe).length };
    },

    async createZip(paths, destinationDir, name, signal) {
      if (injected.archiveHandler) return injected.archiveHandler({ op: 'create', paths, dest: destinationDir, name });
      guard('archiveHandler');
      const target = pathsApi.join(destinationDir, name.endsWith('.zip') ? name : `${name}.zip`);
      if (fs.existsSync(target)) throw new FilePluginError(ErrorCode.CONFLICT, 'archive already exists');
      const root = pathsApi.parse(paths[0]).root;
      if (paths.some(source => pathsApi.parse(source).root.toLowerCase() !== root.toLowerCase())) throw new FilePluginError(ErrorCode.INVALID_PARAMETER, 'archive inputs must be on the same volume');
      let cwd = pathsApi.dirname(paths[0]);
      while (!paths.every(source => { const relative = pathsApi.relative(cwd, source); return relative !== '..' && !relative.startsWith('..' + pathsApi.sep) && !pathsApi.isAbsolute(relative); })) cwd = pathsApi.dirname(cwd);
      const relative = paths.map(source => pathsApi.relative(cwd, source));
      const result = platform === 'win32'
        ? await run('tar', ['-a', '-cf', target, '--', ...relative], { timeoutMs, cwd, signal })
        : await run('zip', ['-r', '-q', target, '--', ...relative], { timeoutMs, cwd, signal });
      if (result.code !== 0) throw new FilePluginError(ErrorCode.INTERNAL, 'zip creation failed');
      return { path: target, count: paths.length };
    },

    async extractArchive(archivePath, destinationDir, authorizeMember, signal) {
      if (injected.archiveHandler) return injected.archiveHandler({ op: 'extract', path: archivePath, dest: destinationDir });
      guard('archiveHandler');
      const listing = await system.archiveList(archivePath, signal);
      if (listing.rejected > 0) {
        throw new FilePluginError(ErrorCode.PATH_DENIED, 'archive contains unsafe members');
      }
      // Detailed mode carries member types. Refuse links/devices before any extraction.
      const zip = platform !== 'win32' && ['.zip', '.jar'].includes(path.extname(archivePath).toLowerCase());
      const details = await run(zip ? 'unzip' : 'tar', zip ? ['-Z', '-l', archivePath] : ['-tvf', archivePath], { timeoutMs, signal });
      if (details.code !== 0) throw new FilePluginError(ErrorCode.INTERNAL, 'archive inspection failed');
      const modes = details.stdout.split('\n').filter((line) => /^[bcdhlps-][rwxStTs-]{9}/.test(line));
      if (modes.length !== listing.entries.length || modes.some((line) => !['-', 'd'].includes(line[0]))) {
        throw new FilePluginError(ErrorCode.PATH_DENIED, 'archive contains unsupported or linked members');
      }
      // Existing symlink directories could redirect otherwise harmless members.
      for (const entry of listing.entries) {
        authorizeMember?.(entry.path);
        const parts = entry.path.split(/[\\/]/).filter(Boolean);
        let current = destinationDir;
        for (const part of parts) {
          current = path.join(current, part);
          try {
            if (fs.lstatSync(current).isSymbolicLink()) throw new FilePluginError(ErrorCode.PATH_DENIED, 'archive target contains a symlink');
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      fs.mkdirSync(destinationDir, { recursive: true });
      const ext = path.extname(archivePath).toLowerCase();
      const result = platform !== 'win32' && ['.zip', '.jar'].includes(ext)
        ? await run('unzip', ['-n', '-q', archivePath, '-d', destinationDir], { timeoutMs, signal })
        : await run('tar', ['-xkf', archivePath, '-C', destinationDir], { timeoutMs, signal });
      if (result.code !== 0) throw new FilePluginError(ErrorCode.INTERNAL, 'archive extraction failed');
      return { path: destinationDir, count: listing.entries.length };
    },

    async pdfText(target) {
      if (injected.pdfTextHandler) return injected.pdfTextHandler(target);
      guard('pdfTextHandler');
      const result = await run('pdftotext', [target, '-'], { timeoutMs });
      return result.code === 0 ? result.stdout : '';
    },

    async locate(query) {
      if (injected.locateHandler) return injected.locateHandler(query);
      guard('locateHandler');
      if (platform !== 'darwin') return [];
      const result = await run('mdfind', ['-name', query], { timeoutMs });
      return result.code === 0 ? result.stdout.split('\n').filter(Boolean) : [];
    },
  };

  return system;
}
