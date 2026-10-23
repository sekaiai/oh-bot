import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelProfileGateway, loadProfileCredential } from '../src/models/profile-gateway.js';
import { createServer } from 'node:http';
import { createModelPriceEstimators } from '../src/application/model-pricing.js';

test('profile credentials are selected only by the explicit credentialRef', async () => {
  const profile = { id:'00000000-0000-4000-8000-000000000011', characterId:'00000000-0000-4000-8000-000000000001', enabled:true, purpose:'chat' as const, provider:'openai' as const, baseUrl:'https://provider.test/v1', model:'m1', credentialRef:'CHAT_KEY', maxTokens:32, timeoutMs:500 };
  assert.equal(loadProfileCredential(profile, { CHAT_KEY:'selected', OPENAI_API_KEY:'wrong' }), 'selected');
  assert.throws(() => loadProfileCredential({...profile, credentialRef:'MISSING'}, { OPENAI_API_KEY:'fallback' }), /model_not_configured/);
  let seen: unknown;
  const gateway = new ModelProfileGateway([profile], { env:{ CHAT_KEY:'secret' }, estimateCost:()=>0.01, estimateMaxCost:()=>0.02, estimateMaxTokens:(_model,_messages,output)=>output, createModel:(config) => ({ invoke:async (messages, options) => { seen = {messages, options, config}; return {content:'ok', response_metadata:{model:'m1'}, usage_metadata:{input_tokens:2,output_tokens:1,total_tokens:3}}; }}) });
  const gatewayInput = {characterId:'00000000-0000-4000-8000-000000000001', purpose:'chat' as const, messages:[{role:'user' as const,content:'hi'}], budget:{maxSteps:1,maxToolCalls:1,maxTokens:32,maxCostUsd:0.1,timeoutMs:500}, signal:new AbortController().signal, tokensUsed:0,costUsdUsed:0,consume:()=>{}};
  const reply = await gateway.complete({profileId:'00000000-0000-4000-8000-000000000011', ...gatewayInput});
  assert.equal(reply.text,'ok');
  assert.equal((seen as any).config.apiKey,'secret');
  assert.equal((seen as any).messages[0].content,'hi');
});

test('profile timeout bounds an unresponsive provider and exposes no provider error text', async () => {
  const profile={id:'00000000-0000-4000-8000-000000000012',characterId:'00000000-0000-4000-8000-000000000001',enabled:true,purpose:'chat' as const,provider:'openai' as const,baseUrl:'https://provider.test/v1',model:'m2',credentialRef:'CHAT_KEY',maxTokens:32,timeoutMs:100};
  const gateway=new ModelProfileGateway([profile],{env:{CHAT_KEY:'secret'},estimateCost:()=>0.01,estimateMaxCost:()=>0.02,estimateMaxTokens:(_model,_messages,output)=>output,createModel:()=>({invoke:async()=>new Promise(()=>{})})});
  await assert.rejects(gateway.complete({profileId:'00000000-0000-4000-8000-000000000012',characterId:profile.characterId,purpose:'chat',messages:[{role:'user',content:'hi'}],budget:{maxSteps:1,maxToolCalls:1,maxTokens:32,maxCostUsd:1,timeoutMs:100},signal:new AbortController().signal,tokensUsed:0,costUsdUsed:0,consume:()=>{}}),/model_timeout/);
});

