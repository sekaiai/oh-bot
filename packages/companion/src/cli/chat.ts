import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  loadChatProviderConfig,
  ModelGatewayError,
  OpenAiCompatibleChatGateway,
  type ChatMessage,
  type ChatReply,
} from '../models/chat-gateway.js';
import { createDatabase, loadDatabaseConfig } from '../database/database.js';
import { IdentityService } from '../identity/identity-service.js';
import { createVerifiedChannelEvidence } from '../identity/trust.js';
import { LocalChatSessionService } from '../conversations/chat-session-service.js';
import { LocalChatService } from '../conversations/local-chat-service.js';
import { loadOrCreateLocalProfile, ensureLocalCharacter } from './local-profile.js';
import { CompanionError } from '../transactions/errors.js';

const USAGE = [
  'usage: pnpm exec tsx packages/companion/src/cli/chat.ts [--persistent] [--session-file <path>] [--system <text>] [--max-turns <n>] [--temperature <n>] [--verbose]',
  '',
  'Local development terminal chat for the companion model gateway.',
  'Requires explicit business chat configuration:',
  '  COMPANION_CHAT_API_URL   OpenAI-compatible base URL or /chat/completions endpoint',
  '  COMPANION_CHAT_API_KEY   provider API key (never printed)',
  '  COMPANION_CHAT_MODEL     provider model name',
  'Persistent mode also requires COMPANION_DATABASE_URL and an explicit prior `pnpm --dir packages/companion db:migrate`.',
].join('\n');

type CliOptions = {
  system?: string;
  maxTurns?: number;
  temperature?: number;
  verbose: boolean;
  persistent: boolean;
  sessionFile?: string;
};

const MAX_MESSAGE_CHARS = 32_000;

class UsageError extends Error {}

function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  const options: CliOptions = { verbose: false, persistent: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--help':
      case '-h':
        return 'help';
      case '--verbose':
        options.verbose = true;
        break;
      case '--persistent':
        options.persistent = true;
        break;
      case '--session-file': {
        const value = argv[++index];
        if (!value || value.length > 4096) throw new UsageError();
        options.sessionFile = value;
        break;
      }
      case '--system': {
        const value = argv[++index];
        if (value === undefined || value.length === 0 || value.length > MAX_MESSAGE_CHARS) throw new UsageError();
        options.system = value;
        break;
      }
      case '--max-turns': {
        const value = argv[++index];
        const parsed = value === undefined ? NaN : Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new UsageError();
        options.maxTurns = parsed;
        break;
      }
      case '--temperature': {
        const value = argv[++index];
        const parsed = value === undefined ? NaN : Number(value);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) throw new UsageError();
        options.temperature = parsed;
        break;
      }
      default:
        throw new UsageError();
    }
  }
  return options;
}

function failureCode(error: unknown): string {
  if (error instanceof ModelGatewayError) return error.code;
  if (error instanceof CompanionError) return error.code;
  return 'chat_terminal_failed';
}

function printFailure(error: unknown): void {
  output.write(`error: ${failureCode(error)}\n`);
}

async function main(): Promise<number> {
  let options: CliOptions | 'help';
  try {
    options = parseArgs(process.argv.slice(2));
  } catch {
    output.write(`${USAGE}\n`);
    return 2;
  }
  if (options === 'help') {
    output.write(`${USAGE}\n`);
    return 0;
  }

  let gateway: OpenAiCompatibleChatGateway;
  try {
    gateway = new OpenAiCompatibleChatGateway({ config: loadChatProviderConfig(process.env) });
  } catch (error) {
    printFailure(error);
    return 1;
  }

  const target = gateway.target;
  output.write(`model: ${target.model} @ ${target.host}${target.path}\n`);
  output.write('type /exit to quit\n');

  const messages: ChatMessage[] = [];
  if (options.system) messages.push({ role: 'system', content: options.system });

  let database: ReturnType<typeof createDatabase> | undefined;
  let localChat: LocalChatService | undefined;
  let profile: Awaited<ReturnType<typeof loadOrCreateLocalProfile>> | undefined;
  let evidence: ReturnType<typeof createVerifiedChannelEvidence> | undefined;
  if (options.persistent) {
    try {
      profile = await loadOrCreateLocalProfile(resolve(options.sessionFile ?? '.local/companion-profile.json'));
      database = createDatabase(loadDatabaseConfig(process.env).databaseUrl);
      await ensureLocalCharacter(database, profile);
      const identity = new IdentityService(database);
      localChat = new LocalChatService(new LocalChatSessionService(database, identity), database, gateway);
      evidence = createVerifiedChannelEvidence('qq', profile.channelId, profile.userId, 'private');
    } catch (error) {
      if (database) await database.close().catch(() => undefined);
      const code = error instanceof Error && ['local_profile_invalid', 'local_profile_unavailable'].includes(error.message)
        ? error.message : process.env.COMPANION_DATABASE_URL ? 'persistent_chat_unavailable' : 'database_not_configured';
      output.write(`error: ${code}\n`);
      return 1;
    }
  }
  const terminal = createInterface({ input, output });
  let turns = 0;
  try {
    while (options.maxTurns === undefined || turns < options.maxTurns) {
      let line: string;
      try {
        line = await terminal.question('you> ');
      } catch {
        break;
      }
      const text = line.trim();
      if (text === '') continue;
      if (text === '/exit' || text === '/quit') break;
      if (text.length > MAX_MESSAGE_CHARS) {
        output.write(`error: message_too_long (max ${MAX_MESSAGE_CHARS} characters)\n`);
        continue;
      }
      let reply: ChatReply;
      try {
        if (localChat && profile && evidence) {
          const result = await localChat.handle(profile.characterId, {
            platform: 'qq', eventId: `local-cli:event:${randomUUID()}`, senderPlatformId: profile.userId,
            conversationPlatformId: profile.channelId, conversationKind: 'private', text,
            timestamp: new Date().toISOString(), participantPlatformIds: [], participantsComplete: false,
          }, evidence, { ...(options.system === undefined ? {} : { system: options.system }), ...(options.temperature === undefined ? {} : { temperature: options.temperature }) });
          reply = { text: result.text, model: target.model, finishReason: null, usage: null };
        } else {
          messages.push({ role: 'user', content: text });
          reply = await gateway.complete({ messages, ...(options.temperature === undefined ? {} : { temperature: options.temperature }) });
          messages.push({ role: 'assistant', content: reply.text });
        }
      } catch (error) {
        printFailure(error);
        return 1;
      }
      output.write(`bot> ${reply.text}\n`);
      if (options.verbose) {
        const usage = reply.usage
          ? `prompt=${reply.usage.promptTokens} completion=${reply.usage.completionTokens} total=${reply.usage.totalTokens}`
          : 'usage=unknown';
        output.write(`[${reply.model}] finish=${reply.finishReason ?? 'unknown'} ${usage}\n`);
      }
      turns += 1;
    }
    return 0;
  } finally {
    terminal.close();
    if (database) await database.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      output.write('error: chat_terminal_failed\n');
      process.exitCode = 1;
    },
  );
}
