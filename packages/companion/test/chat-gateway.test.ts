import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chatRequestSchema,
  createChatGatewayFromEnv,
  loadChatProviderConfig,
  ModelGatewayError,
  OpenAiCompatibleChatGateway,
} from '../src/models/chat-gateway.js';
import { startChatFixture } from './chat-fixture.js';

const secret = 'sk-business-chat-secret-value';

function envWith(baseUrl: string, overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    COMPANION_CHAT_API_URL: baseUrl,
    COMPANION_CHAT_API_KEY: secret,
    COMPANION_CHAT_MODEL: 'fixture-model-under-test',
    ...overrides,
  } as NodeJS.ProcessEnv;
}

function assertGatewayError(error: unknown, code: string): void {
  assert.ok(error instanceof ModelGatewayError, `expected ModelGatewayError, got ${String(error)}`);
  assert.equal(error.code, code);
  assert.ok(!error.message.includes(secret));
}

function gatewayFor(baseUrl: string, extra: Partial<{ defaultTimeoutMs: number }> = {}) {
  return new OpenAiCompatibleChatGateway({ config: loadChatProviderConfig(envWith(baseUrl)), ...extra });
}

test('missing business chat credentials fail explicitly and never fall back to other secrets', () => {
  const codingOnly: NodeJS.ProcessEnv = {
    DEEPSEEK_API_KEY: 'coding-agent-key-must-not-be-used',
    AI_BASE_URL: 'https://coding.example.com/v1',
    AI_MODEL: 'coding-model',
  };
  assert.throws(() => loadChatProviderConfig(codingOnly), (error) => (error instanceof ModelGatewayError) && error.code === 'model_not_configured');
  assert.throws(
    () => loadChatProviderConfig(envWith('http://127.0.0.1:1/v1', { COMPANION_CHAT_API_KEY: '' })),
    (error) => (error instanceof ModelGatewayError) && error.code === 'model_not_configured',
  );
  assert.throws(
    () => loadChatProviderConfig(envWith('http://127.0.0.1:1/v1', { COMPANION_CHAT_MODEL: '<set-model>' })),
    (error) => (error instanceof ModelGatewayError) && error.code === 'model_not_configured',
  );
  assert.throws(
    () => loadChatProviderConfig(envWith('http://127.0.0.1:1/v1', { COMPANION_CHAT_API_KEY: 'REPLACE_WITH_REAL_KEY' })),
    (error) => (error instanceof ModelGatewayError) && error.code === 'model_not_configured',
  );
  assert.throws(
    () => loadChatProviderConfig(envWith('http://127.0.0.1:1/v1', { COMPANION_CHAT_MODEL: 'YOUR_MODEL_ID' })),
    (error) => (error instanceof ModelGatewayError) && error.code === 'model_not_configured',
  );
  assert.throws(
    () => loadChatProviderConfig(envWith('http://127.0.0.1:1/v1', { COMPANION_CHAT_API_URL: '   ' })),
    (error) => (error instanceof ModelGatewayError) && error.code === 'model_not_configured',
  );
});

test('invalid endpoints and embedded URL credentials are rejected distinctly', () => {
  for (const url of [
    'ftp://example.com/v1',
    'not-a-url',
    'http://user:password@127.0.0.1/v1',
    'http://127.0.0.1/v1?api_key=leak',
  ]) {
    assert.throws(
      () => loadChatProviderConfig(envWith(url)),
      (error) => (error instanceof ModelGatewayError) && error.code === 'model_invalid_config',
      url,
    );
  }
});

