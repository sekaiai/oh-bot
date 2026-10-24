import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readDeletionJournal, withDeletionJournalLock } from '../memory/memory-deletion-journal.js';

type SqliteHandle = { backup(path: string): Promise<void>; prepare(query: string): { get(): unknown }; close(): void };
const require = createRequire(import.meta.url);
const SqliteDatabase = require('better-sqlite3') as new (path: string, options: { readonly: boolean; fileMustExist: boolean }) => SqliteHandle;

export type Asset = { path: string; sha256: string; sizeBytes: number };
export type BackupManifest = {
  format: 1;
  createdAt: string;
  kind: string;
  assets: Asset[];
  localOnly: boolean;
  deletionJournalSequence: number;
  deletionJournalChecksum: string;
  deletionJournalPath: string;
};
export type RestoreReplayReceipt = {
  replayedThrough: number;
  journalSequence: number;
  journalChecksum: string;
  targetDatabase: string;
  journalAssetSha256: string;
};
export function restoredHistoryAssetPath(manifest: Pick<BackupManifest, 'assets'>, assetRoot: string, configuredSourcePath?: string): string | undefined {
  const candidates = manifest.assets.filter((asset) => /\.(sqlite|sqlite3|db)$/i.test(asset.path));
  if (!candidates.length) return undefined;
  const selected = configuredSourcePath
    ? candidates.filter((asset) => asset.path === configuredSourcePath || basename(asset.path) === basename(configuredSourcePath))
    : candidates;
  if (selected.length !== 1 || isAbsolute(selected[0]!.path) || selected[0]!.path.split(/[\\/]/).includes('..')) throw stableError('RESTORE_HISTORY_ASSET_AMBIGUOUS');
  return join(resolve(assetRoot), selected[0]!.path);
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function stableError(code: string): Error {
  const error = new Error(code);
  error.name = 'OperationError';
  return error;
}

async function verifiedFile(path: string): Promise<{ path: string; bytes: Buffer }> {
  const absolute = resolve(path);
  const info = await lstat(absolute).catch(() => { throw stableError('SOURCE_MISSING'); });
  if (!info.isFile() || info.isSymbolicLink()) throw stableError('SOURCE_NOT_REGULAR_FILE');
  return { path: absolute, bytes: await readFile(absolute) };
}

async function containedAsset(root: string, relativePath: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw stableError('ASSET_PATH_REJECTED');
  }
  const realRoot = await realpath(root).catch(() => { throw stableError('RESTORE_ROOT_UNAVAILABLE'); });
  const target = resolve(realRoot, relativePath);
  if (!target.startsWith(realRoot + sep)) throw stableError('ASSET_PATH_REJECTED');
  const segments = relative(realRoot, target).split(sep);
  let cursor = realRoot;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor).catch(() => { throw stableError('ASSET_MISSING'); });
    if (info.isSymbolicLink()) throw stableError('ASSET_SYMLINK_REJECTED');
  }
  if (!(await stat(target)).isFile()) throw stableError('ASSET_NOT_REGULAR_FILE');
  return target;
}

async function containedAssetParent(root: string, relativePath: string): Promise<string> {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw stableError('ASSET_PATH_REJECTED');
  const realRoot = await realpath(root).catch(() => { throw stableError('RESTORE_ROOT_UNAVAILABLE'); });
  const target = resolve(realRoot, relativePath);
  if (!target.startsWith(realRoot + sep)) throw stableError('ASSET_PATH_REJECTED');
  let cursor = realRoot;
  for (const segment of relative(realRoot, dirname(target)).split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    try {
      const info = await lstat(cursor);
      if (!info.isDirectory() || info.isSymbolicLink()) throw stableError('RESTORE_ASSET_PARENT_INVALID');
    } catch (error) {
      if (error instanceof Error && error.name === 'OperationError') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw stableError('RESTORE_ASSET_PARENT_INVALID');
      break;
    }
  }
  return target;
}

export async function snapshotSqliteDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  const source = await verifiedFile(sourcePath);
  const destination = resolve(destinationPath);
  try {
    await lstat(destination);
    throw stableError('BACKUP_NAME_COLLISION');
  } catch (error) {
    if (error instanceof Error && error.name === 'OperationError') throw error;
  }
  await mkdir(dirname(destination), { recursive: true });
  if (source.path === destination) throw stableError('BACKUP_NAME_COLLISION');
  const database = new SqliteDatabase(source.path, { readonly: true, fileMustExist: true });
  try {
    await database.backup(destination);
  } catch {
    throw stableError('SQLITE_SNAPSHOT_FAILED');
  } finally {
    database.close();
  }
}

