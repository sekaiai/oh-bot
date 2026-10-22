import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {guard} from './controller.mjs';
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'oh-bot-automation-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  function git(...args) {return execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:'pipe'}).trim();}
  git('init','--quiet');git('config','user.email','automation-test@example.invalid');git('config','user.name','Automation Test');
  mkdirSync(join(dir,'packages','companion','src'),{recursive:true});
  writeFileSync(join(dir,'packages','companion','src','index.ts'),'export const value=1;\n');
  writeFileSync(join(dir,'package.json'),JSON.stringify({name:'test',scripts:{test:'node --test'}}));
  git('add','--all');git('commit','--quiet','-m','创建测试基线');
  const base=git('rev-parse','HEAD');
  return {dir,git,state:{baseline:base,sourceHead:base}};
}
test('guard inspects real new source files',t=>{
  const f=fixture(t);
  writeFileSync(join(f.dir,'packages','companion','src','new.ts'),'export const other=2;\n');
  assert.deepEqual(guard(f.state,f.dir),['packages/companion/src/new.ts']);
});
test('guard blocks added workflow before executing it',t=>{
  const f=fixture(t);mkdirSync(join(f.dir,'.github','workflows'),{recursive:true});
  writeFileSync(join(f.dir,'.github','workflows','bad.yml'),'bad');
  assert.throws(()=>guard(f.state,f.dir),/Protected path changed/);
});
test('guard blocks replacing actual package test command',t=>{
  const f=fixture(t);
  writeFileSync(join(f.dir,'package.json'),JSON.stringify({name:'test',scripts:{test:'true'}}));
  assert.throws(()=>guard(f.state,f.dir),/Existing package scripts changed/);
});
test('guard rejects source symlinks',t=>{
  const f=fixture(t);symlinkSync('/etc/passwd',join(f.dir,'packages','companion','src','secret.ts'));
  assert.throws(()=>guard(f.state,f.dir),/Symlink rejected/);
});
test('guard rejects agent-created git commit',t=>{
  const f=fixture(t);writeFileSync(join(f.dir,'packages','companion','src','index.ts'),'export const value=2;\n');
  f.git('add','--all');f.git('commit','--quiet','-m','越权测试提交');
  assert.throws(()=>guard(f.state,f.dir),/Agent changed git HEAD/);
});
