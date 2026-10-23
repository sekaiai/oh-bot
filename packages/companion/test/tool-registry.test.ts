import test from 'node:test';import assert from 'node:assert/strict';
import {ToolRegistry,unavailableSearchTool,type ToolContext} from '../src/tools/registry.js';
import {AgentRegistry} from '../src/tools/registry.js';
const budget={maxSteps:2,maxToolCalls:1,maxTokens:100,maxCostUsd:1,timeoutMs:1000};
function context(permissions:string[],consume:ToolContext['consume']=()=>{}):ToolContext{return {permissions:new Set(permissions),budget,signal:new AbortController().signal,operationKey:'op',consume};}
test('tools enforce permission and strict schemas and unavailable search has no invented sources',async()=>{
 const registry=new ToolRegistry();registry.register(unavailableSearchTool());
 await assert.rejects(registry.execute('search',{query:'weather'},context([])),/tool_forbidden/);
 await assert.rejects(registry.execute('search',{query:'weather',url:'https://bad'},context(['search'])),/Unrecognized key/);
 assert.deepEqual(await registry.execute('search',{query:'weather'},context(['search'])),{status:'unavailable',results:[]});
});
test('tool runs consume inherited child budget and parse outputs',async()=>{
 const registry=new ToolRegistry();let calls=0;registry.register({name:'x',permission:'x',input:(await import('zod')).z.object({}).strict(),output:(await import('zod')).z.string(),run:async()=>{calls++;return 'ok';}});
 const ctx=context(['x'],(_k,n)=>{if(n>1)throw new Error('budget_exceeded')});
 assert.equal(await registry.execute('x',{},ctx),'ok');assert.equal(calls,1);
 await assert.rejects(registry.execute('x',{},context([])),/tool_forbidden/);
});
test('external action tools fail closed when durable operation-key storage is absent',async()=>{
 const registry=new ToolRegistry();let calls=0;registry.register({name:'send',permission:'send',externalAction:true,input:(await import('zod')).z.object({}).strict(),output:(await import('zod')).z.string(),run:async()=>{calls++;return 'sent';}});
 await assert.rejects(registry.execute('send',{},context(['send'])),/tool_persistence_required/);assert.equal(calls,0);
});

test('agent executor pins inherited authority, cancellation, budget, operation namespace and ordinal keys',async()=>{
 const {z}=await import('zod');const registry=new ToolRegistry(),agents=new AgentRegistry();let calls=0,charged=0;const keys:string[]=[];
 registry.register({name:'lookup',permission:'lookup',input:z.object({q:z.string()}).strict(),output:z.string(),run:async(input,_ctx)=>{calls++;return input.q;}});
 const ctx:ToolContext={...context(['lookup'],(_kind,amount)=>{charged+=amount;if(charged>1)throw new Error('budget_exceeded');}),actor:{personId:'p',characterId:'c',conversationId:'v',platformIdentityId:'i',conversationKind:'private',isPartner:false,circleIds:[],participantIds:[],linkedPersonIds:[],participantsComplete:true},turnId:'t',store:undefined,nextOrdinal:(scope)=>{const key=`${scope}:${calls}`;keys.push(key);return calls;}};
 agents.register({name:'research',permissions:['lookup'],tools:['lookup'],input:z.object({}).strict(),output:z.array(z.string()),run:async(_input,agentContext,scoped)=>{
  assert.throws(()=>{(agentContext.budget as any).maxToolCalls=99;},/read only|extensible|property/i);
  assert.throws(()=>{(agentContext.permissions as any).add('admin');},/not a function/);
  const forged={...agentContext,permissions:new Set(['lookup','admin']),consume:()=>{},signal:new AbortController().signal,operationKey:'forged'} as ToolContext;
  await scoped.execute('lookup',{q:'first'},forged);
  await assert.rejects(scoped.execute('lookup',{q:'second'},forged),/budget_exceeded/);
  return ['first'];
 }});
 await agents.run('research',{},ctx,registry);
 assert.equal(calls,1);assert.equal(charged,2);assert.deepEqual(keys,['agent:research:0','agent:research:0:lookup:0']);
});

test('agent callbacks stop waiting when the inherited deadline aborts',async()=>{
 const {z}=await import('zod');const registry=new ToolRegistry(),agents=new AgentRegistry(),controller=new AbortController();let started!:()=>void;
 const began=new Promise<void>(resolve=>{started=resolve;});
 agents.register({name:'hang',permissions:[],tools:[],input:z.object({}).strict(),output:z.string(),run:async()=>{started();return new Promise(()=>{});}});
 const ctx={...context([]),signal:controller.signal};const pending=agents.run('hang',{},ctx,registry);await began;controller.abort();
 await assert.rejects(pending,/tool_cancelled/);
});

test('separate calls to one tool receive separate durable ordinals',async()=>{
 const {z}=await import('zod');const registry=new ToolRegistry(),seen:string[]=[];let ordinal=0;
 registry.register({name:'lookup',permission:'lookup',input:z.object({q:z.string()}).strict(),output:z.string(),run:async(input,ctx)=>{seen.push(`${ctx.operationKey}:${input.q}`);return input.q;}});
 const ctx={...context(['lookup']),nextOrdinal:()=>ordinal++};
 assert.equal(await registry.execute('lookup',{q:'one'},ctx),'one');assert.equal(await registry.execute('lookup',{q:'two'},ctx),'two');
 assert.deepEqual(seen,['op:tool:lookup:0:one','op:tool:lookup:1:two']);
});
