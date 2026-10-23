import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatCompletionsUrl } from '../src/models/chat-gateway.js';

test('endpoint resolution keeps explicit chat completions paths and appends once to base URLs', () => {
  const cases: Array<[string, string]> = [
    ['https://api.example.com/v1', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com', 'https://api.example.com/chat/completions'],
    ['https://api.example.com/v1/chat/completions', 'https://api.example.com/v1/chat/completions'],
    ['https://api.example.com/v1/chat/completions/', 'https://api.example.com/v1/chat/completions'],
  ];
  for (const [input, expected] of cases) {
    const url = resolveChatCompletionsUrl(input);
    assert.ok(url, input);
    assert.equal(url.href, expected, input);
    assert.equal(url.search, '');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
  }
  for (const input of ['ftp://api.example.com/v1', 'api.example.com/v1', 'https://user:pass@api.example.com/v1', 'https://api.example.com/v1?key=x', 'https://api.example.com/v1#frag']) {
    assert.equal(resolveChatCompletionsUrl(input), undefined, input);
  }
});
