import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import { characters,commitments,conversationMembers,conversationPolicies,conversations,messages,platformIdentities,proactivePermissions } from '../database/schema/index.js';
import type { ActorContext } from '../domain/contracts.js';
import { isTrustedActorContext } from '../identity/trust.js';

export type ProactiveResult={kind:'receipt';receipt:string}|{kind:'not_sent';errorCode:string}|{kind:'receipt_unknown';errorCode:string};
export type ProactiveDelivery=(input:{operationKey:string;personId:string;conversationId:string;description:string})=>Promise<ProactiveResult>;
export class ProactiveCommitmentService {
 constructor(private readonly database:Database,private readonly now=()=>new Date()){}
 async schedule(actor:ActorContext,sourceMessageId:string,input:{description:string;dueAt:Date}):Promise<typeof commitments.$inferSelect>{
  this.assertActor(actor); if(!z.string().uuid().safeParse(sourceMessageId).success||!input?.description?.trim()||input.description.length>1000||!(input.dueAt instanceof Date)||!Number.isFinite(input.dueAt.getTime())||input.dueAt<=this.clock())throw new Error('explicit future due time and description required');
  return this.database.db.transaction(async tx=>{const [source]=await tx.select({id:messages.id}).from(messages).innerJoin(conversations,eq(conversations.id,messages.conversationId)).innerJoin(conversationMembers,and(eq(conversationMembers.conversationId,conversations.id),eq(conversationMembers.personId,actor.personId))).innerJoin(platformIdentities,eq(platformIdentities.id,actor.platformIdentityId)).where(and(eq(messages.id,sourceMessageId),eq(messages.role,'user'),eq(messages.personId,actor.personId),eq(messages.conversationId,actor.conversationId),eq(conversations.characterId,actor.characterId),eq(conversations.kind,actor.conversationKind),eq(conversations.platform,platformIdentities.platform),eq(platformIdentities.personId,actor.personId))).limit(1); if(!source)throw new Error('source message unavailable');
   const [permission]=await tx.select().from(proactivePermissions).where(and(eq(proactivePermissions.characterId,actor.characterId),eq(proactivePermissions.personId,actor.personId))).limit(1); if(!permission?.enabled)throw new Error('person proactive permission disabled');
   if(actor.conversationKind==='group'){const [policy]=await tx.select().from(conversationPolicies).where(eq(conversationPolicies.conversationId,actor.conversationId)).limit(1);if(!policy?.proactiveEnabled)throw new Error('group proactive permission disabled');}
   const key=`commitment:${sourceMessageId}:${actor.personId}`;const [row]=await tx.insert(commitments).values({characterId:actor.characterId,personId:actor.personId,conversationId:actor.conversationId,description:input.description.trim(),sourceMessageId,dueAt:input.dueAt,status:'scheduled',operationKey:key}).onConflictDoNothing({target:commitments.operationKey}).returning(); if(row)return row; const [existing]=await tx.select().from(commitments).where(eq(commitments.operationKey,key)).limit(1); if(!existing)throw new Error('commitment persistence failed'); return existing;
  });
 }
 async deliverDue(commitmentId:string,delivery:ProactiveDelivery):Promise<'sent'|'failed'|'receipt_unknown'|'not_due'|'not_authorized'|'quiet_window'|'quota'|'already_claimed'> {
  if(!z.string().uuid().safeParse(commitmentId).success)throw new Error('invalid commitment');
  const claim=await this.database.db.transaction(async tx=>{const [item]=await tx.select().from(commitments).where(eq(commitments.id,commitmentId)).for('update').limit(1);if(!item||item.status!=='scheduled'||item.jobId)return {outcome:'already_claimed' as const};const now=this.clock();if(!item.dueAt||item.dueAt>now)return {outcome:'not_due' as const};
   const [permission]=await tx.select().from(proactivePermissions).where(and(eq(proactivePermissions.characterId,item.characterId),eq(proactivePermissions.personId,item.personId))).limit(1);const [conversation]=await tx.select().from(conversations).where(eq(conversations.id,item.conversationId)).limit(1);if(!permission?.enabled||!conversation)return {outcome:'not_authorized' as const};let policy:typeof conversationPolicies.$inferSelect|undefined;
   if(conversation.kind==='group'){[policy]=await tx.select().from(conversationPolicies).where(and(eq(conversationPolicies.conversationId,item.conversationId),eq(conversationPolicies.proactiveEnabled,true))).limit(1);if(!policy)return {outcome:'not_authorized' as const};}
   const quota=Math.min(policy?.maxPerDay??permission.maxPerDay,permission.maxPerDay);if(this.quiet(now,permission.quietStart,permission.quietEnd,permission.timeZone)||(policy&&this.quiet(now,policy.quietStart,policy.quietEnd,policy.timeZone)))return {outcome:'quiet_window' as const};const zone=permission.timeZone;
   const localDay=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);const done=await tx.select({updatedAt:commitments.updatedAt}).from(commitments).where(and(eq(commitments.personId,item.personId),eq(commitments.status,'completed')));if(done.filter(row=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(row.updatedAt)===localDay).length>=quota)return {outcome:'quota' as const};
   const claimMarker=`sending:${item.id}`;await tx.update(commitments).set({jobId:claimMarker,updatedAt:now}).where(eq(commitments.id,item.id));return {item,conversation,operationKey:item.operationKey,claimMarker,outcome:'claimed' as const};
  });
  if(claim.outcome!=='claimed')return claim.outcome;
  let result:ProactiveResult;try{result=await delivery({operationKey:claim.operationKey,personId:claim.item.personId,conversationId:claim.conversation.id,description:claim.item.description??''});}catch{result={kind:'receipt_unknown',errorCode:'receipt_unknown'};}
  if(!result||!['receipt','not_sent','receipt_unknown'].includes(result.kind))result={kind:'receipt_unknown',errorCode:'receipt_unknown'};
  const status=result.kind==='receipt'?'completed':result.kind==='not_sent'?'failed':'scheduled';const marker=result.kind==='receipt_unknown'?'receipt_unknown':result.kind==='receipt'?`receipt:${result.receipt}`:null;await this.database.db.update(commitments).set({status,jobId:marker,updatedAt:this.clock()}).where(and(eq(commitments.id,claim.item.id),eq(commitments.jobId,claim.claimMarker)));
  // Claim marker is retained for unknown receipts so a confirmed or ambiguous action cannot be sent twice.
  return result.kind==='receipt'?'sent':result.kind==='not_sent'?'failed':'receipt_unknown';
 }
 async retryNotSent(commitmentId:string):Promise<boolean>{if(!z.string().uuid().safeParse(commitmentId).success)throw new Error('invalid commitment');const [row]=await this.database.db.update(commitments).set({status:'scheduled',jobId:null,updatedAt:this.clock()}).where(and(eq(commitments.id,commitmentId),eq(commitments.status,'failed'))).returning({id:commitments.id});return !!row;}
 private assertActor(actor:ActorContext){if(!isTrustedActorContext(actor))throw new Error('trusted actor context required');}
 private clock(){const date=this.now();if(!(date instanceof Date)||!Number.isFinite(date.getTime()))throw new Error('invalid clock');return date;}
 private quiet(now:Date,start:string,end:string,zone:string):boolean{const hm=(value:string)=>{if(!/^\d{2}:\d{2}$/.test(value))throw new Error('invalid quiet window');const [h,m]=value.split(':').map(Number);if(h!>23||m!>59)throw new Error('invalid quiet window');return h!*60+m!;};const formatter=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});const parts=formatter.formatToParts(now),minute=Number(parts.find(p=>p.type==='hour')?.value)*60+Number(parts.find(p=>p.type==='minute')?.value);const a=hm(start),b=hm(end);return a<=b?minute>=a&&minute<b:minute>=a||minute<b;}
}
