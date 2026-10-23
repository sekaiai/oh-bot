import test from 'node:test';
import assert from 'node:assert/strict';
import {laneDiffAllowed} from './parallel-integrator.mjs';

test('persona and OneBot have disjoint source ownership',()=>{
  assert.equal(laneDiffAllowed('P1',['packages/companion/src/persona/service.ts','packages/companion/test/persona-service.test.ts']),true);
  assert.equal(laneDiffAllowed('Q1',['packages/companion/src/channels/onebot/adapter.ts','packages/companion/test/onebot-protocol.test.ts']),true);
  assert.equal(laneDiffAllowed('P1',['packages/companion/src/channels/onebot/adapter.ts']),false);
  assert.equal(laneDiffAllowed('Q1',['packages/companion/src/persona/service.ts']),false);
});
test('integrator rejects empty or shared-file proposals',()=>{
  assert.equal(laneDiffAllowed('P1',[]),false);
  assert.equal(laneDiffAllowed('P1',['packages/companion/src/persona/service.ts','packages/companion/src/cli/chat.ts']),false);
  assert.equal(laneDiffAllowed('Q1',['packages/companion/src/channels/onebot/adapter.ts','.github/workflows/unattended-codex.yml']),false);
  assert.equal(laneDiffAllowed('Q1',['packages/companion/src/database/schema/operations.ts']),false);
});
