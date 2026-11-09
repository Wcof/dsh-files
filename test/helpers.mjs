import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createFilePlugin } from '../src/index.js';

/** Isolated sandbox: no real home directory, no real OS commands, no ports. */
export async function makeSandbox(overrides = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-files-test-'));
  const trashDir = path.join(dir, '.trash');
  const tools = {
    trashHandler: async (targets) => {
      await fsp.mkdir(trashDir, { recursive: true });
      const moved = [];
      for (const target of targets) {
        const destination = path.join(trashDir, path.basename(target));
        await fsp.rename(target, destination);
        moved.push(destination);
      }
      return moved;
    },
    openHandler: async (target, mode) => ({ ok: true, target, mode }),
    openTrashHandler: async () => ({ ok: true }),
    clipboardHandler: async (payload) => ({ ok: true, ...payload }),
    archiveHandler: async (payload) => ({ ok: true, entries: [], count: 0, ...payload }),
    ...(overrides.tools ?? {}),
  };
  const config = { ...(overrides.config ?? {}) };
  const plugin = createFilePlugin(
    {
      homeDir: dir,
      stateDir: path.join(dir, '.state'),
      tools,
      ...config,
      security: { allowSystemCommands: false, allowWrite: true, safeErrors: true, ...(config.security ?? {}) },
    },
    {}
  );
  await plugin.backend.init?.();
  return { dir, plugin, tools, trashDir };
}

export async function cleanSandbox(sandbox) {
  await sandbox.plugin.dispose();
  await fsp.rm(sandbox.dir, { recursive: true, force: true });
}

export function writeText(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

/** In-memory streams for stdio adapters (NDJSON). */
export function createStreams() {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) sent.push(JSON.parse(line));
    }
  });
  return {
    input,
    output,
    sent,
    send(message) {
      input.write(`${JSON.stringify(message)}\n`);
    },
    /** Wait until at least `count` responses have been written. */
    async waitFor(count, timeoutMs = 2000) {
      const started = Date.now();
      while (sent.length < count) {
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${count} responses, got ${sent.length}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return sent;
    },
    /** Wait for a specific id (notifications may interleave with responses). */
    async waitForId(id, timeoutMs = 2000) {
      const started = Date.now();
      for (;;) {
        const match = sent.find((item) => item.id === id);
        if (match) return match;
        if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for response id ${id}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}
