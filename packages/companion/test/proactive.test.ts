import test from 'node:test'; import assert from 'node:assert/strict'; import { and,eq } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js'; import { migrateDatabase } from '../src/database/migrate.js'; import { ProactiveCommitmentService } from '../src/proactive/proactive-commitment-service.js';
import { auditEvents,characters,people,platformIdentities,conversations,conversationMembers,messages,proactivePermissions,conversationPolicies,commitments,operationKeys,personIdentityLinks } from '../src/database/schema/index.js'; import { trustActorContext } from '../src/identity/trust.js'; import { AdminGuard } from '../src/admin/auth.js'; import { uuid,requireCompatDatabaseUrl } from './helpers.js';
test('commitments require explicit due time and private plus group authorization and unknown receipt is never resent',async()=>{
 const db=createDatabase(requireCompatDatabaseUrl()),s=uuid(),c=uuid(),p=uuid(),i=uuid(),cv=uuid(),m=uuid(),clock={value:new Date('2026-10-23T10:00:00Z')}; try { await migrateDatabase(db);
 await db.db.insert(characters).values({id:c,name:`pro-${s}`}); await db.db.insert(people).values({id:p}); await db.db.insert(platformIdentities).values({id:i,personId:p,platform:'qq',platformUserId:`pro-${s}`,verificationMethod:'test',verifiedAt:new Date()});
 await db.db.insert(conversations).values({id:cv,characterId:c,platform:'qq',platformConversationId:`pro-${s}`,kind:'group'}); await db.db.insert(conversationMembers).values({conversationId:cv,personId:p,confirmedAt:new Date()}); await db.db.insert(messages).values({id:m,conversationId:cv,personId:p,platform:'qq',platformEventId:`pro-${s}`,role:'user',text:'提醒我周五复习'});
 await db.db.insert(proactivePermissions).values({characterId:c,personId:p,enabled:true}); await db.db.insert(conversationPolicies).values({conversationId:cv,proactiveEnabled:true});
 const actor=trustActorContext({personId:p,characterId:c,conversationId:cv,platformIdentityId:i,conversationKind:'group' as const,isPartner:false,circleIds:[],participantIds:[p],linkedPersonIds:[p],participantsComplete:true}); const svc=new ProactiveCommitmentService(db,()=>new Date(clock.value));
 await assert.rejects(svc.schedule(actor,m,{description:'复习'} as any)); await db.db.update(proactivePermissions).set({enabled:false}).where(and(eq(proactivePermissions.characterId,c),eq(proactivePermissions.personId,p))); await assert.rejects(svc.schedule(actor,m,{description:'复习',dueAt:new Date('2026-10-24T12:00:00Z')}),/disabled/); await db.db.update(proactivePermissions).set({enabled:true}).where(and(eq(proactivePermissions.characterId,c),eq(proactivePermissions.personId,p))); const item=await svc.schedule(actor,m,{description:'复习',dueAt:new Date('2026-10-24T12:00:00Z')}); assert.equal(item.status,'scheduled');
 clock.value=new Date('2026-10-24T14:00:00Z'); assert.equal(await svc.deliverDue(item.id,async()=>({kind:'receipt',receipt:'x'})),'quiet_window');
 clock.value=new Date('2026-10-25T00:00:01Z'); const delivered=await svc.deliverDue(item.id,async()=>({kind:'receipt_unknown',errorCode:'receipt_unknown'})); assert.equal(delivered,'receipt_unknown');
 assert.equal(await svc.deliverDue(item.id,async()=>{throw new Error('must not resend');}),'receipt_unknown');
 } finally { await db.close(); }
});

