import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createDatabase } from '../database/database.js';
import { readDeletionJournal } from '../memory/memory-deletion-journal.js';
import { replayRestoredDeletionJournal, verifyRestoredDeletionJournal } from './memory-runtime.js';
import { assertDeletionJournalReplayed } from '../memory/memory-deletion-journal.js';

export type RestoreReplayInput = Readonly<{
  databaseUrl: string;
  historyPath?: string;
  assetRoot: string;
  journalPath: string;
  throughSequence?: number;
}>;
export type RestoreReplayEvidence = Readonly<{
  replayedThrough: number;
  journalSequence: number;
  journalChecksum: string;
  targetDatabase: string;
  journalAssetSha256: string;
}>;

function targetDatabaseName(databaseUrl: string): string {
  let url: URL;
  try { url = new URL(databaseUrl); } catch { throw new Error('restore_database_url_invalid'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('restore_database_url_invalid');
  const name = decodeURIComponent(url.pathname.replace(/^\//u, ''));
  if (!/^[a-z][a-z0-9_-]{0,62}_compat$/u.test(name)) throw new Error('restore_target_not_isolated');
  return name;
}

async function paths(input: RestoreReplayInput) {
  const targetDatabase = targetDatabaseName(input.databaseUrl);
  const assetRoot = await realpath(resolve(input.assetRoot)).catch(() => { throw new Error('restore_asset_root_unavailable'); });
  const journalPath = await realpath(resolve(input.journalPath)).catch(() => { throw new Error('restore_journal_asset_unavailable'); });
  const historyPath = input.historyPath ? await realpath(resolve(input.historyPath)).catch(() => { throw new Error('restore_history_asset_unavailable'); }) : undefined;
  for (const asset of [journalPath, ...(historyPath ? [historyPath] : [])]) {
    const relativePath = relative(assetRoot, asset);
    if (!relativePath || relativePath === '.' || relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
      throw new Error('restore_asset_path_outside_root');
    }
  }
  return { targetDatabase, assetRoot, historyPath, journalPath };
}

async function evidence(input: RestoreReplayInput, replayedThrough: number): Promise<RestoreReplayEvidence> {
  const validated = await paths(input);
  const journal = await readDeletionJournal(validated.journalPath);
  if (replayedThrough !== journal.latestSequence || input.throughSequence !== undefined && input.throughSequence !== journal.latestSequence) throw new Error('deletion_journal_watermark_mismatch');
  const journalBytes = await readFile(validated.journalPath);
  return Object.freeze({
    replayedThrough, journalSequence: journal.latestSequence, journalChecksum: journal.latestChecksum,
    targetDatabase: validated.targetDatabase, journalAssetSha256: createHash('sha256').update(journalBytes).digest('hex'),
  });
}

function restoreEnvironment(historyPath?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (historyPath) env.COMPANION_MEMORY_HISTORY_PATH = historyPath;
  else delete env.COMPANION_MEMORY_HISTORY_PATH;
  return env;
}

/** Replay against explicit restored paths only; never mutates process-wide environment. */
export async function replayDeletionJournal(input: RestoreReplayInput): Promise<RestoreReplayEvidence> {
  const validated = await paths(input);
  const journal = await readDeletionJournal(validated.journalPath);
  if (input.throughSequence === undefined || input.throughSequence !== journal.latestSequence) throw new Error('deletion_journal_watermark_mismatch');
  const database = createDatabase(input.databaseUrl);
  try {
    const replayed = validated.historyPath
      ? await replayRestoredDeletionJournal({ database, databaseUrl: input.databaseUrl, journalPath: validated.journalPath, throughSequence: input.throughSequence,
        historyPath: validated.historyPath, env: restoreEnvironment(validated.historyPath) })
      : await (async () => { await assertDeletionJournalReplayed(database, validated.journalPath); return journal.latestSequence; })();
    return evidence(input, replayed);
  } finally { await database.close(); }
}

export async function verifyDeletionJournalReplay(input: Omit<RestoreReplayInput, 'throughSequence'>): Promise<RestoreReplayEvidence> {
  const validated = await paths(input);
  const database = createDatabase(input.databaseUrl);
  try {
    const replayed = validated.historyPath ? await verifyRestoredDeletionJournal({
      database, databaseUrl: input.databaseUrl, journalPath: validated.journalPath, historyPath: validated.historyPath, env: restoreEnvironment(validated.historyPath),
    }) : await (async () => { await assertDeletionJournalReplayed(database, validated.journalPath); return (await readDeletionJournal(validated.journalPath)).latestSequence; })();
    return evidence(input, replayed);
  } finally { await database.close(); }
}
