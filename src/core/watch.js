import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** One bounded batch retains every changed name; overflow invalidates the directory. */
export function watchDirectory(target, config, emit) {
  const known = new Set(fs.readdirSync(target).slice(0, config.limits.maxDiskUsageEntries));
  let pending = new Map();
  let count = 0;
  let overflow = false;
  let timer;
  let running = false;
  let closed = false;
  let initialScan = true;

  const record = (name) => {
    count = Math.min(count + 1, config.limits.maxWatchEvents);
    if (!name || pending.size >= config.limits.maxWatchEvents && !pending.has(name)) overflow = true;
    else pending.set(name, true);
  };

  const schedule = () => {
    if (closed || timer || running) return;
    timer = setTimeout(flush, config.limits.watchDebounceMs);
    timer.unref?.();
  };
  async function flush() {
    timer = undefined;
    if (closed) return;
    running = true;
    let batchCount = count;
    const changes = [];
    try {
      // Native subscriptions can miss changes made immediately after startup.
      // Reconcile names once, within the same bounded batch as native signals.
      if (initialScan) {
        initialScan = false;
        const current = new Set();
        let complete = true;
        const directory = await fsp.opendir(target);
        for await (const entry of directory) {
          if (closed) return;
          if (current.size >= config.limits.maxDiskUsageEntries) {
            complete = false;
            overflow = true;
            break;
          }
          current.add(entry.name);
          if (!known.has(entry.name) && !pending.has(entry.name)) record(entry.name);
        }
        if (complete) {
          for (const name of known) if (!current.has(name) && !pending.has(name)) record(name);
        }
      }
      if (closed) return;
      const names = [...pending.keys()];
      batchCount = count;
      const batchOverflow = overflow;
      pending = new Map();
      count = 0;
      overflow = false;
      for (const name of names) {
        if (closed) return;
        if (!name) continue;
        const full = path.join(target, name);
        const info = await fsp.lstat(full).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        const existed = known.has(name);
        if (info) {
          if (known.size < config.limits.maxDiskUsageEntries) known.add(name);
          changes.push({ path: full, kind: existed ? 'modified' : 'created' });
        } else if (existed) {
          known.delete(name);
          changes.push({ path: full, kind: 'removed' });
        }
      }
      if (!closed && (changes.length || batchOverflow)) {
        const last = changes.at(-1);
        emit('fs_changed', {
          kind: last?.kind ?? 'modified', path: last?.path ?? target,
          count: batchCount, directory: target, changes, overflow: batchOverflow,
        });
      }
    } catch {
      if (!closed) emit('fs_changed', { kind: 'modified', path: target, count: batchCount, directory: target, changes: [], overflow: true });
    } finally {
      running = false;
      if (count) schedule();
    }
  }
  const watcher = fs.watch(target, { recursive: false }, (_event, filename) => {
    if (closed) return;
    const name = filename ? String(filename) : '';
    record(name);
    schedule();
  });
  watcher.on('error', () => {
    if (!closed) emit('error', { path: target, message: 'filesystem watch failed; restart the watch' });
    close();
  });
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    pending.clear();
    known.clear();
    watcher.close();
  }
  schedule();
  return { close, get closed() { return closed; } };
}
