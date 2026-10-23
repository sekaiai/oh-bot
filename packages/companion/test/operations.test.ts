import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { initializeDeletionJournal, appendDeletionJournal, readDeletionJournal } from '../src/memory/memory-deletion-journal.js';
import { createLegacyBackup, migrateLegacyJson, restoreSnapshot, runDatabaseBackup, verifyRestoreReadiness } from '../src/operations/index.js';

async function snapshotFiles(root: string, seq = 0) {
  const backupRoot=join(root,'backup'); await mkdir(backupRoot,{recursive:true});
  const dump=join(backupRoot,'business.dump'); await writeFile(dump,'db');
  const journal=join(backupRoot,'deletion-journal.jsonl'); await initializeDeletionJournal(journal);
  for(let i=0;i<seq;i++) await appendDeletionJournal(journal,{operationKey:`forget:${i}`,characterId:randomUUID(),sourceIds:[],memoryIds:[`memory-${i}`],scope:{kind:'character_public'}});
  const state=await readDeletionJournal(journal);
  const assets=[];
  for(const path of [dump,journal]) { const bytes=await readFile(path); assets.push({path:path.slice(backupRoot.length+1),sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length}); }
  const manifest={format:1 as const,createdAt:new Date().toISOString(),kind:'restore_drill',assets,localOnly:true,deletionJournalSequence:state.latestSequence,deletionJournalChecksum:state.latestChecksum,deletionJournalPath:'deletion-journal.jsonl'};
  const manifestPath=join(backupRoot,'backup-manifest.json'); await writeFile(manifestPath,JSON.stringify(manifest));
  return {backupRoot,journal,manifestPath,manifest};
}

 test('legacy backup copies source bytes exactly and writes their digest manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-ops-'));
  try {
    const source = join(root, 'legacy.json'); const output = join(root, 'backups');
    const bytes = Buffer.from('{\n  "sessions": ["截断历史"]\n}\n');
    await writeFile(source, bytes);
    const manifest = await createLegacyBackup({ sourcePaths: [source], outputDirectory: output });
    assert.deepEqual(await readFile(join(output, 'legacy.json')), bytes);
    assert.equal(manifest.files[0]?.sha256.length, 64);
    assert.equal(manifest.files[0]?.sizeBytes, bytes.length);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy migration is idempotent and marks old affection as legacy without trust', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-ops-'));
  try {
    const source = join(root, 'sessions.json'); await writeFile(source, JSON.stringify({ sessions: { s1: { messages: [{ text: 'truncated' }], handledMessageIds: [] } } }));
    const backup = await createLegacyBackup({ sourcePaths: [source], outputDirectory: join(root, 'backup') });
    const calls: string[] = [];
    let migratedHash='';
    const hasMigrated=async(hash:string)=>hash===migratedHash;
    const result = await migrateLegacyJson({ sourceKind:'sessions', sourcePath: source, backupManifestPath: backup.manifestPath, hasMigrated, execute: async (records, metadata) => { calls.push(...records.map(r=>r.kind)); migratedHash=metadata.sourceHash; assert.equal(records[0]?.historyComplete,false); return { inserted: records.length }; } });
    const again = await migrateLegacyJson({ sourceKind:'sessions', sourcePath: source, backupManifestPath: backup.manifestPath, hasMigrated, execute: async () => { throw new Error('must not reimport'); } });
    assert.deepEqual(calls, ['session']);
    assert.equal(result.counts.trustUpgrades, 0); assert.equal(again.skipped, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy importer preserves the real keyed sessions, personas, rules, and affection file shapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-ops-'));
  try {
    const fixtures: Array<{ kind: 'sessions' | 'personas' | 'rules' | 'affection'; file: string; value: unknown; expectedKind: string; expectedIds: string[] }> = [
      { kind: 'sessions', file: 'sessions.json', value: { 'private:qq:42': { messages: [{ role: 'user', content: '旧消息', time: 1 }], handledMessageIds: ['m1'] } }, expectedKind: 'session', expectedIds: ['private:qq:42'] },
      { kind: 'personas', file: 'personas.json', value: { 'legacy-nanzhi': { name: '南枝', systemPrompt: 'legacy prompt' } }, expectedKind: 'persona', expectedIds: ['legacy-nanzhi'] },
      { kind: 'rules', file: 'rules.json', value: { admins: ['10001'], whitelistGroups: ['20001'], blacklistUsers: [], privateBlacklist: ['10002'], groupBlacklist: [], botNames: ['oh-bot'], requireAtInGroup: true, aiEnabled: true, commandPrefix: '/', cooldownSeconds: 3 }, expectedKind: 'rule', expectedIds: ['rules:0'] },
      { kind: 'affection', file: 'affection.json', value: { users: { '10001': { affection: 66, turnCount: 12 } }, self: { currentAggressionSelf: 25 } }, expectedKind: 'affection_legacy', expectedIds: ['users:10001', 'self'] },
    ];
    for (const fixture of fixtures) {
      const source = join(root, fixture.file);
      await writeFile(source, JSON.stringify(fixture.value));
      const backup = await createLegacyBackup({ sourcePaths: [source], outputDirectory: join(root, `${fixture.kind}-backup`) });
      let imported: import('../src/operations/index.js').LegacyRecord[] = [];
      const result = await migrateLegacyJson({ sourceKind: fixture.kind, sourcePath: source, backupManifestPath: backup.manifestPath, hasMigrated: async () => false,
        execute: async (records) => { imported = records; return { inserted: records.length }; } });
      assert.equal(result.counts.sessions + result.counts.personas + result.counts.rules + result.counts.affectionLegacy, fixture.expectedIds.length);
      assert.deepEqual(imported.map((record) => record.kind), Array(fixture.expectedIds.length).fill(fixture.expectedKind));
      assert.deepEqual(imported.map((record) => record.legacyId), fixture.expectedIds);
      assert.ok(imported.every((record) => record.sandboxOnly && record.identityMerge === false));
      if (fixture.kind === 'sessions') assert.ok(imported.every((record) => record.historyComplete === false));
      if (fixture.kind === 'affection') assert.ok(imported.every((record) => record.trustUpgrade === false));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy importer rejects unsupported file shapes before writing an imported marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-ops-'));
  try {
    const source = join(root, 'sessions.json'); await writeFile(source, JSON.stringify({ sessions: [] }));
    const backup = await createLegacyBackup({ sourcePaths: [source], outputDirectory: join(root, 'backup') });
    let executeCalled = false;
    await assert.rejects(() => migrateLegacyJson({ sourceKind: 'sessions', sourcePath: source, backupManifestPath: backup.manifestPath,
      hasMigrated: async () => false, execute: async () => { executeCalled = true; return { inserted: 0 }; } }), /LEGACY_SHAPE_UNSUPPORTED/);
    assert.equal(executeCalled, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('legacy affection files retain the repository per-bot users and self records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-ops-'));
  try {
    const { createCompanionOperationsRunner } = await import('../src/operations/runner.js');
    const affectionRoot = join(root, 'affection'); const botRoot = join(affectionRoot, 'default_bot');
    await mkdir(botRoot, { recursive: true });
    await writeFile(join(botRoot, 'users.json'), JSON.stringify({ '10001': { affection: 71, turnCount: 4, lastInteraction: 12 } }));
    await writeFile(join(botRoot, 'self.json'), JSON.stringify({ baseLibidoSelf: 25, currentLibidoSelf: 27, lastUpdate: 12 }));
    const runner = createCompanionOperationsRunner({ env: { COMPANION_LEGACY_SOURCE_ROOT: root } as NodeJS.ProcessEnv });
    const inspected = await runner.run({ action: 'inspect', sourceId: 'affection/default_bot/users.json', auditReason: 'inspect legacy fixture', confirm: true });
    assert.equal(inspected.sourceId, 'affection/default_bot/users.json');
    assert.equal(inspected.sourceKind, 'affection');
    assert.match(String(inspected.version), /^[a-f0-9]{64}$/);
    assert.ok(Number(inspected.sizeBytes) > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('operations list projects only configured backup and supported legacy source rows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-ops-list-'));
  try {
    const backupRoot = join(root, 'backups'); const sourceRoot = join(root, 'legacy');
    await mkdir(backupRoot); await mkdir(join(sourceRoot, 'affection', 'bot'), { recursive: true });
    await writeFile(join(sourceRoot, 'affection', 'bot', 'users.json'), JSON.stringify({ '10001': { affection: 71 } }));
    await writeFile(join(sourceRoot, 'ignore.txt'), 'not an import source');
    const backup = join(backupRoot, 'backup-fixture'); await mkdir(backup);
    const manifestBytes = Buffer.from(JSON.stringify({ format: 1, createdAt: new Date().toISOString(), assets: [], localOnly: true }));
    await writeFile(join(backup, 'backup-manifest.json'), manifestBytes);
    const { createCompanionOperationsRunner } = await import('../src/operations/runner.js');
    const result = await createCompanionOperationsRunner({ env: { COMPANION_BACKUP_ROOT: backupRoot, COMPANION_LEGACY_SOURCE_ROOT: sourceRoot,
      COMPANION_DATABASE_URL: 'postgresql://localhost/oh_bot_ops_compat', MEMORY_DELETION_JOURNAL_PATH: join(root, 'journal'),
      COMPANION_RESTORE_ROOT: root, RESTORE_DATABASE_URL: 'postgresql://localhost/oh_bot_restore_compat' } as NodeJS.ProcessEnv }).list();
    assert.equal(result.backups.length, 1);
    assert.equal(result.backups[0]?.backupId, 'backup-fixture');
    assert.equal(result.backups[0]?.version, createHash('sha256').update(manifestBytes).digest('hex'));
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0]?.sourceId, 'affection/bot/users.json');
    assert.equal(result.sources[0]?.sourceKind, 'affection');
    assert.equal(result.capabilities.migrations.ready, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('backup, restore, and migration writes require a selected SHA-256 version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-ops-cas-'));
  try {
    const backupRoot = join(root, 'backups'); const sourceRoot = join(root, 'legacy'); const restoreRoot = join(root, 'restore');
    await mkdir(backupRoot); await mkdir(sourceRoot); await mkdir(restoreRoot);
    const source = join(sourceRoot, 'sessions.json'); await writeFile(source, JSON.stringify({ sessions: { old: { messages: [] } } }));
    const backupId = 'backup-fixture'; const backupDir = join(backupRoot, backupId); await mkdir(backupDir);
    await writeFile(join(backupDir, 'backup-manifest.json'), JSON.stringify({ format: 1 }));
    const env = { COMPANION_BACKUP_ROOT: backupRoot, COMPANION_LEGACY_SOURCE_ROOT: sourceRoot, COMPANION_RESTORE_ROOT: restoreRoot,
      COMPANION_DATABASE_URL: 'postgresql://localhost/oh_bot_ops_compat', RESTORE_DATABASE_URL: 'postgresql://localhost/oh_bot_restore_compat',
      MEMORY_DELETION_JOURNAL_PATH: join(root, 'journal') } as NodeJS.ProcessEnv;
    const { createCompanionOperationsRunner } = await import('../src/operations/runner.js');
    const runner = createCompanionOperationsRunner({ env, execute: async () => { throw new Error('must not execute'); } });
    await assert.rejects(() => runner.run({ action: 'backup', sourceId: 'sessions.json', auditReason: 'backup legacy source', confirm: true }), /EXPECTED_VERSION_REQUIRED/);
    await assert.rejects(() => runner.run({ action: 'apply', sourceId: 'sessions.json', auditReason: 'apply legacy source', confirm: true }), /EXPECTED_VERSION_REQUIRED/);
    await assert.rejects(() => runner.run({ action: 'restore', backupId, auditReason: 'restore selected backup', confirm: true }), /EXPECTED_VERSION_REQUIRED/);
    await assert.rejects(() => runner.run({ action: 'verify', backupId, auditReason: 'verify selected backup', confirm: true }), /EXPECTED_VERSION_REQUIRED/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('restore readiness rejects missing assets and forgotten-data replay not applied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'companion-ops-'));
  try {
    const fixture=await snapshotFiles(root,1);
    await writeFile(join(fixture.backupRoot,'media.bin'),'media');
    fixture.manifest.assets.push({path:'media.bin',sha256:createHash('sha256').update('media').digest('hex'),sizeBytes:5});
    await assert.rejects(() => verifyRestoreReadiness({ manifest: fixture.manifest, rootDirectory: fixture.backupRoot, targetDatabaseUrl: 'postgresql://compat/oh_bot_restore_compat', receipt: undefined }), /DELETION_JOURNAL_REPLAY_INCOMPLETE/);
    await assert.rejects(() => verifyRestoreReadiness({ manifest: fixture.manifest, rootDirectory: fixture.backupRoot, targetDatabaseUrl: 'postgresql://compat/oh_bot_restore_compat', receipt: { replayedThrough: 0 } as never }), /DELETION_JOURNAL_REPLAY_INCOMPLETE/);
    await writeFile(join(fixture.backupRoot, 'media.bin'), 'corrupt');
    await assert.rejects(() => verifyRestoreReadiness({ manifest: fixture.manifest, rootDirectory: fixture.backupRoot, targetDatabaseUrl: 'postgresql://compat/oh_bot_restore_compat', receipt: { replayedThrough: 1 } as never }), /ASSET_HASH_MISMATCH/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('asset paths cannot escape restore root', async () => {
  await assert.rejects(() => verifyRestoreReadiness({ manifest: { format: 1, assets: [{ path: '../outside', sha256: 'x', sizeBytes: 1 }], deletionJournalSequence:0,deletionJournalChecksum:'0'.repeat(64),deletionJournalPath:'../outside' }, rootDirectory: '/tmp', targetDatabaseUrl: 'postgresql://compat/oh_bot_restore_compat', receipt: { replayedThrough: 0 } as never }), /ASSET_PATH_REJECTED/);
});

test('database backup captures the independent deletion journal and reports local-only', async () => {
  const root=await mkdtemp(join(tmpdir(),'companion-ops-'));
  try {
    const journal=join(root,'deletions.jsonl'); await initializeDeletionJournal(journal);
    const result=await runDatabaseBackup({outputDirectory:join(root,'backup'),databaseUrl:'postgresql://safe:topsecret@example/db',assets:[],deletionJournalPath:journal,execute:async(_cmd,args,env)=>{assert.equal(JSON.stringify(args).includes('topsecret'),false);assert.equal(env?.PGPASSWORD,'topsecret');await writeFile(args[args.indexOf('--file')+1],'dump-bytes');}});
    assert.equal(result.status,'local-only'); assert.ok(result.manifest.assets.some(a=>a.path==='deletion-journal.jsonl'));
    const saved=await readFile(result.manifestPath,'utf8'); assert.equal(saved.includes('safe@example'),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('restore replays deletion journal before returning readiness', async () => {
  const root=await mkdtemp(join(tmpdir(),'companion-ops-'));
  try {
    const fixture=await snapshotFiles(root,0);
    const latestJournal=join(root,'latest-deletions.jsonl'); await initializeDeletionJournal(latestJournal);
    await appendDeletionJournal(latestJournal,{operationKey:'forget:after-backup',characterId:randomUUID(),sourceIds:[],memoryIds:['forgotten'],scope:{kind:'character_public'}});
    const restoredJournalState=await readDeletionJournal(latestJournal);
    const order:string[]=[];
    const assetRoot=join(root,'restored-assets');
    const ready=await restoreSnapshot({manifestPath:fixture.manifestPath,rootDirectory:fixture.backupRoot,restoreAssetDirectory:assetRoot,targetDatabaseUrl:'postgresql://isolated/oh_bot_restore_compat',deletionJournalPath:latestJournal,isolatedTarget:true,execute:async(cmd)=>{order.push(cmd);},replayDeletionJournal:async(path,through)=>{order.push('replay');assert.equal(through,restoredJournalState.latestSequence);assert.equal(path,join(assetRoot,'deletion-journal.jsonl'));return { replayedThrough: through, journalSequence: restoredJournalState.latestSequence, journalChecksum: restoredJournalState.latestChecksum, targetDatabase: 'oh_bot_restore_compat', journalAssetSha256: createHash('sha256').update(await readFile(path)).digest('hex') }; }});
    assert.deepEqual(order,['pg_restore','replay']); assert.equal(ready.ready,true);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('restore copies verified assets and catches a journal advance during replay', async () => {
  const root=await mkdtemp(join(tmpdir(),'companion-ops-'));
  try {
    const fixture=await snapshotFiles(root,0);
    const media=join(fixture.backupRoot,'media','photo.bin'); await mkdir(join(fixture.backupRoot,'media'));
    await writeFile(media,'verified-media');
    const mediaBytes=await readFile(media);
    fixture.manifest.assets.push({path:'media/photo.bin',sha256:createHash('sha256').update(mediaBytes).digest('hex'),sizeBytes:mediaBytes.length});
    await writeFile(fixture.manifestPath,JSON.stringify(fixture.manifest));
    const latest=join(root,'latest.jsonl'); await initializeDeletionJournal(latest);
    await appendDeletionJournal(latest,{operationKey:'forget:first',characterId:randomUUID(),sourceIds:[],memoryIds:['first'],scope:{kind:'character_public'}});
    const assetRoot=join(root,'assets'); const seen:number[]=[];
    const ready=await restoreSnapshot({manifestPath:fixture.manifestPath,rootDirectory:fixture.backupRoot,restoreAssetDirectory:assetRoot,targetDatabaseUrl:'postgresql://isolated/oh_bot_restore_compat',deletionJournalPath:latest,isolatedTarget:true,execute:async()=>{},replayDeletionJournal:async(path,through)=>{
      assert.equal(path,join(assetRoot,'deletion-journal.jsonl')); seen.push(through);
      const restored=await readDeletionJournal(path);
      assert.equal(restored.latestSequence,through);
      if(seen.length===1) await appendDeletionJournal(latest,{operationKey:'forget:second',characterId:randomUUID(),sourceIds:[],memoryIds:['second'],scope:{kind:'character_public'}});
      return { replayedThrough: through, journalSequence: through, journalChecksum: restored.latestChecksum, targetDatabase: 'oh_bot_restore_compat', journalAssetSha256: createHash('sha256').update(await readFile(path)).digest('hex') };
    }});
    assert.deepEqual(seen,[1,2]);
    assert.equal(ready.deletionJournalReplayedThrough,2);
    assert.equal(await readFile(join(assetRoot,'media','photo.bin'),'utf8'),'verified-media');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('restore rejects non-compat databases before running pg_restore', async () => {
  const root=await mkdtemp(join(tmpdir(),'companion-ops-'));
  try {
    const calls:string[]=[];
    await assert.rejects(()=>restoreSnapshot({manifestPath:join(root,'none'),rootDirectory:root,restoreAssetDirectory:join(root,'restore'),targetDatabaseUrl:'postgresql://localhost/prod',deletionJournalPath:join(root,'deletion-journal.jsonl'),isolatedTarget:true,execute:async(cmd)=>{calls.push(cmd);},replayDeletionJournal:async()=>({} as never)}),/RESTORE_TARGET_NOT_COMPAT/);
    assert.deepEqual(calls,[]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('restore validates the latest independent journal before pg_restore', async () => {
  const root=await mkdtemp(join(tmpdir(),'companion-ops-'));
  try {
    const fixture=await snapshotFiles(root,0);
    const latestJournal=join(root,'latest-deletions.jsonl'); await writeFile(latestJournal,'corrupt');
    const calls:string[]=[];
    await assert.rejects(()=>restoreSnapshot({manifestPath:fixture.manifestPath,rootDirectory:fixture.backupRoot,restoreAssetDirectory:join(root,'restore'),targetDatabaseUrl:'postgresql://localhost/oh_bot_restore_compat',deletionJournalPath:latestJournal,isolatedTarget:true,execute:async(cmd)=>{calls.push(cmd);},replayDeletionJournal:async()=>({} as never)}),/DELETION_JOURNAL|corrupt/i);
    assert.deepEqual(calls,[]);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('retention selection uses timestamp buckets and configured limits', async () => {
  const { selectRetentionCandidates }=await import('../src/operations/index.js');
  const now=new Date('2026-10-23T12:00:00Z');
  const candidates=selectRetentionCandidates(Array.from({length:6},(_,i)=>({path:`b${i}`,createdAt:new Date(now.getTime()-i*6*3600_000).toISOString()})),now);
  assert.equal(candidates.length,2);
});

test('scheduled backup buckets are stable UTC six-hourly, daily, weekly, and monthly keys', async () => {
  const { scheduledBackupBuckets, runScheduledBackupSchedule } = await import('../src/operations/runner.js');
  assert.deepEqual(scheduledBackupBuckets(new Date('2026-11-01T00:15:00Z')), [
    { kind: 'six_hourly', key: 'six-hourly-2026-11-01-00' },
    { kind: 'daily', key: 'daily-2026-11-01' },
    { kind: 'weekly', key: 'weekly-2026-44' },
    { kind: 'monthly', key: 'monthly-2026-11' },
  ]);
  assert.deepEqual(scheduledBackupBuckets(new Date('2026-11-02T12:15:00Z')), [
    { kind: 'six_hourly', key: 'six-hourly-2026-11-02-12' },
    { kind: 'daily', key: 'daily-2026-11-02' },
    { kind: 'weekly', key: 'weekly-2026-45' },
    { kind: 'monthly', key: 'monthly-2026-11' },
  ]);
  const root = await mkdtemp(join(tmpdir(), 'companion-schedule-'));
  try {
    const backupRoot = join(root, 'backups'); const restoreRoot = join(root, 'restore'); const journal = join(root, 'deletion-journal.jsonl');
    await mkdir(backupRoot); await mkdir(restoreRoot); await initializeDeletionJournal(journal);
    const env = { COMPANION_BACKUP_SCHEDULE_ENABLED: 'true', COMPANION_BACKUP_ROOT: backupRoot, COMPANION_RESTORE_ROOT: restoreRoot,
      COMPANION_DATABASE_URL: 'postgresql://compat@localhost/source', COMPANION_MONTHLY_RESTORE_DATABASE_URL: 'postgresql://compat@localhost/monthly_compat', MEMORY_DELETION_JOURNAL_PATH: journal } as NodeJS.ProcessEnv;
    let monthlyDrills = 0;
    const options = { env, now: new Date(), execute: async (_binary: string, args: string[]) => {
      await writeFile(args[args.indexOf('--file') + 1]!, 'synthetic-pg-dump');
    }, runMonthlyRestore: async ({ restoreAssetDirectory }: { restoreAssetDirectory: string }) => {
      monthlyDrills += 1; await mkdir(restoreAssetDirectory, { recursive: true }); return { ready: true, journalChecksum: 'a'.repeat(64) };
    } };
    const first = await runScheduledBackupSchedule(options);
    const second = await runScheduledBackupSchedule(options);
    assert.equal(first.created.length, 4);
    assert.deepEqual(second.created, []);
    assert.equal(second.skipped.length, 4);
    assert.equal(monthlyDrills, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SQLite snapshot uses the database backup API and preserves committed rows', async () => {
  const root=await mkdtemp(join(tmpdir(),'companion-ops-'));
  try {
    const require=createRequire(import.meta.url);
    const Database=require('better-sqlite3');
    const { snapshotSqliteDatabase }=await import('../src/operations/index.js');
    const source=join(root,'mem0.sqlite'); const backup=join(root,'backup.sqlite');
    const db=new Database(source); db.exec('CREATE TABLE facts (value TEXT); INSERT INTO facts VALUES (\'durable\')'); db.close();
    await snapshotSqliteDatabase(source,backup);
    const restored=new Database(backup,{readonly:true});
    assert.equal(restored.prepare('SELECT value FROM facts').get()?.value,'durable');
    restored.close();
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('retention pruning only removes expired copies with ownership and valid manifests', async () => {
  const { pruneByRetention }=await import('../src/operations/index.js');
  const root=await mkdtemp(join(tmpdir(),'companion-ops-'));
  try {
    const retained=join(root,'retained'); const expired=join(root,'expired');
    await mkdir(retained); await mkdir(expired);
    await writeFile(join(retained,'.companion-backup-owner'),'owned');
    await writeFile(join(expired,'.companion-backup-owner'),'owned');
    await writeFile(join(retained,'backup-manifest.json'),'{}'); await writeFile(join(expired,'backup-manifest.json'),'{}');
    const now=new Date('2026-10-23T12:00:00Z'); const removed:string[]=[];
    const result=await pruneByRetention({backups:[{path:retained,createdAt:now.toISOString()},{path:expired,createdAt:'2020-01-01T00:00:00Z'}],now,ownershipMarker:'owned',validateManifest:async(path)=>path===join(expired,'backup-manifest.json'),remove:async(path)=>{removed.push(path);}});
    assert.deepEqual(result,[expired]); assert.deepEqual(removed,[expired]);
  } finally { await rm(root,{recursive:true,force:true}); }
});
