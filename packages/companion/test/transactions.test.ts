import test from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray, sql } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { createVerifiedChannelEvidence } from '../src/identity/trust.js';
import { createTrustedRosterEvidence } from '../src/identity/trust.js';
import { TurnService, type TurnLease } from '../src/transactions/turn-service.js';
import { DeliveryService } from '../src/transactions/delivery-service.js';
import { uuid, requireCompatDatabaseUrl } from './helpers.js';
import { characters, conversations, conversationMembers, messages, people, platformIdentities, turns, businessOutbox, deliveryOutbox, auditEvents, bindingChallenges, personIdentityLinks } from '../src/database/schema/index.js';

test('inbound duplicates serialize to one message, turn, and process outbox', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const suffix = uuid();
  const characterId = uuid();
  let personId: string | undefined;
  let identityId: string | undefined;
  let conversationId: string | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    const [{ InboundService }, { IdentityService }] = await Promise.all([
      import('../src/transactions/inbound-service.js'), import('../src/identity/identity-service.js'),
    ]);
    const identityService = new IdentityService(database);
    const evidence = createVerifiedChannelEvidence('qq', `private-${suffix}`, `user-${suffix}`, 'private');
    const resolved = await identityService.resolveIdentity({ platform: 'qq', platformUserId: `user-${suffix}` }, evidence);
    personId = resolved.personId;
    identityId = resolved.platformIdentityId;
    await database.db.insert(characters).values({ id: characterId, name: `tx-${suffix}` });
    const service = new InboundService(database, identityService);
    const event = { platform: 'qq' as const, eventId: `event-${suffix}`, senderPlatformId: `user-${suffix}`, conversationPlatformId: `private-${suffix}`, conversationKind: 'private' as const, text: 'hello', timestamp: new Date().toISOString(), participantPlatformIds: [] as string[], participantsComplete: false };
    const results = await Promise.all(Array.from({ length: 8 }, () => service.accept(characterId, event, evidence)));
    assert.equal(new Set(results.map((item) => item.messageId)).size, 1);
    assert.equal(new Set(results.map((item) => item.turnId)).size, 1);
    assert.equal(results.filter((item) => item.duplicate).length, 7);
    conversationId = results[0]!.conversationId;
    assert.equal((await database.db.select().from(messages).where(eq(messages.id, results[0]!.messageId))).length, 1);
    assert.equal((await database.db.select().from(turns).where(eq(turns.id, results[0]!.turnId))).length, 1);
    assert.equal((await database.db.select().from(businessOutbox).where(eq(businessOutbox.operationKey, `turn:${results[0]!.turnId}:process`))).length, 1);
    const secondEvent={...event,eventId:`event-two-${suffix}`,text:'second event in same conversation'};
    const secondResults=await Promise.all(Array.from({length:6},()=>service.accept(characterId,secondEvent,evidence)));
    assert.equal(new Set(secondResults.map((item)=>item.conversationId)).size,1);
    assert.equal(secondResults[0]!.conversationId,conversationId);
    assert.equal(new Set(secondResults.map((item)=>item.messageId)).size,1);
    assert.equal(secondResults.filter((item)=>item.duplicate).length,5);
    await assert.rejects(service.accept(characterId, { ...event, text: 'changed' }, evidence), { code: 'replay_conflict' });
    await assert.rejects(service.accept(uuid(), event, evidence), { code: 'replay_conflict' });
    await assert.rejects(service.accept(characterId, { ...event, senderPlatformId: `other-${suffix}` }, evidence));
    await assert.rejects(service.accept(characterId, { ...event, extra: true } as never, evidence), { code: 'invalid_input' });
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError: unknown;
    try {
      if (conversationId) {
        const found = await database.db.select({ id: messages.id }).from(messages).where(eq(messages.conversationId, conversationId));
        const mids = found.map((row) => row.id);
        const conversationTurns=await database.db.select({id:turns.id}).from(turns).where(eq(turns.conversationId,conversationId));
        if (conversationTurns.length) await database.db.delete(businessOutbox).where(inArray(businessOutbox.operationKey,conversationTurns.map(({id})=>`turn:${id}:process`)));
        if (conversationTurns.length) await database.db.delete(deliveryOutbox).where(inArray(deliveryOutbox.turnId,conversationTurns.map(({id})=>id)));
        if (mids.length) await database.db.delete(turns).where(inArray(turns.inboundMessageId, mids));
        await database.db.delete(deliveryOutbox).where(eq(deliveryOutbox.conversationId, conversationId));
        await database.db.delete(messages).where(eq(messages.conversationId, conversationId));
        await database.db.delete(conversationMembers).where(eq(conversationMembers.conversationId, conversationId));
        await database.db.delete(conversations).where(eq(conversations.id, conversationId));
      }
      if (identityId) await database.db.delete(auditEvents).where(eq(auditEvents.targetId, identityId));
      if (identityId) await database.db.delete(platformIdentities).where(eq(platformIdentities.id, identityId));
      if (personId) await database.db.delete(people).where(eq(people.id, personId));
      await database.db.delete(characters).where(eq(characters.id, characterId));
    } catch (error) { cleanupError = error; }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});