async function verifySqliteAsset(path: string): Promise<void> {
  const database = new SqliteDatabase(path, { readonly: true, fileMustExist: true });
  try {
    const result = database.prepare('PRAGMA integrity_check').get();
    const status = result && typeof result === 'object' ? Object.values(result)[0] : undefined;
    if (status !== 'ok') throw stableError('RESTORED_SQLITE_INVALID');
  } catch (error) {
    if (error instanceof Error && error.name === 'OperationError') throw error;
    throw stableError('RESTORED_SQLITE_INVALID');
  } finally { database.close(); }
}

export async function createLegacyBackup(input: { sourcePaths: string[]; outputDirectory: string }) {
  if (!input.sourcePaths.length) throw stableError('LEGACY_SOURCE_REQUIRED');
  const output = resolve(input.outputDirectory);
  await mkdir(output, { recursive: true });
  const realOutput = await realpath(output);
  const files: Array<{ sourcePath: string; backupPath: string; sha256: string; sizeBytes: number }> = [];
  const targets = new Set<string>();
  for (const sourcePath of input.sourcePaths) {
    const source = await verifiedFile(sourcePath);
    const target = join(realOutput, basename(source.path));
    if (target === source.path || targets.has(target) || basename(source.path) === 'legacy-backup-manifest.json') throw stableError('BACKUP_NAME_COLLISION');
    targets.add(target);
    await writeFile(target, source.bytes, { flag: 'wx' }).catch(() => { throw stableError('BACKUP_WRITE_FAILED'); });
    files.push({ sourcePath: source.path, backupPath: target, sha256: digest(source.bytes), sizeBytes: source.bytes.length });
  }
  const manifestPath = join(output, 'legacy-backup-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify({ format: 1, createdAt: new Date().toISOString(), files }, null, 2)}\n`, { flag: 'wx' });
  return { manifestPath, files };
}

export type LegacySourceKind = 'sessions' | 'personas' | 'rules' | 'affection';
export type LegacyRecord = {
  kind: 'session' | 'persona' | 'rule' | 'affection_legacy';
  legacyId: string;
  payload: unknown;
  provenance: 'legacy_json';
  sourceHash: string;
  trustUpgrade?: false;
  historyComplete?: false;
  identityMerge?: false;
  sandboxOnly: true;
  sandboxScope: { kind: 'legacy_sandbox'; sourceHash: string };
};
export type LegacyImportAdapter = {
  hasMigrated(sourceHash: string): Promise<boolean>;
  importLegacyRecords(records: LegacyRecord[], metadata: { sourceHash: string; sourcePath: string; backupManifestPath: string; sourceKind: LegacySourceKind }): Promise<{ inserted: number }>;
  close?(): Promise<void>;
};

export async function migrateLegacyJson(input: {
  sourceKind: LegacySourceKind;
  sourcePath: string;
  backupManifestPath: string;
  hasMigrated: LegacyImportAdapter['hasMigrated'];
  execute: LegacyImportAdapter['importLegacyRecords'];
}) {
  const source = await verifiedFile(input.sourcePath);
  const sourceHash = digest(source.bytes);
  const manifestPath = resolve(input.backupManifestPath);
  const backup = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    files?: Array<{ sourcePath: string; backupPath: string; sha256: string }>;
  };
  const entry = backup.files?.find((file) => resolve(file.sourcePath) === source.path);
  if (!entry || entry.sha256 !== sourceHash) throw stableError('VERIFIED_LEGACY_BACKUP_REQUIRED');
  const backupFile = await verifiedFile(entry.backupPath);
  if (digest(backupFile.bytes) !== sourceHash) throw stableError('LEGACY_BACKUP_HASH_MISMATCH');

  const value = JSON.parse(source.bytes.toString('utf8')) as unknown;
  const records: LegacyRecord[] = [];
  const common = { provenance: 'legacy_json' as const, sourceHash, sandboxOnly: true as const, identityMerge: false as const, sandboxScope: { kind: 'legacy_sandbox' as const, sourceHash } };
  const addRows = (rows: unknown[], kind: LegacyRecord['kind']) => rows.forEach((payload, index) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw stableError('LEGACY_RECORD_INVALID');
    const legacyId = String((payload as { id?: unknown }).id ?? `${input.sourceKind}:${index}`);
    records.push({ ...common, kind, legacyId, payload, ...(kind === 'session' ? { historyComplete: false as const } : {}), ...(kind === 'affection_legacy' ? { trustUpgrade: false as const } : {}) });
  });
  if (input.sourceKind === 'sessions') {
    const body = value as { sessions?: unknown } | null;
    const sessions = body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'sessions') ? body.sessions : value;
    if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) throw stableError('LEGACY_SHAPE_UNSUPPORTED');
    const rows = Object.entries(sessions).map(([legacyId, payload]) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray((payload as { messages?: unknown }).messages)) throw stableError('LEGACY_SHAPE_UNSUPPORTED');
      return { id: legacyId, ...payload };
    });
    addRows(rows, 'session');
  } else if (input.sourceKind === 'personas') {
    const body = value as { personas?: unknown } | null;
    const personas = Array.isArray(body) ? body : body?.personas;
    if (Array.isArray(personas)) addRows(personas, 'persona');
    else if (personas && typeof personas === 'object') addRows(Object.entries(personas).map(([id, payload]) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw stableError('LEGACY_SHAPE_UNSUPPORTED');
      return { id, ...(payload as object) };
    }), 'persona');
    else if (body && typeof body === 'object' && !Array.isArray(body)) addRows(Object.entries(body).map(([id, payload]) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw stableError('LEGACY_SHAPE_UNSUPPORTED');
      return { id, ...(payload as object) };
    }), 'persona');
    else throw stableError('LEGACY_SHAPE_UNSUPPORTED');
  } else if (input.sourceKind === 'rules') {
    const rules = (value as { rules?: unknown } | null)?.rules;
    if (Array.isArray(value)) addRows(value, 'rule');
    else if (Array.isArray(rules)) addRows(rules, 'rule');
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const config = (value as Record<string, unknown>).admins !== undefined || (value as Record<string, unknown>).whitelistGroups !== undefined;
      if (!config) throw stableError('LEGACY_SHAPE_UNSUPPORTED');
      const items = [value];
      addRows(items, 'rule');
    } else throw stableError('LEGACY_SHAPE_UNSUPPORTED');
  } else {
    const affection = (value as { affection?: unknown; affectionLevels?: unknown } | null)?.affection ??
      (value as { affectionLevels?: unknown } | null)?.affectionLevels ?? value;
    if (!affection || typeof affection !== 'object' || Array.isArray(affection)) throw stableError('LEGACY_SHAPE_UNSUPPORTED');
    const body = affection as Record<string, unknown>;
    const filename = basename(source.path);
    const users = filename === 'users.json' ? body : body.users;
    const rows = filename === 'self.json'
      ? [{ id: 'self', value: body }]
      : filename === 'config.json'
        ? [{ id: 'config', value: body }]
        : users && typeof users === 'object' && !Array.isArray(users)
          ? [
              ...Object.entries(users).map(([id, payload]) => ({ id: filename === 'users.json' ? id : `users:${id}`, value: payload })),
              ...(filename !== 'users.json' && body.self && typeof body.self === 'object' && !Array.isArray(body.self) ? [{ id: 'self', value: body.self }] : []),
            ]
          : Object.entries(body).map(([id, payload]) => ({ id, value: payload }));
    if (!rows.length || rows.some((row) => !(typeof row.value === 'number' || (row.value && typeof row.value === 'object' && !Array.isArray(row.value))))) {
      throw stableError('LEGACY_SHAPE_UNSUPPORTED');
    }
    addRows(rows, 'affection_legacy');
  }
  if (!records.length) throw stableError('LEGACY_SHAPE_EMPTY');
  if (await input.hasMigrated(sourceHash)) {
    return { skipped: true, sourceHash, counts: { sessions: 0, personas: 0, rules: 0, affectionLegacy: 0, trustUpgrades: 0 } };
  }
  const result = await input.execute(records, { sourceHash, sourcePath: source.path, backupManifestPath: manifestPath, sourceKind: input.sourceKind });
  return {
    skipped: false,
    sourceHash,
    counts: {
      sessions: records.filter((record) => record.kind === 'session').length,
      personas: records.filter((record) => record.kind === 'persona').length,
      rules: records.filter((record) => record.kind === 'rule').length,
      affectionLegacy: records.filter((record) => record.kind === 'affection_legacy').length,
      trustUpgrades: 0,
    },
    inserted: result.inserted,
  };
}

