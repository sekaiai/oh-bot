import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIsolatedDatabase } from '../src/isolation.js';

test('shared database guard accepts only explicit compatibility database names', () => {
  assert.doesNotThrow(() => assertIsolatedDatabase('postgresql://user:password@localhost:5432/oh_bot_compat'));
  assert.throws(() => assertIsolatedDatabase('postgresql://user:password@127.0.0.1:1/production_db'), /must end with _compat/);
});
