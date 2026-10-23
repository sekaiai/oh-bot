import type { ActorContext } from '../domain/contracts.js';
const trusted = new WeakSet<object>();
const trustedEvidence = new WeakMap<object, { platformUserId: string; conversationKind: 'private' | 'group' }>();
const trustedRosters = new WeakMap<object, { platform: 'qq'|'weixin'|'dingtalk'; channelId: string; memberIds: readonly string[]; observedAt: Date }>();
export function trustActorContext<T extends ActorContext>(value: T): T { trusted.add(value); return value; }
export function isTrustedActorContext(value: unknown): value is ActorContext { return typeof value === 'object' && value !== null && trusted.has(value); }
// In-process gateway adapters call this only after authenticating the platform callback.
export type ChannelEvidence = Readonly<{kind:'verified-channel';platform:'qq'|'weixin'|'dingtalk';channelId:string}>;
export function createVerifiedChannelEvidence(platform:ChannelEvidence['platform'], channelId:string, platformUserId:string, conversationKind:'private'|'group'):ChannelEvidence {
  const platforms = ['qq', 'weixin', 'dingtalk'];
  const kinds = ['private', 'group'];
  if(typeof platform!=='string'||!platforms.includes(platform)||typeof channelId!=='string'||!channelId.trim()||typeof platformUserId!=='string'||!platformUserId.trim()||typeof conversationKind!=='string'||!kinds.includes(conversationKind)) {
    throw new Error('authenticated channel, user, platform, and conversation kind are required');
  }
  const evidence=Object.freeze({kind:'verified-channel' as const,platform,channelId});
  trustedEvidence.set(evidence,{platformUserId,conversationKind});
  return evidence;
}
export function isTrustedEvidence(value:unknown, platformUserId?:string, conversationKind?:'private'|'group', channelId?:string):value is ChannelEvidence {
  if(typeof value!=='object'||value===null)return false;
  const verified=trustedEvidence.get(value);
  return !!verified&&
    (platformUserId===undefined||verified.platformUserId===platformUserId)&&
    (conversationKind===undefined||verified.conversationKind===conversationKind)&&
    (channelId===undefined||(value as ChannelEvidence).channelId===channelId);
}
export type VerifiedChannelSubject = Readonly<{
  platform:'qq'|'weixin'|'dingtalk';
  channelId:string;
  platformUserId:string;
  conversationKind:'private'|'group';
}>;
export function readVerifiedChannelSubject(value:unknown):VerifiedChannelSubject|undefined {
  if(typeof value!=='object'||value===null)return undefined;
  const verified=trustedEvidence.get(value);
  if(!verified)return undefined;
  const evidence=value as ChannelEvidence;
  if(evidence.kind!=='verified-channel'||!['qq','weixin','dingtalk'].includes(evidence.platform)||typeof evidence.channelId!=='string'||!evidence.channelId.trim())return undefined;
  return Object.freeze({
    platform:evidence.platform,
    channelId:evidence.channelId,
    platformUserId:verified.platformUserId,
    conversationKind:verified.conversationKind,
  });
}
export type TrustedRosterEvidence = Readonly<{kind:'trusted-roster';platform:'qq'|'weixin'|'dingtalk';channelId:string}>;
export function createTrustedRosterEvidence(platform:'qq'|'weixin'|'dingtalk', channelId:string, memberIds:readonly string[], observedAt:Date):TrustedRosterEvidence {
  if(!['qq','weixin','dingtalk'].includes(platform)||!channelId.trim()||!Array.isArray(memberIds)||memberIds.length===0||memberIds.length>1000||memberIds.some(id=>typeof id!=='string'||!id.trim())||new Set(memberIds).size!==memberIds.length||!(observedAt instanceof Date)||!Number.isFinite(observedAt.getTime())) throw new Error('valid trusted roster required');
  const value=Object.freeze({kind:'trusted-roster' as const,platform,channelId});
  trustedRosters.set(value,{platform,channelId,memberIds:Object.freeze([...memberIds]),observedAt:new Date(observedAt)});
  return value;
}
export function readTrustedRoster(value:unknown):{platform:'qq'|'weixin'|'dingtalk';channelId:string;memberIds:readonly string[];observedAt:Date}|undefined {
  if(typeof value!=='object'||value===null)return undefined;
  const roster=trustedRosters.get(value);
  return roster?{...roster,memberIds:[...roster.memberIds],observedAt:new Date(roster.observedAt)}:undefined;
}
export function createRosterMemberEvidence(value:unknown, platformUserId:string):ChannelEvidence {
  const roster=readTrustedRoster(value);
  if(!roster||!roster.memberIds.includes(platformUserId)) throw new Error('member is not in the trusted roster');
  return createVerifiedChannelEvidence(roster.platform,roster.channelId,platformUserId,'group');
}