export async function createPostgresLegacyAdapter(databaseUrl: string): Promise<LegacyImportAdapter> {
  const [{ createDatabase }, { migrationRecords }, { eq }] = await Promise.all([
    import('../database/database.js'),
    import('../database/schema/operations.js'),
    import('drizzle-orm'),
  ]);
  const database = createDatabase(databaseUrl);
  return {
    close: database.close,
    async hasMigrated(sourceHash) {
      const [record] = await database.db.select({ id: migrationRecords.id })
        .from(migrationRecords).where(eq(migrationRecords.sourceHash, sourceHash)).limit(1);
      return Boolean(record);
    },
    async importLegacyRecords(records, metadata) {
      const { createHash } = await import('node:crypto');
      const marker = {
        sourceHash: metadata.sourceHash,
        sourcePath: metadata.sourcePath,
        backupManifestPath: metadata.backupManifestPath,
        status: 'imported' as const,
        counts: { recordType: 'legacy_import_marker', sourceKind: metadata.sourceKind, provenance: 'legacy_json', importedRecords: records.length, sandboxOnly: true },
        completedAt: new Date(),
      };
      const rows = records.map((record) => ({
        sourceHash: createHash('sha256').update(`${metadata.sourceHash}\n${record.kind}\n${record.legacyId}`).digest('hex'),
        sourcePath: metadata.sourcePath,
        backupManifestPath: metadata.backupManifestPath,
        status: 'imported' as const,
        counts: {
          recordType: 'legacy_sandbox_record',
          sourceFileHash: metadata.sourceHash,
          sourceKind: metadata.sourceKind,
          provenance: record.provenance,
          sandboxOnly: record.sandboxOnly,
          sandboxScope: record.sandboxScope,
          identityMerge: false,
          trustUpgrade: false,
          historyComplete: record.historyComplete ?? false,
          legacyKind: record.kind,
          legacyId: record.legacyId,
          payload: record.payload,
        },
        completedAt: new Date(),
      }));
      const insertedRows = await database.db.transaction(async (tx) => {
        const insertedMarker = await tx.insert(migrationRecords).values(marker)
          .onConflictDoNothing({ target: migrationRecords.sourceHash }).returning({ id: migrationRecords.id });
        if (!insertedMarker.length) return 0;
        const inserted = await tx.insert(migrationRecords).values(rows)
          .onConflictDoNothing({ target: migrationRecords.sourceHash }).returning({ id: migrationRecords.id });
        if (inserted.length !== rows.length) throw stableError('LEGACY_RECORD_CONFLICT');
        return inserted.length;
      });
      return { inserted: insertedRows };
    },
  };
}

