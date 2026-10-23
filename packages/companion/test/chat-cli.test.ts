import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startChatFixture } from './chat-fixture.js';

const cliPath = fileURLToPath(new URL('../src/cli/chat.ts', import.meta.url));

type CliRun = { code: number | null; stdout: string; stderr: string };

function runCli(env: Record<string, string | undefined>, stdin: string, args: readonly string[] = []): Promise<CliRun> {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return spawnCli(merged, args, (child) => child.stdin.end(stdin));
}

function spawnCli(
  env: NodeJS.ProcessEnv,
  args: readonly string[],
  drive?: (child: ChildProcessWithoutNullStreams) => void,
): Promise<CliRun> {
  const child = spawn(process.execPath, ['--import', 'tsx', cliPath, ...args], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  drive?.(child);
  return new Promise<CliRun>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not exit; stdout=${stdout} stderr=${stderr}`));
    }, 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

const emptyChatEnv = {
  COMPANION_CHAT_API_URL: undefined,
  COMPANION_CHAT_API_KEY: undefined,
  COMPANION_CHAT_MODEL: undefined,
  DEEPSEEK_API_KEY: undefined,
  AI_BASE_URL: undefined,
  AI_API_KEY: undefined,
  AI_MODEL: undefined,
};

test('terminal chat fails closed with a stable code when business chat is unconfigured', async () => {
  const result = await runCli(emptyChatEnv, 'hello\n');
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, 'error: model_not_configured\n');
});

test('terminal chat does not borrow coding-agent credentials for business chat', async () => {
  const result = await runCli(
    {
      ...emptyChatEnv,
      DEEPSEEK_API_KEY: 'coding-only-secret',
      AI_BASE_URL: 'http://127.0.0.1:1/v1',
      AI_MODEL: 'coding-model',
    },
    'hello\n',
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'error: model_not_configured\n');
  assert.ok(!`${result.stdout}${result.stderr}`.includes('coding-only-secret'));
});

function chatEnv(baseUrl: string, secret: string): Record<string, string> {
  return {
    COMPANION_CHAT_API_URL: baseUrl,
    COMPANION_CHAT_API_KEY: secret,
    COMPANION_CHAT_MODEL: 'fixture-model-under-test',
  };
}

test('terminal chat replays the configured system prompt on the first request', async () => {
  const secret = 'sk-terminal-fixture-secret';
  const fixture = await startChatFixture({ reply: '收到，我在。' });
  try {
    const result = await runCli(chatEnv(fixture.baseUrl, secret), '你好\n', ['--system', 'stable persona']);
    assert.equal(result.code, 0, `stderr=${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.includes('bot> 收到，我在。'));
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret), 'terminal output must not leak the API key');
    assert.equal(fixture.calls.length, 1);
    const firstBody = fixture.calls[0].body as { messages: Array<{ role: string; content: string }> };
    assert.deepEqual(firstBody.messages, [
      { role: 'system', content: 'stable persona' },
      { role: 'user', content: '你好' },
    ]);
    assert.equal(fixture.calls[0].headers.authorization, `Bearer ${secret}`);
  } finally {
    await fixture.close();
  }
});

test('terminal chat carries assistant history into the next request', async () => {
  const secret = 'sk-terminal-history-secret';
  const fixture = await startChatFixture({ reply: ({ index }) => (index === 0 ? '收到，我在。' : '第二轮回复') });
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(emptyChatEnv)) delete env[key];
    Object.assign(env, chatEnv(fixture.baseUrl, secret));
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, '--max-turns', '2'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.write('你好\n');
    const deadline = Date.now() + 10_000;
    while (fixture.calls.length < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(fixture.calls.length, 1, `first turn was not sent; stdout=${stdout} stderr=${stderr}`);
    child.stdin.write('今天怎么样\n');
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`CLI did not exit; stdout=${stdout} stderr=${stderr}`));
      }, 10_000);
      child.once('error', reject);
      child.once('exit', (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });
    assert.equal(code, 0, `stderr=${stderr}`);
    assert.equal(fixture.calls.length, 2);
    const secondBody = fixture.calls[1].body as { messages: Array<{ role: string; content: string }> };
    assert.deepEqual(secondBody.messages.slice(0, 2), [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '收到，我在。' },
    ]);
    assert.equal(secondBody.messages[2]?.role, 'user');
    assert.ok(stdout.includes('bot> 第二轮回复'));
    assert.ok(!`${stdout}${stderr}`.includes(secret));
  } finally {
    await fixture.close();
  }
});

test('terminal chat stops at --max-turns and reports provider errors without leaking the key', async () => {
  const secret = 'sk-terminal-error-secret';
  const fixture = await startChatFixture({ status: 401, errorBody: { error: { message: `echo ${secret}` } } });
  try {
    const merged: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(emptyChatEnv)) delete merged[key];
    Object.assign(merged, chatEnv(fixture.baseUrl, secret));
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, '--max-turns', '3'], {
      env: merged,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.write('hello\n');
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`CLI did not exit; stdout=${stdout} stderr=${stderr}`));
      }, 10_000);
      child.once('error', reject);
      child.once('exit', (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });
    assert.equal(code, 1);
    assert.equal(fixture.calls.length, 1);
    assert.equal(stdout.includes('bot>'), false);
    assert.ok(stdout.includes('error: model_unauthorized'));
    assert.ok(!`${stdout}${stderr}`.includes(secret));
    assert.equal(fixture.calls[0].headers.authorization, `Bearer ${secret}`);
  } finally {
    await fixture.close();
  }
});

test('terminal chat stops cleanly once --max-turns requests complete', async () => {
  const secret = 'sk-terminal-max-turns-secret';
  const fixture = await startChatFixture();
  try {
    const merged: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(emptyChatEnv)) delete merged[key];
    Object.assign(merged, chatEnv(fixture.baseUrl, secret));
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, '--max-turns', '1'], {
      env: merged,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.stdin.write('one\n');
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('CLI did not stop after reaching --max-turns'));
      }, 10_000);
      child.once('error', reject);
      child.once('exit', (exitCode) => {
        clearTimeout(timeout);
        resolve(exitCode);
      });
    });
    assert.equal(code, 0);
    assert.equal(fixture.calls.length, 1);
    assert.ok(stdout.includes('bot> fixture reply'));
  } finally {
    await fixture.close();
  }
});

test('terminal chat fails before listening when the business chat key is a placeholder', async () => {
  const result = await runCli(
    {
      ...emptyChatEnv,
      COMPANION_CHAT_API_URL: 'http://127.0.0.1:1/v1',
      COMPANION_CHAT_API_KEY: 'REPLACE_WITH_REAL_BUSINESS_KEY',
      COMPANION_CHAT_MODEL: 'fixture-model',
    },
    'hello\n',
  );
  assert.equal(result.code, 1);
  assert.equal(result.stdout, 'error: model_not_configured\n');
});

test('terminal chat rejects bad arguments before contacting any provider', async () => {
  const result = await runCli(emptyChatEnv, '', ['--max-turns', '0']);
  assert.equal(result.code, 2);
  assert.ok(result.stdout.startsWith('usage: '));
  assert.equal(result.stderr, '');
});

test('terminal chat prints usage for --help without requiring configuration', async () => {
  const result = await runCli(emptyChatEnv, '', ['--help']);
  assert.equal(result.code, 0);
  assert.ok(result.stdout.includes('COMPANION_CHAT_API_KEY'));
  assert.ok(result.stdout.includes('COMPANION_CHAT_MODEL'));
  assert.equal(result.stderr, '');
});
