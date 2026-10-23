import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Database } from '../database/database.js';
import { characters, conversationMembers, conversations, emotionStates, interactionEvents, messages, people, platformIdentities, relationshipStates } from '../database/schema/index.js';
import type { ActorContext } from '../domain/contracts.js';
import { isTrustedActorContext } from '../identity/trust.js';

export type GroundedInteractionKind='conversation'|'appreciation'|'shared_experience'|'boundary_respected';
export type InteractionAnalyzer=(text:string)=>GroundedInteractionKind;
const deltas:Record<GroundedInteractionKind,{familiarity:number;trust:number;pleasantness:number;care:number}>={
 conversation:{familiarity:.01,trust:0,pleasantness:0,care:0}, appreciation:{familiarity:.01,trust:.02,pleasantness:.03,care:.02},
 shared_experience:{familiarity:.02,trust:.01,pleasantness:.02,care:.01}, boundary_respected:{familiarity:0,trust:.02,pleasantness:.01,care:.02},
};
const bounded=(v:number,min:number,max:number)=>Math.max(min,Math.min(max,v));
export class RelationshipEventService {
 constructor(private readonly database:Database,private readonly analyze:InteractionAnalyzer){ }
 async recordIncoming(actor:ActorContext,messageId:string):Promise<{applied:boolean;kind?:GroundedInteractionKind}> {
  if(!isTrustedActorContext(actor)) throw new Error('trusted actor context required');
  if(!/^[0-9a-f-]{36}$/i.test(messageId)) throw new Error('valid source message required');
  const [source]=await this.database.db.select({text:messages.text}).from(messages).innerJoin(conversations,eq(conversations.id,messages.conversationId)).innerJoin(conversationMembers,and(eq(conversationMembers.conversationId,conversations.id),inArray(conversationMembers.personId,actor.linkedPersonIds),isNotNull(conversationMembers.confirmedAt))).innerJoin(platformIdentities,and(eq(platformIdentities.id,actor.platformIdentityId),eq(platformIdentities.platform,conversations.platform))).where(and(eq(messages.id,messageId),eq(messages.role,'user'),eq(messages.conversationId,actor.conversationId),eq(messages.personId,actor.personId),eq(conversations.characterId,actor.characterId),eq(conversations.kind,actor.conversationKind),inArray(platformIdentities.personId,actor.linkedPersonIds))).limit(1);
  if(!source?.text?.trim()) throw new Error('source message unavailable');
  let kind:GroundedInteractionKind;try{const result=this.analyze(source.text);if(!(result in deltas))return {applied:false};kind=result;}catch{return {applied:false};}
  const delta=deltas[kind], key=`incoming:${messageId}`, now=new Date();
  return this.database.db.transaction(async tx=>{
   const [event]=await tx.insert(interactionEvents).values({eventKey:key,characterId:actor.characterId,personId:actor.personId,sourceMessageId:messageId,kind,payload:{sourceMessageId:messageId,kind,delta},appliedAt:now}).onConflictDoNothing({target:interactionEvents.eventKey}).returning({id:interactionEvents.id});
   if(!event)return {applied:false,kind};
   await tx.insert(relationshipStates).values({characterId:actor.characterId,personId:actor.personId,familiarity:delta.familiarity,trust:delta.trust,lastEventAt:now}).onConflictDoUpdate({target:[relationshipStates.characterId,relationshipStates.personId],set:{familiarity:sql`least(1, ${relationshipStates.familiarity} + ${delta.familiarity})`,trust:sql`least(1, ${relationshipStates.trust} + ${delta.trust})`,lastEventAt:now,version:sql`${relationshipStates.version}+1`}});
   await tx.insert(emotionStates).values({characterId:actor.characterId,personId:actor.personId,pleasantness:delta.pleasantness,care:bounded(.5+delta.care,0,1),lastEventAt:now}).onConflictDoUpdate({target:[emotionStates.characterId,emotionStates.personId],set:{pleasantness:sql`least(1, ${emotionStates.pleasantness} + ${delta.pleasantness})`,care:sql`least(1, ${emotionStates.care} + ${delta.care})`,lastEventAt:now,version:sql`${emotionStates.version}+1`}});
   return {applied:true,kind};
  });
 }
}