test('verified identity binding preserves inbound event replay identity', async () => {
  const database=createDatabase(requireCompatDatabaseUrl());
  const suffix=uuid(),characterId=uuid();
  const personIds:string[]=[],identityIds:string[]=[];
  let conversationId:string|undefined,messageId:string|undefined,turnId:string|undefined,processKey:string|undefined;
  let primaryError:unknown;
  try{
    await migrateDatabase(database);
    const identityService=new (await import('../src/identity/identity-service.js')).IdentityService(database);
    const service=new (await import('../src/transactions/inbound-service.js')).InboundService(database,identityService);
    await database.db.insert(characters).values({id:characterId,name:`replay-binding-${suffix}`});
    const sourceEvidence=createVerifiedChannelEvidence('qq',`source-${suffix}`,`alice-${suffix}`,'private');
    const senderEvidence=createVerifiedChannelEvidence('qq',`dm-${suffix}`,`bob-${suffix}`,'private');
    const alice=await identityService.resolveIdentity({platform:'qq',platformUserId:`alice-${suffix}`},sourceEvidence);
    const bob=await identityService.resolveIdentity({platform:'qq',platformUserId:`bob-${suffix}`},senderEvidence);
    personIds.push(alice.personId,bob.personId);identityIds.push(alice.platformIdentityId,bob.platformIdentityId);
    const event={platform:'qq' as const,eventId:`bound-replay-${suffix}`,senderPlatformId:`bob-${suffix}`,conversationPlatformId:`dm-${suffix}`,conversationKind:'private' as const,text:'same authenticated message',timestamp:new Date().toISOString(),participantPlatformIds:[],participantsComplete:false};
    const accepted=await service.accept(characterId,event,senderEvidence);
    conversationId=accepted.conversationId;messageId=accepted.messageId;turnId=accepted.turnId;processKey=`turn:${turnId}:process`;
    const challenge=await identityService.createBindingChallenge(alice.platformIdentityId,'qq',{kind:'admin',auditActorId:`test-admin-${suffix}`});
    await identityService.consumeBindingChallenge(challenge.token,{platform:'qq',platformUserId:`bob-${suffix}`,conversationKind:'private'},senderEvidence);
    const replay=await service.accept(characterId,event,senderEvidence);
    assert.equal(replay.duplicate,true);
    assert.equal(replay.messageId,accepted.messageId);
    assert.equal(replay.turnId,accepted.turnId);
    assert.equal(replay.conversationId,accepted.conversationId);
  }catch(error){primaryError=error;throw error;}
  finally{
    let cleanupError:unknown;
    try{
      if(turnId)await database.db.delete(deliveryOutbox).where(eq(deliveryOutbox.turnId,turnId));
      if(turnId)await database.db.delete(turns).where(eq(turns.id,turnId));
      if(processKey)await database.db.delete(businessOutbox).where(eq(businessOutbox.operationKey,processKey));
      if(messageId)await database.db.delete(messages).where(eq(messages.id,messageId));
      if(conversationId){await database.db.delete(conversationMembers).where(eq(conversationMembers.conversationId,conversationId));await database.db.delete(conversations).where(eq(conversations.id,conversationId));}
      if(identityIds.length)await database.db.delete(auditEvents).where(inArray(auditEvents.targetId,identityIds));
      if(personIds.length)await database.db.delete(auditEvents).where(inArray(auditEvents.actorId,personIds));
      await database.db.delete(auditEvents).where(eq(auditEvents.actorId,`test-admin-${suffix}`));
      if(personIds.length)await database.db.delete(personIdentityLinks).where(inArray(personIdentityLinks.aliasPersonId,personIds));
      if(identityIds.length)await database.db.delete(bindingChallenges).where(inArray(bindingChallenges.sourceIdentityId,identityIds));
      if(identityIds.length)await database.db.delete(platformIdentities).where(inArray(platformIdentities.id,identityIds));
      if(personIds.length)await database.db.delete(people).where(inArray(people.id,personIds));
      await database.db.delete(characters).where(eq(characters.id,characterId));
    }catch(error){cleanupError=error;}
    try{await database.close();}catch(error){cleanupError??=error;}
    if(cleanupError&&primaryError===undefined)throw cleanupError;
  }
});