export async function listLegacySandboxRecords(databaseUrl: string, sourceHash: string) {
  const [{ createDatabase }, { migrationRecords }, { sql }] = await Promise.all([
    import('../database/database.js'),
    import('../database/schema/operations.js'),
    import('drizzle-orm'),
  ]);
  const database = createDatabase(databaseUrl);
  try {
    const rows = await database.db.select().from(migrationRecords).where(sql`${migrationRecords.counts}->>'sourceFileHash' = ${sourceHash}`);
    return rows.filter((row) => (row.counts as { recordType?: string }).recordType === 'legacy_sandbox_record')
      .map((row) => ({ sourceHash: row.sourceHash, provenance: (row.counts as { provenance: string }).provenance, sandboxOnly: true as const, record: row.counts }));
  } finally {
    await database.close();
  }
}

export type CommandExecutor = (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<void>;

function postgresConnection(databaseUrl: string) {
  const url = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw stableError('DATABASE_URL_INVALID');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw stableError('DATABASE_NAME_REQUIRED');
  return {
    database,
    env: {
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username),
      ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
      ...(url.searchParams.has('sslmode') ? { PGSSLMODE: url.searchParams.get('sslmode')! } : {}),
    },
  };
}

async function copyAsset(sourcePath: string, output: string, forcedFileName?: string): Promise<Asset[]> {
  const source = resolve(sourcePath);
  const info = await lstat(source).catch(() => { throw stableError('BACKUP_ASSET_MISSING'); });
  if (info.isSymbolicLink()) throw stableError('BACKUP_ASSET_SYMLINK_REJECTED');
  const directoryEntries = info.isDirectory() ? await readdir(source, { recursive: true, withFileTypes: true }) : [];
  if (directoryEntries.some((entry) => entry.isSymbolicLink())) throw stableError('BACKUP_ASSET_SYMLINK_REJECTED');
  const entries = info.isDirectory()
    ? directoryEntries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name))
    : [source];
  const assets: Asset[] = [];
  for (const entry of entries) {
    const rel = info.isDirectory() ? join(basename(source), relative(source, entry)) : forcedFileName ?? basename(source);
    const target = join(output, rel);
    try {
      await lstat(target);
      throw stableError('BACKUP_NAME_COLLISION');
    } catch (error) {
      if (error instanceof Error && error.name === 'OperationError') throw error;
    }
    await mkdir(dirname(target), { recursive: true });
    if (/\.(sqlite|sqlite3|db)$/i.test(entry)) await snapshotSqliteDatabase(entry, target);
    else await copyFile(entry, target);
    const bytes = await readFile(target);
    assets.push({ path: rel, sha256: digest(bytes), sizeBytes: bytes.length });
  }
  if (!assets.length) throw stableError('BACKUP_ASSET_EMPTY');
  return assets;
}

