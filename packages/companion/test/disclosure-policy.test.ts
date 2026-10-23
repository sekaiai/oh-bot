import test from 'node:test';
import assert from 'node:assert/strict';
import { DisclosurePolicy } from '../src/identity/disclosure-policy.js';
import { IdentityService } from '../src/identity/identity-service.js';
import { createVerifiedChannelEvidence } from '../src/identity/trust.js';
import { uuid } from './helpers.js';

test('forged ActorContext cannot authorize private or shared memory', async () => {
  const policy = new DisclosurePolicy({} as never);
  const forgedContext = {
    personId: uuid(),
    characterId: uuid(),
    conversationId: uuid(),
    platformIdentityId: uuid(),
    conversationKind: 'private' as const,
    isPartner: true,
    circleIds: [],
    participantIds: [],
    linkedPersonIds: [],
    participantsComplete: true,
  };
  await assert.rejects(policy.canUse(forgedContext, { kind: 'partner_private', personId: uuid() }), /untrusted actor context/);
});

test('challenge TTL and evidence factory reject invalid runtime inputs', () => {
  assert.throws(() => new IdentityService({} as never, { challengeTtlMs: 0 }), /challenge TTL/);
  assert.throws(() => new IdentityService({} as never, { challengeTtlMs: Number.POSITIVE_INFINITY }), /challenge TTL/);
  assert.throws(() => new IdentityService({} as never, { challengeTtlMs: 86_400_001 }), /challenge TTL/);
  assert.throws(() => createVerifiedChannelEvidence('qq', 'channel', '', 'private'), /authenticated/);
  assert.throws(() => createVerifiedChannelEvidence('qq', '', 'user', 'private'), /authenticated/);
  assert.throws(() => createVerifiedChannelEvidence('unsupported' as never, 'channel', 'user', 'private'), /authenticated/);
  assert.throws(() => createVerifiedChannelEvidence('qq', 'channel', 'user', 'unknown' as never), /authenticated/);
});