test('turn leases fence stale workers and generated JSON comparison ignores key order', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const suffix = uuid();
  const characterId = uuid();
  let personId: string | undefined;
  let identityId: string | undefined;
  let conversationId: string | undefined;
  let turnId: string | undefined;
  let deliveryId: string | undefined;
  let processKey: string | undefined;
  let primaryError: unknown;
  const clock = { value: new Date() };
  try {
    await migrateDatabase(database);
    const identityService = new (await import('../src/identity/identity-service.js')).IdentityService(database);
    const evidence = createVerifiedChannelEvidence('qq', `dm-${suffix}`, `user-${suffix}`, 'private');
    const identity = await identityService.resolveIdentity({ platform: 'qq', platformUserId: `user-${suffix}` }, evidence);
    personId = identity.personId;
    identityId = identity.platformIdentityId;
    await database.db.insert(characters).values({ id: characterId, name: `leases-${suffix}` });
    const accepted = await new (await import('../src/transactions/inbound-service.js')).InboundService(database, identityService).accept(characterId, {
      platform: 'qq', eventId: `in-${suffix}`, senderPlatformId: `user-${suffix}`, conversationPlatformId: `dm-${suffix}`,
      conversationKind: 'private', text: 'incoming', timestamp: new Date().toISOString(), participantPlatformIds: [], participantsComplete: false,
    }, evidence);
    conversationId = accepted.conversationId;
    turnId = accepted.turnId;
    processKey = `turn:${turnId}:process`;
    const turnService = new TurnService(database, { now: () => new Date(clock.value) });
    const oldLease = await turnService.claim(turnId, `worker-old-${suffix}`, 1000);
    assert.ok(oldLease);
    assert.equal(await turnService.claim(turnId, `worker-busy-${suffix}`, 1000), null);
    clock.value = new Date(clock.value.getTime() + 1001);
    const lease = await turnService.claim(turnId, `worker-new-${suffix}`, 1000);
    assert.ok(lease);
    assert.ok(lease.version > oldLease.version);
    await assert.rejects(turnService.fail(oldLease, 'late_error'), { code: 'lease_lost' });
    const renewed = await turnService.renew(lease, 1500);
    assert.ok(renewed.version > lease.version);
    const generated = await turnService.persistGenerated(renewed, {
      text: 'answer',
      format: 'text',
      metadata: { outer: { z: 9, a: ['x', { y: true, b: 2 }] } },
    });
    deliveryId = generated.deliveryId;
    assert.equal(generated.duplicate, false);
    assert.equal((await turnService.persistGenerated(oldLease, {
      format: 'text',
      metadata: { outer: { a: ['x', { b: 2, y: true }], z: 9 } },
      text: 'answer',
    })).duplicate, true);
    await assert.rejects(turnService.persistGenerated(oldLease, { text: 'replacement' }), { code: 'generated_conflict' });
    await assert.rejects(turnService.persistGenerated(oldLease, { text: 'bad metadata', metadata: { unsupported: undefined } }), { code: 'invalid_input' });
    const delivery = new DeliveryService(database, { now: () => new Date(clock.value) });
    const competingClaims = await Promise.all([
      delivery.claimPending(deliveryId, `sender-a-${suffix}`, 1000),
      delivery.claimPending(deliveryId, `sender-b-${suffix}`, 1000),
    ]);
    assert.equal(competingClaims.filter(Boolean).length, 1);
    const sendToken = competingClaims.find((claim) => claim !== null)!;
    assert.ok(sendToken);
    await delivery.finish(sendToken, { kind: 'unknown', errorCode: 'connection_lost' });
    await assert.rejects(delivery.finish(sendToken, { kind: 'receipt', receipt: `late-${suffix}` }), { code: 'lease_lost' });
    assert.equal(await delivery.claimPending(deliveryId, `sender-retry-${suffix}`, 1000), null);
    await assert.rejects(delivery.reconcile(deliveryId, 'retry', { kind: 'person', actor: {} }), { code: 'admin_required' });
    const retryToken = await delivery.claimPending(deliveryId, `sender-retry-${suffix}`, 1000);
    assert.equal(retryToken, null);
    // Recovery of a sending claim after a process crash is also unknown, never an implicit retry.
    await database.db.update(deliveryOutbox).set({ status: 'sending', leaseOwner: `crashed-${suffix}`, leaseExpiresAt: new Date(clock.value.getTime() - 1) }).where(eq(deliveryOutbox.id, deliveryId));
    assert.equal(await delivery.recoverExpiredSending(), 1);
    assert.equal(await delivery.claimPending(deliveryId, `sender-retry-${suffix}`, 1000), null);
    await delivery.reconcile(deliveryId, 'retry', { kind: 'admin', auditActorId: `admin-${suffix}` });
    assert.equal((await database.db.select().from(auditEvents).where(eq(auditEvents.targetId, deliveryId))).length, 1);
    const retry = await delivery.claimPending(deliveryId, `sender-retry-${suffix}`, 1000);
    assert.ok(retry);
    await delivery.finish(retry, { kind: 'receipt', receipt: `receipt-${suffix}` });
    assert.equal((await database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.id, deliveryId)))[0]?.status, 'sent');
    assert.equal((await database.db.select().from(turns).where(eq(turns.id, turnId)))[0]?.status, 'sent');
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError: unknown;
    try {
      if (deliveryId) await database.db.delete(deliveryOutbox).where(eq(deliveryOutbox.id, deliveryId));
      if (turnId) await database.db.delete(auditEvents).where(eq(auditEvents.targetId, deliveryId!));
      if (turnId) await database.db.delete(turns).where(eq(turns.id, turnId));
      if (processKey) await database.db.delete(businessOutbox).where(eq(businessOutbox.operationKey, processKey));
      if (turnId) await database.db.delete(businessOutbox).where(eq(businessOutbox.operationKey, `turn:${turnId}:deliver`));
      if (conversationId) await database.db.delete(messages).where(eq(messages.conversationId, conversationId));
      if (conversationId) await database.db.delete(conversationMembers).where(eq(conversationMembers.conversationId, conversationId));
      if (conversationId) await database.db.delete(conversations).where(eq(conversations.id, conversationId));
      if (identityId) await database.db.delete(platformIdentities).where(eq(platformIdentities.id, identityId));
      if (personId) await database.db.delete(people).where(eq(people.id, personId));
      await database.db.delete(characters).where(eq(characters.id, characterId));
    } catch (error) { cleanupError = error; }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError && primaryError === undefined) throw cleanupError;
  }
});