export async function runDatabaseBackup(input: {
  outputDirectory: string;
  databaseUrl: string;
  assets: string[];
  deletionJournalPath: string;
  deletionJournalSequence?: number;
  execute: CommandExecutor;
  resticRepository?: string;
  environment?: NodeJS.ProcessEnv;
  kind?: string;
}) {
  const output = resolve(input.outputDirectory);
  await mkdir(output, { recursive: true });
  const realOutput = await realpath(output);
  const dumpPath = join(realOutput, 'business.dump');
  const journalAssetPath = 'deletion-journal.jsonl';
  const journalFile = join(realOutput, journalAssetPath);
  const journal = await withDeletionJournalLock(input.deletionJournalPath, async () => {
    const source = await verifiedFile(input.deletionJournalPath);
    const state = await readDeletionJournal(source.path);
    if (input.deletionJournalSequence !== undefined && state.latestSequence !== input.deletionJournalSequence) throw stableError('DELETION_JOURNAL_SEQUENCE_MISMATCH');
    await copyFile(source.path, `${journalFile}.snapshot-tmp`);
    await rename(`${journalFile}.snapshot-tmp`, journalFile);
    return state;
  });
  const connection = postgresConnection(input.databaseUrl);
  await input.execute('pg_dump', ['--format=custom', '--file', dumpPath, '--dbname', connection.database], connection.env);
  const dumpBytes = await readFile(dumpPath).catch(() => { throw stableError('DATABASE_DUMP_MISSING'); });
  const assets: Asset[] = [{ path: 'business.dump', sha256: digest(dumpBytes), sizeBytes: dumpBytes.length }];
  for (const assetPath of input.assets) assets.push(...await copyAsset(assetPath, realOutput));
  const journalBytes = await readFile(journalFile);
  assets.push({ path: journalAssetPath, sha256: digest(journalBytes), sizeBytes: journalBytes.length });
  if (assets.filter((asset) => asset.path === journalAssetPath).length !== 1) throw stableError('BACKUP_NAME_COLLISION');
  const manifest: BackupManifest = {
    format: 1,
    createdAt: new Date().toISOString(),
    kind: input.kind ?? 'pre_upgrade',
    assets,
    localOnly: !input.resticRepository,
    deletionJournalSequence: journal.latestSequence,
    deletionJournalChecksum: journal.latestChecksum,
    deletionJournalPath: journalAssetPath,
  };
  const manifestPath = join(realOutput, 'backup-manifest.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  if (input.resticRepository) {
    await input.execute('restic', ['-r', input.resticRepository, 'backup', output], input.environment);
  }
  return { manifestPath, manifest, status: input.resticRepository ? 'offsite' as const : 'local-only' as const };
}

