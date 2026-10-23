import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createLegacyBackup, createPostgresLegacyAdapter, migrateLegacyJson, pruneByRetention, restoreSnapshot, restoredHistoryAssetPath, runDatabaseBackup, verifyRestoreReadiness, type CommandExecutor, type LegacySourceKind } from './index.js';
import { readDeletionJournal } from '../memory/memory-deletion-journal.js';

export type OperationsAction = { action: 'create' | 'verify' | 'restore' | 'inspect' | 'backup' | 'apply'; backupId?: string; sourceId?: string; expectedVersion?: string; auditReason: string; confirm: true };
export type RunnerConfig = { env?: NodeJS.ProcessEnv; execute?: CommandExecutor };
const stable = (code: string): Error => Object.assign(new Error(code), { name: 'OperationError' });
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export type ScheduledBackupBucket = { kind: 'six_hourly' | 'daily' | 'weekly' | 'monthly'; key: string };

function isoWeek(date: Date): { year: number; week: number } {
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const year = thursday.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7) + 3);
  return { year, week: 1 + Math.round((thursday.getTime() - first.getTime()) / (7 * 24 * 60 * 60_000)) };
}

export function scheduledBackupBuckets(now = new Date()): ScheduledBackupBucket[] {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const hour = String(Math.floor(now.getUTCHours() / 6) * 6).padStart(2, '0');
  const week = isoWeek(now);
  return [
    { kind: 'six_hourly', key: `six-hourly-${year}-${month}-${day}-${hour}` },
    { kind: 'daily', key: `daily-${year}-${month}-${day}` },
    { kind: 'weekly', key: `weekly-${week.year}-${String(week.week).padStart(2, '0')}` },
    { kind: 'monthly', key: `monthly-${year}-${month}` },
  ];
}

export function operationsScheduleStatus(env: NodeJS.ProcessEnv): { configured: boolean; ready: boolean; enabled: boolean; monthlyRestoreConfigured: boolean; missing: string[] } {
  const missing = ['COMPANION_BACKUP_ROOT', 'COMPANION_DATABASE_URL', 'MEMORY_DELETION_JOURNAL_PATH']
    .filter((key) => !env[key]?.trim());
  const monthlyMissing = ['COMPANION_RESTORE_ROOT', 'COMPANION_MONTHLY_RESTORE_DATABASE_URL']
    .filter((key) => !env[key]?.trim());
  const enabled = env.COMPANION_BACKUP_SCHEDULE_ENABLED === 'true';
  const allMissing = [...missing, ...monthlyMissing];
  return { configured: allMissing.length === 0, ready: allMissing.length === 0 && enabled, enabled, monthlyRestoreConfigured: monthlyMissing.length === 0, missing: allMissing };
}

