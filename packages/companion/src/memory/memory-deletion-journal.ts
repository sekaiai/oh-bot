import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { deletionRecords } from '../database/schema/index.js';
import type { Database } from '../database/database.js';
import { visibilityScopeSchema } from '../domain/contracts.js';

const fields = {
  sequence: z.number().int().positive(), operationKey: z.string().min(1), characterId: z.string().uuid(),
  sourceIds: z.array(z.string().uuid()), memoryIds: z.array(z.string().min(1)), scope: visibilityScopeSchema,
  recordedAt: z.string().datetime(), previousChecksum: z.string().regex(/^[a-f0-9]{64}$/),
};
export const deletionJournalEntrySchema = z.object({ ...fields, checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type DeletionJournalEntry = z.infer<typeof deletionJournalEntrySchema>;
export type DeletionJournalInput = Omit<DeletionJournalEntry, 'sequence' | 'recordedAt' | 'previousChecksum' | 'checksum'>;

function checksum(entry: Omit<DeletionJournalEntry, 'checksum'>): string {
  // Explicit order makes the digest independent of object construction/spread order.
  const canonical = {
    sequence: entry.sequence, operationKey: entry.operationKey, characterId: entry.characterId,
    sourceIds: entry.sourceIds, memoryIds: entry.memoryIds, scope: entry.scope,
    recordedAt: entry.recordedAt, previousChecksum: entry.previousChecksum,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Creates an empty journal only during explicit fresh initialization. */
export async function initializeDeletionJournal(file: string): Promise<void> {
  const absolute = path.resolve(file);
  await mkdir(path.dirname(absolute), { recursive: true });
  let handle;
  try { handle = await open(absolute, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // Init runs on normal restarts too. Existing state is accepted only after
    // full strict chain validation; it is never silently replaced or truncated.
    await readDeletionJournal(absolute);
    return;
  }
  await handle.sync();
  await handle.close();
  const directory = await open(path.dirname(absolute), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function acquireJournalLock(file: string) {
  const lockPath = `${file}.lock`;
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      const lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(`${process.pid}\n${randomUUID()}\n`);
      await lock.sync();
      return async () => { await lock.close(); await unlink(lockPath).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A shared volume may be mounted into containers with separate PID
      // namespaces. ESRCH therefore cannot prove that the lock owner died.
      // Never evict a lock automatically; after bounded waiting, fail closed
      // and require offline operator recovery of a demonstrably stale lock.
      try { await readFile(lockPath, 'utf8'); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code === 'ENOENT') continue; throw statError; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('deletion journal lock is unavailable');
}

/** Serialize restore/replay snapshots with appenders using the same journal lock. */
export async function withDeletionJournalLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const release = await acquireJournalLock(path.resolve(file));
  try { return await action(); } finally { await release(); }
}

export async function readDeletionJournal(file: string): Promise<{ entries: DeletionJournalEntry[]; latestSequence: number; latestChecksum: string }> {
  const content = await readFile(path.resolve(file), 'utf8');
  const entries: DeletionJournalEntry[] = [];
  let priorChecksum = '0'.repeat(64);
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(`deletion journal is corrupt at line ${index + 1}`); }
    const parsed = deletionJournalEntrySchema.safeParse(value);
    const entry = parsed.success ? parsed.data : undefined;
    if (!entry || entry.sequence !== entries.length + 1 || entry.previousChecksum !== priorChecksum || checksum({
      sequence: entry.sequence, operationKey: entry.operationKey, characterId: entry.characterId, sourceIds: entry.sourceIds,
      memoryIds: entry.memoryIds, scope: entry.scope, recordedAt: entry.recordedAt, previousChecksum: entry.previousChecksum,
    }) !== entry.checksum) throw new Error(`deletion journal is corrupt at line ${index + 1}`);
    const previous = entries.find((item) => item.operationKey === entry.operationKey);
    if (previous && (previous.characterId !== entry.characterId || previous.scope.kind !== entry.scope.kind ||
        JSON.stringify(previous.scope) !== JSON.stringify(entry.scope) ||
        previous.sourceIds.join(',') !== entry.sourceIds.join(',') ||
        previous.memoryIds.join(',') !== entry.memoryIds.join(','))) throw new Error(`deletion journal has conflicting operation at line ${index + 1}`);
    priorChecksum = entry.checksum;
    entries.push(entry);
  }
  return { entries, latestSequence: entries.at(-1)?.sequence ?? 0, latestChecksum: priorChecksum };
}

/** Append and fsync; operation keys are idempotent and conflicting replays fail closed. */
export async function appendDeletionJournal(file: string, input: DeletionJournalInput): Promise<DeletionJournalEntry> {
  const absolute = path.resolve(file);
  const release = await acquireJournalLock(absolute);
  try {
    const state = await readDeletionJournal(absolute);
    const prior = state.entries.find((entry) => entry.operationKey === input.operationKey);
    if (prior) {
      if (prior.characterId !== input.characterId || JSON.stringify(prior.scope) !== JSON.stringify(input.scope) ||
          prior.sourceIds.join(',') !== input.sourceIds.join(',') || prior.memoryIds.join(',') !== input.memoryIds.join(',')) throw new Error('deletion journal operation conflicts');
      return prior;
    }
    const body = { ...input, sequence: state.latestSequence + 1, recordedAt: new Date().toISOString(), previousChecksum: state.latestChecksum };
    const entry = deletionJournalEntrySchema.parse({ ...body, checksum: checksum(body) });
    const handle = await open(absolute, 'a');
    try { await handle.writeFile(`${JSON.stringify(entry)}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    return entry;
  } finally { await release(); }
}

export async function replayDeletionJournal(file: string, apply: (entry: DeletionJournalEntry) => Promise<void>, throughSequence?: number): Promise<number> {
  const state = await readDeletionJournal(file);
  if (throughSequence !== undefined && (!Number.isSafeInteger(throughSequence) || throughSequence < 0 || throughSequence > state.latestSequence)) throw new Error('deletion journal watermark is unavailable');
  const through = throughSequence ?? state.latestSequence;
  let count = 0;
  for (const entry of state.entries) {
    if (entry.sequence > through) break;
    await apply(entry);
    count++;
  }
  return count;
}

/** Prevents recall/index activation unless the external journal is present and fully represented. */
export async function assertDeletionJournalReplayed(database: Database, file: string): Promise<void> {
  const { entries } = await readDeletionJournal(file);
  const [pending] = await database.db.select({ id: deletionRecords.id }).from(deletionRecords).where(eq(deletionRecords.status, 'pending')).limit(1);
  if (pending) throw new Error('deletion journal replay is incomplete');
  const records = await database.db.select().from(deletionRecords);
  const recordsByOperation = new Map(records.map((record) => [record.operationKey, record]));
  for (const entry of entries) {
    const record = recordsByOperation.get(entry.operationKey);
    if (!record || record.status !== 'applied' || record.journalSequence !== BigInt(entry.sequence) ||
        record.characterId !== entry.characterId || JSON.stringify(record.scope) !== JSON.stringify(entry.scope) ||
        record.sourceIds.join(',') !== entry.sourceIds.join(',') || entry.memoryIds.some((id) => !record.memoryIds.includes(id))) {
      throw new Error('deletion journal replay is incomplete');
    }
  }
}

export async function pendingDeletionJournal(database: Database) {
  return database.db.select().from(deletionRecords).where(eq(deletionRecords.status, 'pending')).orderBy(deletionRecords.journalSequence);
}
