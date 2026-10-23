import test from 'node:test';
import assert from 'node:assert/strict';
import { getTableConfig } from 'drizzle-orm/pg-core';
import * as schema from '../src/database/schema/index.js';

test('schema metadata exposes enums, version checks, and restrictive identity foreign keys', () => {
  assert.equal(schema.platformEnum.enumName, 'platform');
  assert.ok(getTableConfig(schema.people).checks.some((item) => item.name === 'people_version_positive'));
  const characterFks = getTableConfig(schema.characters).foreignKeys;
  assert.ok(characterFks.some((fk) => fk.getName() === 'characters_current_version_fk'));
  const conversationFks = getTableConfig(schema.conversations).foreignKeys;
  assert.ok(conversationFks.some((fk) => fk.getName().includes('character_id')));
  assert.ok(getTableConfig(schema.deletionRecords).foreignKeys.some((fk) => fk.getName().includes('people')));
  assert.ok(getTableConfig(schema.deletionRecords).foreignKeys.some((fk) => fk.getName().includes('characters')));
  assert.equal(getTableConfig(schema.messages).columns.find((column) => column.name === 'occurred_at')?.notNull, false);
});

test('memory and operations constraints exist in Drizzle metadata', () => {
  assert.equal(schema.relationshipStageEnum.enumName, 'relationship_stage');
  assert.ok(getTableConfig(schema.personIdentityLinks).checks.some((item) => item.name === 'person_identity_links_distinct_people'));
  assert.ok(getTableConfig(schema.memoryIndexes).indexes.some((item) => item.config.name === 'memory_indexes_one_active_per_character' && item.config.where !== undefined));
  assert.ok(getTableConfig(schema.memoryRevisions).indexes.some((item) => item.config.name === 'memory_revision_current_validated_unique' && item.config.where !== undefined));
  assert.ok(getTableConfig(schema.memoryRevisions).checks.some((item) => item.name === 'memory_revisions_revision_positive'));
  assert.ok(getTableConfig(schema.memoryIndexes).foreignKeys.some((fk) => fk.getName().includes('model_profiles')));
  assert.ok(getTableConfig(schema.relationshipEdges).foreignKeys.some((fk) => fk.getName() === 'relationship_edges_source_message_id_messages_id_fk'));
  assert.ok(getTableConfig(schema.emotionStates).checks.length >= 5);
  assert.ok(getTableConfig(schema.relationshipStates).checks.some((item) => item.name === 'relationship_trust_range'));
  assert.ok(getTableConfig(schema.modelRoleBindings).foreignKeys.some((fk) => fk.getName() === 'model_role_bindings_profile_purpose_fk'));
});