/** Idempotent scheduler entrypoint for the opt-in six-hour host cron. */
export async function runScheduledBackupSchedule(input: {
  env: NodeJS.ProcessEnv;
  execute?: CommandExecutor;
  now?: Date;
  runMonthlyRestore?: (input: { manifestPath: string; backupRoot: string; restoreAssetDirectory: string; targetDatabaseUrl: string; deletionJournalPath: string; historyPath?: string; execute: CommandExecutor }) => Promise<{ ready: boolean; journalChecksum: string }>;
}) {
  const status = operationsScheduleStatus(input.env);
  if (!status.ready) return { ...status, created: [], skipped: [], pruned: [], message: 'scheduled backup service is disabled or missing configuration' };
  const env = input.env;
  const root = await configuredPath(env, 'COMPANION_BACKUP_ROOT');
  const lockPath = join(root, '.scheduled-backup.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { ...status, ready: false, created: [], skipped: [], pruned: [], message: 'scheduled backup is already running' };
    throw error;
  }
  const marker = env.COMPANION_BACKUP_OWNER ?? 'companion-operations-v1';
  const created: string[] = [];
  const skipped: string[] = [];
  try {
    await lock.writeFile(`${process.pid}\n`); await lock.sync();
    const assets = (env.COMPANION_BACKUP_ASSET_ROOTS ?? '').split(',').map((path) => path.trim()).filter(Boolean);
    for (const bucket of scheduledBackupBuckets(input.now)) {
      const output = join(root, bucket.key);
      let outputExists = false;
      try {
        await lstat(output);
        outputExists = true;
        const savedManifest = JSON.parse(await readFile(join(output, 'backup-manifest.json'), 'utf8')) as { kind?: string };
        const owner = (await readFile(join(output, '.companion-backup-owner'), 'utf8')).trim();
        if (owner !== marker || savedManifest.kind !== `scheduled_${bucket.kind}`) throw stable('SCHEDULED_BACKUP_INCOMPLETE');
        skipped.push(bucket.key);
      } catch (error) {
        if (error instanceof Error && error.name === 'OperationError') throw error;
        if (outputExists) throw stable('SCHEDULED_BACKUP_INCOMPLETE');
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw stable('SCHEDULED_BACKUP_INCOMPLETE');
      }
      let manifestPath = join(output, 'backup-manifest.json');
      if (!outputExists) {
        await mkdir(output, { recursive: false });
        const backup = await runDatabaseBackup({ outputDirectory: output, databaseUrl: required(env, 'COMPANION_DATABASE_URL'), assets,
          deletionJournalPath: required(env, 'MEMORY_DELETION_JOURNAL_PATH'), execute: input.execute ?? externalExecutor(env),
          resticRepository: env.RESTIC_REPOSITORY, environment: env.RESTIC_PASSWORD_FILE ? { RESTIC_PASSWORD_FILE: env.RESTIC_PASSWORD_FILE } : {}, kind: `scheduled_${bucket.kind}` });
        await writeFile(join(output, '.companion-backup-owner'), `${marker}\n`, { flag: 'wx' });
        created.push(bucket.key);
        manifestPath = backup.manifestPath;
      }
      if (bucket.kind === 'monthly') {
        const monthlyUrl = required(env, 'COMPANION_MONTHLY_RESTORE_DATABASE_URL');
        const restoreRoot = await configuredPath(env, 'COMPANION_RESTORE_ROOT');
        const monthlyDatabase = decodeURIComponent(new URL(monthlyUrl).pathname.slice(1));
        if (!monthlyDatabase.endsWith('_compat')) throw stable('RESTORE_TARGET_NOT_COMPAT');
        const assetsTo = join(restoreRoot, `monthly-${bucket.key}`);
        let drillComplete = false;
        try {
          const drill = JSON.parse(await readFile(join(assetsTo, '.monthly-restore-ready.json'), 'utf8')) as { bucket?: string; backupManifestHash?: string; ready?: boolean };
          drillComplete = drill.bucket === bucket.key && drill.backupManifestHash === hash(await readFile(manifestPath)) && drill.ready === true;
        } catch { /* an absent/invalid receipt causes a fresh isolated drill attempt */ }
        if (!drillComplete) {
          const backupManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
          const historyPath = restoredHistoryAssetPath(backupManifest, assetsTo, env.COMPANION_MEMORY_HISTORY_PATH);
          const execute = input.execute ?? externalExecutor(env);
          let readiness: { ready: boolean; journalChecksum: string };
          if (input.runMonthlyRestore) {
            readiness = await input.runMonthlyRestore({ manifestPath, backupRoot: output, restoreAssetDirectory: assetsTo, targetDatabaseUrl: monthlyUrl,
              deletionJournalPath: required(env, 'MEMORY_DELETION_JOURNAL_PATH'), historyPath, execute });
          } else {
            const adapter = await import('../application/restore-replay-adapter.js');
            readiness = await restoreSnapshot({ manifestPath, rootDirectory: output, restoreAssetDirectory: assetsTo,
              targetDatabaseUrl: monthlyUrl, deletionJournalPath: required(env, 'MEMORY_DELETION_JOURNAL_PATH'), execute, isolatedTarget: true,
              replayDeletionJournal: (journalPath, throughSequence) => adapter.replayDeletionJournal({ databaseUrl: monthlyUrl, historyPath, assetRoot: assetsTo, journalPath, throughSequence }) });
          }
          await writeFile(join(assetsTo, '.monthly-restore-ready.json'), `${JSON.stringify({ bucket: bucket.key, backupManifestHash: hash(await readFile(manifestPath)), ready: readiness.ready, journalChecksum: readiness.journalChecksum })}\n`, { flag: 'wx' });
        }
      }
    }
    const entries = await readdir(root, { withFileTypes: true });
    const backups = [] as Array<{ path: string; createdAt: string; kind?: 'six_hourly' | 'daily' | 'weekly' | 'monthly' }>;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^(six-hourly|daily|weekly|monthly)-/.test(entry.name)) continue;
      const path = join(root, entry.name);
      try {
        const manifest = JSON.parse(await readFile(join(path, 'backup-manifest.json'), 'utf8')) as { createdAt?: string; kind?: string };
        const kind = manifest.kind?.replace('scheduled_', '') as 'six_hourly' | 'daily' | 'weekly' | 'monthly' | undefined;
        if (typeof manifest.createdAt === 'string' && ['six_hourly', 'daily', 'weekly', 'monthly'].includes(kind ?? '')) backups.push({ path, createdAt: manifest.createdAt, kind });
      } catch { /* pruneByRetention requires a valid manifest before deleting */ }
    }
    const pruned = await pruneByRetention({ backups, now: input.now, ownershipMarker: marker,
      validateManifest: async (path) => {
        try {
          const manifest = JSON.parse(await readFile(path, 'utf8')) as { format?: number; assets?: Array<{ path?: string; sha256?: string; sizeBytes?: number }>; deletionJournalSequence?: number; deletionJournalChecksum?: string; deletionJournalPath?: string };
          if (manifest.format !== 1 || !Array.isArray(manifest.assets) || !manifest.assets.length || !Number.isSafeInteger(manifest.deletionJournalSequence) ||
              !/^[a-f0-9]{64}$/.test(manifest.deletionJournalChecksum ?? '') || !manifest.deletionJournalPath) return false;
          const directory = dirname(path);
          for (const asset of manifest.assets) {
            if (!asset.path || isAbsolute(asset.path) || asset.path.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') ||
                !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes! < 0) return false;
            const bytes = await readFile(join(directory, asset.path));
            if (bytes.length !== asset.sizeBytes || hash(bytes) !== asset.sha256) return false;
          }
          const journalPath = join(directory, manifest.deletionJournalPath);
          const journal = await readDeletionJournal(journalPath);
          return journal.latestSequence === manifest.deletionJournalSequence && journal.latestChecksum === manifest.deletionJournalChecksum;
        } catch { return false; }
      },
      remove: async (path) => { await rm(path, { recursive: true, force: false }); } });
    return { ...status, ready: true, created, skipped, pruned: pruned.map((path) => basename(path)), message: 'scheduled backups checked and retention applied' };
  } finally {
    await lock.close(); await unlink(lockPath).catch(() => undefined);
  }
}

