import test from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { PersonaContextService } from '../src/persona/persona-context-service.js';
import { AdminGuard } from '../src/admin/auth.js';
import { characters, people, platformIdentities, conversations, conversationMembers, personIdentityLinks } from '../src/database/schema/index.js';
import { trustActorContext } from '../src/identity/trust.js';
import { uuid, requireCompatDatabaseUrl } from './helpers.js';

test('publishes immutable adult persona versions only for authenticated admins and reads trusted actor context', async () => {
  const database=createDatabase(requireCompatDatabaseUrl()); const suffix=uuid(); const characterId=uuid(),personId=uuid(),identityId=uuid(),conversationId=uuid(),personTwoId=uuid(),identityTwoId=uuid(),conversationTwoId=uuid(),partnerAliasId=uuid();
  try {
    await migrateDatabase(database);
    await database.db.insert(characters).values({id:characterId,name:`persona-${suffix}`});
    await database.db.insert(people).values([{id:personId},{id:personTwoId},{id:partnerAliasId}]);
    await database.db.insert(personIdentityLinks).values({aliasPersonId:partnerAliasId,canonicalPersonId:personId});
    await database.db.insert(platformIdentities).values([{id:identityId,personId,platform:'qq',platformUserId:`persona-${suffix}`,verificationMethod:'test',verifiedAt:new Date()},{id:identityTwoId,personId:personTwoId,platform:'qq',platformUserId:`persona-two-${suffix}`,verificationMethod:'test',verifiedAt:new Date()}]);
    await database.db.insert(conversations).values([{id:conversationId,characterId,platform:'qq',platformConversationId:`persona-${suffix}`,kind:'private'},{id:conversationTwoId,characterId,platform:'qq',platformConversationId:`persona-two-${suffix}`,kind:'private'}]);
    await database.db.insert(conversationMembers).values([{conversationId,personId,confirmedAt:new Date()},{conversationId:conversationTwoId,personId:personTwoId,confirmedAt:new Date()}]);
    const service=new PersonaContextService(database);
    const req:any={method:'POST',query:{},routeOptions:{url:'/admin/persona'},headers:{authorization:'Bearer test-token'}};
    new AdminGuard('test-token').canActivate({switchToHttp:()=>({getRequest:()=>req})} as any);
    const principal=req.adminPrincipal;
    await assert.rejects(service.publish(characterId,{voice:'forged'}, {kind:'admin',auditActorId:'forged'}));
    await assert.rejects(service.publish(characterId,{voice:'person'}, {kind:'person',actor:{}} as any));
    const version=await service.publish(characterId,{voice:'温柔、主动表达、有主见，尊重空间'},principal);
    assert.equal(version.revision,1);
    const actor=trustActorContext({personId,characterId,conversationId,platformIdentityId:identityId,conversationKind:'private' as const,isPartner:false,circleIds:[],participantIds:[personId],linkedPersonIds:[uuid()],participantsComplete:true});
    const context=await service.buildContext(actor);
    assert.match(context,/成年/); assert.match(context,/温柔、主动表达/);
    await assert.rejects(service.buildContext({...actor}));
    await assert.rejects(service.setPrimaryPartner(characterId,personId,{kind:'admin',auditActorId:'forged'}));
    await service.setPrimaryPartner(characterId,partnerAliasId,principal);
    const secondActor=trustActorContext({personId:personTwoId,characterId,conversationId:conversationTwoId,platformIdentityId:identityTwoId,conversationKind:'private' as const,isPartner:false,circleIds:[],participantIds:[personTwoId],linkedPersonIds:[personTwoId],participantsComplete:true});
    assert.match(await new PersonaContextService(database).buildContext(secondActor),/朋友与共同社交圈成员/);
    assert.match(await new PersonaContextService(database).buildContext(actor),/已绑定的唯一伴侣/);
    await database.db.update(conversationMembers).set({confirmedAt:null}).where(eq(conversationMembers.conversationId,conversationTwoId));
    await assert.rejects(new PersonaContextService(database).buildContext(secondActor),/membership/);
    await database.db.update(conversationMembers).set({confirmedAt:new Date()}).where(eq(conversationMembers.conversationId,conversationTwoId));
    await database.db.update(people).set({status:'erased'}).where(eq(people.id,personTwoId));
    await assert.rejects(new PersonaContextService(database).buildContext(secondActor),/active canonical/);
    const next=await service.publish(characterId,{voice:'更新'},principal);
    assert.equal(next.revision,2);
    assert.equal((await database.db.select().from((await import('../src/database/schema/index.js')).characterVersions)).length>=2,true);
  } finally { await database.close(); }
});