export async function verifyRestoreReadiness(input: {
  manifest: Pick<BackupManifest, 'format' | 'assets' | 'deletionJournalSequence' | 'deletionJournalChecksum' | 'deletionJournalPath'>;
  rootDirectory: string;
  targetDatabaseUrl: string;
  receipt: RestoreReplayReceipt | undefined;
  replayedHistoryAssetPath?: string;
}) {
  if (input.manifest.format !== 1 || !Array.isArray(input.manifest.assets) || !input.manifest.assets.length ||
      !Number.isSafeInteger(input.manifest.deletionJournalSequence) || input.manifest.deletionJournalSequence < 0 ||
      !/^[a-f0-9]{64}$/.test(input.manifest.deletionJournalChecksum) || typeof input.manifest.deletionJournalPath !== 'string') {
    throw stableError('BACKUP_MANIFEST_INVALID');
  }
  const seen = new Set<string>();
  for (const asset of input.manifest.assets) {
    if (!asset || typeof asset.path !== 'string' || !asset.path || isAbsolute(asset.path) || asset.path.split(/[\\/]/).includes('..')) throw stableError('ASSET_PATH_REJECTED');
    if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 0 || seen.has(asset.path)) throw stableError('BACKUP_MANIFEST_INVALID');
    seen.add(asset.path);
    if (asset.path === 'business.dump' || asset.path === input.manifest.deletionJournalPath) continue;
    const target = await containedAsset(input.rootDirectory, asset.path);
    const bytes = await readFile(target);
    if (input.replayedHistoryAssetPath && asset.path === input.replayedHistoryAssetPath) {
      if (!/\.(sqlite|sqlite3|db)$/i.test(asset.path)) throw stableError('RESTORE_HISTORY_ASSET_INVALID');
      await verifySqliteAsset(target);
    } else if (bytes.length !== asset.sizeBytes || digest(bytes) !== asset.sha256) throw stableError('ASSET_HASH_MISMATCH');
  }
  if (!seen.has('business.dump') || !seen.has(input.manifest.deletionJournalPath)) throw stableError('BACKUP_MANIFEST_INVALID');
  const journalPath = await containedAsset(input.rootDirectory, input.manifest.deletionJournalPath);
  const journalBytes = await readFile(journalPath);
  const journal = await readDeletionJournal(journalPath);
  if (journal.latestSequence < input.manifest.deletionJournalSequence ||
    (input.manifest.deletionJournalSequence === 0 ? '0'.repeat(64) : journal.entries[input.manifest.deletionJournalSequence - 1]?.checksum) !== input.manifest.deletionJournalChecksum) {
    throw stableError('DELETION_JOURNAL_STATE_INVALID');
  }
  const targetDatabase = postgresConnection(input.targetDatabaseUrl).database;
  const receipt = input.receipt;
  if (!receipt || !Number.isSafeInteger(receipt.replayedThrough) || receipt.replayedThrough !== journal.latestSequence ||
      !Number.isSafeInteger(receipt.journalSequence) || receipt.journalSequence !== journal.latestSequence ||
      receipt.journalChecksum !== journal.latestChecksum || receipt.targetDatabase !== targetDatabase ||
      receipt.journalAssetSha256 !== digest(journalBytes)) {
    throw stableError('DELETION_JOURNAL_REPLAY_INCOMPLETE');
  }
  return { ready: true, assetsVerified: input.manifest.assets.length, deletionJournalReplayedThrough: receipt.replayedThrough, journalChecksum: receipt.journalChecksum };
}

