import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { Client } from 'pg';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { characters, deletionRecords } from '../src/database/schema/index.js';
import { MemoryGateway } from '../src/memory/memory-gateway.js';
import { MemoryLifecycleService } from '../src/memory/memory-lifecycle-service.js';
import { MemoryReadService } from '../src/memory/memory-read-service.js';
import { appendDeletionJournal, initializeDeletionJournal, readDeletionJournal } from '../src/memory/memory-deletion-journal.js';
import { createLegacyBackup, createPostgresLegacyAdapter, listLegacySandboxRecords, migrateLegacyJson, restoreSnapshot, runDatabaseBackup } from '../src/operations/index.js';
import { createHash, randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const Sqlite = require('better-sqlite3');

let currentPhase = 'setup';
function command(binary: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: 'ignore', env: { ...process.env, ...env } });
    child.once('error', () => reject(new Error(`TEST_COMMAND_UNAVAILABLE:${currentPhase}`)));
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`TEST_COMMAND_FAILED:${currentPhase}`)));
  });
}

const sourceDatabase = 'oh_bot_integration_compat';

async function manageDatabase(databaseUrl: string, database: string, action: 'CREATE' | 'DROP') {
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    await client.query(`${action} DATABASE "${database}"${action === 'DROP' ? ' WITH (FORCE)' : ''}`);
  } finally {
    await client.end();
  }
}

