import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runIsolatedCheck} from './controller.mjs';
test('generated test cannot access host controller, credentials or original source',t=>{
  const root=mkdtempSync(join(tmpdir(),'oh-bot-isolation-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const snapshot=join(root,'snapshot');mkdirSync(snapshot);
  const sentinel=join(root,'controller.mjs');writeFileSync(sentinel,'trusted');
  const source=join(root,'original.ts');writeFileSync(source,'original');
  writeFileSync(join(snapshot,'candidate.ts'),'candidate');
  const script=join(root,'check.sh');
  writeFileSync(script,"node <<'JS'\n"+
    "const fs=require('node:fs'),assert=require('node:assert/strict');\n"+
    "assert.equal(process.env.GH_TOKEN,undefined);\n"+
    "assert.equal(process.env.DEEPSEEK_API_KEY,undefined);\n"+
    "assert.equal(fs.existsSync("+JSON.stringify(sentinel)+"),false);\n"+
    "assert.equal(fs.existsSync('/control/.github/codex/controller.mjs'),false);\n"+
    "assert.throws(()=>fs.writeFileSync('/trusted-check.sh','replaced'),/EROFS|EACCES/);\n"+
    "fs.writeFileSync('/app/candidate.ts','untrusted test changed copy');\n"+
    "console.log('ISOLATION_OK');\nJS\n");
  const oldToken=process.env.GH_TOKEN,oldKey=process.env.DEEPSEEK_API_KEY;
  process.env.GH_TOKEN='fake-test-token';process.env.DEEPSEEK_API_KEY='fake-test-key';
  try {assert.match(runIsolatedCheck(snapshot,script),/ISOLATION_OK/);} finally {
    if(oldToken===undefined) delete process.env.GH_TOKEN;else process.env.GH_TOKEN=oldToken;
    if(oldKey===undefined) delete process.env.DEEPSEEK_API_KEY;else process.env.DEEPSEEK_API_KEY=oldKey;
  }
  assert.equal(readFileSync(sentinel,'utf8'),'trusted');
  assert.equal(readFileSync(source,'utf8'),'original');
});
