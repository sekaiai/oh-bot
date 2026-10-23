import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  createLegacyBackup,
  createPostgresLegacyAdapter,
  migrateLegacyJson,
  restoreSnapshot,
  runDatabaseBackup,
  restoredHistoryAssetPath,
  verifyRestoreReadiness,
  type CommandExecutor,
} from '../operations/index.js';
import { runScheduledBackupSchedule } from '../operations/runner.js';
import { initializeDeletionJournal, readDeletionJournal } from '../memory/memory-deletion-journal.js';

const args = process.argv.slice(2);
const command = args.shift();

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function list(name: string): string[] {
  return args.flatMap((argument, index) => argument === name && args[index + 1] ? [args[index + 1]!] : []);
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error('INPUT_REQUIRED');
  return value;
}

const execute: CommandExecutor = async (binary, commandArgs, extraEnvironment) => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, commandArgs, {
      stdio: 'ignore',
      env: { ...process.env, ...extraEnvironment },
    });
    child.once('error', () => reject(new Error('EXECUTOR_UNAVAILABLE')));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('EXECUTOR_FAILED')));
  });
};

async function createLegacyMigrationAdapter() {
  const override = process.env.LEGACY_MIGRATION_ADAPTER_MODULE;
  if (override) return await import(override);
  const databaseUrl = process.env.COMPANION_DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_CONFIGURATION_MISSING');
  return createPostgresLegacyAdapter(databaseUrl);
}

async function main(): Promise<void> {
  if (command === 'journal-init') {
    const file = option('--deletion-journal') ?? process.env.MEMORY_DELETION_JOURNAL_PATH;
    if (!file) throw new Error('INPUT_REQUIRED');
    let initialized = false;
    try { await initializeDeletionJournal(file); initialized = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await readDeletionJournal(file); // validate an existing journal before allowing init to complete
    }
    process.stdout.write(`${JSON.stringify({ initialized, validatedExisting: !initialized })}\n`);
    return;
  }

  if (command === 'schedule') {
    process.stdout.write(`${JSON.stringify(await runScheduledBackupSchedule({ env: process.env, execute }))}\n`);
    return;
  }

  if (command === 'legacy-backup') {
    const result = await createLegacyBackup({ sourcePaths: list('--source'), outputDirectory: required('--output') });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === 'legacy-migrate') {
    const adapter = await createLegacyMigrationAdapter();
    try {
      const result = await migrateLegacyJson({
        sourceKind: required('--source-kind') as import('../operations/index.js').LegacySourceKind,
        sourcePath: required('--source'),
        backupManifestPath: required('--backup-manifest'),
        hasMigrated: adapter.hasMigrated,
        execute: adapter.importLegacyRecords,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
      await adapter.close?.();
    }
    return;
  }

  if (command === 'backup') {
    const databaseUrl = process.env.COMPANION_DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_CONFIGURATION_MISSING');
    const result = await runDatabaseBackup({
      outputDirectory: required('--output'),
      databaseUrl,
      assets: list('--asset'),
      deletionJournalPath: option('--deletion-journal') ?? process.env.MEMORY_DELETION_JOURNAL_PATH ?? required('--deletion-journal'),
      execute,
      resticRepository: process.env.RESTIC_REPOSITORY,
      environment: process.env.RESTIC_PASSWORD_FILE ? { RESTIC_PASSWORD_FILE: process.env.RESTIC_PASSWORD_FILE } : {},
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (command === 'verify-restore') {
    const targetDatabaseUrl = process.env.RESTORE_DATABASE_URL;
    if (!targetDatabaseUrl) throw new Error('DATABASE_CONFIGURATION_MISSING');
    const rootDirectory = required('--root');
    const manifest = JSON.parse(await readFile(required('--manifest'), 'utf8'));
    const historyPath = restoredHistoryAssetPath(manifest, rootDirectory, process.env.COMPANION_MEMORY_HISTORY_PATH);
    const replayModule = process.env.DELETION_JOURNAL_REPLAY_MODULE
      ? await import(process.env.DELETION_JOURNAL_REPLAY_MODULE)
      : await import('../application/restore-replay-adapter.js');
    const journalPath = required('--deletion-journal');
    const receipt = await replayModule.verifyDeletionJournalReplay({
      databaseUrl: targetDatabaseUrl,
      historyPath,
      assetRoot: rootDirectory,
      journalPath,
    });
    process.stdout.write(`${JSON.stringify(await verifyRestoreReadiness({
      manifest,
      rootDirectory,
      targetDatabaseUrl,
      receipt,
      replayedHistoryAssetPath: historyPath ? relative(resolve(rootDirectory), historyPath) : undefined,
    }))}\n`);
    return;
  }

  if (command === 'restore') {
    const targetDatabaseUrl = process.env.RESTORE_DATABASE_URL;
    if (!targetDatabaseUrl) throw new Error('DATABASE_CONFIGURATION_MISSING');
    const replayModule = process.env.DELETION_JOURNAL_REPLAY_MODULE
      ? await import(process.env.DELETION_JOURNAL_REPLAY_MODULE)
      : await import('../application/restore-replay-adapter.js');
    const assetsTo = required('--assets-to');
    const manifestPath = required('--manifest');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const historyPath = restoredHistoryAssetPath(manifest, assetsTo, process.env.COMPANION_MEMORY_HISTORY_PATH);
    process.stdout.write(`${JSON.stringify(await restoreSnapshot({
      manifestPath,
      rootDirectory: required('--root'),
      restoreAssetDirectory: assetsTo,
      targetDatabaseUrl,
      deletionJournalPath: required('--deletion-journal'),
      execute,
      replayDeletionJournal: async (journalPath: string, throughSequence: number) => replayModule.replayDeletionJournal({
        databaseUrl: targetDatabaseUrl,
        historyPath,
        assetRoot: assetsTo,
        journalPath,
        throughSequence,
      }),
      isolatedTarget: process.env.RESTORE_ISOLATED === 'true',
    }))}\n`);
    return;
  }

  throw new Error('COMMAND_INVALID');
}

main().catch((error: unknown) => {
  const code = error instanceof Error && error.name === 'OperationError' ? error.message :
    error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : 'OPERATION_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
