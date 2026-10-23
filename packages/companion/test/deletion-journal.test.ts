import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendDeletionJournal, initializeDeletionJournal, readDeletionJournal, replayDeletionJournal } from '../src/memory/memory-deletion-journal.js';
import { uuid } from './helpers.js';

test('deletion journal fsync appends tombstones and replay coalesces duplicate operations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'companion-deletions-'));
  const file = path.join(directory, 'journal.jsonl');
  const entry = { operationKey: 'forget:one', characterId: uuid(), sourceIds: [uuid()], memoryIds: ['mem-one'], scope: { kind: 'person_private' as const, personId: uuid() } };
  try {
    await initializeDeletionJournal(file);
    await appendDeletionJournal(file, entry);
    await appendDeletionJournal(file, entry);
    await Promise.all(Array.from({ length: 8 }, (_, index) => appendDeletionJournal(file, {
      ...entry, operationKey: `forget:parallel:${index}`, memoryIds: [`mem-${index}`],
    })));
    const replayed: string[] = [];
    const count = await replayDeletionJournal(file, async (item) => { replayed.push(item.operationKey); });
    assert.equal(count, 9);
    const state = await readDeletionJournal(file);
    assert.equal(state.latestSequence, 9);
    assert.equal(state.entries[0]?.checksum.length, 64);
    assert.equal(new Set(state.entries.map((item) => item.sequence)).size, 9);
    assert.ok(replayed.includes('forget:one'));
    await assert.rejects(appendDeletionJournal(file, { ...entry, memoryIds: ['different-memory'] }), /conflicts/);
    await writeFile(file, '{bad json}\n');
    await assert.rejects(replayDeletionJournal(file, async () => undefined), /corrupt at line 1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('journal init is restart-safe and validates existing contents instead of truncating them', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'companion-journal-init-'));
  const file = path.join(directory, 'journal.jsonl');
  const entry = { operationKey: 'restart-safe', characterId: uuid(), sourceIds: [uuid()], memoryIds: ['mem-one'], scope: { kind: 'person_private' as const, personId: uuid() } };
  try {
    await initializeDeletionJournal(file);
    await appendDeletionJournal(file, entry);
    await initializeDeletionJournal(file);
    assert.equal((await readDeletionJournal(file)).entries.length, 1);
    await writeFile(file, '{corrupt}\n');
    await assert.rejects(initializeDeletionJournal(file), /corrupt at line 1/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
