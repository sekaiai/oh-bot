import test from 'node:test'; import assert from 'node:assert/strict';
import { createDatabase } from '../src/database/database.js'; import { migrateDatabase } from '../src/database/migrate.js'; import { eq } from 'drizzle-orm';
import { RelationshipEventService } from '../src/relationships/relationship-event-service.js'; import { createVerifiedChannelEvidence,trustActorContext } from '../src/identity/trust.js';
import { characters,people,platformIdentities,conversations,conversationMembers,messages,interactionEvents,relationshipStates } from '../src/database/schema/index.js'; import { uuid,requireCompatDatabaseUrl } from './helpers.js';
test('relationship events are source validated, deterministic, replay safe and never penalize delay or refusal',async()=>{
 const db=createDatabase(requireCompatDatabaseUrl()),s=uuid(),c=uuid(),p=uuid(),i=uuid(),cv=uuid(),m=uuid(); try { await migrateDatabase(db);
 await db.db.insert(characters).values({id:c,name:`rel-${s}`}); await db.db.insert(people).values({id:p}); await db.db.insert(platformIdentities).values({id:i,personId:p,platform:'qq',platformUserId:`rel-${s}`,verificationMethod:'test'});
 await db.db.insert(conversations).values({id:cv,characterId:c,platform:'qq',platformConversationId:`rel-${s}`,kind:'private'}); await db.db.insert(conversationMembers).values({conversationId:cv,personId:p,confirmedAt:new Date()});
 await db.db.insert(messages).values({id:m,conversationId:cv,personId:p,platform:'qq',platformEventId:`rel-${s}`,role:'user',text:'谢谢你'});
 const actor=trustActorContext({personId:p,characterId:c,conversationId:cv,platformIdentityId:i,conversationKind:'private' as const,isPartner:false,circleIds:[],participantIds:[p],linkedPersonIds:[p],participantsComplete:true}); const svc=new RelationshipEventService(db,()=>'appreciation');
 const first=await svc.recordIncoming(actor,m); const again=await svc.recordIncoming(actor,m); assert.equal(first.applied,true); assert.equal(again.applied,false);
 const state=(await db.db.select().from(relationshipStates).where(eq(relationshipStates.personId,p)))[0]!; assert.equal(state.trust,0.02); await assert.rejects(svc.recordIncoming({...actor},m));
 const failed=new RelationshipEventService(db,()=>{throw new Error('analyzer offline')}); assert.equal((await failed.recordIncoming(actor,m)).applied,false); assert.equal((await db.db.select().from(interactionEvents).where(eq(interactionEvents.sourceMessageId,m))).length,1); assert.equal((await db.db.select().from(relationshipStates).where(eq(relationshipStates.personId,p)))[0]!.trust,0.02);
 } finally { await db.close(); }
});
