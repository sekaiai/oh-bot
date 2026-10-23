import { createServer, type Server } from 'node:http';

export async function startProtocolFixture(options: { embeddingError?: string; chatFact?: string } = {}): Promise<{ server: Server; baseUrl: string; calls: { chat: number; embeddings: number; dimensions?: number; encodingFormat?: string } }> {
  const calls: { chat: number; embeddings: number; dimensions?: number; encodingFormat?: string } = { chat: 0, embeddings: 0 };
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/embeddings')) {
      calls.embeddings++;
      if (options.embeddingError) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: { message: options.embeddingError } }));
        return;
      }
      const { input, dimensions, encoding_format: encodingFormat } = JSON.parse(body);
      calls.dimensions = dimensions;
      calls.encodingFormat = encodingFormat;
      const vector = Array.from({ length: dimensions ?? 8 }, (_, index) => (index + 1) / 10);
      const items = (Array.isArray(input) ? input : [input]).map((_: string, index: number) => ({ object: 'embedding', index, embedding: vector }));
      response.end(JSON.stringify({ object: 'list', data: items, model: 'fixture-embedding', usage: { prompt_tokens: 1, total_tokens: 1 } }));
      return;
    }
    if (request.url?.endsWith('/chat/completions')) {
      calls.chat++;
      response.end(JSON.stringify({ id: 'fixture-chat', object: 'chat.completion', created: 0, model: 'fixture-chat', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ memory: [{ id: '0', text: options.chatFact ?? '用户喜欢清晨喝热茶。', attributed_to: 'user', linked_memory_ids: [] }] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: { message: 'unknown fixture endpoint' } }));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1`, calls };
}
