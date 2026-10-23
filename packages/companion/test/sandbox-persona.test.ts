import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSandboxPersona, saveSandboxPersona } from '../src/cli/chat.js';

test('sandbox persona calibration persists only the isolated local persona file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-sandbox-'));
  const file = join(root, 'sandbox', 'persona.json');
  try {
    assert.equal(await loadSandboxPersona(file), '');
    await saveSandboxPersona(file, 'A patient, candid trial character.');
    assert.equal(await loadSandboxPersona(file), 'A patient, candid trial character.');
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, persona: 'A patient, candid trial character.' });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const bad = join(root, 'bad.json');
    await writeFile(bad, '{"version":1,"persona":false}', { mode: 0o600 });
    await assert.rejects(loadSandboxPersona(bad));
    await saveSandboxPersona(file, 'Updated trial persona.');
    assert.equal(await loadSandboxPersona(file), 'Updated trial persona.');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
