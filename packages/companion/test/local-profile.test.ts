import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, lstat, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateLocalProfile } from '../src/cli/local-profile.js';

test('local CLI profile is private, stable across restart, and reserves synthetic identity namespace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oh-local-profile-'));
  try {
    const path = join(root, 'nested', 'profile.json');
    const first = await loadOrCreateLocalProfile(path);
    const second = await loadOrCreateLocalProfile(path);
    assert.deepEqual(second, first);
    assert.match(first.userId, /^local-cli:user:/);
    assert.match(first.channelId, /^local-cli:channel:/);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), first);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local CLI profile rejects malformed files, symlinks, and permissive modes without overwriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oh-local-profile-'));
  try {
    const malformed = join(root, 'malformed.json');
    await writeFile(malformed, '{"characterId":"someone-elses"}', { mode: 0o600 });
    await assert.rejects(loadOrCreateLocalProfile(malformed), { message: 'local_profile_invalid' });
    assert.equal(await readFile(malformed, 'utf8'), '{"characterId":"someone-elses"}');

    const secret = join(root, 'target.json');
    await writeFile(secret, '{}', { mode: 0o600 });
    const link = join(root, 'link.json');
    await symlink(secret, link);
    await assert.rejects(loadOrCreateLocalProfile(link), { message: 'local_profile_invalid' });

    const insecure = join(root, 'insecure.json');
    await writeFile(insecure, '{}', { mode: 0o644 });
    await chmod(insecure, 0o644);
    await assert.rejects(loadOrCreateLocalProfile(insecure), { message: 'local_profile_invalid' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
