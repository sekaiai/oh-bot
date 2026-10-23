import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { superviseChildren } from '../src/cli/start.js';

test('supervisor reports a signalled child as failure and joins its sibling', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'companion-supervisor-'));
  const marker = path.join(root, 'stopped');
  try {
    await writeFile(path.join(root, 'crash.js'), "setTimeout(() => process.kill(process.pid, 'SIGTERM'), 30);\n");
    await writeFile(path.join(root, 'sibling.js'), `process.on('SIGTERM', async () => { await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(marker)}, 'joined')); process.exit(0); }); setInterval(() => {}, 1000);\n`);
    const status = await superviseChildren({ executable: process.execPath, cwd: root, children: [{ script: 'crash.js' }, { script: 'sibling.js' }], graceMs: 1_000 });
    assert.equal(status, 1);
    assert.equal(await readFile(marker, 'utf8'), 'joined');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup stops after a failed step and never runs later steps', async () => {
  const { runSetup } = await import('../src/cli/start.js');
  const calls: string[] = [];
  await assert.rejects(runSetup({ run: async (script) => { calls.push(script); if (script.includes('migrate')) throw new Error('fixture failure'); } }));
  assert.deepEqual(calls, ['database/migrate-cli.js']);
});
