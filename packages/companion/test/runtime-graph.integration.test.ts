import {randomUUID} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {interrupt} from '@langchain/langgraph';
import {z} from 'zod';
import {createCompanionGraph} from '../src/runtime/companion-graph.js';
import {ToolRegistry,type ToolInvocationStore} from '../src/tools/registry.js';

const url=process.env.CORE_TEST_DATABASE_URL;
test('Postgres checkpoints bind actors, refresh prompt context, and resume with the live signal without repeating tools', {skip:!url}, async()=>{
 const personId='00000000-0000-4000-8000-000000000001',characterId='00000000-0000-4000-8000-000000000002',conversationId='00000000-0000-4000-8000-000000000003';
 const actor={personId,characterId,conversationId,platformIdentityId:'platform-id',conversationKind:'private' as const,isPartner:false,circleIds:[],participantIds:[],linkedPersonIds:[],participantsComplete:true};
 let authorizations=0,routes=0,actionCalls=0,persona='persona',memories:readonly unknown[]=[{id:'memory-1',text:'safe'}],authorized=true,blockCompose=false,hangCompose=false,pausePersona=false,failPersonaOnce=false,failMemoryOnce=false,failIdentityAtCall=0,composeStarted:(()=>void)|undefined,releaseCompose:(()=>void)|undefined,failFinalize=false,finalizeCalls=0;const seen:string[]=[],composeSignals:AbortSignal[]=[];
 const results=new Map<string,unknown>();const runStore:ToolInvocationStore={beginTool:async({operationKey})=>results.has(operationKey)?{kind:'cached',runId:operationKey,result:results.get(operationKey)}:{kind:'execute',runId:operationKey},finishTool:async({operationKey,result})=>{if(result!==undefined)results.set(operationKey,result);},beginAgent:async()=>randomUUID(),finishAgent:async()=>{}};
 const tools=new ToolRegistry();tools.register({name:'record_action',permission:'action',externalAction:true,input:z.object({}).strict(),output:z.object({ok:z.literal(true)}).strict(),run:async()=>{actionCalls++;return {ok:true as const};}});
 const graph=await createCompanionGraph({databaseUrl:url!,setup:true,tools,runStore,hooks:{
  authorize:async(req)=>{authorizations++;if(authorizations===failIdentityAtCall){failIdentityAtCall=0;throw new Error('identity fixture failure');}if(!authorized||req.principal.kind!=='person'||req.principal.actor.personId!==personId)throw new Error('graph_forbidden');return {actor,permissions:['action']};},
  loadPersona:async()=>{if(failPersonaOnce){failPersonaOnce=false;throw new Error('context fixture failure');}if(pausePersona){pausePersona=false;return `${persona} ${String(interrupt('continue context'))}`;}return persona;},readMemory:async()=>{if(failMemoryOnce){failMemoryOnce=false;throw new Error('memory fixture failure');}return memories;},
  route:async({text},context)=>{routes++;if(text.includes('budgetover')){context.consume('tokens',60);context.consume('costUsd',0.6);}return text.includes('action')?{kind:'tool',name:'record_action',input:{}}:{kind:'answer'};},
  compose:async({userText,signal,context})=>{composeSignals.push(signal);if(userText.includes('budgetover')){assert.equal(context.usageSnapshot?.().tokens,60);context.consume('tokens',41);}if(hangCompose)await new Promise<void>(()=>{});if(blockCompose){composeStarted?.();await new Promise<void>(resolve=>{releaseCompose=resolve;});}return userText.includes('pause')?'resumed '+String(interrupt('resume now')):userText;},
  deliver:async({content,operationKey})=>{seen.push(operationKey+':'+content);return {status:'staged'};},
  finalize:async()=>{finalizeCalls++;if(failFinalize){failFinalize=false;throw new Error('temporary finalize failure');}},
 }});
 try{
  const req=(turnId:string,userText='hello')=>({turnId,principal:{kind:'person' as const,actor},actor,conversationId,characterId,userText,budget:{maxSteps:4,maxToolCalls:2,maxTokens:100,maxCostUsd:1,timeoutMs:1000},permissions:['action']});
  const a=await graph.invoke(req(randomUUID())),b=await graph.invoke(req(randomUUID()));
  assert.notEqual(a.threadId,b.threadId);assert.equal(seen.length,2);
  const routeCountBeforeDispatchValidation=routes;assert.equal((await graph.validatePendingContext(a.turnId)).valid,true);assert.equal(routes,routeCountBeforeDispatchValidation);
  authorized=false;await assert.rejects(graph.validatePendingContext(a.turnId),/graph_forbidden/);authorized=true;
  memories=[{id:'memory-1',text:'revoked before dispatch'}];await assert.rejects(graph.validatePendingContext(a.turnId),/graph_context_changed/);memories=[{id:'memory-1',text:'safe'}];
  const partial=req(randomUUID(),'partial checkpoint');pausePersona=true;await graph.invoke(partial);const resumedPartial=await graph.invoke({...partial,resume:'continue'});assert.equal(resumedPartial.deliveryStatus,'staged');
  const beforeIdentity=req(randomUUID(),'failure before identity checkpoint');failIdentityAtCall=authorizations+2;await assert.rejects(graph.invoke(beforeIdentity),/identity fixture failure/);assert.equal((await graph.invoke(beforeIdentity)).deliveryStatus,'staged');
  const beforeContext=req(randomUUID(),'failure before context checkpoint');failPersonaOnce=true;await assert.rejects(graph.invoke(beforeContext),/context fixture failure/);assert.equal((await graph.invoke(beforeContext)).deliveryStatus,'staged');
  const beforeMemory=req(randomUUID(),'failure before memory checkpoint');failMemoryOnce=true;await assert.rejects(graph.invoke(beforeMemory),/memory fixture failure/);assert.equal((await graph.invoke(beforeMemory)).deliveryStatus,'staged');
  const actionTurn=req(randomUUID(),'pause action'),firstController=new AbortController();await graph.invoke({...actionTurn,signal:firstController.signal});const routesAtPause=routes;
  const resumedController=new AbortController(),resumed=await graph.invoke({...actionTurn,resume:'continue',signal:resumedController.signal});
  assert.equal(resumed.content,'resumed continue');assert.equal(routes,routesAtPause);assert.equal(actionCalls,1);assert.notEqual(composeSignals.at(-1),firstController.signal);assert.notEqual(composeSignals.at(-1),resumedController.signal);assert.equal(composeSignals.at(-1)?.aborted,false);assert.equal(seen.at(-1)?.endsWith(':resumed continue'),true);
  const during=req(randomUUID(),'revoke during compose');blockCompose=true;const started=new Promise<void>(resolve=>{composeStarted=resolve;});const pending=graph.invoke(during);await started;const beforeRevocationDelivery=seen.length;authorized=false;releaseCompose?.();await assert.rejects(pending,/graph_forbidden/);assert.equal(seen.length,beforeRevocationDelivery);authorized=true;blockCompose=false;
  const deadline=req(randomUUID(),'deadline');hangCompose=true;const beforeDeadlineDelivery=seen.length;await assert.rejects(graph.invoke({...deadline,budget:{...deadline.budget,timeoutMs:100}}),/graph_timeout/);assert.equal(seen.length,beforeDeadlineDelivery);hangCompose=false;
  const overBudget=req(randomUUID(),'budgetover');const beforeOverBudgetDelivery=seen.length;await assert.rejects(graph.invoke(overBudget),/budget_exceeded/);assert.equal(seen.length,beforeOverBudgetDelivery);
  const finalizeTurn=req(randomUUID(),'finalize recovery');failFinalize=true;const beforeFinalizeDelivery=seen.length;await assert.rejects(graph.invoke(finalizeTurn),/temporary finalize failure/);const deliveredOnce=seen.length;assert.equal(deliveredOnce,beforeFinalizeDelivery+1);const recovered=await graph.invoke(finalizeTurn);assert.equal(recovered.deliveryStatus,'staged');assert.equal(seen.length,deliveredOnce);
  const stale=req(randomUUID(),'pause stale');await graph.invoke(stale);const deliveriesBefore=seen.length;memories=[{id:'memory-1',text:'deleted or corrected'}];
  await assert.rejects(graph.invoke({...stale,resume:'resume'}),/graph_context_changed/);assert.equal(seen.length,deliveriesBefore);
  const revoked=req(randomUUID(),'pause revoked');await graph.invoke(revoked);const revokedDeliveryCount=seen.length;authorized=false;await assert.rejects(graph.invoke({...revoked,resume:'resume'}),/graph_forbidden/);assert.equal(seen.length,revokedDeliveryCount);authorized=true;
  await assert.rejects(graph.invoke({...req(randomUUID()),principal:{kind:'person',actor:{...actor,personId:'00000000-0000-4000-8000-000000000099'}}}),/graph_forbidden/);
  assert.ok(authorizations>=18);assert.ok(finalizeCalls>=6);
  persona='revised persona';
 }finally{await graph.close();}
});

