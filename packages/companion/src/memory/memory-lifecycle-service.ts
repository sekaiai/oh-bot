import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/database.js';
import { auditEvents, commitments, conversationMembers, conversations, deliveryOutbox, deletionRecords, jobLogs, knowledgeClaims, memoryMappings, memoryRevisions, memorySources, memoryValidationRecords, messages, personEntities, relationshipEdges, turns } from '../database/schema/index.js';
import type { ActorContext, VisibilityScope } from '../domain/contracts.js';
import { isAuthenticatedAdminPrincipal } from '../admin/auth.js';
import { DisclosurePolicy } from '../identity/disclosure-policy.js';
import { isTrustedActorContext } from '../identity/trust.js';
import { visibilityScopeSchema } from '../domain/contracts.js';

const uuidSchema = z.string().uuid();
// Fail closed on common hypothetical, reported, and fictional framing. Human review still
// confirms that an accepted quote supports the candidate; this prevents a visibly non-factual
// utterance from being promoted as a direct personal fact.
const nonDirectClaimPatterns = [
  /(?:如果|假如|假设|要是|万一|倘若|若是|的话|有空的话|哪天|一旦|只要|除非|等我|以后|也许|或许|可能|大概|估计|应该|好像|似乎|说不定|我猜|我觉得|不一定|未必)/u,
  /\b(?:if i|if we|suppose|hypothetically|maybe|perhaps|might|could possibly|would probably)\b/iu,
  /(?:听说|据说|有人说|朋友说|别人说|他说|她说|他们说|传闻|据传|我朋友跟我说|我同事跟我说|我家人跟我说|朋友告诉我|同事告诉我|家人告诉我)/u,
  /\b(?:i heard that|someone told me|they say|reportedly|allegedly)\b/iu,
  /(?:小说|故事里|角色|虚构|编的|做梦|梦见|假想)/u,
  /\b(?:fictional|in my story|i dreamed|dreamt that)\b/iu,
];

