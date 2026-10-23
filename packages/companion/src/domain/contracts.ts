import { z } from 'zod';
export const platformSchema = z.enum(['qq','weixin','dingtalk']);
export type Platform = z.infer<typeof platformSchema>;
export const conversationKindSchema = z.enum(['private','group']);
export type ConversationKind = z.infer<typeof conversationKindSchema>;
const uuid = z.string().uuid();
export const visibilityScopeSchema = z.discriminatedUnion('kind',[
 z.object({kind:z.literal('character_public')}).strict(), z.object({kind:z.literal('circle_shared'),circleId:uuid}).strict(),
 z.object({kind:z.literal('conversation_shared'),conversationId:uuid}).strict(), z.object({kind:z.literal('person_private'),personId:uuid}).strict(), z.object({kind:z.literal('partner_private'),personId:uuid}).strict()
]);
export type VisibilityScope = Readonly<z.infer<typeof visibilityScopeSchema>>;
export const inboundEventSchema = z.object({platform:platformSchema,eventId:z.string().min(1),senderPlatformId:z.string().min(1),conversationPlatformId:z.string().min(1),conversationKind:conversationKindSchema,text:z.string().max(32000),timestamp:z.string().datetime({offset:true}),participantPlatformIds:z.array(z.string()).default([]),participantsComplete:z.boolean().default(false),replyToEventId:z.string().optional()}).strict();
export type InboundEvent = Readonly<z.infer<typeof inboundEventSchema>>;
export type ActorContext = Readonly<{personId:string;characterId:string;conversationId:string;platformIdentityId:string;conversationKind:ConversationKind;isPartner:boolean;circleIds:readonly string[];participantIds:readonly string[];linkedPersonIds:readonly string[];participantsComplete:boolean}>;
export type Principal = Readonly<{kind:'admin';auditActorId:string}|{kind:'person';actor:ActorContext}>;
export const budgetSchema = z.object({
 maxSteps: z.number().int().positive().max(100).default(8),
 maxToolCalls: z.number().int().positive().max(100).default(8),
 maxTokens: z.number().int().positive().max(100000).default(8000),
 maxCostUsd: z.number().nonnegative().default(1),
 timeoutMs: z.number().int().positive().max(3600000).default(60000),
}).strict();
export type Budget = Readonly<z.infer<typeof budgetSchema>>;
export const sourceKinds=['user','assistant','tool','legacy'] as const; export type SourceKind=typeof sourceKinds[number];
export const memoryStatuses=['candidate','validated','conflict','superseded','deleted'] as const; export type MemoryStatus=typeof memoryStatuses[number];
export const turnStatuses=['received','processing','generated','sent','failed','receipt_unknown'] as const; export type TurnStatus=typeof turnStatuses[number];
export const deliveryStatuses=['pending','sending','sent','failed','receipt_unknown'] as const; export type DeliveryStatus=typeof deliveryStatuses[number];