test('gateway posts OpenAI-compatible chat completions with only the explicit messages and bearer auth', async () => {
  const fixture = await startChatFixture({ reply: '你好，这是 fixture 回复。' });
  try {
    const gateway = gatewayFor(fixture.baseUrl);
    const reply = await gateway.complete({
      messages: [
        { role: 'system', content: 'stable persona' },
        { role: 'user', content: 'hello' },
      ],
      temperature: 0.3,
      maxTokens: 64,
    });
    assert.equal(reply.text, '你好，这是 fixture 回复。');
    assert.equal(reply.model, 'fixture-model-under-test');
    assert.equal(reply.finishReason, 'stop');
    assert.deepEqual(reply.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    assert.equal(fixture.calls.length, 1);
    const [call] = fixture.calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/v1/chat/completions');
    assert.equal(call.headers.authorization, `Bearer ${secret}`);
    assert.equal(call.headers['content-type'], 'application/json');
    assert.deepEqual(call.body, {
      model: 'fixture-model-under-test',
      messages: [
        { role: 'system', content: 'stable persona' },
        { role: 'user', content: 'hello' },
      ],
      stream: false,
      temperature: 0.3,
      max_tokens: 64,
    });
    const serialized = JSON.stringify(call.body);
    assert.ok(!serialized.includes(secret), 'request body must not embed the API key');
  } finally {
    await fixture.close();
  }
});

test('explicit /chat/completions endpoints are used verbatim and base URLs get the suffix once', async () => {
  const fixture = await startChatFixture();
  try {
    const explicit = new OpenAiCompatibleChatGateway({
      config: loadChatProviderConfig(envWith(`${fixture.baseUrl}/chat/completions`)),
    });
    await explicit.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const trailing = new OpenAiCompatibleChatGateway({
      config: loadChatProviderConfig(envWith(`${fixture.baseUrl}/`)),
    });
    await trailing.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.deepEqual(
      fixture.calls.map((call) => call.path),
      ['/v1/chat/completions', '/v1/chat/completions'],
    );
    assert.deepEqual(Object.keys(explicit.target).sort(), ['host', 'model', 'path']);
    assert.ok(!JSON.stringify(explicit.target).includes(secret));
    assert.equal(Object.values(explicit.target).includes(secret), false);
    assert.equal(explicit.target.model, 'fixture-model-under-test');
  } finally {
    await fixture.close();
  }
});

test('gateway classifies HTTP failures without leaking provider error text', async () => {
  const cases: Array<[number, string]> = [
    [401, 'model_unauthorized'],
    [403, 'model_unauthorized'],
    [429, 'model_rate_limited'],
    [500, 'model_upstream_error'],
  ];
  for (const [status, code] of cases) {
    const fixture = await startChatFixture({ status, errorBody: { error: { message: `upstream echo ${secret}` } } });
    try {
      const gateway = gatewayFor(fixture.baseUrl);
      await assert.rejects(
        gateway.complete({ messages: [{ role: 'user', content: 'hi' }] }),
        (error) => {
          assertGatewayError(error, code);
          return true;
        },
      );
    } finally {
      await fixture.close();
    }
  }
});

test('gateway rejects malformed completions and empty content', async () => {
  const invalid = await startChatFixture({ invalidJson: true });
  try {
    await assert.rejects(gatewayFor(invalid.baseUrl).complete({ messages: [{ role: 'user', content: 'hi' }] }), (error) => {
      assertGatewayError(error, 'model_invalid_response');
      return true;
    });
  } finally {
    await invalid.close();
  }
  const empty = await startChatFixture({ reply: '   ' });
  try {
    await assert.rejects(gatewayFor(empty.baseUrl).complete({ messages: [{ role: 'user', content: 'hi' }] }), (error) => {
      assertGatewayError(error, 'model_invalid_response');
      return true;
    });
  } finally {
    await empty.close();
  }
});

test('gateway reports timeouts, unreachable hosts, and refuses redirects without leaking secrets', async () => {
  const slow = await startChatFixture({ delayMs: 250 });
  try {
    const gateway = gatewayFor(slow.baseUrl, { defaultTimeoutMs: 60 });
    const startedAt = Date.now();
    await assert.rejects(gateway.complete({ messages: [{ role: 'user', content: 'hi' }] }), (error) => {
      assertGatewayError(error, 'model_timeout');
      return true;
    });
    assert.ok(Date.now() - startedAt < 2000);
  } finally {
    await slow.close();
  }

  await assert.rejects(
    new OpenAiCompatibleChatGateway({ config: loadChatProviderConfig(envWith('http://127.0.0.1:1/v1')) }).complete({
      messages: [{ role: 'user', content: 'hi' }],
    }),
    (error) => {
      assertGatewayError(error, 'model_unreachable');
      return true;
    },
  );

  const redirecting = await startChatFixture({ status: 302, location: 'http://127.0.0.1:1/v1/chat/completions' });
  try {
    await assert.rejects(
      gatewayFor(redirecting.baseUrl).complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (error) => {
        assertGatewayError(error, 'model_invalid_config');
        return true;
      },
    );
    assert.equal(redirecting.calls.length, 1, 'redirect must not be followed to another host');
  } finally {
    await redirecting.close();
  }
});

test('gateway refuses a 3xx redirect without following it to the location target', async () => {
  const target = await startChatFixture({ reply: 'must not be reached' });
  const redirecting = await startChatFixture({
    status: 302,
    location: `${target.baseUrl}/chat/completions`,
  });
  try {
    await assert.rejects(
      gatewayFor(redirecting.baseUrl).complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (error) => {
        assertGatewayError(error, 'model_invalid_config');
        return true;
      },
    );
    assert.equal(redirecting.calls.length, 1, 'the redirect response was not followed');
    assert.equal(target.calls.length, 0, 'the redirect location must never be contacted');
  } finally {
    await redirecting.close();
    await target.close();
  }
});

test('request validation is strict and rejects unknown fields and oversized payloads', () => {
  assert.equal(chatRequestSchema.safeParse({ messages: [{ role: 'user', content: 'hi' }] }).success, true);
  assert.equal(chatRequestSchema.safeParse({ messages: [{ role: 'user', content: '' }] }).success, false);
  assert.equal(chatRequestSchema.safeParse({ messages: [] }).success, false);
  assert.equal(chatRequestSchema.safeParse({ messages: [{ role: 'tool', content: 'hi' }] }).success, false);
  assert.equal(chatRequestSchema.safeParse({ messages: [{ role: 'user', content: 'hi' }], surprise: true }).success, false);
  assert.equal(
    chatRequestSchema.safeParse({ messages: [{ role: 'user', content: 'x'.repeat(32001) }] }).success,
    false,
  );
});

test('createChatGatewayFromEnv wires the injected fetch and fails closed on missing config', async () => {
  const fixture = await startChatFixture({ reply: 'wired' });
  try {
    const gateway = createChatGatewayFromEnv(envWith(fixture.baseUrl));
    const reply = await gateway.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(reply.text, 'wired');
    assert.equal(fixture.calls.length, 1);
  } finally {
    await fixture.close();
  }
  assert.throws(
    () => createChatGatewayFromEnv({ COMPANION_CHAT_API_URL: 'http://127.0.0.1:1/v1' }),
    (error) => (error instanceof ModelGatewayError) && error.code === 'model_not_configured',
  );
});