async function fixture(options:{alias?:boolean;now?:Date}={}){
 const db=createDatabase(requireCompatDatabaseUrl()),s=uuid(),characterId=uuid(),personId=uuid(),aliasId=uuid(),identityId=uuid(),conversationId=uuid(),sourceId=uuid();
 const clock={value:options.now??new Date('2026-10-23T23:00:00Z')},sourceOwner=options.alias?aliasId:personId;
 await migrateDatabase(db); await db.db.insert(characters).values({id:characterId,name:`fixture-${s}`});
 await db.db.insert(people).values(options.alias?[{id:personId},{id:aliasId}]:[{id:personId}]);
 if(options.alias)await db.db.insert(personIdentityLinks).values({aliasPersonId:aliasId,canonicalPersonId:personId});
 await db.db.insert(platformIdentities).values({id:identityId,personId:sourceOwner,platform:'qq',platformUserId:`fixture-${s}`,verificationMethod:'test',verifiedAt:new Date()});
 await db.db.insert(conversations).values({id:conversationId,characterId,platform:'qq',platformConversationId:`fixture-${s}`,kind:'group'});
 await db.db.insert(conversationMembers).values({conversationId,personId:sourceOwner,confirmedAt:new Date()});
 await db.db.insert(messages).values({id:sourceId,conversationId,personId:sourceOwner,platform:'qq',platformEventId:`fixture-${s}`,role:'user',text:'提醒我周末复习'});
 await db.db.insert(proactivePermissions).values({characterId,personId,enabled:true,maxPerDay:1});
 await db.db.insert(conversationPolicies).values({conversationId,proactiveEnabled:true,maxPerDay:1});
 const actor=trustActorContext({personId,characterId,conversationId,platformIdentityId:identityId,conversationKind:'group' as const,isPartner:false,circleIds:[],participantIds:[personId],linkedPersonIds:[uuid()],participantsComplete:true});
 const service=new ProactiveCommitmentService(db,()=>new Date(clock.value));
 const schedule=(messageId=sourceId)=>service.schedule(actor,messageId,{description:'周末复习',dueAt:new Date('2026-10-24T00:00:00Z')});
 return {db,s,characterId,personId,aliasId,identityId,conversationId,sourceId,sourceOwner,clock,actor,service,schedule};
}

test('scheduling canonicalizes verified aliases and delivery rechecks confirmed membership',async()=>{
 const f=await fixture({alias:true});try{
  const item=await f.schedule();assert.equal(item.personId,f.personId);f.clock.value=new Date('2026-10-24T01:00:00Z');
  await f.db.db.update(conversationMembers).set({confirmedAt:null}).where(and(eq(conversationMembers.conversationId,f.conversationId),eq(conversationMembers.personId,f.aliasId)));
  let called=0;assert.equal(await f.service.deliverDue(item.id,async()=>{called++;return {kind:'receipt',receipt:'should-not-send'};}),'not_authorized');assert.equal(called,0);
 }finally{await f.db.close();}
});

test('relinked identity makes a previously trusted actor stale at scheduling time',async()=>{
 const f=await fixture({alias:true});try{
  const newCanonical=uuid();await f.db.db.insert(people).values({id:newCanonical});
  await f.db.db.update(personIdentityLinks).set({canonicalPersonId:newCanonical}).where(eq(personIdentityLinks.aliasPersonId,f.aliasId));
  await assert.rejects(f.schedule(),/stale/);
 }finally{await f.db.close();}
});

test('current actor authorization rejects erased people and unconfirmed membership instead of trusting saved linked IDs',async()=>{
 const f=await fixture();try{
  await f.db.db.update(conversationMembers).set({confirmedAt:null}).where(and(eq(conversationMembers.conversationId,f.conversationId),eq(conversationMembers.personId,f.personId)));
  await assert.rejects(f.schedule(),/membership/);
  await f.db.db.update(conversationMembers).set({confirmedAt:new Date()}).where(and(eq(conversationMembers.conversationId,f.conversationId),eq(conversationMembers.personId,f.personId)));
  await f.db.db.update(people).set({status:'erased'}).where(eq(people.id,f.personId));
  await assert.rejects(f.schedule(),/active canonical/);
 }finally{await f.db.close();}
});

test('quota reservation serializes concurrent commitments and counts in-flight dispatch',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});try{
  const secondMessage=uuid();await f.db.db.insert(messages).values({id:secondMessage,conversationId:f.conversationId,personId:f.personId,platform:'qq',platformEventId:`second-${f.s}`,role:'user',text:'再提醒我周末复习'});
 const first=await f.schedule(),second=await f.schedule(secondMessage);f.clock.value=new Date('2026-10-24T01:00:00Z');let sends=0;
  const firstDelivery=f.service.deliverDue(first.id,async()=>{sends++;entered();await waiting;return {kind:'receipt',receipt:'r1'};});await started;
  const secondDelivery=await f.service.deliverDue(second.id,async()=>{sends++;return {kind:'receipt',receipt:'r2'};});assert.equal(secondDelivery,'quota');release();assert.equal(await firstDelivery,'sent');assert.equal(sends,1);
 }finally{await f.db.close();}
});