export async function restoreSnapshot(input: {
  manifestPath: string;
  rootDirectory: string;
  restoreAssetDirectory: string;
  targetDatabaseUrl: string;
  deletionJournalPath: string;
  execute: CommandExecutor;
  replayDeletionJournal: (journalPath: string, throughSequence: number) => Promise<RestoreReplayReceipt>;
  isolatedTarget: boolean;
}) {
  const target = postgresConnection(input.targetDatabaseUrl);
  if (!input.isolatedTarget || !target.database.endsWith('_compat')) throw stableError('RESTORE_TARGET_NOT_COMPAT');
  const manifest = JSON.parse(await readFile(input.manifestPath, 'utf8')) as BackupManifest;
  if (manifest.format !== 1 || !Array.isArray(manifest.assets) || !manifest.assets.length ||
      !Number.isSafeInteger(manifest.deletionJournalSequence) || manifest.deletionJournalSequence < 0 ||
      !/^[a-f0-9]{64}$/.test(manifest.deletionJournalChecksum) || typeof manifest.deletionJournalPath !== 'string' || !manifest.deletionJournalPath ||
      typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)) || typeof manifest.kind !== 'string' || typeof manifest.localOnly !== 'boolean') {
    throw stableError('BACKUP_MANIFEST_INVALID');
  }
  const manifestPaths = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.path !== 'string' || !asset.path || !/^[a-f0-9]{64}$/.test(asset.sha256) ||
        !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 0 || manifestPaths.has(asset.path)) throw stableError('BACKUP_MANIFEST_INVALID');
    manifestPaths.add(asset.path);
  }
  if (!manifestPaths.has('business.dump') || !manifestPaths.has(manifest.deletionJournalPath)) throw stableError('BACKUP_MANIFEST_INVALID');
  const dump = manifest.assets.find((asset) => asset.path === 'business.dump');
  if (!dump) throw stableError('BUSINESS_DUMP_MISSING');
  if (!manifest.assets.some((asset) => asset.path === manifest.deletionJournalPath)) throw stableError('DELETION_JOURNAL_MISSING');

  // Validate every backup asset and the newest independent journal before pg_restore can mutate its target.
  for (const asset of manifest.assets) {
    const path = await containedAsset(input.rootDirectory, asset.path);
    if (digest(await readFile(path)) !== asset.sha256) throw stableError('ASSET_HASH_MISMATCH');
  }
  const snapshotJournalPath = await containedAsset(input.rootDirectory, manifest.deletionJournalPath);
  const snapshotJournal = await readDeletionJournal(snapshotJournalPath);
  if (snapshotJournal.latestSequence !== manifest.deletionJournalSequence || snapshotJournal.latestChecksum !== manifest.deletionJournalChecksum) {
    throw stableError('BACKUP_JOURNAL_CHECKSUM_MISMATCH');
  }
  const latestJournalFile = await verifiedFile(input.deletionJournalPath);
  const latestJournal = await readDeletionJournal(latestJournalFile.path);
  if (latestJournal.latestSequence < snapshotJournal.latestSequence ||
    snapshotJournal.latestSequence > 0 && latestJournal.entries[snapshotJournal.latestSequence - 1]?.checksum !== snapshotJournal.latestChecksum) {
    throw stableError('LATEST_DELETION_JOURNAL_INVALID');
  }
  const restoreRoot = resolve(input.restoreAssetDirectory);
  await mkdir(restoreRoot, { recursive: true });
  const realRestoreRoot = await realpath(restoreRoot);
  const backupRoot = await realpath(input.rootDirectory);
  if (realRestoreRoot === backupRoot || realRestoreRoot.startsWith(backupRoot + sep) || backupRoot.startsWith(realRestoreRoot + sep)) {
    throw stableError('RESTORE_ASSET_ROOT_NOT_ISOLATED');
  }
  const existing = await readdir(realRestoreRoot);
  if (existing.length) throw stableError('RESTORE_ASSET_ROOT_NOT_EMPTY');
  const dumpPath = await containedAsset(input.rootDirectory, dump.path);
  const connection = postgresConnection(input.targetDatabaseUrl);
  await input.execute('pg_restore', ['--clean', '--if-exists', '--no-owner', '--dbname', connection.database, dumpPath], connection.env);

  for (const asset of manifest.assets) {
    if (asset.path === dump.path || asset.path === manifest.deletionJournalPath) continue;
    const source = await containedAsset(input.rootDirectory, asset.path);
    const target = await containedAssetParent(realRestoreRoot, asset.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, `${target}.restore-tmp`);
    await rename(`${target}.restore-tmp`, target);
    const copied = await readFile(target);
    if (copied.length !== asset.sizeBytes || digest(copied) !== asset.sha256) throw stableError('ASSET_HASH_MISMATCH');
    if (/\.(sqlite|sqlite3|db)$/i.test(target)) await verifySqliteAsset(target);
  }
  const restoredJournalPath = await containedAssetParent(realRestoreRoot, manifest.deletionJournalPath);
  await mkdir(dirname(restoredJournalPath), { recursive: true });
  await withDeletionJournalLock(input.deletionJournalPath, async () => {
    const latest = await verifiedFile(input.deletionJournalPath);
    const state = await readDeletionJournal(latest.path);
    if (state.latestSequence < snapshotJournal.latestSequence ||
        (snapshotJournal.latestSequence === 0 ? '0'.repeat(64) : state.entries[snapshotJournal.latestSequence - 1]?.checksum) !== snapshotJournal.latestChecksum) {
      throw stableError('LATEST_DELETION_JOURNAL_INVALID');
    }
    await copyFile(latest.path, `${restoredJournalPath}.restore-tmp`);
    await rename(`${restoredJournalPath}.restore-tmp`, restoredJournalPath);
  });

  let readiness: Awaited<ReturnType<typeof verifyRestoreReadiness>> | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const replayState = await readDeletionJournal(restoredJournalPath);
    const receipt = await input.replayDeletionJournal(restoredJournalPath, replayState.latestSequence);
    const stableResult = await withDeletionJournalLock(input.deletionJournalPath, async () => {
      const currentFile = await verifiedFile(input.deletionJournalPath);
      const current = await readDeletionJournal(currentFile.path);
      const prefixChecksum = replayState.latestSequence === 0 ? '0'.repeat(64) : current.entries[replayState.latestSequence - 1]?.checksum;
      if (current.latestSequence < replayState.latestSequence || prefixChecksum !== replayState.latestChecksum) throw stableError('LATEST_DELETION_JOURNAL_INVALID');
      if (current.latestSequence !== replayState.latestSequence || current.latestChecksum !== replayState.latestChecksum) {
        await copyFile(currentFile.path, `${restoredJournalPath}.restore-tmp`);
        await rename(`${restoredJournalPath}.restore-tmp`, restoredJournalPath);
        return undefined;
      }
      const historyPath = restoredHistoryAssetPath(manifest, realRestoreRoot);
      const historyRelativePath = historyPath ? relative(realRestoreRoot, historyPath) : undefined;
      return await verifyRestoreReadiness({ manifest, rootDirectory: realRestoreRoot, targetDatabaseUrl: input.targetDatabaseUrl, receipt,
        replayedHistoryAssetPath: historyRelativePath });
    });
    if (stableResult) { readiness = stableResult; break; }
  }
  if (!readiness) throw stableError('DELETION_JOURNAL_ADVANCING');
  return readiness;
}

