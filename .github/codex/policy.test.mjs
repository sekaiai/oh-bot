import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from './policy.mjs';

test("allows companion source", () => assert.equal((p=>p.allowedPath("packages/companion/src/memory/gateway.ts")===true)(p), true));
test("rejects workflow changes", () => assert.equal((p=>p.allowedPath(".github/workflows/unattended-codex.yml")===false)(p), true));
test("rejects controller changes", () => assert.equal((p=>p.allowedPath("scripts/unattended-check.sh")===false)(p), true));
test("rejects secrets and traversal", () => assert.equal((p=>["packages/x/.env","packages/../.github/x","/tmp/a","packages/x/../../x","packages\\x\\a"].every(x=>!p.allowedPath(x)))(p), true));
test("rejects task self-completion", () => assert.equal((p=>!p.allowedPath("docs/implementation/unattended-tasks.md"))(p), true));
test("blocks package-script bypass", () => assert.equal((p=>{try{p.assertManifest({name:"x",scripts:{test:"tsx --test"}},{name:"x",scripts:{test:"true"}});return false}catch(e){return e.message==="Existing package scripts changed"}})(p), true));
test("allows pinned dependency update", () => assert.equal((p=>{p.assertManifest({name:"x",scripts:{test:"run"},dependencies:{x:"1.0.0"}},{name:"x",scripts:{test:"run"},dependencies:{x:"1.0.1"}});return true})(p), true));
test("rejects malformed review", () => assert.equal((p=>!p.reviewApproved({approved:true}))(p), true));
test("rejects important finding", () => assert.equal((p=>!p.reviewApproved({approved:true,findings:[{severity:"important",message:"ACL bypass"}]}))(p), true));
test("allows clean review", () => assert.equal((p=>p.reviewApproved({approved:true,findings:[]}))(p), true));
test("rejects unknown severity", () => assert.equal((p=>!p.reviewApproved({approved:true,findings:[{severity:"whatever",message:"x"}]}))(p), true));
test("selects first unfinished task", () => assert.equal((p=>p.selectTask("- [x] F4a：已完成\n- [ ] F4b：下一步\n- [ ] F4c：稍后").id==="F4b")(p), true));
test("idles completed backlog", () => assert.equal((p=>p.selectTask("- [x] F4a：已完成")===null)(p), true));
test("never publishes failed verification", () => assert.equal((p=>p.publicationTarget({safe:true,changed:true,verified:false,reviewed:true,baseline:"a",current:"a"})==="retry")(p), true));
test("never publishes stale verification", () => assert.equal((p=>p.publicationTarget({safe:true,changed:true,verified:true,reviewed:true,baseline:"a",current:"b"})==="retry")(p), true));
test("publishes only verified current base", () => assert.equal((p=>p.publicationTarget({safe:true,changed:true,verified:true,reviewed:true,baseline:"a",current:"a"})==="target")(p), true));
test("does not persist forbidden changes", () => assert.equal((p=>p.publicationTarget({safe:false,changed:true,verified:true,reviewed:true,baseline:"a",current:"a"})==="none")(p), true));
test("test feedback includes stdout", () => assert.equal((p=>p.errorFeedback({stdout:'Assertion failed',stderr:''},{})==='Assertion failed')(p), true));
test("test feedback redacts secrets", () => assert.equal((p=>p.errorFeedback({stdout:'key=secret-value',stderr:'bad'},{DEEPSEEK_API_KEY:'secret-value'}).includes('[REDACTED]'))(p), true));
test("retry restores only trusted task checkbox", () => assert.equal((p=>p.retryBacklog('- [x] F4b：work\n- [ ] F4c：next',{line:'- [ ] F4b：work'})==='- [ ] F4b：work\n- [ ] F4c：next')(p), true));

test("F4b changes stay inside compatibility package and progress", () => assert.equal((p =>
  p.taskPathAllowed({id:"F4b"}, "packages/compatibility/src/history-deletion.ts")
  && p.taskPathAllowed({id:"F4b"}, "docs/implementation/progress.md")
  && p.taskPathAllowed({id:"F4b"}, "docs/implementation/unattended-retry-feedback.md")
  && !p.taskPathAllowed({id:"F4b"}, "packages/companion/src/worker.ts")
  && !p.taskPathAllowed({id:"F4b"}, "packages/companion/admin/src/App.vue")
)(p), true));

test('MVP task is prioritized ahead of deferred legacy tasks', () => {
  const backlog = '- [x] F4a：done\n- [ ] M1a：first usable chat\n- [ ] F4b：deferred SDK adapter';
  assert.equal(p.selectTask(backlog)?.id,'M1a');
});
test('M1a cannot edit unrelated app, automation or compatibility package', () => {
  const task={id:'M1a'};
  assert.equal(p.taskPathAllowed(task,'packages/companion/src/chat/model-gateway.ts'),true);
  assert.equal(p.taskPathAllowed(task,'packages/companion/test/chat.test.ts'),true);
  assert.equal(p.taskPathAllowed(task,'docs/implementation/progress.md'),true);
  assert.equal(p.taskPathAllowed(task,'src/index.ts'),false);
  assert.equal(p.taskPathAllowed(task,'packages/compatibility/src/config.ts'),false);
  assert.equal(p.taskPathAllowed(task,'.github/workflows/unattended-codex.yml'),false);
});
test('M2b may integrate compatibility memory but M3a may not', () => {
  assert.equal(p.taskPathAllowed({id:'M2b'},'packages/compatibility/src/memory-worker.ts'),true);
  assert.equal(p.taskPathAllowed({id:'M3a'},'packages/compatibility/src/memory-worker.ts'),false);
});

test('parallel persona worker cannot edit chat, schema or channel adapter',()=>{
  assert.equal(p.taskPathAllowed({id:'P1'},'packages/companion/src/persona/service.ts'),true);
  assert.equal(p.taskPathAllowed({id:'P1'},'packages/companion/test/persona-service.test.ts'),true);
  assert.equal(p.taskPathAllowed({id:'P1'},'packages/companion/src/cli/chat.ts'),false);
  assert.equal(p.taskPathAllowed({id:'P1'},'packages/companion/src/database/schema/identity.ts'),false);
  assert.equal(p.taskPathAllowed({id:'P1'},'packages/companion/src/channels/onebot/adapter.ts'),false);
  assert.equal(p.taskPathAllowed({id:'P1'},'docs/implementation/progress.md'),false);
});
test('parallel OneBot worker cannot edit persona, identity or trusted controller',()=>{
  assert.equal(p.taskPathAllowed({id:'Q1'},'packages/companion/src/channels/onebot/adapter.ts'),true);
  assert.equal(p.taskPathAllowed({id:'Q1'},'packages/companion/test/onebot-protocol.test.ts'),true);
  assert.equal(p.taskPathAllowed({id:'Q1'},'packages/companion/src/persona/service.ts'),false);
  assert.equal(p.taskPathAllowed({id:'Q1'},'packages/companion/src/identity/trust.ts'),false);
  assert.equal(p.taskPathAllowed({id:'Q1'},'.github/codex/controller.mjs'),false);
});
