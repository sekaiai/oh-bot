import { createChatGatewayFromEnv } from '../models/chat-gateway.js';

try {
  const gateway = createChatGatewayFromEnv(process.env);
  const reply = await gateway.complete({
    messages: [
      { role: 'system', content: 'Reply with exactly: companion-model-ok' },
      { role: 'user', content: 'Check that this explicitly configured business model profile can complete a request.' },
    ],
    timeoutMs: 15_000,
    maxTokens: 32,
  });
  process.stdout.write(`COMPANION_MODEL_SMOKE_OK model=${reply.model} response_chars=${reply.text.length}\n`);
} catch (error) {
  const code = error instanceof Error && /^model_[a-z_]+$/.test(error.message) ? error.message : 'model_smoke_failed';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
