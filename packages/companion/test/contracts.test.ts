import test from 'node:test';
import assert from 'node:assert/strict';
import { inboundEventSchema, visibilityScopeSchema } from '../src/domain/contracts.js';
import { budgetSchema } from '../src/domain/contracts.js';

test('visibility scope is required, typed, and strict', () => {
  assert.equal(visibilityScopeSchema.safeParse({ kind: 'character_public' }).success, true);
  assert.equal(visibilityScopeSchema.safeParse({ kind: 'circle_shared', circleId: 'not-uuid' }).success, false);
  assert.equal(visibilityScopeSchema.safeParse({ kind: 'person_private', personId: '123e4567-e89b-42d3-a456-426614174000', leak: true }).success, false);
});
test('inbound event preserves platform IDs as strings and validates timestamp/text/unknown fields', () => {
 const base = { platform:'qq', eventId:'90071992547409930', senderPlatformId:'9', conversationPlatformId:'8', conversationKind:'group', text:'hi', timestamp:'2026-10-22T00:00:00Z' };
 const parsed = inboundEventSchema.parse(base);
 assert.equal(parsed.eventId, base.eventId); assert.deepEqual(parsed.participantPlatformIds, []); assert.equal(parsed.participantsComplete, false);
 assert.equal(inboundEventSchema.safeParse({...base, timestamp:'yesterday'}).success, false);
 assert.equal(inboundEventSchema.safeParse({...base, text:'x'.repeat(32001)}).success, false);
 assert.equal(inboundEventSchema.safeParse({...base, surprise:true}).success, false);
});

test('budget applies safe defaults and rejects zero, excessive, and negative bounds', () => {
  assert.deepEqual(budgetSchema.parse({}), {
    maxSteps: 8, maxToolCalls: 8, maxTokens: 8000, maxCostUsd: 1, timeoutMs: 60000,
  });
  assert.equal(budgetSchema.safeParse({ maxSteps: 0 }).success, false);
  assert.equal(budgetSchema.safeParse({ maxToolCalls: 101 }).success, false);
  assert.equal(budgetSchema.safeParse({ maxCostUsd: -1 }).success, false);
  assert.equal(budgetSchema.safeParse({ timeoutMs: 3600001 }).success, false);
});