function externalExecutor(environment: NodeJS.ProcessEnv): CommandExecutor {
  return async (binary, args, extra = {}) => new Promise<void>((resolvePromise, reject) => {
    const child = spawn(binary, args, { stdio: 'ignore', env: { ...environment, ...extra } });
    child.once('error', () => reject(stable('EXECUTOR_UNAVAILABLE')));
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(stable('EXECUTOR_FAILED')));
  });
}

async function configuredPath(env: NodeJS.ProcessEnv, name: string): Promise<string> {
  const value = env[name];
  if (!value) throw stable(`${name}_REQUIRED`);
  return realpath(resolve(value)).catch(() => { throw stable(`${name}_UNAVAILABLE`); });
}
function assertId(id: string | undefined, code: string): string {
  if (!id || !idPattern.test(id) || id.startsWith('/') || id.includes('\\') || id.split('/').some((segment) => !segment || segment === '.' || segment === '..')) throw stable(code);
  return id;
}
async function childDirectory(root: string, id: string): Promise<string> {
  const target = resolve(root, id);
  if (!target.startsWith(root + sep)) throw stable('OPERATION_ID_REJECTED');
  const info = await lstat(target).catch(() => { throw stable('OPERATION_NOT_FOUND'); });
  if (!info.isDirectory() || info.isSymbolicLink()) throw stable('OPERATION_PATH_REJECTED');
  const real = await realpath(target);
  if (relative(root, real).startsWith('..')) throw stable('OPERATION_PATH_REJECTED');
  return real;
}
function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw stable(`${key}_REQUIRED`);
  return value;
}
async function sourceFile(env: NodeJS.ProcessEnv, sourceId: string): Promise<{ root: string; id: string; path: string; kind: LegacySourceKind }> {
  const root = await configuredPath(env, 'COMPANION_LEGACY_SOURCE_ROOT');
  const id = assertId(sourceId, 'SOURCE_ID_REQUIRED');
  const path = resolve(root, id);
  if (!path.startsWith(root + sep)) throw stable('SOURCE_ID_REJECTED');
  const info = await lstat(path).catch(() => { throw stable('LEGACY_SOURCE_MISSING'); });
  if (!info.isFile() || info.isSymbolicLink()) throw stable('LEGACY_SOURCE_INVALID');
  const real = await realpath(path);
  if (!real.startsWith(root + sep)) throw stable('SOURCE_ID_REJECTED');
  const file = basename(path);
  const relative = real.slice(root.length + 1).split(sep).join('/');
  const kinds: Record<string, LegacySourceKind> = { 'sessions.json': 'sessions', 'personas.json': 'personas', 'rules.json': 'rules', 'affection.json': 'affection' };
  const kind = relative.startsWith('affection/') && ['users.json', 'self.json', 'config.json'].includes(file) ? 'affection' : kinds[file];
  if (!kind) throw stable('LEGACY_SOURCE_KIND_UNSUPPORTED');
  return { root, id: relative, path: real, kind };
}