export const retentionPolicy = { sixHourly: 4, daily: 30, weekly: 12, monthly: 36, monthlyIsolatedRestore: true } as const;
export type RetentionBackup = { path: string; createdAt: string; kind?: 'six_hourly' | 'daily' | 'weekly' | 'monthly' };

export function selectRetentionCandidates(backups: RetentionBackup[], now = new Date()): string[] {
  const valid = backups.map((backup) => ({ ...backup, kind: backup.kind ?? 'six_hourly' as const, time: Date.parse(backup.createdAt) }))
    .filter((backup) => Number.isFinite(backup.time) && backup.time <= now.getTime())
    .sort((left, right) => right.time - left.time);
  const retained = new Set<string>();
  const keepBucket = (kind: RetentionBackup['kind'], width: number, limit: number) => {
    const buckets = new Set<number>();
    for (const backup of valid.filter((item) => item.kind === kind)) {
      const bucket = Math.floor((now.getTime() - backup.time) / width);
      if (bucket < limit && !buckets.has(bucket)) {
        buckets.add(bucket);
        retained.add(backup.path);
      }
    }
  };
  keepBucket('six_hourly', 6 * 60 * 60_000, retentionPolicy.sixHourly);
  keepBucket('daily', 24 * 60 * 60_000, retentionPolicy.daily);
  keepBucket('weekly', 7 * 24 * 60 * 60_000, retentionPolicy.weekly);
  keepBucket('monthly', 30 * 24 * 60 * 60_000, retentionPolicy.monthly);
  return valid.filter((backup) => !retained.has(backup.path)).map((backup) => backup.path);
}

export async function pruneOwnedBackups(input: {
  directories: string[];
  ownershipMarker: string;
  validateManifest: (path: string) => Promise<boolean>;
  remove: (path: string) => Promise<void>;
}) {
  const removed: string[] = [];
  for (const candidate of input.directories) {
    const directory = resolve(candidate);
    let marker: string;
    try { marker = await readFile(join(directory, '.companion-backup-owner'), 'utf8'); } catch { continue; }
    if (marker.trim() !== input.ownershipMarker) continue;
    const manifest = join(directory, 'backup-manifest.json');
    if (!await input.validateManifest(manifest)) continue;
    await input.remove(directory);
    removed.push(directory);
  }
  return removed;
}

export async function pruneByRetention(input: {
  backups: RetentionBackup[];
  now?: Date;
  ownershipMarker: string;
  validateManifest: (path: string) => Promise<boolean>;
  remove: (path: string) => Promise<void>;
}) {
  const candidates = new Set(selectRetentionCandidates(input.backups, input.now));
  return pruneOwnedBackups({
    directories: input.backups.filter((backup) => candidates.has(backup.path)).map((backup) => backup.path),
    ownershipMarker: input.ownershipMarker,
    validateManifest: input.validateManifest,
    remove: input.remove,
  });
}

export async function upgradeWithPreBackup(input: { backup: () => Promise<unknown>; upgrade: () => Promise<void> }) {
  const backup = await input.backup();
  await input.upgrade();
  return { backup };
}
