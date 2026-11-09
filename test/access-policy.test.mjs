import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { AccessPolicy, Operation, resolveConfig, ErrorCode, FilePluginError } from '../src/index.js';

async function sandbox() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-policy-'));
  const config = resolveConfig({ homeDir: dir, stateDir: path.join(dir, '.state') }, {});
  return { dir, policy: new AccessPolicy(config), config };
}

function denied(policy, raw, operation) {
  assert.throws(
    () => policy.authorize(raw, operation),
    (error) => error instanceof FilePluginError && error.code === ErrorCode.PATH_DENIED,
    `expected ${raw} to be denied`
  );
}

test('home subtree is authorized and canonicalized', async () => {
  const { dir, policy } = await sandbox();
  await fsp.mkdir(path.join(dir, 'a'), { recursive: true });
  const handle = policy.authorize(path.join(dir, 'a'), Operation.WRITE);
  assert.equal(handle.path, await fsp.realpath(path.join(dir, 'a')));
  assert.equal(handle.operation, Operation.WRITE);
  assert.equal(policy.authorize('~', Operation.READ).path, await fsp.realpath(dir));
});

test('parent traversal, NUL bytes and sensitive dotfiles are rejected', async () => {
  const { dir, policy } = await sandbox();
  // Keep the literal '..' component (path.join would normalize it away).
  denied(policy, `${dir}/../etc`);
  denied(policy, `${dir}/a/../../etc`);
  denied(policy, `${dir}/a\0b`);
  denied(policy, path.join(dir, '.ssh'));
  denied(policy, path.join(dir, '.aws', 'credentials'));
});

test('out-of-sandbox paths are rejected; ancestors of home are read-only', async () => {
  const { policy } = await sandbox();
  denied(policy, '/etc/passwd');
  // '/' is an ancestor of home but is not itself in any allowlist.
  assert.equal(policy.authorize('/', Operation.READ).path, '/');
  denied(policy, '/', Operation.WRITE);
});

test('system temp roots are allowed', async () => {
  const { policy, config } = await sandbox();
  assert.ok(policy.authorize(config.tempDir, Operation.READ).path);
  assert.ok(policy.authorize('/tmp', Operation.WRITE).path);
});

test('extra roots and blocklists are injectable', async () => {
  const extra = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-extra-'));
  const config = resolveConfig(
    {
      homeDir: os.homedir(),
      allowedRoots: [extra],
      deniedNames: ['SECRET'],
      externalVolumePrefixes: [],
      allowExternalVolumes: false,
    },
    {}
  );
  const policy = new AccessPolicy(config);
  assert.ok(policy.authorize(extra, Operation.WRITE).path);
  denied(policy, path.join(extra, 'SECRET'));
  denied(policy, '/Volumes/Drive/folder');
  const described = policy.describe();
  assert.ok(described.allowedRoots.includes(await fsp.realpath(extra)));
  await fsp.rm(extra, { recursive: true, force: true });
});

test('external volume roots are read-only, descendants may be written', async () => {
  const config = resolveConfig(
    { homeDir: os.homedir(), externalVolumePrefixes: ['/Volumes'], allowExternalVolumes: true },
    {}
  );
  const policy = new AccessPolicy(config);
  assert.equal(policy.authorizeExternalVolume('/Volumes/MyDrive', Operation.READ), true);
  assert.equal(policy.authorizeExternalVolume('/Volumes/MyDrive', Operation.WRITE), false);
  assert.equal(policy.authorizeExternalVolume('/Volumes/MyDrive/docs', Operation.WRITE), true);
});

test('dangling symlinks are rejected instead of treated as plain names', async () => {
  const { dir, policy } = await sandbox();
  await fsp.symlink(path.join(dir, 'does-not-exist'), path.join(dir, 'dangling'));
  denied(policy, path.join(dir, 'dangling'));
});

test('validName mirrors the Rust name rules', async () => {
  const { policy } = await sandbox();
  assert.equal(policy.validName('notes.txt'), true);
  assert.equal(policy.validName('..'), false);
  assert.equal(policy.validName('a/b'), false);
  assert.equal(policy.validName('a\\b'), false);
  assert.equal(policy.validName('a'.repeat(256)), false);
  assert.equal(policy.validName('a\0b'), false);
});
