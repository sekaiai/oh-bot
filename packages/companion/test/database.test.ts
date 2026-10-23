import test from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { uuid, requireCompatDatabaseUrl } from './helpers.js';

const databaseUrl = requireCompatDatabaseUrl();

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  while (current && typeof current === 'object') {
    const candidate = current as { code?: string; cause?: unknown };
    if (candidate.code) return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function expectPostgresError(
  transaction: any,
  code: string,
  query: (nestedTransaction: any) => Promise<unknown>,
): Promise<void> {
  await assert.rejects(
    transaction.transaction((nestedTransaction: any) => query(nestedTransaction)),
    (error: unknown) => postgresCode(error) === code,
  );
}

test('fresh database migration is repeatable and preserves existing data and constraints', async () => {
  const database = createDatabase(databaseUrl);
  const { db } = database;
  const existingPersonId = uuid();
  let primaryError: unknown;

  try {
    await db.execute(sql`select 1`);
    await migrateDatabase(database);
    const migrationMetadata = await db.execute(sql`
      select table_schema from information_schema.tables
      where table_schema = 'companion_migrations' and table_name = '__drizzle_migrations'
    `);
    assert.equal(migrationMetadata.rows.length, 1);

    await db.execute(sql`
      insert into companion.people (id, display_name)
      values (${existingPersonId}, 'migration-fixture')
    `);
    await migrateDatabase(database);

    const existingRow = await db.execute(sql`
      select id from companion.people where id = ${existingPersonId}
    `);
    assert.equal(existingRow.rows.length, 1);

    await db.transaction(async (transaction) => {
      const firstPersonId = uuid();
      const secondPersonId = uuid();
      const deletionOnlyPersonId = uuid();
      const characterId = uuid();
      const secondCharacterId = uuid();
      const firstVersionId = uuid();
      const secondVersionId = uuid();
      const conversationId = uuid();
      const messageId = uuid();

      await transaction.execute(sql`
        insert into companion.people (id, display_name)
        values
          (${firstPersonId}, 'same-name'),
          (${secondPersonId}, 'same-name'),
          (${deletionOnlyPersonId}, 'deletion-only')
      `);
      await transaction.execute(sql`
        insert into companion.characters (id, name)
        values (${characterId}, 'first'), (${secondCharacterId}, 'second')
      `);
      await transaction.execute(sql`
        insert into companion.character_versions (id, character_id, revision, core, created_by)
        values
          (${firstVersionId}, ${characterId}, 1, '{}', 'test'),
          (${secondVersionId}, ${secondCharacterId}, 1, '{}', 'test')
      `);
      await transaction.execute(sql`
        update companion.characters set current_version_id = ${firstVersionId}
        where id = ${characterId}
      `);
      await expectPostgresError(transaction, '23503', (nested) => nested.execute(sql`
        update companion.characters set current_version_id = ${secondVersionId}
        where id = ${characterId}
      `));

      await transaction.execute(sql`
        insert into companion.platform_identities (person_id, platform, platform_user_id, verification_method)
        values (${firstPersonId}, 'qq', 'same-platform-id', 'test')
      `);
      await expectPostgresError(transaction, '23505', (nested) => nested.execute(sql`
        insert into companion.platform_identities (person_id, platform, platform_user_id, verification_method)
        values (${secondPersonId}, 'qq', 'same-platform-id', 'test')
      `));
      await transaction.execute(sql`
        insert into companion.platform_identities (person_id, platform, platform_user_id, verification_method)
        values (${secondPersonId}, 'weixin', 'same-platform-id', 'test')
      `);
      const sameNameCount = await transaction.execute(sql`
        select count(*)::int as count from companion.people where display_name = 'same-name'
      `);
      assert.equal(sameNameCount.rows[0]?.count, 2);
      const identityCount = await transaction.execute(sql`
        select count(*)::int as count from companion.platform_identities
        where platform_user_id = 'same-platform-id'
      `);
      assert.equal(identityCount.rows[0]?.count, 2);

      await transaction.execute(sql`
        insert into companion.primary_relationship_bindings (character_id, person_id, created_by)
        values (${characterId}, ${firstPersonId}, 'test')
      `);
      await expectPostgresError(transaction, '23505', (nested) => nested.execute(sql`
        insert into companion.primary_relationship_bindings (character_id, person_id, created_by)
        values (${characterId}, ${secondPersonId}, 'test')
      `));

      await expectPostgresError(transaction, '23503', (nested) => nested.execute(sql`
        insert into companion.conversations (character_id, platform, platform_conversation_id, kind)
        values (${uuid()}, 'qq', 'orphan-conversation', 'private')
      `));
      await transaction.execute(sql`
        insert into companion.conversations (id, character_id, platform, platform_conversation_id, kind)
        values (${conversationId}, ${characterId}, 'qq', 'test-conversation', 'private')
      `);
      await transaction.execute(sql`
        insert into companion.messages (id, conversation_id, platform, platform_event_id, role, text)
        values (${messageId}, ${conversationId}, 'qq', 'test-event', 'user', 'hello')
      `);
      await expectPostgresError(transaction, '23505', (nested) => nested.execute(sql`
        insert into companion.messages (conversation_id, platform, platform_event_id, role, text)
        values (${conversationId}, 'qq', 'test-event', 'user', 'duplicate')
      `));
      await expectPostgresError(transaction, '23503', (nested) => nested.execute(sql`
        insert into companion.turns (conversation_id, inbound_message_id, person_id, status, graph_thread_id)
        values (${conversationId}, ${uuid()}, ${firstPersonId}, 'received', 'test-thread')
      `));
      const turnId = uuid();
      await transaction.execute(sql`
        insert into companion.turns (id, conversation_id, inbound_message_id, person_id, status, graph_thread_id)
        values (${turnId}, ${conversationId}, ${messageId}, ${firstPersonId}, 'received', 'test-thread')
      `);
      await expectPostgresError(transaction, '23514', (nested) => nested.execute(sql`
        update companion.people set version = 0 where id = ${firstPersonId}
      `));

      await transaction.execute(sql`
        insert into companion.deletion_records (character_id, person_id, scope, operation_key)
        values (
          ${characterId}, ${deletionOnlyPersonId},
          ${JSON.stringify({ kind: 'person_private', personId: deletionOnlyPersonId })}::jsonb,
          'deletion-test'
        )
      `);
      await expectPostgresError(transaction, '23503', (nested) => nested.execute(sql`
        delete from companion.people where id = ${deletionOnlyPersonId}
      `));

      const sourceId = uuid();
      await transaction.execute(sql`
        insert into companion.memory_sources
          (id, character_id, person_id, conversation_id, message_id, source_kind, batch_key, scope, claim_kind, allowed_for_extraction)
        values (${sourceId}, ${characterId}, ${firstPersonId}, ${conversationId}, ${messageId}, 'user', 'batch-f1b',
          ${JSON.stringify({ kind: 'person_private', personId: firstPersonId })}::jsonb, 'direct', true)
      `);
      await expectPostgresError(transaction, '23505', (nested) => nested.execute(sql`
        insert into companion.memory_sources
          (character_id, person_id, conversation_id, message_id, source_kind, batch_key, scope, claim_kind)
        values (${characterId}, ${firstPersonId}, ${conversationId}, ${messageId}, 'user', 'batch-f1b',
          ${JSON.stringify({ kind: 'person_private', personId: firstPersonId })}::jsonb, 'direct')
      `));
      const revisionId = uuid();
      await transaction.execute(sql`
        insert into companion.memory_revisions
          (id, character_id, canonical_key, revision, source_id, scope, status, valid_from)
        values (${revisionId}, ${characterId}, 'f1b-current-fact', 1, ${sourceId},
          ${JSON.stringify({ kind: 'person_private', personId: firstPersonId })}::jsonb, 'validated', now())
      `);
      await expectPostgresError(transaction, '23505', (nested) => nested.execute(sql`
        insert into companion.memory_revisions
          (character_id, canonical_key, revision, source_id, scope, status, valid_from)
        values (${characterId}, 'f1b-current-fact', 2, ${sourceId},
          ${JSON.stringify({ kind: 'person_private', personId: firstPersonId })}::jsonb, 'validated', now())
      `));
      await expectPostgresError(transaction, '23505', (nested) => nested.execute(sql`
        insert into companion.memory_revisions
          (character_id, canonical_key, revision, source_id, scope, status, valid_from)
        values (${characterId}, 'f1b-current-fact', 1, ${sourceId},
          ${JSON.stringify({ kind: 'person_private', personId: firstPersonId })}::jsonb, 'candidate', now())
      `));
      await transaction.execute(sql`
        insert into companion.memory_revisions
          (character_id, canonical_key, revision, source_id, scope, status, valid_from)
        values (${characterId}, 'f1b-current-fact', 2, ${sourceId},
          ${JSON.stringify({ kind: 'person_private', personId: firstPersonId })}::jsonb, 'candidate', now()),
               (${characterId}, 'f1b-current-fact', 3, ${sourceId},
          ${JSON.stringify({ kind: 'person_private', personId: firstPersonId })}::jsonb, 'candidate', now())
      `);
      await transaction.execute(sql`
        insert into companion.memory_revisions
          (character_id, canonical_key, revision, source_id, scope, status, valid_from, valid_to)
        values (${characterId}, 'f1b-current-fact', 4, ${sourceId},
          ${JSON.stringify({ kind: 'person_private', personId: firstPersonId })}::jsonb, 'validated', now(), now())
      `);
      await expectPostgresError(transaction, '23514', (nested) => nested.execute(sql`
        insert into companion.memory_revisions
          (character_id, canonical_key, revision, source_id, scope, status, valid_from)
        values (${characterId}, 'f1b-revision-zero', 0, ${sourceId},
          ${JSON.stringify({ kind: 'person_private', personId: firstPersonId })}::jsonb, 'candidate', now())
      `));
      await expectPostgresError(transaction, '23514', (nested) => nested.execute(sql`
        insert into companion.memory_revisions
          (character_id, canonical_key, revision, source_id, scope, status, valid_from)
        values (${characterId}, 'f1b-revision-negative', -1, ${sourceId},
          ${JSON.stringify({ kind: 'person_private', personId: firstPersonId })}::jsonb, 'candidate', now())
      `));

      await transaction.execute(sql`
        insert into companion.model_profiles
          (id,name,purpose,provider,base_url,model,credential_ref,last_test_status)
        values (${uuid()}, 'f1b-chat', 'chat', 'test', 'http://localhost', 'chat-model', 'ENV_CHAT', 'never'),
               (${uuid()}, 'f1b-embedding', 'embedding', 'test', 'http://localhost', 'embed-model', 'ENV_EMBED', 'never')
      `);
      const modelRows = await transaction.execute(sql`select id,purpose from companion.model_profiles where name in ('f1b-chat','f1b-embedding')`);
      const chatProfile = modelRows.rows.find((row) => row.purpose === 'chat')?.id as string;
      const embedProfile = modelRows.rows.find((row) => row.purpose === 'embedding')?.id as string;
      await expectPostgresError(transaction, '23503', (nested) => nested.execute(sql`
        insert into companion.model_role_bindings (character_id,purpose,profile_id) values (${characterId}, 'chat', ${embedProfile})
      `));
      await transaction.execute(sql`
        insert into companion.model_role_bindings (character_id,purpose,profile_id) values (${characterId}, 'chat', ${chatProfile})
      `);
      const indexOne = uuid();
      await transaction.execute(sql`
        insert into companion.memory_indexes (id,character_id,model_profile_id,provider,model,dimensions,preprocessing_version,collection_name,status)
        values (${indexOne},${characterId},${embedProfile},'test','embed-model',384,'v1','f1b-collection-one','active')
      `);
      await transaction.execute(sql`
        insert into companion.memory_indexes (character_id,model_profile_id,provider,model,dimensions,preprocessing_version,collection_name,status)
        values (${characterId},${embedProfile},'test','embed-model',384,'v1','f1b-collection-building','building'),
               (${characterId},${embedProfile},'test','embed-model',384,'v1','f1b-collection-retired','retired')
      `);
      await expectPostgresError(transaction, '23505', (nested) => nested.execute(sql`
        insert into companion.memory_indexes (character_id,model_profile_id,provider,model,dimensions,preprocessing_version,collection_name,status)
        values (${characterId},${embedProfile},'test','embed-model',384,'v1','f1b-collection-two','active')
      `));

      const defaults = await transaction.execute(sql`
        insert into companion.proactive_permissions (character_id,person_id) values (${characterId},${firstPersonId}) returning enabled
      `);
      assert.equal(defaults.rows[0]?.enabled, false);
      await transaction.execute(sql`insert into companion.conversation_policies (conversation_id) values (${conversationId})`);
      const policyDefaults = await transaction.execute(sql`select trigger_mode, circle_disclosure_verified, proactive_enabled from companion.conversation_policies where conversation_id=${conversationId}`);
      assert.deepEqual(policyDefaults.rows[0], { trigger_mode: 'mentioned', circle_disclosure_verified: false, proactive_enabled: false });
      await expectPostgresError(transaction, '23514', (nested) => nested.execute(sql`
        insert into companion.emotion_states (character_id,person_id,pleasantness) values (${characterId},${firstPersonId},1.1)
      `));
      await expectPostgresError(transaction, '23514', (nested) => nested.execute(sql`
        insert into companion.relationship_states (character_id,person_id,trust) values (${characterId},${firstPersonId},-0.1)
      `));
      await transaction.execute(sql`insert into companion.operation_keys (key,kind,status) values ('f1b-operation-key','test','completed')`);
      await expectPostgresError(transaction, '23505', (nested) => nested.execute(sql`
        insert into companion.operation_keys (key,kind,status) values ('f1b-operation-key','test','completed')
      `));
      await transaction.execute(sql`
        insert into companion.agent_runs (character_id,turn_id,graph_version,thread_id,task,budget)
        values (${characterId},${turnId},'v1','f1b-agent-valid','{}','{}')
      `);
      await expectPostgresError(transaction, '23503', (nested) => nested.execute(sql`
        insert into companion.agent_runs (character_id,turn_id,graph_version,thread_id,task,budget)
        values (${characterId},${uuid()},'v1','f1b-agent-invalid','{}','{}')
      `));
      await transaction.execute(sql`
        insert into companion.tool_runs (turn_id,name,operation_key,permission,input_hash)
        values (${turnId},'read-tool','f1b-tool-valid','read','hash-valid')
      `);
      await expectPostgresError(transaction, '23503', (nested) => nested.execute(sql`
        insert into companion.tool_runs (turn_id,name,operation_key,permission,input_hash)
        values (${uuid()},'read-tool','f1b-tool-invalid','read','hash-invalid')
      `));
      await transaction.execute(sql`update companion.memory_sources set status='deleted',deleted_at=now() where id=${sourceId}`);
      const keptRevision = await transaction.execute(sql`select id from companion.memory_revisions where id=${revisionId}`);
      assert.equal(keptRevision.rows.length, 1);
      throw new Error('ROLLBACK_INTEGRATION_CASE');
    }).catch((error: Error) => {
      if (error.message !== 'ROLLBACK_INTEGRATION_CASE') throw error;
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    try {
      await db.execute(sql`delete from companion.people where id = ${existingPersonId}`);
    } catch (error) {
      cleanupError = error;
    }
    try {
      await database.close();
    } catch (error) {
      cleanupError ??= error;
    }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});