test('unknown receipt reserves quota against a later commitment that day',async()=>{
 const f=await fixture();try{
  const secondMessage=uuid();await f.db.db.insert(messages).values({id:secondMessage,conversationId:f.conversationId,personId:f.personId,platform:'qq',platformEventId:`unknown-second-${f.s}`,role:'user',text:'也提醒我'});
  const first=await f.schedule(),second=await f.schedule(secondMessage);f.clock.value=new Date('2026-10-24T01:00:00Z');
  assert.equal(await f.service.deliverDue(first.id,async()=>({kind:'receipt_unknown',errorCode:'receipt_unknown'})),'receipt_unknown');
  let sends=0;assert.equal(await f.service.deliverDue(second.id,async()=>{sends++;return {kind:'receipt',receipt:'bad'};}),'quota');assert.equal(sends,0);
 }finally{await f.db.close();}
});

test('daily quota uses the configured local timezone across UTC midnight',async()=>{
 const f=await fixture();try{
  const secondMessage=uuid();await f.db.db.insert(messages).values({id:secondMessage,conversationId:f.conversationId,personId:f.personId,platform:'qq',platformEventId:`timezone-second-${f.s}`,role:'user',text:'再提醒我'});
  await f.db.db.update(proactivePermissions).set({quietStart:'00:00',quietEnd:'00:00'}).where(eq(proactivePermissions.personId,f.personId));
  await f.db.db.update(conversationPolicies).set({quietStart:'00:00',quietEnd:'00:00'}).where(eq(conversationPolicies.conversationId,f.conversationId));
  const first=await f.schedule(),second=await f.schedule(secondMessage);f.clock.value=new Date('2026-10-24T15:59:00Z');assert.equal(await f.service.deliverDue(first.id,async()=>({kind:'receipt',receipt:'local-day-one'})),'sent');
  f.clock.value=new Date('2026-10-24T16:01:00Z');assert.equal(await f.service.deliverDue(second.id,async()=>({kind:'receipt',receipt:'local-day-two'})),'sent');
 }finally{await f.db.close();}
});

test('expired worker claims become unknown and fence stale successful receipts; admin can reconcile',async()=>{
 const f=await fixture();let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});try{
  const item=await f.schedule();f.clock.value=new Date('2026-10-24T01:00:00Z');const active=f.service.deliverDue(item.id,async()=>{entered();await waiting;return {kind:'receipt',receipt:'late-receipt'};},'worker-a',1_000);await started;
  f.clock.value=new Date(f.clock.value.getTime()+2_000);assert.equal(await f.service.recoverExpiredClaims(),1);release();assert.equal(await active,'receipt_unknown');
  assert.equal(await f.service.deliverDue(item.id,async()=>{throw new Error('blind resend');}),'receipt_unknown');
  await assert.rejects(f.service.reconcile(item.id,'sent',{kind:'admin',auditActorId:'forged'},'receipt'));const req:any={method:'POST',query:{},routeOptions:{url:'/admin/proactive/reconcile'},headers:{authorization:'Bearer valid'}};new AdminGuard('valid').canActivate({switchToHttp:()=>({getRequest:()=>req})} as any);
  await f.service.reconcile(item.id,'sent',req.adminPrincipal,'reconciled-receipt');
  assert.equal((await f.db.db.select().from(commitments).where(eq(commitments.id,item.id)))[0]!.status,'completed');
  assert.equal((await f.db.db.select().from(auditEvents).where(and(eq(auditEvents.targetId,item.id),eq(auditEvents.action,'proactive_receipt_reconciled')))).length,1);
  assert.ok((await f.db.db.select().from(operationKeys).where(eq(operationKeys.key,`proactive-delivery:${item.id}`)))[0]!.resultRef?.startsWith('receipt:'));
 }finally{await f.db.close();}
});