test('concurrent turns keep authorization and context baselines isolated by checkpoint thread', {skip:!url}, async()=>{
 const actors=[
  {personId:'00000000-0000-4000-8000-000000000011',characterId:'00000000-0000-4000-8000-000000000012',conversationId:'00000000-0000-4000-8000-000000000013',platformIdentityId:'actor-a',conversationKind:'private' as const,isPartner:false,circleIds:[],participantIds:[],linkedPersonIds:[],participantsComplete:true},
  {personId:'00000000-0000-4000-8000-000000000021',characterId:'00000000-0000-4000-8000-000000000022',conversationId:'00000000-0000-4000-8000-000000000023',platformIdentityId:'actor-b',conversationKind:'private' as const,isPartner:false,circleIds:[],participantIds:[],linkedPersonIds:[],participantsComplete:true},
 ];
 let contextsLoaded=0,releaseContexts!:()=>void,compositionsStarted=0,releaseCompositions!:()=>void;const bothContexts=new Promise<void>(resolve=>{releaseContexts=resolve;}),bothCompositions=new Promise<void>(resolve=>{releaseCompositions=resolve;});const deliveries:string[]=[];
 const graph=await createCompanionGraph({databaseUrl:url!,setup:true,hooks:{
  authorize:async(request)=>({actor:request.actor,permissions:[]}),
  loadPersona:async(actor)=>{contextsLoaded++;if(contextsLoaded===2)releaseContexts();await bothContexts;return `persona:${actor.personId}`;},
  readMemory:async(actor)=>[{actor:actor.personId}],
  route:async()=>({kind:'answer'}),
  compose:async({actor,context})=>{compositionsStarted++;if(compositionsStarted===2)releaseCompositions();await bothCompositions;assert.equal(context.actor?.personId,actor.personId);return `answer:${actor.personId}`;},
  deliver:async({actor})=>{deliveries.push(actor.personId);return {status:'staged'};},
 }});
 try{
  const requests=actors.map((actor,index)=>({turnId:randomUUID(),principal:{kind:'person' as const,actor},actor,conversationId:actor.conversationId,characterId:actor.characterId,userText:`parallel:${index}`,budget:{maxSteps:4,maxToolCalls:1,maxTokens:100,maxCostUsd:1,timeoutMs:5000},permissions:[]}));
  const results=await Promise.all(requests.map(request=>graph.invoke(request)));
  assert.equal(results.length,2);assert.deepEqual(new Set(deliveries),new Set(actors.map(actor=>actor.personId)));
 }finally{await graph.close();}
});

