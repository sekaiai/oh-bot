import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {guard,requestReviewWithFallback} from './controller.mjs';
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

test('review outage may use a clearly labelled second pass to an already authorized coding provider',async()=>{
  const apis={coding:{baseUrl:'https://code.example.com/v1',model:'coder'},review:{baseUrl:'https://review.example.com/v1',model:'reviewer'}};
  const calls=[];
  const request=async(api,messages,params)=>{
    calls.push({api,messages,params});
    if(api===apis.review) throw new Error('Configured model API HTTP 404');
    return '{"approved":true,"findings":[]}';
  };
  const messages=[{role:'user',content:'source diff'}],params={temperature:0};
  const result=await requestReviewWithFallback(apis,messages,params,request,true);
  assert.equal(result.mode,'coding-provider-second-pass');
  assert.deepEqual(calls.map(x=>x.api),[apis.review,apis.coding]);
  assert.deepEqual(calls[1].messages,messages);
  assert.deepEqual(calls[1].params,params);
});
test('review fallback is opt-in and never hides authentication errors',async()=>{
  const apis={coding:{baseUrl:'https://code.example.com/v1',model:'coder'},review:{baseUrl:'https://review.example.com/v1',model:'reviewer'}};
  let calls=0;
  await assert.rejects(()=>requestReviewWithFallback(apis,[],{},async()=>{calls++;throw new Error('Configured model API HTTP 404');},false),/HTTP 404/);
  assert.equal(calls,1);
  calls=0;
  await assert.rejects(()=>requestReviewWithFallback(apis,[],{},async()=>{calls++;throw new Error('Configured model API HTTP 401');},true),/HTTP 401/);
  assert.equal(calls,1);
});
test('review fallback is disabled when the coding and review model are identical',async()=>{
  const same={baseUrl:'https://same.example.com/v1',model:'same'};
  let calls=0;
  await assert.rejects(()=>requestReviewWithFallback({coding:same,review:same},[],{},async()=>{calls++;throw new Error('Configured model API HTTP 404');},true),/HTTP 404/);
  assert.equal(calls,1);
});