/** Action-only facade for authenticated admin controllers. Caller resolves/audits action; raw paths and commands are never accepted. */
export class CompanionOperationsRunner {
  private readonly env: NodeJS.ProcessEnv;
  private readonly execute: CommandExecutor;
  constructor(config: RunnerConfig = {}) {
    this.env = config.env ?? process.env;
    this.execute = config.execute ?? externalExecutor(this.env);
  }

  /** Read-only projection of configured, server-owned backup and migration inputs. */
  async list() {
    const backupRootValue = this.env.COMPANION_BACKUP_ROOT?.trim();
    const sourceRootValue = this.env.COMPANION_LEGACY_SOURCE_ROOT?.trim();
    const backupRoot = backupRootValue ? await realpath(resolve(backupRootValue)).catch(() => undefined) : undefined;
    const sourceRoot = sourceRootValue ? await realpath(resolve(sourceRootValue)).catch(() => undefined) : undefined;
    const journalReady = Boolean(this.env.MEMORY_DELETION_JOURNAL_PATH?.trim());
    const databaseReady = Boolean(this.env.COMPANION_DATABASE_URL?.trim());
    const restoreRootReady = Boolean(this.env.COMPANION_RESTORE_ROOT?.trim() && await realpath(resolve(this.env.COMPANION_RESTORE_ROOT)).catch(() => undefined));
    const restoreTarget = this.env.RESTORE_DATABASE_URL?.trim();
    const restoreTargetReady = Boolean(restoreTarget && (() => { try { return decodeURIComponent(new URL(restoreTarget).pathname.slice(1)).endsWith('_compat'); } catch { return false; } })());
    const backups: Array<Record<string, unknown>> = [];
    if (backupRoot) {
      for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const directory = join(backupRoot, entry.name);
        let bytes: Buffer;
        try { bytes = await readFile(join(directory, 'backup-manifest.json')); } catch { continue; }
        const version = hash(bytes);
        let valid = false;
        try {
          const manifest = JSON.parse(bytes.toString('utf8')) as { format?: number; assets?: unknown; createdAt?: string; localOnly?: boolean };
          valid = manifest.format === 1 && Array.isArray(manifest.assets) && typeof manifest.createdAt === 'string' && typeof manifest.localOnly === 'boolean';
        } catch { /* invalid rows remain visible but cannot be selected without a valid manifest */ }
        backups.push({ backupId: entry.name, version, configured: true, ready: valid && journalReady && Boolean(restoreRootReady) && restoreTargetReady,
          message: !valid ? 'backup manifest is invalid' : !restoreTargetReady ? 'isolated restore target is unavailable' : 'backup is available' });
      }
    }
    const sources: Array<Record<string, unknown>> = [];
    if (sourceRoot) {
      const visit = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) { await visit(path); continue; }
          if (!entry.isFile()) continue;
          const id = relative(sourceRoot, path).split(sep).join('/');
          try {
            const source = await sourceFile(this.env, id);
            const bytes = await readFile(source.path);
            sources.push({ sourceId: source.id, version: hash(bytes), sourceKind: source.kind, configured: true, ready: true, message: 'source is available for inspection' });
          } catch { /* unsupported files are deliberately not exposed as actionable rows */ }
        }
      };
      await visit(sourceRoot);
    }
    const backupsConfigured = Boolean(backupRoot && databaseReady && journalReady);
    const sourcesConfigured = Boolean(sourceRoot);
    const restoreConfigured = Boolean(restoreRootReady && restoreTarget);
    return {
      configured: backupsConfigured || sourcesConfigured || restoreConfigured,
      ready: backupsConfigured && sourcesConfigured && restoreRootReady && restoreTargetReady,
      capabilities: {
        backups: { configured: backupsConfigured, ready: backupsConfigured, message: backupsConfigured ? 'backup inputs are configured' : 'backup root, database, or deletion journal is unavailable' },
        restore: { configured: restoreConfigured, ready: restoreConfigured && restoreTargetReady && journalReady, message: !restoreConfigured ? 'restore root or target is unavailable' : !restoreTargetReady ? 'restore target must end in _compat' : 'isolated restore is configured' },
        migrations: { configured: sourcesConfigured && databaseReady, ready: sourcesConfigured && databaseReady, message: sourcesConfigured && databaseReady ? 'legacy sources are available' : 'legacy source root or database is unavailable' },
      },
      backups,
      sources,
    };
  }

  async run(request: OperationsAction): Promise<Record<string, unknown>> {
    if (request.confirm !== true || request.auditReason.trim().length < 8) throw stable('OPERATION_CONFIRMATION_REQUIRED');
    if (request.action === 'create') {
      const root = await configuredPath(this.env, 'COMPANION_BACKUP_ROOT');
      const journal = required(this.env, 'MEMORY_DELETION_JOURNAL_PATH');
      const roots = (this.env.COMPANION_BACKUP_ASSET_ROOTS ?? '').split(',').map((path) => path.trim()).filter(Boolean);
      const assets: string[] = [];
      for (const input of roots) assets.push(await realpath(resolve(input)).catch(() => { throw stable('BACKUP_ASSET_ROOT_UNAVAILABLE'); }));
      const id = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
      const output = join(root, id); await mkdir(output, { recursive: false });
      try {
        const result = await runDatabaseBackup({ outputDirectory: output, databaseUrl: required(this.env, 'COMPANION_DATABASE_URL'), assets, deletionJournalPath: journal, execute: this.execute,
          resticRepository: this.env.RESTIC_REPOSITORY, environment: this.env.RESTIC_PASSWORD_FILE ? { RESTIC_PASSWORD_FILE: this.env.RESTIC_PASSWORD_FILE } : {} });
        const marker = this.env.COMPANION_BACKUP_OWNER ?? 'companion-operations-v1';
        await writeFile(join(output, '.companion-backup-owner'), `${marker}\n`, { flag: 'wx' });
        const manifestBytes = await readFile(result.manifestPath);
        return { backupId: id, version: hash(manifestBytes), createdAt: result.manifest.createdAt, assetCount: result.manifest.assets.length, localOnly: result.manifest.localOnly, deletionJournalSequence: result.manifest.deletionJournalSequence };
      } catch (error) { throw error; }
    }
    if (request.action === 'inspect' || request.action === 'backup' || request.action === 'apply') {
      const source = await sourceFile(this.env, request.sourceId ?? '');
      const bytes = await readFile(source.path); const sourceHash = hash(bytes);
      if (request.action === 'backup' || request.action === 'apply') {
        if (!request.expectedVersion || !/^[a-f0-9]{64}$/.test(request.expectedVersion)) throw stable('EXPECTED_VERSION_REQUIRED');
      }
      if (request.expectedVersion && request.expectedVersion !== sourceHash) throw stable('VERSION_CONFLICT');
      if (request.action === 'inspect') return { sourceId: source.id, version: sourceHash, sizeBytes: bytes.length, sourceKind: source.kind };
      const legacyRoot = await configuredPath(this.env, 'COMPANION_BACKUP_ROOT');
      const directory = join(legacyRoot, `legacy-${basename(source.path, '.json')}-${sourceHash.slice(0, 12)}`);
      if (request.action === 'backup') {
        const backup = await createLegacyBackup({ sourcePaths: [source.path], outputDirectory: directory });
        return { sourceId: source.id, version: sourceHash, backupManifest: basename(backup.manifestPath), bytePreserved: true };
      }
      const backupManifestPath = join(directory, 'legacy-backup-manifest.json');
      await readFile(backupManifestPath).catch(() => { throw stable('VERIFIED_LEGACY_BACKUP_REQUIRED'); });
      const adapter = await createPostgresLegacyAdapter(required(this.env, 'COMPANION_DATABASE_URL'));
      try {
        const result = await migrateLegacyJson({ sourceKind: source.kind, sourcePath: source.path, backupManifestPath, hasMigrated: adapter.hasMigrated, execute: adapter.importLegacyRecords });
        return { sourceId: source.id, version: sourceHash, skipped: result.skipped, counts: result.counts, inserted: result.inserted ?? 0 };
      } finally { await adapter.close?.(); }
    }
    const root = await configuredPath(this.env, 'COMPANION_BACKUP_ROOT');
    const backupId = assertId(request.backupId, 'BACKUP_ID_REQUIRED');
    const directory = await childDirectory(root, backupId);
    const manifestPath = join(directory, 'backup-manifest.json');
    const manifestBytes = await readFile(manifestPath).catch(() => { throw stable('BACKUP_MANIFEST_MISSING'); });
    const version = hash(manifestBytes);
    if (!request.expectedVersion || !/^[a-f0-9]{64}$/.test(request.expectedVersion)) throw stable('EXPECTED_VERSION_REQUIRED');
    if (request.expectedVersion && request.expectedVersion !== version) throw stable('VERSION_CONFLICT');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    const restoreRoot = await configuredPath(this.env, 'COMPANION_RESTORE_ROOT');
    const targetUrl = required(this.env, 'RESTORE_DATABASE_URL');
    const journal = required(this.env, 'MEMORY_DELETION_JOURNAL_PATH');
    const assetsTo = join(restoreRoot, backupId);
    const target = new URL(targetUrl);
    if (!decodeURIComponent(target.pathname.slice(1)).endsWith('_compat')) throw stable('RESTORE_TARGET_NOT_COMPAT');
    const replay = await import('../application/restore-replay-adapter.js');
    const restoredHistoryPath = restoredHistoryAssetPath(manifest, assetsTo, this.env.COMPANION_MEMORY_HISTORY_PATH);
    if (request.action === 'verify') {
      const receipt = await replay.verifyDeletionJournalReplay({ databaseUrl: targetUrl, historyPath: restoredHistoryPath, assetRoot: assetsTo, journalPath: join(assetsTo, manifest.deletionJournalPath) });
      const restoredHistoryRelativePath = restoredHistoryPath ? relative(assetsTo, restoredHistoryPath) : undefined;
      const readiness = await verifyRestoreReadiness({ manifest, rootDirectory: assetsTo, targetDatabaseUrl: targetUrl, receipt,
        replayedHistoryAssetPath: restoredHistoryRelativePath });
      return { backupId, version, assetCount: readiness.assetsVerified, createdAt: manifest.createdAt, localOnly: manifest.localOnly, ...readiness };
    }
    const readiness = await restoreSnapshot({ manifestPath, rootDirectory: directory, restoreAssetDirectory: assetsTo, targetDatabaseUrl: targetUrl, deletionJournalPath: journal,
      execute: this.execute, isolatedTarget: true,
      replayDeletionJournal: (journalPath, throughSequence) => replay.replayDeletionJournal({
        databaseUrl: targetUrl, historyPath: restoredHistoryPath, assetRoot: assetsTo, journalPath, throughSequence,
      }) });
    return { backupId, version, ready: readiness.ready, assetsVerified: readiness.assetsVerified, deletionJournalReplayedThrough: readiness.deletionJournalReplayedThrough };
  }
}

export function createCompanionOperationsRunner(config?: RunnerConfig): CompanionOperationsRunner { return new CompanionOperationsRunner(config); }