test('lease writes validate expiry after waiting for PostgreSQL row locks', async () => {
  const database=createDatabase(requireCompatDatabaseUrl());
  const suffix=uuid(),characterId=uuid();
  const accepted:Array<{messageId:string;turnId:string;conversationId:string;duplicate:boolean}>=[];
  let personId:string|undefined,identityId:string|undefined,deliveryId:string|undefined,pendingDeliveryId:string|undefined,primaryError:unknown;
  const clock={value:new Date('2026-10-22T09:00:00.000Z')};
  try{
    await migrateDatabase(database);
    const identityService=new (await import('../src/identity/identity-service.js')).IdentityService(database);
    const evidence=createVerifiedChannelEvidence('qq',`lock-${suffix}`,`user-${suffix}`,'private');
    const identity=await identityService.resolveIdentity({platform:'qq',platformUserId:`user-${suffix}`},evidence);
    personId=identity.personId;identityId=identity.platformIdentityId;
    await database.db.insert(characters).values({id:characterId,name:`lease-lock-${suffix}`});
    const inbound=new (await import('../src/transactions/inbound-service.js')).InboundService(database,identityService);
    for(let index=0;index<5;index+=1){
      accepted.push(await inbound.accept(characterId,{
        platform:'qq',eventId:`lock-event-${index}-${suffix}`,senderPlatformId:`user-${suffix}`,
        conversationPlatformId:`lock-${suffix}`,conversationKind:'private',text:`event ${index}`,
        timestamp:new Date().toISOString(),participantPlatformIds:[],participantsComplete:false,
      },evidence));
    }
    const turnService=new TurnService(database,{now:()=>new Date(clock.value)});
    const leases:TurnLease[]=[];
    for(let index=0;index<4;index+=1){
      const lease=await turnService.claim(accepted[index]!.turnId,`worker-${index}-${suffix}`,1000);
      assert.ok(lease);leases.push(lease);
    }
    const generated=await turnService.persistGenerated(leases[3]!,{text:'delivery body'});
    deliveryId=generated.deliveryId;
    const deliveryService=new DeliveryService(database,{now:()=>new Date(clock.value)});
    const sendToken=await deliveryService.claimPending(deliveryId,`sender-${suffix}`,1000);
    assert.ok(sendToken);

    async function startBlocked<T>(
      table:'turns'|'delivery_outbox',
      rowId:string,
      operation:()=>Promise<T>,
      afterWait=new Date('2026-10-22T09:00:01.001Z'),
    ):Promise<T>{
      const locker=await database.pool.connect();
      let pending:Promise<T>|undefined;
      try{
        await locker.query('BEGIN');
        await locker.query(`SELECT id FROM companion.${table} WHERE id = $1 FOR UPDATE`,[rowId]);
        pending=operation();
        // The expected lease_lost may happen before the lock holder rolls back below.
        // Attach a handler now to avoid a transient process-level unhandled rejection;
        // the original promise is still returned and asserted by assert.rejects.
        void pending.catch(()=>undefined);
        let waiting=false;
        for(let attempt=0;attempt<250;attempt+=1){
          const result=await database.pool.query<{waiting:boolean}>(
            `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1) AS waiting`,
            [`%${table}%`],
          );
          if(result.rows[0]?.waiting){waiting=true;break;}
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert.equal(waiting,true,`service query should be waiting for the ${table} row lock`);
        clock.value=afterWait;
      }finally{
        await locker.query('ROLLBACK');
        locker.release();
      }
      assert.ok(pending);
      return pending;
    }

    // Claim must calculate its expiry from the instant its row lock is acquired.
    clock.value=new Date('2026-10-22T09:00:00.000Z');
    const lateClaim=await startBlocked('turns',accepted[4]!.turnId,()=>turnService.claim(accepted[4]!.turnId,`late-claim-${suffix}`,1000));
    assert.ok(lateClaim);
    assert.ok(lateClaim.expiresAt>clock.value);

    const pendingDelivery=await turnService.persistGenerated(lateClaim,{text:'claim after row-lock wait'});
    pendingDeliveryId=pendingDelivery.deliveryId;
    const lateSendClaim=await startBlocked(
      'delivery_outbox',
      pendingDeliveryId,
      ()=>deliveryService.claimPending(pendingDeliveryId!,`late-send-${suffix}`,1000),
      new Date('2026-10-22T09:00:03.001Z'),
    );
    assert.ok(lateSendClaim);
    assert.ok(lateSendClaim.expiresAt>clock.value);

    clock.value=new Date('2026-10-22T09:00:00.000Z');
    await assert.rejects(startBlocked('turns',leases[0]!.turnId,()=>turnService.renew(leases[0]!,1000)),{code:'lease_lost'});
    clock.value=new Date('2026-10-22T09:00:00.000Z');
    await assert.rejects(startBlocked('turns',leases[1]!.turnId,()=>turnService.fail(leases[1]!,'late_failure')),{code:'lease_lost'});
    clock.value=new Date('2026-10-22T09:00:00.000Z');
    await assert.rejects(startBlocked('turns',leases[2]!.turnId,()=>turnService.persistGenerated(leases[2]!,{text:'too late'})),{code:'lease_lost'});
    clock.value=new Date('2026-10-22T09:00:00.000Z');
    await assert.rejects(startBlocked('delivery_outbox',deliveryId,()=>deliveryService.finish(sendToken,{kind:'receipt',receipt:`late-${suffix}`})),{code:'lease_lost'});

    const stillSending=(await database.db.select().from(deliveryOutbox).where(eq(deliveryOutbox.id,deliveryId)))[0]!;
    assert.equal(stillSending.status,'sending');
    assert.equal(stillSending.version,sendToken.version);
    assert.deepEqual(stillSending.leaseExpiresAt,sendToken.expiresAt);
    for(const lease of leases.slice(0,3)){
      const unchanged=(await database.db.select().from(turns).where(eq(turns.id,lease.turnId)))[0]!;
      assert.equal(unchanged.status,'processing');
      assert.equal(unchanged.version,lease.version);
      assert.deepEqual(unchanged.leaseExpiresAt,lease.expiresAt);
    }
  }catch(error){primaryError=error;throw error;}
  finally{
    let cleanupError:unknown;
    try{
      if(deliveryId)await database.db.delete(deliveryOutbox).where(eq(deliveryOutbox.id,deliveryId));
      if(pendingDeliveryId)await database.db.delete(deliveryOutbox).where(eq(deliveryOutbox.id,pendingDeliveryId));
      if(accepted.length)await database.db.delete(turns).where(inArray(turns.id,accepted.map(item=>item.turnId)));
      if(accepted.length)await database.db.delete(businessOutbox).where(inArray(businessOutbox.operationKey,accepted.flatMap(item=>[`turn:${item.turnId}:process`,`turn:${item.turnId}:deliver`])));
      if(accepted.length)await database.db.delete(messages).where(eq(messages.conversationId,accepted[0]!.conversationId));
      if(accepted.length){await database.db.delete(conversationMembers).where(eq(conversationMembers.conversationId,accepted[0]!.conversationId));await database.db.delete(conversations).where(eq(conversations.id,accepted[0]!.conversationId));}
      if(identityId)await database.db.delete(platformIdentities).where(eq(platformIdentities.id,identityId));
      if(personId)await database.db.delete(people).where(eq(people.id,personId));
      await database.db.delete(characters).where(eq(characters.id,characterId));
    }catch(error){cleanupError=error;}
    try{await database.close();}catch(error){cleanupError??=error;}
    if(cleanupError&&primaryError===undefined)throw cleanupError;
  }
});

test('failed inbound transaction leaves no conversation, message, turn, or outbox row', async () => {
  const database = createDatabase(requireCompatDatabaseUrl());
  const suffix = uuid();
  const characterId = uuid();
  let personId: string | undefined;
  let identityId: string | undefined;
  let primaryError: unknown;
  try {
    await migrateDatabase(database);
    const identityService = new (await import('../src/identity/identity-service.js')).IdentityService(database);
    const evidence = createVerifiedChannelEvidence('qq', `bad-${suffix}`, `user-${suffix}`, 'private');
    const identity = await identityService.resolveIdentity({ platform: 'qq', platformUserId: `user-${suffix}` }, evidence);
    personId = identity.personId;
    identityId = identity.platformIdentityId;
    const service = new (await import('../src/transactions/inbound-service.js')).InboundService(database, identityService);
    await assert.rejects(service.accept(characterId, { platform: 'qq', eventId: `rollback-${suffix}`, senderPlatformId: `user-${suffix}`, conversationPlatformId: `bad-${suffix}`, conversationKind: 'private', text: 'no commit', timestamp: new Date().toISOString(), participantPlatformIds: [], participantsComplete: false }, evidence));
    assert.equal((await database.db.select().from(conversations).where(eq(conversations.platformConversationId, `bad-${suffix}`))).length, 0);
    assert.equal((await database.db.select().from(messages).where(eq(messages.platformEventId, `rollback-${suffix}`))).length, 0);
    assert.equal((await database.db.select().from(turns).innerJoin(messages, eq(turns.inboundMessageId, messages.id)).where(eq(messages.platformEventId, `rollback-${suffix}`))).length, 0);
    assert.equal((await database.db.select().from(businessOutbox).where(sql`${businessOutbox.payload}->>'characterId' = ${characterId}`)).length, 0);
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError: unknown;
    try { if(identityId)await database.db.delete(platformIdentities).where(eq(platformIdentities.id,identityId));if(personId)await database.db.delete(people).where(eq(people.id,personId)); }
    catch(error){cleanupError=error;}
    try{await database.close();}catch(error){cleanupError??=error;}
    if(cleanupError&&primaryError===undefined)throw cleanupError;
  }
});

test('linked roster identities deduplicate and inbound barriers reject delayed snapshots', async () => {
  const database=createDatabase(requireCompatDatabaseUrl());
  const suffix=uuid(),characterId=uuid();
  const personIds:string[]=[],identityIds:string[]=[],conversationIds:string[]=[],messageIds:string[]=[],turnIds:string[]=[],outboxKeys:string[]=[];
  const clock={value:new Date('2026-10-22T09:00:00.000Z')};
  let primaryError:unknown;
  try{
    await migrateDatabase(database);
    const identityService=new (await import('../src/identity/identity-service.js')).IdentityService(database);
    await database.db.insert(characters).values({id:characterId,name:`roster-${suffix}`});
    const channel=`group-${suffix}`,alice=`alice-${suffix}`,bob=`bob-${suffix}`;
    const evidence=createVerifiedChannelEvidence('qq',channel,alice,'group');
    const aliceIdentity=await identityService.resolveIdentity({platform:'qq',platformUserId:alice},evidence);
    const bobIdentity=await identityService.resolveIdentity({platform:'qq',platformUserId:bob},createVerifiedChannelEvidence('qq',channel,bob,'group'));
    const alias=`alice-alias-${suffix}`;
    const aliasEvidence=createVerifiedChannelEvidence('qq',channel,alias,'private');
    const aliasIdentity=await identityService.resolveIdentity({platform:'qq',platformUserId:alias},aliasEvidence);
    const carol=`carol-${suffix}`;
    const carolEvidence=createVerifiedChannelEvidence('qq',channel,carol,'group');
    const carolIdentity=await identityService.resolveIdentity({platform:'qq',platformUserId:carol},carolEvidence);
    personIds.push(aliceIdentity.personId,bobIdentity.personId,aliasIdentity.personId,carolIdentity.personId);
    identityIds.push(aliceIdentity.platformIdentityId,bobIdentity.platformIdentityId,aliasIdentity.platformIdentityId,carolIdentity.platformIdentityId);
    const challenge=await identityService.createBindingChallenge(aliceIdentity.platformIdentityId,'qq',{kind:'admin',auditActorId:`roster-admin-${suffix}`});
    await identityService.consumeBindingChallenge(challenge.token,{platform:'qq',platformUserId:alias,conversationKind:'private'},aliasEvidence);
    const service=new (await import('../src/transactions/inbound-service.js')).InboundService(database,identityService,{now:()=>new Date(clock.value)});
    await assert.rejects(service.updateVerifiedRoster('qq',channel,{kind:'trusted-roster',platform:'qq',channelId:channel} as never),{code:'invalid_roster_evidence'});
    assert.throws(()=>createTrustedRosterEvidence('qq',channel,[],new Date()),/trusted roster/);
    const accepted=await service.accept(characterId,{platform:'qq',eventId:`g1-${suffix}`,senderPlatformId:alice,conversationPlatformId:channel,conversationKind:'group',text:'one',timestamp:new Date().toISOString(),participantPlatformIds:[alice,bob],participantsComplete:true},evidence);
    conversationIds.push(accepted.conversationId);messageIds.push(accepted.messageId);turnIds.push(accepted.turnId);outboxKeys.push(`turn:${accepted.turnId}:process`);
    let members=await database.db.select().from(conversationMembers).where(eq(conversationMembers.conversationId,accepted.conversationId));
    assert.equal(members.length,1);
    assert.equal((await database.db.select().from(conversations).where(eq(conversations.id,accepted.conversationId)))[0]?.participantsComplete,false);
    const t1=new Date('2026-10-22T10:00:00.000Z');
    const trusted=createTrustedRosterEvidence('qq',channel,[alice,bob,alias],t1);
    await service.updateVerifiedRoster('qq',channel,trusted);
    members=await database.db.select().from(conversationMembers).where(eq(conversationMembers.conversationId,accepted.conversationId));
    assert.equal(members.length,2);
    assert.equal((await database.db.select().from(conversations).where(eq(conversations.id,accepted.conversationId)))[0]?.participantsComplete,true);
    const receivedAt=(await database.db.select({occurredAt:messages.occurredAt}).from(messages).where(eq(messages.id,accepted.messageId)))[0]!.occurredAt!;
    const replay={platform:'qq' as const,eventId:`g1-${suffix}`,senderPlatformId:alice,conversationPlatformId:channel,conversationKind:'group' as const,text:'one',timestamp:receivedAt.toISOString(),participantPlatformIds:[alice,bob],participantsComplete:true};
    assert.equal((await service.accept(characterId,replay,evidence)).duplicate,true);
    await assert.rejects(service.accept(characterId,{...replay,text:'altered'},evidence),{code:'replay_conflict'});
    assert.equal((await database.db.select().from(conversations).where(eq(conversations.id,accepted.conversationId)))[0]?.participantsComplete,true);
    const t2=new Date('2026-10-22T10:30:00.000Z');
    clock.value=new Date('2026-10-22T11:00:00.000Z');
    const next=await service.accept(characterId,{...replay,eventId:`g2-${suffix}`,senderPlatformId:carol,text:'new sender joins',timestamp:clock.value.toISOString()},carolEvidence);
    messageIds.push(next.messageId);turnIds.push(next.turnId);outboxKeys.push(`turn:${next.turnId}:process`);
    assert.equal((await database.db.select().from(conversations).where(eq(conversations.id,accepted.conversationId)))[0]?.participantsComplete,false);
    await service.updateVerifiedRoster('qq',channel,createTrustedRosterEvidence('qq',channel,[alice,bob,alias],t2));
    assert.equal((await database.db.select().from(conversations).where(eq(conversations.id,accepted.conversationId)))[0]?.participantsComplete,false);
    members=await database.db.select().from(conversationMembers).where(eq(conversationMembers.conversationId,accepted.conversationId));
    assert.ok(members.some(member=>member.personId===carolIdentity.personId));
    await service.updateVerifiedRoster('qq',channel,createTrustedRosterEvidence('qq',channel,[alice,bob,alias,carol],new Date('2026-10-22T11:30:00.000Z')));
    assert.equal((await database.db.select().from(conversations).where(eq(conversations.id,accepted.conversationId)))[0]?.participantsComplete,true);
    members=await database.db.select().from(conversationMembers).where(eq(conversationMembers.conversationId,accepted.conversationId));
    assert.equal(members.length,3);
  }catch(error){primaryError=error;throw error;}
  finally{
    let cleanupError:unknown;
    try{
      if(outboxKeys.length)await database.db.delete(businessOutbox).where(inArray(businessOutbox.operationKey,outboxKeys));
      if(turnIds.length)await database.db.delete(deliveryOutbox).where(inArray(deliveryOutbox.turnId,turnIds));
      if(turnIds.length)await database.db.delete(turns).where(inArray(turns.id,turnIds));
      if(messageIds.length)await database.db.delete(messages).where(inArray(messages.id,messageIds));
      if(conversationIds.length){await database.db.delete(conversationMembers).where(inArray(conversationMembers.conversationId,conversationIds));await database.db.delete(conversations).where(inArray(conversations.id,conversationIds));}
      if(identityIds.length)await database.db.delete(auditEvents).where(inArray(auditEvents.targetId,identityIds));
      if(personIds.length)await database.db.delete(auditEvents).where(inArray(auditEvents.actorId,personIds));
      await database.db.delete(auditEvents).where(eq(auditEvents.actorId,`roster-admin-${suffix}`));
      if(personIds.length)await database.db.delete(personIdentityLinks).where(inArray(personIdentityLinks.aliasPersonId,personIds));
      if(identityIds.length)await database.db.delete(bindingChallenges).where(inArray(bindingChallenges.sourceIdentityId,identityIds));
      if(identityIds.length)await database.db.delete(platformIdentities).where(inArray(platformIdentities.id,identityIds));
      if(personIds.length)await database.db.delete(people).where(inArray(people.id,personIds));
      await database.db.delete(characters).where(eq(characters.id,characterId));
    }catch(error){cleanupError=error;}
    try{await database.close();}catch(error){cleanupError??=error;}
    if(cleanupError&&primaryError===undefined)throw cleanupError;
  }
});
