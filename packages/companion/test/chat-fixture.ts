import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';

export type CapturedChatCall = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
};

export type ChatFixtureOptions = {
  reply?: string | ((call: { index: number; body: unknown }) => string);
  status?: number;
  errorBody?: unknown;
  invalidJson?: boolean;
  delayMs?: number;
  location?: string;
};

/**
 * Protocol fixture for OpenAI-compatible Chat Completions. It records exactly what
 * the gateway sent so tests can assert on the outgoing payload, headers, and path.
 */
export async function startChatFixture(options: ChatFixtureOptions = {}) {
  const calls: CapturedChatCall[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer({ keepAliveTimeout: 1 }, async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
    calls.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers, body });
    if (!request.url?.endsWith('/chat/completions')) {
      response.statusCode = 404;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ error: { message: 'unknown fixture endpoint' } }));
      return;
    }
    if (options.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    response.setHeader('content-type', 'application/json');
    if (options.status && options.status >= 300) {
      const status = options.status;
      response.statusCode = status;
      if (options.location) response.setHeader('location', options.location);
      response.end(JSON.stringify(options.errorBody ?? { error: { message: 'fixture failure' } }));
      return;
    }
    if (options.invalidJson) {
      response.end('not json');
      return;
    }
    const requested = body && typeof body === 'object' ? (body as { model?: unknown }).model : undefined;
    const model = typeof requested === 'string' || typeof requested === 'number' ? String(requested) : 'fixture-chat';
    const reply = typeof options.reply === 'function' ? options.reply({ index: calls.length - 1, body }) : options.reply;
    response.end(
      JSON.stringify({
        id: 'fixture-chat',
        object: 'chat.completion',
        created: 0,
        model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: reply ?? 'fixture reply' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    );
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close();
    throw new Error('chat fixture did not bind');
  }
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, calls, close };
}