test('simultaneous invokes for one checkpoint thread are fenced', {skip:!url}, async()=>{
 const actor={personId:'00000000-0000-4000-8000-000000000031',characterId:'00000000-0000-4000-8000-000000000032',conversationId:'00000000-0000-4000-8000-000000000033',platformIdentityId:'same-thread',conversationKind:'private' as const,isPartner:false,circleIds:[],participantIds:[],linkedPersonIds:[],participantsComplete:true};
 let release!:()=>void,started!:()=>void;const startedPromise=new Promise<void>(resolve=>{started=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});
 const graph=await createCompanionGraph({databaseUrl:url!,setup:true,hooks:{
  authorize:async(request)=>({actor:request.actor,permissions:[]}),loadPersona:async()=>'',readMemory:async()=>[],route:async()=>({kind:'answer'}),
  compose:async()=>{started();await held;return 'done';},deliver:async()=>({status:'staged'}),
 }});
 try{
  const request={turnId:randomUUID(),principal:{kind:'person' as const,actor},actor,conversationId:actor.conversationId,characterId:actor.characterId,userText:'same',budget:{maxSteps:4,maxToolCalls:1,maxTokens:100,maxCostUsd:1,timeoutMs:5000},permissions:[]};
  const first=graph.invoke(request);await startedPromise;
  await assert.rejects(graph.invoke(request),/graph_turn_busy/);
  release();assert.equal((await first).deliveryStatus,'staged');
 }finally{release();await graph.close();}
});