test('PostgreSQL migration adapter and pg_dump/pg_restore work on isolated compatibility databases', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-ops-integration-'));
  const targetDatabase = `oh_bot_ops_restore_${process.pid}_compat`;
  const baseUrl = process.env.CORE_TEST_DATABASE_URL;
  if (!baseUrl) throw new Error('CORE_TEST_DATABASE_URL must be explicitly set');
  const sourceUrl = new URL(baseUrl);
  sourceUrl.pathname = `/${sourceDatabase}`;
  const databaseUrl = sourceUrl.toString();
  const targetUrlValue = new URL(databaseUrl);
  targetUrlValue.pathname = `/${targetDatabase}`;
  const targetUrl = targetUrlValue.toString();
  let targetCreated = false;
  let adapter: Awaited<ReturnType<typeof createPostgresLegacyAdapter>> | undefined;
  try {
    currentPhase = 'create-isolated-database';
    await manageDatabase(databaseUrl, targetDatabase, 'CREATE');
    targetCreated = true;

    const source = join(root, 'sessions.json');
    const journal = join(root, 'deletions.jsonl');
    const runId = `${process.pid}-${Date.now()}`;
    await writeFile(source, JSON.stringify({ sessions: { [`synthetic-session-${runId}`]: { messages: [{ text: 'old truncated history' }], handledMessageIds: [] } } }));
    await initializeDeletionJournal(journal);
    const legacyBackup = await createLegacyBackup({ sourcePaths: [source], outputDirectory: join(root, 'legacy-backup') });

    currentPhase = 'migration-adapter';
    adapter = await createPostgresLegacyAdapter(databaseUrl);
    if (!adapter) throw new Error('migration adapter unavailable');
    const migrationAdapter = adapter;
    const first = await migrateLegacyJson({ sourceKind:'sessions', sourcePath: source, backupManifestPath: legacyBackup.manifestPath, hasMigrated: migrationAdapter.hasMigrated, execute: migrationAdapter.importLegacyRecords });
    const second = await migrateLegacyJson({ sourceKind:'sessions', sourcePath: source, backupManifestPath: legacyBackup.manifestPath, hasMigrated: migrationAdapter.hasMigrated, execute: migrationAdapter.importLegacyRecords });
    assert.equal(first.skipped, false);
    assert.equal(second.skipped, true);
    const persisted = await migrationAdapter.hasMigrated(first.sourceHash!);
    assert.equal(persisted, true);
    const sandboxRows = await listLegacySandboxRecords(databaseUrl, first.sourceHash!);
    assert.equal(sandboxRows.length, 1);
    assert.equal((sandboxRows[0]?.record as { legacyKind: string }).legacyKind, 'session');
    assert.deepEqual((sandboxRows[0]?.record as { sandboxScope: { kind: string; sourceHash: string }; identityMerge: boolean; historyComplete: boolean }).sandboxScope,
      { kind: 'legacy_sandbox', sourceHash: first.sourceHash });
    assert.equal((sandboxRows[0]?.record as { identityMerge: boolean }).identityMerge, false);
    assert.equal((sandboxRows[0]?.record as { historyComplete: boolean }).historyComplete, false);

    const shapedFixtures: Array<{ kind: 'personas' | 'rules' | 'affection'; file: string; value: unknown; recordKind: string; recordId: string; count: number }> = [
      { kind: 'personas', file: 'personas.json', value: { [`legacy-persona-${runId}`]: { name: '旧人格', systemPrompt: '保留原始来源' } }, recordKind: 'persona', recordId: `legacy-persona-${runId}`, count: 1 },
      { kind: 'rules', file: 'rules.json', value: { admins: ['10001'], whitelistGroups: ['20001'], blacklistUsers: [], privateBlacklist: ['10002'], groupBlacklist: [], botNames: [`oh-bot-${runId}`], requireAtInGroup: true, aiEnabled: true, commandPrefix: '/', cooldownSeconds: 3 }, recordKind: 'rule', recordId: 'rules:0', count: 1 },
      { kind: 'affection', file: 'affection.json', value: { users: { [runId]: { affection: 67, turnCount: 9 } }, self: { currentAggressionSelf: 24 } }, recordKind: 'affection_legacy', recordId: `users:${runId}`, count: 2 },
    ];
    const importedHashes: string[] = [];
    for (const fixture of shapedFixtures) {
      const sourcePath = join(root, fixture.file);
      await writeFile(sourcePath, JSON.stringify(fixture.value));
      const backup = await createLegacyBackup({ sourcePaths: [sourcePath], outputDirectory: join(root, `backup-${fixture.kind}`) });
      const imported = await migrateLegacyJson({ sourceKind: fixture.kind, sourcePath, backupManifestPath: backup.manifestPath,
        hasMigrated: adapter.hasMigrated, execute: adapter.importLegacyRecords });
      importedHashes.push(imported.sourceHash!);
      const queryable = await listLegacySandboxRecords(databaseUrl, imported.sourceHash!);
      assert.equal(queryable.length, fixture.count, `unexpected queryable fixture count for ${fixture.kind}`);
      assert.equal((queryable[0]?.record as { legacyKind: string }).legacyKind, fixture.recordKind);
      assert.equal((queryable[0]?.record as { legacyId: string }).legacyId, fixture.recordId);
      assert.equal((queryable[0]?.record as { sandboxOnly: boolean; identityMerge: boolean }).sandboxOnly, true);
      assert.equal((queryable[0]?.record as { identityMerge: boolean }).identityMerge, false);
      if (fixture.kind === 'affection') assert.equal((queryable[0]?.record as { trustUpgrade: boolean }).trustUpgrade, false);
    }
    await adapter.close?.();
    adapter = undefined;

    const characterId=randomUUID();
    const sourceDb=createDatabase(databaseUrl);
    await sourceDb.db.insert(characters).values({id:characterId,name:`restore-fixture-${runId}`});
    await sourceDb.close();
    const historySource=join(root,'history.sqlite');
    const memoryId=`memory-before-backup-${runId}`;
    const history=new Sqlite(historySource); history.exec('CREATE TABLE memory_history (memory_id TEXT, message TEXT)'); history.prepare('INSERT INTO memory_history VALUES (?, ?)').run(memoryId,'forgotten private fact'); history.close();
    const mediaSource=join(root,'media'); await import('node:fs/promises').then(({mkdir})=>mkdir(mediaSource));
    await writeFile(join(mediaSource,'fixture.bin'),'before-forget-media');

    const executor = async (binary: string, args: string[], env?: NodeJS.ProcessEnv) => {
      if (binary !== 'pg_dump' && binary !== 'pg_restore') throw new Error('TEST_COMMAND_UNSUPPORTED');
      currentPhase = binary;
      await command(binary, args, env);
    };
    currentPhase = 'pg-dump';
    const backup = await runDatabaseBackup({
      outputDirectory: join(root, 'database-backup'), databaseUrl, assets: [historySource,mediaSource], deletionJournalPath: journal,
      execute: executor,
    });
    assert.equal(backup.status, 'local-only');
    assert.ok((await readFile(join(root, 'database-backup', 'business.dump'))).byteLength > 0);

    await appendDeletionJournal(journal,{operationKey:`forget-after-backup-${runId}`,characterId,sourceIds:[],memoryIds:[memoryId],scope:{kind:'character_public'}});
    const latest=await readDeletionJournal(journal);

    currentPhase = 'pg-restore';
    const deleteCalls:string[]=[];
    const assetRoot=join(root,'restored-assets');
    const ready = await restoreSnapshot({
      manifestPath: backup.manifestPath,
      rootDirectory: join(root, 'database-backup'),
      restoreAssetDirectory:assetRoot,
      targetDatabaseUrl: targetUrl,
      deletionJournalPath: journal,
      execute: executor,
        replayDeletionJournal: async (restoredJournalPath) => {
        const targetDb=createDatabase(targetUrl);
        try {
          const engine={add:async()=>({results:[]}),search:async()=>({results:[]}),get:async(id:string)=>({id}),delete:async(id:string)=>{deleteCalls.push(id);},deleteHistory:async(id:string)=>{const historyDb=new Sqlite(join(assetRoot,'history.sqlite'));const result=historyDb.prepare('DELETE FROM memory_history WHERE memory_id = ?').run(id);historyDb.close();return Number(result.changes);}};
          const gateway=new MemoryGateway(targetDb,new MemoryLifecycleService(targetDb),new MemoryReadService(targetDb),engine as never,async()=>{throw new Error('no actor required for journal replay');},restoredJournalPath);
          await gateway.assertDeletionJournalReplayed();
          const journalState = await readDeletionJournal(restoredJournalPath);
          const journalBytes = await readFile(restoredJournalPath);
          return { replayedThrough: journalState.latestSequence, journalSequence: journalState.latestSequence,
            journalChecksum: journalState.latestChecksum, targetDatabase, journalAssetSha256: createHash('sha256').update(journalBytes).digest('hex') };
        } finally { await targetDb.close(); }
      },
      isolatedTarget: true,
    });
    assert.equal(ready.ready, true);
    assert.equal(latest.latestSequence,1);
    assert.ok(deleteCalls.includes(memoryId));
    const restoredDb=createDatabase(targetUrl);
    try {
      const [tombstone]=await restoredDb.db.select().from(deletionRecords).where(eq(deletionRecords.operationKey,`forget-after-backup-${runId}`));
      assert.equal(tombstone?.status,'applied');
    } finally { await restoredDb.close(); }
    const restoredHistory=new Sqlite(join(assetRoot,'history.sqlite'),{readonly:true});
    assert.equal(restoredHistory.prepare('SELECT count(*) AS count FROM memory_history WHERE memory_id = ?').get(memoryId).count,0); restoredHistory.close();
    assert.equal(await readFile(join(assetRoot,'media','fixture.bin'),'utf8'),'before-forget-media');
    currentPhase = 'verify-restored-data';
    const restoredAdapter = await createPostgresLegacyAdapter(targetUrl);
    try {
      assert.equal(await restoredAdapter.hasMigrated(first.sourceHash!), true);
      for (const sourceHash of importedHashes) assert.equal(await restoredAdapter.hasMigrated(sourceHash), true);
    } finally {
      await restoredAdapter.close?.();
    }
  } finally {
    await adapter?.close?.();
    if (targetCreated) {
      await manageDatabase(databaseUrl, targetDatabase, 'DROP');
    }
    await rm(root, { recursive: true, force: true });
  }
});
