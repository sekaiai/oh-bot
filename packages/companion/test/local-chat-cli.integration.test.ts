import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, inArray } from 'drizzle-orm';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { businessOutbox, characters, conversationMembers, conversations, deliveryOutbox, emotionStates, interactionEvents, messages, modelProfiles, modelRoleBindings, modelUsage, people, platformIdentities, relationshipStates, turns } from '../src/database/schema/index.js';
import { startChatFixture } from './chat-fixture.js';
import { requireCompatDatabaseUrl } from './helpers.js';

const cliPath = fileURLToPath(new URL('../src/cli/chat.ts', import.meta.url));
function runPersistentCli(env: NodeJS.ProcessEnv, sessionFile: string, input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath, '--persistent', '--session-file', sessionFile, '--max-turns', '1'], { env, stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  let sent = false;
  child.stdout.on('data', () => {
    if (!sent && stdout.includes('you> ')) { sent = true; child.stdin.end(`${input}\n`); }
  });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('persistent CLI did not exit')); }, 20_000);
    child.once('error', reject);
    child.once('exit', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

test('persistent CLI child-process restart sends saved user and assistant history to the next fixture request', async () => {
  const databaseUrl = requireCompatDatabaseUrl();
  const database = createDatabase(databaseUrl);
  const root = await mkdtemp(join(tmpdir(), 'oh-persistent-cli-'));
  const sessionFile = join(root, 'profile.json');
  const fixture = await startChatFixture({ reply: ({ index }) => index === 0 ? 'first saved answer' : 'second answer' });
  let primaryError: unknown;
  let profile: { characterId: string; userId: string; channelId: string } | undefined;
  const profileId = randomUUID();
  try {
    await migrateDatabase(database);
    profile = { characterId: randomUUID(), userId: `local-cli:user:${randomUUID()}`, channelId: `local-cli:channel:${randomUUID()}` };
    await writeFile(sessionFile, `${JSON.stringify({ version: 1, ...profile })}\n`, { mode: 0o600 });
    await database.db.insert(characters).values({ id: profile.characterId, name: `Local CLI ${profile.characterId}` });
    await database.db.insert(modelProfiles).values({ id: profileId, name: `local CLI fixture ${profileId}`, purpose: 'chat', provider: 'openai', baseUrl: fixture.baseUrl, model: 'local-cli-fixture', credentialRef: 'COMPANION_CHAT_API_KEY', enabled: true, maxTokens: 64, timeoutMs: 2_000, monthlyBudgetUsd: '1' });
    await database.db.insert(modelRoleBindings).values({ characterId: profile.characterId, purpose: 'chat', profileId });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      COMPANION_DATABASE_URL: databaseUrl,
      COMPANION_CHAT_API_KEY: 'sk-local-cli-fixture-secret',
      COMPANION_MODEL_PRICING_JSON: JSON.stringify({ 'local-cli-fixture': { inputUsdPer1M: 1, outputUsdPer1M: 1 } }),
    };
    const first = await runPersistentCli(env, sessionFile, 'first question');
    assert.equal(first.code, 0, first.stdout + first.stderr);
    assert.ok(first.stdout.includes('bot> first saved answer'), first.stdout + first.stderr);
    const second = await runPersistentCli(env, sessionFile, 'second question');
    assert.equal(second.code, 0, second.stdout + second.stderr);
    assert.ok(second.stdout.includes('bot> second answer'));
    assert.equal(fixture.calls.length, 2);
    const secondRequest = fixture.calls[1].body as { messages: Array<{ role: string; content: string }> };
    const historyMessages = secondRequest.messages.filter(({ role }) => role !== 'system');
    assert.deepEqual(historyMessages.slice(0, 2).map(({ role, content }) => [role, content]), [
      ['user', 'first question'], ['assistant', 'first saved answer'],
    ]);
    assert.equal(historyMessages.at(-1)?.role, 'user');
    assert.ok(historyMessages.at(-1)?.content.includes('second question'));
    assert.ok(!`${first.stdout}${second.stdout}${first.stderr}${second.stderr}`.includes('sk-local-cli-fixture-secret'));
    profile = JSON.parse(await readFile(sessionFile, 'utf8')) as typeof profile;
  } catch (error) { primaryError = error; throw error; }
  finally {
    let cleanupError: unknown;
    try {
      if (profile) {
        const rows = await database.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.characterId, profile.characterId));
        const conversationIds = rows.map((row) => row.id);
        const turnRows = conversationIds.length ? await database.db.select({ id: turns.id }).from(turns).where(inArray(turns.conversationId, conversationIds)) : [];
        const turnIds = turnRows.map((row) => row.id);
        if (turnIds.length) {
          await database.db.delete(businessOutbox).where(inArray(businessOutbox.operationKey, turnIds.flatMap((id) => [`turn:${id}:process`, `turn:${id}:deliver`])));
          await database.db.delete(deliveryOutbox).where(inArray(deliveryOutbox.turnId, turnIds));
          await database.db.delete(turns).where(inArray(turns.id, turnIds));
        }
        if (conversationIds.length) {
          const sourceRows = await database.db.select({ id: messages.id }).from(messages).where(inArray(messages.conversationId, conversationIds));
          if (sourceRows.length) await database.db.delete(interactionEvents).where(inArray(interactionEvents.sourceMessageId, sourceRows.map((row) => row.id)));
          await database.db.delete(messages).where(inArray(messages.conversationId, conversationIds));
          await database.db.delete(conversationMembers).where(inArray(conversationMembers.conversationId, conversationIds));
          await database.db.delete(conversations).where(inArray(conversations.id, conversationIds));
        }
        const identities = await database.db.select({ id: platformIdentities.id, personId: platformIdentities.personId }).from(platformIdentities).where(eq(platformIdentities.platformUserId, profile.userId));
        if (identities.length) {
          const personIds = [...new Set(identities.map((row) => row.personId))];
          await database.db.delete(emotionStates).where(inArray(emotionStates.personId, personIds));
          await database.db.delete(relationshipStates).where(inArray(relationshipStates.personId, personIds));
          await database.db.delete(platformIdentities).where(inArray(platformIdentities.id, identities.map((row) => row.id)));
          await database.db.delete(people).where(inArray(people.id, personIds));
        }
        await database.db.delete(modelRoleBindings).where(eq(modelRoleBindings.profileId, profileId));
        await database.db.delete(modelUsage).where(eq(modelUsage.profileId, profileId));
        await database.db.delete(modelProfiles).where(eq(modelProfiles.id, profileId));
        await database.db.delete(characters).where(eq(characters.id, profile.characterId));
      }
    } catch (error) { cleanupError = error; }
    try { await fixture.close(); } catch (error) { cleanupError ??= error; }
    try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
    try { await database.close(); } catch (error) { cleanupError ??= error; }
    if (cleanupError) throw new AggregateError([primaryError, cleanupError].filter(Boolean), 'persistent CLI integration cleanup failed');
  }
});

test('persistent CLI fails safely without its explicit database URL and never prints credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oh-persistent-cli-missing-db-'));
  const fixture = await startChatFixture();
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, COMPANION_CHAT_API_URL: fixture.baseUrl, COMPANION_CHAT_API_KEY: 'sk-private-test-value', COMPANION_CHAT_MODEL: 'fixture' };
    delete env.COMPANION_DATABASE_URL;
    const result = await runPersistentCli(env, join(root, 'profile.json'), 'not sent');
    assert.equal(result.code, 1);
    assert.ok(result.stdout.endsWith('error: database_not_configured\n'));
    assert.equal(result.stderr, '');
    assert.ok(!`${result.stdout}${result.stderr}`.includes('sk-private-test-value'));
    assert.equal(fixture.calls.length, 0);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