test('pre-dispatch crash recovery marks an expired durable claim unknown without calling delivery',async()=>{
 const f=await fixture();try{
  const item=await f.schedule(),key=`proactive-delivery:${item.id}`,expired=new Date(f.clock.value.getTime()-1);await f.db.db.update(commitments).set({jobId:'sending:2',version:item.version+1}).where(eq(commitments.id,item.id));
  await f.db.db.insert(operationKeys).values({key,kind:'proactive_delivery',status:'leased',leaseOwner:'dead-worker',leaseExpiresAt:expired,resultRef:'dispatching',version:2});
  assert.equal(await f.service.recoverExpiredClaims(),1);let sends=0;assert.equal(await f.service.deliverDue(item.id,async()=>{sends++;return {kind:'receipt',receipt:'never'};}),'receipt_unknown');assert.equal(sends,0);
  const row=(await f.db.db.select().from(commitments).where(eq(commitments.id,item.id)))[0]!;assert.equal(row.jobId,'receipt_unknown');assert.equal(row.status,'failed');
 }finally{await f.db.close();}
});

test('malformed receipts fail closed into unknown state and never count as definite failure',async()=>{
 const f=await fixture();try{
  const item=await f.schedule();f.clock.value=new Date('2026-10-24T01:00:00Z');assert.equal(await f.service.deliverDue(item.id,async()=>({kind:'receipt',receipt:''})),'receipt_unknown');
  const op=(await f.db.db.select().from(operationKeys).where(eq(operationKeys.key,`proactive-delivery:${item.id}`)))[0]!;assert.match(op.resultRef??'',/^receipt_unknown:/);
  await assert.rejects(f.service.retryNotSent(item.id,{kind:'admin',auditActorId:'forged'}));
 }finally{await f.db.close();}
});

test('known not-sent results release quota and only authenticated admin can explicitly retry',async()=>{
 const f=await fixture();try{
  const item=await f.schedule();f.clock.value=new Date('2026-10-24T01:00:00Z');assert.equal(await f.service.deliverDue(item.id,async()=>({kind:'not_sent',errorCode:'network_error'})),'failed');
  const req:any={method:'POST',query:{},routeOptions:{url:'/admin/proactive/retry'},headers:{authorization:'Bearer valid'}};new AdminGuard('valid').canActivate({switchToHttp:()=>({getRequest:()=>req})} as any);
  assert.equal(await f.service.retryNotSent(item.id,req.adminPrincipal),true);assert.equal(await f.service.deliverDue(item.id,async()=>({kind:'receipt',receipt:'after-retry'})),'sent');
 }finally{await f.db.close();}
});

test('malformed not-sent error codes are ambiguous, not quota releasing',async()=>{
 const f=await fixture();try{
  const item=await f.schedule();f.clock.value=new Date('2026-10-24T01:00:00Z');assert.equal(await f.service.deliverDue(item.id,async()=>({kind:'not_sent',errorCode:'BAD CODE'})),'receipt_unknown');
  const op=(await f.db.db.select().from(operationKeys).where(eq(operationKeys.key,`proactive-delivery:${item.id}`)))[0]!;assert.match(op.resultRef??'',/^receipt_unknown:/);
 }finally{await f.db.close();}
});

test('commitment reschedule and cancellation require authenticated admin and leave audit trail',async()=>{
 const f=await fixture();try{
  const item=await f.schedule();await assert.rejects(f.service.reschedule(item.id,{dueAt:new Date('2026-10-25T00:00:00Z')},{kind:'admin',auditActorId:'forged'}));
  const req:any={method:'POST',query:{},routeOptions:{url:'/admin/proactive'},headers:{authorization:'Bearer valid'}};new AdminGuard('valid').canActivate({switchToHttp:()=>({getRequest:()=>req})} as any);
  await f.service.reschedule(item.id,{dueAt:new Date('2026-10-25T00:00:00Z'),description:'改到周日'},req.adminPrincipal);await f.service.cancel(item.id,req.adminPrincipal);
  const row=(await f.db.db.select().from(commitments).where(eq(commitments.id,item.id)))[0]!;assert.equal(row.status,'cancelled');assert.equal(row.description,'改到周日');
  assert.equal((await f.db.db.select().from(auditEvents).where(and(eq(auditEvents.targetId,item.id),eq(auditEvents.actorKind,'admin')))).length,2);
 }finally{await f.db.close();}
});