test('character profile selection comes from the persisted purpose binding', async () => {
  const {createDatabase}=await import('../src/database/database.js');
  const {migrateDatabase}=await import('../src/database/migrate.js');
  const {characters,modelProfiles,modelRoleBindings,modelUsage}=await import('../src/database/schema/index.js');
  const {requireCompatDatabaseUrl,uuid}=await import('./helpers.js');
  const database=createDatabase(requireCompatDatabaseUrl()),characterId=uuid(),profileId=uuid();
  try {
    await migrateDatabase(database);
    await database.db.insert(characters).values({id:characterId,name:'model-binding-fixture'});
    await database.db.insert(modelProfiles).values({id:profileId,name:'model-binding-'+profileId,purpose:'chat',provider:'openai',baseUrl:'https://provider.test/v1',model:'bound-model',credentialRef:'BOUND_KEY',enabled:true,maxTokens:64,timeoutMs:500,monthlyBudgetUsd:null});
    await database.db.insert(modelRoleBindings).values({characterId,purpose:'chat',profileId});
    let usedModel='';
    const gateway=await ModelProfileGateway.fromCharacterBinding(database,characterId,'chat',{
      env:{BOUND_KEY:'explicit-secret'},
      estimateCost:()=>0.01,
      estimateMaxCost:()=>0.02,
      estimateMaxTokens:(_model,_messages,output)=>output,
      createModel:config=>({invoke:async()=>{usedModel=config.model;return {content:'bound',usage_metadata:{input_tokens:1,output_tokens:1,total_tokens:2}};}}),
    });
    const reply=await gateway.completeBound({characterId,purpose:'chat',messages:[{role:'user',content:'hi'}],budget:{maxSteps:2,maxToolCalls:1,maxTokens:512,maxCostUsd:1,timeoutMs:500},signal:new AbortController().signal,tokensUsed:0,costUsdUsed:0,consume:()=>{}});
    assert.equal(reply.text,'bound');assert.equal(usedModel,'bound-model');
    await database.db.update(modelProfiles).set({monthlyBudgetUsd:'2'}).where((await import('drizzle-orm')).eq(modelProfiles.id,profileId));
    const monthlyLimited=await ModelProfileGateway.fromCharacterBinding(database,characterId,'chat',{env:{BOUND_KEY:'explicit-secret'},estimateCost:()=>0.01,estimateMaxCost:()=>0.02,estimateMaxTokens:(_model,_messages,output)=>output,createModel:()=>({invoke:async()=>({content:'should not run',usage_metadata:{input_tokens:1,output_tokens:1,total_tokens:2}})})});
    await assert.rejects(monthlyLimited.completeBound({characterId,purpose:'chat',messages:[{role:'user',content:'hi'}],budget:{maxSteps:2,maxToolCalls:1,maxTokens:512,maxCostUsd:1,timeoutMs:500},signal:new AbortController().signal,tokensUsed:0,costUsdUsed:0,consume:()=>{}}),/model_monthly_budget_unavailable/);
    await database.db.update(modelProfiles).set({monthlyBudgetUsd:'0.05'}).where((await import('drizzle-orm')).eq(modelProfiles.id,profileId));
    let providerCalls=0,chargedTokens=0,chargedCost=0;
    const pricing=createModelPriceEstimators({BOUND_KEY:'explicit-secret',COMPANION_MODEL_PRICING_JSON:JSON.stringify({'bound-model':{inputUsdPer1M:1,outputUsdPer1M:2}})});
    let billingDate=new Date('2026-10-31T23:59:59Z');
    const metered=await ModelProfileGateway.fromCharacterBinding(database,characterId,'chat',{env:{BOUND_KEY:'explicit-secret'},...pricing,now:()=>billingDate,createModel:()=>({invoke:async()=>{providerCalls++;return {content:'metered',usage_metadata:{input_tokens:2,output_tokens:1,total_tokens:3}};}})});
    const meteredInput={characterId,purpose:'chat' as const,messages:[{role:'user' as const,content:'hi'}],budget:{maxSteps:2,maxToolCalls:1,maxTokens:512,maxCostUsd:1,timeoutMs:500},signal:new AbortController().signal,tokensUsed:0,costUsdUsed:0,invocationId:'turn:monthly:compose:0',consume:(kind:'tokens'|'costUsd',amount:number)=>{if(kind==='tokens')chargedTokens+=amount;else chargedCost+=amount;}};
    assert.equal((await metered.completeBound(meteredInput)).text,'metered');
    const [settledUsage]=await database.db.select({usageMonth:modelUsage.usageMonth,reservedUsd:modelUsage.reservedUsd,actualUsd:modelUsage.actualUsd}).from(modelUsage).where((await import('drizzle-orm')).eq(modelUsage.invocationId,'turn:monthly:compose:0')).limit(1);
    assert.equal(settledUsage?.usageMonth,'2026-10');assert.ok(Number(settledUsage?.reservedUsd)>=0.000004);assert.equal(Number(settledUsage?.actualUsd),0.000004);
    billingDate=new Date('2026-11-01T00:00:01Z');
    await assert.rejects(metered.completeBound(meteredInput),/model_usage_unknown/);
    assert.equal(providerCalls,1);assert.equal(chargedTokens,3);assert.equal(chargedCost,0.000004);
    await assert.rejects(ModelProfileGateway.fromCharacterBinding(database,characterId,'search',{env:{}}),/model_not_configured/);
  } finally {
    await database.db.delete(modelUsage).where((await import('drizzle-orm')).eq(modelUsage.profileId,profileId));
    await database.db.delete(modelRoleBindings).where((await import('drizzle-orm')).eq(modelRoleBindings.characterId,characterId));
    await database.db.delete(modelProfiles).where((await import('drizzle-orm')).eq(modelProfiles.id,profileId));
    await database.db.delete(characters).where((await import('drizzle-orm')).eq(characters.id,characterId));
    await database.close();
  }
});

test('actual ChatOpenAI request carries effective token cap for ordinary and reasoning models',async()=>{
 const requests:Array<{body:any;authorization:string|null}>=[];const server=createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;requests.push({body:JSON.parse(data),authorization:req.headers.authorization??null});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:requests.at(-1)!.body.model,choices:[{index:0,message:{role:'assistant',content:'fixture answer'},finish_reason:'stop'}],usage:{prompt_tokens:4,completion_tokens:3,total_tokens:7}}));});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const baseUrl=`http://127.0.0.1:${address.port}/v1`;
 try{for(const [idx,model] of ['gpt-4o-mini','o3-mini'].entries()){const profile={id:`00000000-0000-4000-8000-00000000001${idx}`,characterId:'00000000-0000-4000-8000-000000000001',enabled:true,purpose:'chat' as const,provider:'openai' as const,baseUrl,model,credentialRef:'CHAT_KEY',maxTokens:40,timeoutMs:1000};const gateway=new ModelProfileGateway([profile],{env:{CHAT_KEY:'fixture-secret'},estimateCost:()=>0.01,estimateMaxCost:()=>0.02,estimateMaxTokens:(_model,_messages,output)=>output});await gateway.complete({profileId:profile.id,characterId:profile.characterId,purpose:'chat',messages:[{role:'user',content:'authorized only'}],budget:{maxSteps:1,maxToolCalls:1,maxTokens:7,maxCostUsd:0.2,timeoutMs:1000},signal:new AbortController().signal,tokensUsed:0,costUsdUsed:0,consume:()=>{}});}
  assert.equal(requests[0]!.body.max_tokens,7);assert.equal(requests[0]!.body.max_completion_tokens,undefined);assert.equal(requests[1]!.body.max_completion_tokens,7);assert.equal(requests[1]!.body.max_tokens,undefined);assert.equal(requests[0]!.authorization,'Bearer fixture-secret');assert.equal(requests[0]!.body.messages[0].content,'authorized only');
 }finally{await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
});