function classifyUserClaim(text: string): 'direct' | 'reported' | 'hypothetical' | 'fiction' {
  if (/(?:听说|据说|有人说|朋友说|别人说|他说|她说|他们说|传闻|据传|我朋友跟我说|我同事跟我说|我家人跟我说|我(?:的)?(?:朋友|同事|家人|父母|爸爸|妈妈|父亲|母亲|兄弟|姐妹|儿子|女儿|妻子|丈夫|伴侣|室友|同学|老板)(?:跟我)?(?:说|告诉我|提到|讲过)|[\p{Script=Han}]{2,4}(?:告诉我|跟我说|对我说|说过|提到))|\b(?:i heard that|someone told me|they say|reportedly|allegedly|[A-Z][a-z]{1,30}\s+(?:told me|said|mentioned))\b/iu.test(text)) return 'reported';
  if (/(?:小说|故事里|角色|虚构|编的|做梦|梦见|假想)|\b(?:fictional|in my story|i dreamed|dreamt that)\b/iu.test(text)) return 'fiction';
  if (/(?:我的(?:朋友|同事|家人|父母|爸爸|妈妈|父亲|母亲|兄弟|姐妹|儿子|女儿|妻子|丈夫|伴侣|室友|同学|老板)|\bmy\s+(?:friend|coworker|colleague|family|parent|father|mother|brother|sister|son|daughter|wife|husband|partner|roommate|classmate|boss)\b)/iu.test(text)) return 'reported';
  if (/我(?:有|认识|雇佣|聘请)?(?:个|位|名|一个|一位)?(?:朋友|同事|家人|父母|爸爸|妈妈|父亲|母亲|兄弟|姐妹|儿子|女儿|妻子|丈夫|伴侣|室友|同学|老板|邻居|熟人|同伴|伙伴|同乡|客户|老师|医生|师傅)(?:的[\p{Script=Han}]{1,4}){0,3}/u.test(text) ||
      /\bi have (?:a|an|one)\s+(?:friend|neighbor|neighbour|coworker|colleague|family|parent|father|mother|brother|sister|son|daughter|wife|husband|partner|roommate|classmate|boss|acquaintance|customer|teacher|doctor)(?:['’]s\s+[a-z -]{1,32})?/iu.test(text)) return 'reported';
  if (/^\s*我(?:其实)?(?:喜欢|不喜欢|爱|讨厌|擅长|认识|知道|养)的[\p{Script=Han}]{1,4}(?:有|是|在|住在|来自|喜欢|爱|养)/u.test(text)) return 'reported';
  if (nonDirectClaimPatterns.some((pattern) => pattern.test(text))) return 'hypothetical';
  // Ambiguous sentences are not evidence by default. Require an explicit first-person
  // assertion in every clause before a source can be extracted as a personal fact.
  const clauses = text.normalize('NFKC').replace(/^[\s“”"'「」『』]*(?:更正(?:一下)?[，,:：]?\s*)?/u, '')
    .split(/[，,。.!！？?；;:：()\[\]（）【】{}｛｝《》「」『』“”"—–\n]+|(?:与此同时|要不然|因此|所以|于是|因而|从而|否则|不然|因为|由于|虽然|尽管|但是|以及|然而|可是|不过|只是|反而|同时|然后|另外|此外|而|但|却|又)|(?<![a-z])(?:therefore|otherwise|because|although|however|whereas|while|since|thus|unless|meanwhile|moreover|furthermore|instead|but|and|yet|so)(?![a-z])/iu)
    .map((clause) => clause.trim()).filter(Boolean);
  const firstPersonAssertion = (clause: string) => /^(?:我(?:(?:其实|现在|目前|曾经|正在)\s*)?(?:是|有|住在?|来自|喜欢|不喜欢|更喜欢|爱|讨厌|擅长|从事|做|养|工作|读书|出生于)|本人(?:是|有|住在?|来自|喜欢|不喜欢|爱|讨厌|擅长|从事|做|养))/u.test(clause.trim())
    || /^\s*(?:i have|i live|i like|i dislike|i love|i hate|i am (?:a|an|from|located|married|single|happy|sad|tired|based)|i'm (?:a|an|from|located|married|single|happy|sad|tired|based))\b/iu.test(clause);
  if (!clauses.length || !firstPersonAssertion(clauses[0]!)) return 'hypothetical';
  const sameSubjectContinuation = /^(?:(?:也|还|并且|而且)(?:更)?(?:喜欢|不喜欢|爱|讨厌|有|在|擅长|从事|养)|and\s+also\s+(?:like|dislike|love|hate|have|live|am)\b)/iu;
  if (clauses.slice(1).some((clause) => !firstPersonAssertion(clause) && !sameSubjectContinuation.test(clause))) return 'hypothetical';
  return 'direct';
}

function normalizeEvidenceClaim(text: string): string {
  return text.normalize('NFKC').replace(/^[\s“”"'「」『』]*(?:更正(?:一下)?[，,:：]?\s*)?/u, '')
    .replace(/^[\s“”"'「」『』]*(?:我其实|其实|我|本人)?[\s，,:：]*/u, '')
    .replace(/[\p{P}\p{S}\s]/gu, '').toLocaleLowerCase();
}

function reintroducesSupersededFact(candidate: string, superseded: string): boolean {
  const stale = normalizeEvidenceClaim(superseded);
  const proposed = normalizeEvidenceClaim(candidate);
  // Mem0 can combine a corrected clause with an unrelated surviving clause.
  // The engine output then differs from the superseded revision as a whole,
  // while still explicitly repeating it. Treat that as a conflict.
  return stale.length >= 3 && proposed.includes(stale);
}
const candidateSchema = z.object({
  sourceId: uuidSchema,
  canonicalKey: z.string().trim().min(1).max(200),
  factText: z.string().trim().min(1).max(4_000),
  engineMemoryId: z.string().trim().min(1).max(512),
}).strict();
type BeforeDeletionCommit = (entry: { operationKey: string; characterId: string; sourceIds: string[]; memoryIds: string[]; scope: VisibilityScope }) => Promise<void>;

export class MemoryLifecycleError extends Error {
  constructor(readonly code: 'untrusted_actor' | 'invalid_input' | 'source_not_owned' | 'source_unavailable' | 'stale_revision' | 'invalid_state') {
    super(code);
  }
}

export class MemoryLifecycleService {
  private readonly policy: DisclosurePolicy;

  constructor(private readonly database: Database, policy?: DisclosurePolicy) {
    this.policy = policy ?? new DisclosurePolicy(database);
  }

  async recordUserSource(context: ActorContext, messageId: string): Promise<typeof memorySources.$inferSelect> {
    if (!isTrustedActorContext(context)) throw new MemoryLifecycleError('untrusted_actor');
    if (!uuidSchema.safeParse(messageId).success) throw new MemoryLifecycleError('invalid_input');
    return this.database.db.transaction(async (tx) => {
      const authorization = await this.policy.authorizationSnapshot(context, tx);
      const [message] = await tx.select().from(messages).where(eq(messages.id, messageId)).for('share').limit(1);
      if (!message || message.role !== 'user' || message.deletedAt || !message.personId ||
          message.conversationId !== context.conversationId || !authorization.matchesPersonIds([message.personId])) {
        throw new MemoryLifecycleError('source_not_owned');
      }
      const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, message.conversationId)).limit(1);
      if (!conversation || conversation.characterId !== context.characterId || conversation.platform !== message.platform) {
        throw new MemoryLifecycleError('source_not_owned');
      }
      const scope = conversation.kind === 'private'
        ? { kind: 'person_private' as const, personId: message.personId }
        : { kind: 'conversation_shared' as const, conversationId: conversation.id };
      if (!authorization.allowedScopes.some((allowed) => JSON.stringify(allowed) === JSON.stringify(scope))) {
        throw new MemoryLifecycleError('source_not_owned');
      }
      const participants = conversation.kind === 'group'
        ? await tx.select({ personId: conversationMembers.personId }).from(conversationMembers)
          .where(eq(conversationMembers.conversationId, conversation.id))
          .orderBy(conversationMembers.personId)
        : [{ personId: message.personId }];
      const batchKey = `user-message:${message.id}`;
      const [inserted] = await tx.insert(memorySources).values({
        characterId: conversation.characterId,
        personId: message.personId,
        conversationId: conversation.id,
        messageId: message.id,
        sourceKind: 'user',
        batchKey,
        scope,
        subjectPersonIds: [message.personId],
        speakerPersonId: message.personId,
        participantPersonIds: participants.map(({ personId }) => personId),
        claimKind: typeof message.text === 'string' ? classifyUserClaim(message.text) : 'direct',
        allowedForExtraction: typeof message.text === 'string' && message.text.trim().length > 0 && classifyUserClaim(message.text) === 'direct',
      }).onConflictDoNothing({ target: memorySources.batchKey }).returning();
      if (inserted) {
        await tx.insert(jobLogs).values({ operationKey: `mem0-sync:${inserted.id}`, queueName: 'memory_sync', status: 'pending' })
          .onConflictDoNothing({ target: jobLogs.operationKey });
        return inserted;
      }
      const [existing] = await tx.select().from(memorySources).where(eq(memorySources.batchKey, batchKey)).limit(1);
      if (!existing || existing.messageId !== message.id || existing.characterId !== conversation.characterId) {
        throw new MemoryLifecycleError('invalid_state');
      }
      await tx.insert(jobLogs).values({ operationKey: `mem0-sync:${existing.id}`, queueName: 'memory_sync', status: 'pending' })
        .onConflictDoNothing({ target: jobLogs.operationKey });
      return existing;
    }, { isolationLevel: 'repeatable read' });
  }

  async recordCandidate(context: ActorContext, rawCandidate: unknown): Promise<typeof memoryRevisions.$inferSelect> {
    if (!isTrustedActorContext(context)) throw new MemoryLifecycleError('untrusted_actor');
    const candidate = candidateSchema.parse(rawCandidate);
    return this.database.db.transaction(async (tx) => {
      const authorization = await this.policy.authorizationSnapshot(context, tx);
      const [source] = await tx.select().from(memorySources).where(eq(memorySources.id, candidate.sourceId)).for('update').limit(1);
      if (!source || source.status !== 'active' || source.deletedAt || !source.allowedForExtraction ||
          source.characterId !== context.characterId || source.sourceKind !== 'user' || source.claimKind !== 'direct' ||
          !source.speakerPersonId || !authorization.matchesPersonIds([source.speakerPersonId]) ||
          !authorization.allowedScopes.some((scope) => JSON.stringify(scope) === JSON.stringify(source.scope))) {
        throw new MemoryLifecycleError('source_unavailable');
      }
      const [existingValidation] = await tx.select().from(memoryValidationRecords)
        .where(eq(memoryValidationRecords.engineMemoryId, candidate.engineMemoryId)).limit(1);
      if (existingValidation) {
        if (existingValidation.sourceId !== source.id) throw new MemoryLifecycleError('invalid_state');
        const [existingRevision] = await tx.select().from(memoryRevisions)
          .where(and(eq(memoryRevisions.sourceId, source.id), eq(memoryRevisions.engineMemoryId, candidate.engineMemoryId)))
          .limit(1);
        if (!existingRevision) throw new MemoryLifecycleError('invalid_state');
        return existingRevision;
      }

      const superseded = await tx.select({ factText: memoryRevisions.factText }).from(memoryRevisions)
        .where(and(eq(memoryRevisions.sourceId, source.id), eq(memoryRevisions.status, 'superseded')));
      if (superseded.some((row) => row.factText && reintroducesSupersededFact(candidate.factText, row.factText))) {
        throw new MemoryLifecycleError('source_unavailable');
      }

      const parsedScope = visibilityScopeSchema.safeParse(source.scope);
      if (!parsedScope.success) throw new MemoryLifecycleError('source_unavailable');
      const keyLock = `${source.characterId}:${candidate.canonicalKey}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${keyLock}, 0))`);
      const [maximum] = await tx.select({ value: sql<number>`coalesce(max(${memoryRevisions.revision}), 0)::int` })
        .from(memoryRevisions).where(and(
          eq(memoryRevisions.characterId, source.characterId),
          eq(memoryRevisions.canonicalKey, candidate.canonicalKey),
        ));
      const [revision] = await tx.insert(memoryRevisions).values({
        characterId: source.characterId,
        canonicalKey: candidate.canonicalKey,
        revision: (maximum?.value ?? 0) + 1,
        sourceId: source.id,
        engineMemoryId: candidate.engineMemoryId,
        factText: candidate.factText,
        scope: parsedScope.data,
        subjectPersonIds: source.subjectPersonIds,
        status: 'candidate',
        validFrom: new Date(),
      }).returning();
      if (!revision) throw new MemoryLifecycleError('invalid_state');
      await tx.insert(memoryValidationRecords).values({
        sourceId: source.id,
        engineMemoryId: candidate.engineMemoryId,
        status: 'candidate',
        subjectPersonIds: source.subjectPersonIds,
        evidenceMessageIds: [source.messageId],
      });
      return revision;
    }, { isolationLevel: 'repeatable read' });
  }

  async approveCandidate(revisionId: string, expectedVersion: number, principal: unknown, review: { claimKind: 'direct'; evidenceQuote: string }): Promise<typeof memoryRevisions.$inferSelect> {
    if (!uuidSchema.safeParse(revisionId).success || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new MemoryLifecycleError('invalid_input');
    }
    if (!isAuthenticatedAdminPrincipal(principal)) throw new MemoryLifecycleError('untrusted_actor');
    if (review?.claimKind !== 'direct' || typeof review.evidenceQuote !== 'string' || !review.evidenceQuote.trim()) throw new MemoryLifecycleError('invalid_input');
    return this.database.db.transaction(async (tx) => {
      const [identity] = await tx.select({ sourceId: memoryRevisions.sourceId }).from(memoryRevisions)
        .where(eq(memoryRevisions.id, revisionId)).limit(1);
      if (!identity) throw new MemoryLifecycleError('invalid_state');
      const [source] = await tx.select().from(memorySources).where(eq(memorySources.id, identity.sourceId)).for('update').limit(1);
      const [evidence] = source?.messageId ? await tx.select().from(messages).where(eq(messages.id, source.messageId)).limit(1) : [];
      const [revision] = await tx.select().from(memoryRevisions).where(eq(memoryRevisions.id, revisionId)).for('update').limit(1);
      if (!source || source.status !== 'active' || source.deletedAt || source.sourceKind !== 'user' ||
          source.claimKind !== 'direct' || !source.allowedForExtraction || !revision ||
          revision.status !== 'candidate' || revision.version !== expectedVersion || !revision.factText?.trim() || evidence?.role !== 'user' ||
          typeof evidence.text !== 'string' || classifyUserClaim(evidence.text) !== 'direct' || classifyUserClaim(review.evidenceQuote) !== 'direct' || !evidence.text.includes(review.evidenceQuote) ||
          !normalizeEvidenceClaim(revision.factText) || normalizeEvidenceClaim(revision.factText) !== normalizeEvidenceClaim(review.evidenceQuote)) {
        throw new MemoryLifecycleError(revision?.version !== expectedVersion ? 'stale_revision' : 'source_unavailable');
      }
      const supersededFacts = await tx.select({ factText: memoryRevisions.factText }).from(memoryRevisions)
        .where(and(eq(memoryRevisions.sourceId, source.id), eq(memoryRevisions.status, 'superseded')));
      if (supersededFacts.some((item) => item.factText && reintroducesSupersededFact(revision.factText!, item.factText))) {
        throw new MemoryLifecycleError('source_unavailable');
      }
      const keyLock = `${revision.characterId}:${revision.canonicalKey}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${keyLock}, 0))`);
      const [current] = await tx.select({ id: memoryRevisions.id }).from(memoryRevisions).where(and(
        eq(memoryRevisions.characterId, revision.characterId),
        eq(memoryRevisions.canonicalKey, revision.canonicalKey),
        eq(memoryRevisions.status, 'validated'),
        isNull(memoryRevisions.validTo),
      )).limit(1);
      if (current) throw new MemoryLifecycleError('invalid_state');
      const parsedScope = visibilityScopeSchema.safeParse(source.scope);
      const revisionScope = visibilityScopeSchema.safeParse(revision.scope);
      if (!parsedScope.success || !revisionScope.success || JSON.stringify(parsedScope.data) !== JSON.stringify(revisionScope.data) ||
          revision.subjectPersonIds.length !== source.subjectPersonIds.length ||
          revision.subjectPersonIds.some((id, index) => id !== source.subjectPersonIds[index])) {
        throw new MemoryLifecycleError('source_unavailable');
      }
      const [updated] = await tx.update(memoryRevisions).set({
        status: 'validated', version: sql`${memoryRevisions.version} + 1`,
      }).where(and(eq(memoryRevisions.id, revision.id), eq(memoryRevisions.version, expectedVersion))).returning();
      if (!updated) throw new MemoryLifecycleError('stale_revision');
      await tx.update(memoryValidationRecords).set({ status: 'validated', evidenceQuote: review.evidenceQuote }).where(and(
        eq(memoryValidationRecords.sourceId, source.id),
        eq(memoryValidationRecords.engineMemoryId, revision.engineMemoryId!),
        eq(memoryValidationRecords.status, 'candidate'),
      ));
      await tx.insert(auditEvents).values({
        actorKind: 'admin', actorId: principal.auditActorId, action: 'memory_candidate_approved',
        targetId: revision.id, metadata: { sourceId: source.id, canonicalKey: revision.canonicalKey },
      });
      return updated;
    }, { isolationLevel: 'repeatable read' });
  }

  async correctRevision(context: ActorContext, input: { revisionId: string; expectedVersion: number; messageId: string; factText: string }): Promise<typeof memoryRevisions.$inferSelect> {
    if (!isTrustedActorContext(context)) throw new MemoryLifecycleError('untrusted_actor');
    if (!uuidSchema.safeParse(input.revisionId).success || !uuidSchema.safeParse(input.messageId).success ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !input.factText.trim()) throw new MemoryLifecycleError('invalid_input');
    return this.database.db.transaction(async (tx) => {
      const authorization = await this.policy.authorizationSnapshot(context, tx);
      const [revisionKey] = await tx.select({ sourceId: memoryRevisions.sourceId }).from(memoryRevisions)
        .where(eq(memoryRevisions.id, input.revisionId)).limit(1);
      if (!revisionKey) throw new MemoryLifecycleError('invalid_state');
      const [oldSource] = await tx.select().from(memorySources).where(eq(memorySources.id, revisionKey.sourceId)).for('update').limit(1);
      const [oldRevision] = await tx.select().from(memoryRevisions).where(eq(memoryRevisions.id, input.revisionId)).for('update').limit(1);
      if (!oldSource || !oldRevision || oldRevision.version !== input.expectedVersion) throw new MemoryLifecycleError('stale_revision');
      if (oldRevision.status !== 'validated' || oldRevision.validTo || oldSource.status !== 'active' || oldSource.deletedAt ||
          oldSource.characterId !== context.characterId || !oldSource.personId || !authorization.matchesPersonIds([oldSource.personId])) {
        throw new MemoryLifecycleError('source_unavailable');
      }
      const [message] = await tx.select().from(messages).where(eq(messages.id, input.messageId)).for('share').limit(1);
      if (!message || message.role !== 'user' || message.deletedAt || message.personId !== oldSource.personId ||
          message.conversationId !== context.conversationId) throw new MemoryLifecycleError('source_not_owned');
      if (typeof message.text !== 'string' || classifyUserClaim(message.text) !== 'direct' ||
          !normalizeEvidenceClaim(input.factText) ||
          normalizeEvidenceClaim(input.factText) !== normalizeEvidenceClaim(message.text)) {
        throw new MemoryLifecycleError('source_unavailable');
      }
      const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, message.conversationId)).limit(1);
      if (!conversation || conversation.characterId !== context.characterId) throw new MemoryLifecycleError('source_not_owned');
      const scope = conversation.kind === 'private' ? { kind: 'person_private' as const, personId: message.personId! } : { kind: 'conversation_shared' as const, conversationId: conversation.id };
      if (!authorization.allowedScopes.some((allowed) => JSON.stringify(allowed) === JSON.stringify(scope)) || JSON.stringify(scope) !== JSON.stringify(oldSource.scope)) {
        throw new MemoryLifecycleError('source_unavailable');
      }
      const batchKey = `user-message:${message.id}`;
      let [source] = await tx.select().from(memorySources).where(eq(memorySources.batchKey, batchKey)).for('update').limit(1);
      if (!source) {
        const participants = conversation.kind === 'group'
          ? await tx.select({ personId: conversationMembers.personId }).from(conversationMembers).where(eq(conversationMembers.conversationId, conversation.id)).orderBy(conversationMembers.personId)
          : [{ personId: message.personId! }];
        [source] = await tx.insert(memorySources).values({
          characterId: conversation.characterId, personId: message.personId, conversationId: conversation.id, messageId: message.id,
          sourceKind: 'user', batchKey, scope, subjectPersonIds: [message.personId!], speakerPersonId: message.personId,
          participantPersonIds: participants.map((x) => x.personId), claimKind: classifyUserClaim(message.text ?? ''),
          allowedForExtraction: Boolean(message.text?.trim()) && classifyUserClaim(message.text ?? '') === 'direct',
        }).returning();
      }
      if (!source || source.status !== 'active' || source.personId !== oldSource.personId || source.claimKind !== 'direct' || !source.allowedForExtraction) throw new MemoryLifecycleError('source_unavailable');
      const keyLock = `${oldRevision.characterId}:${oldRevision.canonicalKey}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${keyLock}, 0))`);
      const [maximum] = await tx.select({ value: sql<number>`coalesce(max(${memoryRevisions.revision}), 0)::int` }).from(memoryRevisions)
        .where(and(eq(memoryRevisions.characterId, oldRevision.characterId), eq(memoryRevisions.canonicalKey, oldRevision.canonicalKey)));
      const now = new Date();
      const [updatedOld] = await tx.update(memoryRevisions).set({ status: 'superseded', validTo: now, version: sql`${memoryRevisions.version} + 1` })
        .where(and(eq(memoryRevisions.id, oldRevision.id), eq(memoryRevisions.version, input.expectedVersion), eq(memoryRevisions.status, 'validated'), isNull(memoryRevisions.validTo))).returning();
      if (!updatedOld) throw new MemoryLifecycleError('stale_revision');
      const [created] = await tx.insert(memoryRevisions).values({
        characterId: oldRevision.characterId, canonicalKey: oldRevision.canonicalKey, revision: (maximum?.value ?? 0) + 1,
        sourceId: source.id, engineMemoryId: null, factText: input.factText.trim(), scope, subjectPersonIds: [message.personId!],
        status: 'validated', validFrom: now, supersedesId: oldRevision.id,
      }).returning();
      if (!created) throw new MemoryLifecycleError('invalid_state');
      await tx.insert(memoryValidationRecords).values({ sourceId: source.id, status: 'validated', subjectPersonIds: [message.personId!], evidenceMessageIds: [message.id] });
      await tx.insert(jobLogs).values({ operationKey: `mem0-sync:${source.id}`, queueName: 'memory_sync', status: 'pending' })
        .onConflictDoNothing({ target: jobLogs.operationKey });
      return created;
    }, { isolationLevel: 'repeatable read' });
  }

  /** Explicit admin correction grounded in a persisted, same-owner message and exact evidence quote. */
  async correctRevisionAsAdmin(input: { revisionId: string; expectedVersion: number; messageId: string; factText: string; evidenceQuote: string }, principal: unknown, auditReason: string): Promise<typeof memoryRevisions.$inferSelect> {
    if (!isAuthenticatedAdminPrincipal(principal)) throw new MemoryLifecycleError('untrusted_actor');
    if (!uuidSchema.safeParse(input.revisionId).success || !uuidSchema.safeParse(input.messageId).success ||
        !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !input.factText.trim() ||
        typeof input.evidenceQuote !== 'string' || !input.evidenceQuote.trim() ||
        typeof auditReason !== 'string' || auditReason.trim().length < 3 || auditReason.length > 500 || /[\u0000-\u001f\u007f]/u.test(auditReason)) {
      throw new MemoryLifecycleError('invalid_input');
    }
    return this.database.db.transaction(async (tx) => {
      const [old] = await tx.select().from(memoryRevisions).where(eq(memoryRevisions.id, input.revisionId)).for('update').limit(1);
      if (!old) throw new MemoryLifecycleError('invalid_state');
      const [oldSource] = await tx.select().from(memorySources).where(eq(memorySources.id, old.sourceId)).for('update').limit(1);
      if (!oldSource || old.version !== input.expectedVersion) throw new MemoryLifecycleError('stale_revision');
      if (old.status !== 'validated' || old.validTo || oldSource.status !== 'active' || oldSource.deletedAt || !oldSource.personId) throw new MemoryLifecycleError('source_unavailable');
      const [message] = await tx.select().from(messages).where(eq(messages.id, input.messageId)).for('share').limit(1);
      if (!message || message.role !== 'user' || message.deletedAt || message.personId !== oldSource.personId || message.conversationId !== oldSource.conversationId || typeof message.text !== 'string' ||
          classifyUserClaim(message.text) !== 'direct' || classifyUserClaim(input.evidenceQuote) !== 'direct' || !message.text.includes(input.evidenceQuote) ||
          normalizeEvidenceClaim(input.factText) !== normalizeEvidenceClaim(input.evidenceQuote)) throw new MemoryLifecycleError('source_unavailable');
      const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, message.conversationId)).limit(1);
      if (!conversation || conversation.characterId !== old.characterId) throw new MemoryLifecycleError('source_unavailable');
      const scope = conversation.kind === 'private' ? { kind: 'person_private' as const, personId: message.personId! } : { kind: 'conversation_shared' as const, conversationId: conversation.id };
      if (JSON.stringify(scope) !== JSON.stringify(oldSource.scope)) throw new MemoryLifecycleError('source_unavailable');
      const batchKey = `user-message:${message.id}`;
      let [source] = await tx.select().from(memorySources).where(eq(memorySources.batchKey, batchKey)).for('update').limit(1);
      if (!source) {
        const participants = conversation.kind === 'group' ? await tx.select({ personId: conversationMembers.personId }).from(conversationMembers).where(eq(conversationMembers.conversationId, conversation.id)).orderBy(conversationMembers.personId) : [{ personId: message.personId! }];
        [source] = await tx.insert(memorySources).values({ characterId: conversation.characterId, personId: message.personId, conversationId: conversation.id, messageId: message.id, sourceKind: 'user', batchKey, scope, subjectPersonIds: [message.personId!], speakerPersonId: message.personId, participantPersonIds: participants.map((item) => item.personId), claimKind: classifyUserClaim(message.text), allowedForExtraction: true }).returning();
      }
      if (!source || source.status !== 'active' || source.personId !== oldSource.personId || JSON.stringify(source.scope) !== JSON.stringify(oldSource.scope)) throw new MemoryLifecycleError('source_unavailable');
      const keyLock = `${old.characterId}:${old.canonicalKey}`;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${keyLock}, 0))`);
      const [maximum] = await tx.select({ value: sql<number>`coalesce(max(${memoryRevisions.revision}), 0)::int` }).from(memoryRevisions).where(and(eq(memoryRevisions.characterId, old.characterId), eq(memoryRevisions.canonicalKey, old.canonicalKey)));
      const now = new Date();
      const [superseded] = await tx.update(memoryRevisions).set({ status: 'superseded', validTo: now, version: sql`${memoryRevisions.version} + 1` }).where(and(eq(memoryRevisions.id, old.id), eq(memoryRevisions.version, input.expectedVersion), eq(memoryRevisions.status, 'validated'), isNull(memoryRevisions.validTo))).returning();
      if (!superseded) throw new MemoryLifecycleError('stale_revision');
      const [created] = await tx.insert(memoryRevisions).values({ characterId: old.characterId, canonicalKey: old.canonicalKey, revision: (maximum?.value ?? 0) + 1, sourceId: source.id, engineMemoryId: null, factText: input.factText.trim(), scope, subjectPersonIds: [message.personId!], status: 'validated', validFrom: now, supersedesId: old.id }).returning();
      if (!created) throw new MemoryLifecycleError('invalid_state');
      await tx.insert(memoryValidationRecords).values({ sourceId: source.id, status: 'validated', subjectPersonIds: [message.personId!], evidenceMessageIds: [message.id], evidenceQuote: input.evidenceQuote.trim() });
      await tx.insert(jobLogs).values({ operationKey: `mem0-sync:${source.id}`, queueName: 'memory_sync', status: 'pending' }).onConflictDoNothing({ target: jobLogs.operationKey });
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: principal.auditActorId, action: 'memory_revision_corrected_by_admin', targetId: old.id, metadata: { replacementRevisionId: created.id, sourceId: source.id, auditReason: auditReason.trim() } });
      return created;
    }, { isolationLevel: 'repeatable read' });
  }

  async forgetSource(context: ActorContext, sourceId: string, beforeCommit?: BeforeDeletionCommit): Promise<typeof deletionRecords.$inferSelect> {
    if (!isTrustedActorContext(context)) throw new MemoryLifecycleError('untrusted_actor');
    if (!uuidSchema.safeParse(sourceId).success) throw new MemoryLifecycleError('invalid_input');
    return this.database.db.transaction(async (tx) => {
      const authorization = await this.policy.authorizationSnapshot(context, tx);
      const [source] = await tx.select().from(memorySources).where(eq(memorySources.id, sourceId)).limit(1);
      if (!source || source.characterId !== context.characterId || !source.personId || !authorization.matchesPersonIds([source.personId]) ||
          !authorization.allowedScopes.some((scope) => JSON.stringify(scope) === JSON.stringify(source.scope))) throw new MemoryLifecycleError('source_not_owned');
      const candidates = await tx.select({ id: memoryRevisions.id, sourceId: memoryRevisions.sourceId, engineMemoryId: memoryRevisions.engineMemoryId, supersedesId: memoryRevisions.supersedesId }).from(memoryRevisions).where(eq(memoryRevisions.characterId, source.characterId));
      const sourceIdsClosure = new Set([source.id]);
      const chainRevisionIds = new Set<string>();
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const row of candidates) {
          const linked = sourceIdsClosure.has(row.sourceId) || chainRevisionIds.has(row.id) || Boolean(row.supersedesId && chainRevisionIds.has(row.supersedesId)) || candidates.some((child) => child.supersedesId === row.id && chainRevisionIds.has(child.id));
          if (linked && !chainRevisionIds.has(row.id)) { chainRevisionIds.add(row.id); expanded = true; }
          if (chainRevisionIds.has(row.id) && !sourceIdsClosure.has(row.sourceId)) { sourceIdsClosure.add(row.sourceId); expanded = true; }
        }
      }
      const revisionRows = candidates.filter((r) => chainRevisionIds.has(r.id));
      const sourceIds = [...sourceIdsClosure].sort();
      await tx.select({ id: memorySources.id }).from(memorySources).where(inArray(memorySources.id, sourceIds)).orderBy(memorySources.id).for('update');
      const revisions = revisionRows.length ? await tx.select({ id: memoryRevisions.id, sourceId: memoryRevisions.sourceId, engineMemoryId: memoryRevisions.engineMemoryId }).from(memoryRevisions).where(inArray(memoryRevisions.id, revisionRows.map((r) => r.id))).orderBy(memoryRevisions.id).for('update') : [];
      const rootIds = revisionRows.filter((row) => !row.supersedesId || !chainRevisionIds.has(row.supersedesId)).map((row) => row.id).sort();
      if (rootIds.length === 0) rootIds.push(source.id);
      const operationKey = `forget-chain:${source.characterId}:${rootIds.join(',')}`;
      const [existing] = await tx.select().from(deletionRecords).where(eq(deletionRecords.operationKey, operationKey)).for('update').limit(1);
      if (existing) {
        await beforeCommit?.({ operationKey: existing.operationKey, characterId: existing.characterId, sourceIds: existing.sourceIds, memoryIds: existing.memoryIds, scope: existing.scope });
        return existing;
      }
      const validations = await tx.select({ engineMemoryId: memoryValidationRecords.engineMemoryId }).from(memoryValidationRecords).where(inArray(memoryValidationRecords.sourceId, sourceIds));
      const revisionIds = revisions.map((x) => x.id);
      const mappings = revisionIds.length ? await tx.select({ engineMemoryId: memoryMappings.engineMemoryId }).from(memoryMappings).where(inArray(memoryMappings.revisionId, revisionIds)) : [];
      const memoryIds = [...new Set([...revisions.map((x) => x.engineMemoryId), ...validations.map((x) => x.engineMemoryId), ...mappings.map((x) => x.engineMemoryId)].filter((x): x is string => Boolean(x)))];
      await beforeCommit?.({ operationKey, characterId: source.characterId, sourceIds, memoryIds, scope: source.scope });
      const now = new Date();
      await tx.update(memorySources).set({ status: 'deleted', deletedAt: now }).where(inArray(memorySources.id, sourceIds));
      await tx.update(memoryRevisions).set({ status: 'deleted', validTo: sql`coalesce(${memoryRevisions.validTo}, ${now})`, version: sql`${memoryRevisions.version} + 1` })
        .where(inArray(memoryRevisions.id, revisionIds));
      await tx.update(memoryRevisions).set({ factText: '[forgotten]' }).where(inArray(memoryRevisions.id, revisionIds));
      const erasedMessages = await tx.select({ messageId: memorySources.messageId }).from(memorySources).where(inArray(memorySources.id, sourceIds));
      const erasedMessageIds = erasedMessages.map((item) => item.messageId);
      await this.eraseSourceDerivedText(tx, sourceIds, erasedMessageIds, now);
      const [record] = await tx.insert(deletionRecords).values({
        characterId: source.characterId, personId: source.personId, scope: source.scope, sourceIds, memoryIds, operationKey, status: 'pending',
      }).returning();
      if (!record) throw new MemoryLifecycleError('invalid_state');
      await tx.insert(jobLogs).values({ operationKey: `mem0-delete:${record.id}`, queueName: 'memory_delete', status: 'pending' })
        .onConflictDoNothing({ target: jobLogs.operationKey });
      await tx.insert(auditEvents).values({ actorKind: 'person', actorId: source.personId, action: 'memory_source_forgotten', targetId: source.id,
        metadata: { deletionRecordId: record.id, memoryIds } });
      return record;
    }, { isolationLevel: 'repeatable read' });
  }

  /** Admin deletion is explicit, audited, CAS-protected, and keeps the original source scope. */
  async forgetRevisionAsAdmin(revisionId: string, expectedVersion: number, principal: unknown, auditReason: string, beforeCommit?: BeforeDeletionCommit): Promise<typeof deletionRecords.$inferSelect> {
    if (!isAuthenticatedAdminPrincipal(principal)) throw new MemoryLifecycleError('untrusted_actor');
    if (!uuidSchema.safeParse(revisionId).success || !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 ||
        typeof auditReason !== 'string' || auditReason.trim().length < 3 || auditReason.length > 500 || /[\u0000-\u001f\u007f]/u.test(auditReason)) throw new MemoryLifecycleError('invalid_input');
    const operationKey = `admin-forget-revision:${revisionId}:v${expectedVersion}`;
    return this.database.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(deletionRecords).where(eq(deletionRecords.operationKey, operationKey)).for('update').limit(1);
      if (existing) {
        await beforeCommit?.({ operationKey: existing.operationKey, characterId: existing.characterId, sourceIds: existing.sourceIds, memoryIds: existing.memoryIds, scope: existing.scope });
        return existing;
      }
      const [key] = await tx.select({ sourceId: memoryRevisions.sourceId }).from(memoryRevisions).where(eq(memoryRevisions.id, revisionId)).limit(1);
      if (!key) throw new MemoryLifecycleError('invalid_state');
      const [source] = await tx.select().from(memorySources).where(eq(memorySources.id, key.sourceId)).for('update').limit(1);
      const [requested] = await tx.select().from(memoryRevisions).where(eq(memoryRevisions.id, revisionId)).for('update').limit(1);
      if (!source || !requested || requested.version !== expectedVersion) throw new MemoryLifecycleError(requested ? 'stale_revision' : 'invalid_state');
      if (source.status !== 'active' || source.deletedAt) throw new MemoryLifecycleError('source_unavailable');
      const candidates = await tx.select({ id: memoryRevisions.id, sourceId: memoryRevisions.sourceId, engineMemoryId: memoryRevisions.engineMemoryId, supersedesId: memoryRevisions.supersedesId }).from(memoryRevisions).where(eq(memoryRevisions.characterId, source.characterId));
      const sourceIdsClosure = new Set([source.id]);
      const chainRevisionIds = new Set<string>();
      let expanded = true;
      while (expanded) {
        expanded = false;
        for (const row of candidates) {
          const linked = sourceIdsClosure.has(row.sourceId) || chainRevisionIds.has(row.id) || Boolean(row.supersedesId && chainRevisionIds.has(row.supersedesId)) || candidates.some((child) => child.supersedesId === row.id && chainRevisionIds.has(child.id));
          if (linked && !chainRevisionIds.has(row.id)) { chainRevisionIds.add(row.id); expanded = true; }
          if (chainRevisionIds.has(row.id) && !sourceIdsClosure.has(row.sourceId)) { sourceIdsClosure.add(row.sourceId); expanded = true; }
        }
      }
      const sourceIds = [...sourceIdsClosure].sort();
      const revisionIds = [...chainRevisionIds].sort();
      await tx.select({ id: memorySources.id }).from(memorySources).where(inArray(memorySources.id, sourceIds)).orderBy(memorySources.id).for('update');
      const revisions = revisionIds.length ? await tx.select({ id: memoryRevisions.id, engineMemoryId: memoryRevisions.engineMemoryId }).from(memoryRevisions).where(inArray(memoryRevisions.id, revisionIds)).orderBy(memoryRevisions.id).for('update') : [];
      const validations = await tx.select({ engineMemoryId: memoryValidationRecords.engineMemoryId }).from(memoryValidationRecords).where(inArray(memoryValidationRecords.sourceId, sourceIds));
      const mappings = revisionIds.length ? await tx.select({ engineMemoryId: memoryMappings.engineMemoryId }).from(memoryMappings).where(inArray(memoryMappings.revisionId, revisionIds)) : [];
      const memoryIds = [...new Set([...revisions.map((item) => item.engineMemoryId), ...validations.map((item) => item.engineMemoryId), ...mappings.map((item) => item.engineMemoryId)].filter((item): item is string => Boolean(item)))];
      await beforeCommit?.({ operationKey, characterId: source.characterId, sourceIds, memoryIds, scope: source.scope });
      const now = new Date();
      await tx.update(memorySources).set({ status: 'deleted', deletedAt: now }).where(inArray(memorySources.id, sourceIds));
      if (revisionIds.length) await tx.update(memoryRevisions).set({ status: 'deleted', validTo: sql`coalesce(${memoryRevisions.validTo}, ${now})`, version: sql`${memoryRevisions.version} + 1` }).where(inArray(memoryRevisions.id, revisionIds));
      if (revisionIds.length) await tx.update(memoryRevisions).set({ factText: '[forgotten]' }).where(inArray(memoryRevisions.id, revisionIds));
      const erasedMessageIds = await tx.select({ id: memorySources.messageId }).from(memorySources).where(inArray(memorySources.id, sourceIds));
      const erasedMessageIdList = erasedMessageIds.map((item) => item.id);
      await this.eraseSourceDerivedText(tx, sourceIds, erasedMessageIdList, now);
      const [record] = await tx.insert(deletionRecords).values({ characterId: source.characterId, personId: source.personId, scope: source.scope, sourceIds, memoryIds, operationKey, status: 'pending' }).returning();
      if (!record) throw new MemoryLifecycleError('invalid_state');
      await tx.insert(jobLogs).values({ operationKey: `mem0-delete:${record.id}`, queueName: 'memory_delete', status: 'pending' })
        .onConflictDoNothing({ target: jobLogs.operationKey });
      await tx.insert(auditEvents).values({ actorKind: 'admin', actorId: principal.auditActorId, action: 'memory_revision_forgotten_by_admin', targetId: revisionId, metadata: { deletionRecordId: record.id, auditReason: auditReason.trim(), sourceIds, memoryIds } });
      return record;
    }, { isolationLevel: 'repeatable read' });
  }

  private async eraseSourceDerivedEntities(tx: Parameters<Parameters<Database['db']['transaction']>[0]>[0], messageIds: string[], now: Date) {
    if (!messageIds.length) return;
    const edges = await tx.select({ id: relationshipEdges.id, subjectEntityId: relationshipEdges.subjectEntityId, objectEntityId: relationshipEdges.objectEntityId })
      .from(relationshipEdges).where(and(inArray(relationshipEdges.sourceMessageId, messageIds), isNull(relationshipEdges.validTo)));
    if (!edges.length) return;
    await tx.update(relationshipEdges).set({ status: 'superseded', validTo: now, version: sql`${relationshipEdges.version} + 1` })
      .where(inArray(relationshipEdges.id, edges.map((edge) => edge.id)));
    const impactedIds = [...new Set(edges.flatMap((edge) => [edge.subjectEntityId, edge.objectEntityId]))];
    for (const entityId of impactedIds) {
      const [live] = await tx.select({ id: relationshipEdges.id }).from(relationshipEdges).where(and(
        or(eq(relationshipEdges.subjectEntityId, entityId), eq(relationshipEdges.objectEntityId, entityId)),
        isNull(relationshipEdges.validTo),
      )).limit(1);
      if (!live) await tx.update(personEntities).set({ displayName: '[forgotten]', aliases: [], version: sql`${personEntities.version} + 1` }).where(eq(personEntities.id, entityId));
    }
  }

  async eraseSourceDerivedText(tx: Parameters<Parameters<Database['db']['transaction']>[0]>[0], sourceIds: string[], messageIds: string[], now: Date): Promise<void> {
    if (!messageIds.length) return;
    await tx.update(messages).set({ text: null, metadata: sql`'{}'::jsonb` }).where(inArray(messages.id, messageIds));
    await tx.update(memoryValidationRecords).set({ evidenceQuote: null }).where(inArray(memoryValidationRecords.sourceId, sourceIds));
    await tx.update(knowledgeClaims).set({ claimText: null, status: 'deleted', validTo: sql`coalesce(${knowledgeClaims.validTo}, ${now})`, version: sql`${knowledgeClaims.version} + 1` })
      .where(and(inArray(knowledgeClaims.sourceId, sourceIds), or(isNotNull(knowledgeClaims.claimText), sql`${knowledgeClaims.status} <> 'deleted'`)));
    const affectedTurns = await tx.select({ id: turns.id }).from(turns).where(inArray(turns.inboundMessageId, messageIds));
    const turnIds = affectedTurns.map(({ id }) => id);
    if (turnIds.length) {
      const generatedEventIds = turnIds.map((id) => `generated:${id}`);
      await tx.update(messages).set({ text: null, metadata: sql`'{}'::jsonb` }).where(and(inArray(messages.platformEventId, generatedEventIds), eq(messages.role, 'assistant')));
      await tx.update(deliveryOutbox).set({ content: {}, status: 'failed', errorCode: 'source_forgotten', leaseOwner: null, leaseExpiresAt: null, version: sql`${deliveryOutbox.version} + 1` })
        .where(and(inArray(deliveryOutbox.turnId, turnIds), inArray(deliveryOutbox.status, ['pending', 'sending'])));
    }
    await tx.update(commitments).set({ description: null, status: sql`case when ${commitments.status} in ('scheduled', 'proposed') then 'cancelled'::companion.commitment_status else ${commitments.status} end`, version: sql`${commitments.version} + 1` })
      .where(and(inArray(commitments.sourceMessageId, messageIds), isNotNull(commitments.description)));
    await this.eraseSourceDerivedEntities(tx, messageIds, now);
  }
}
