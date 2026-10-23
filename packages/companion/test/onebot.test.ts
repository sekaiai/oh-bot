import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';
import { createOneBotAdapter, normalizeOneBotEvent } from '../src/adapters/onebot/adapter.js';
import { createDatabase } from '../src/database/database.js';
import { migrateDatabase } from '../src/database/migrate.js';
import { characters, people, conversations, messages, turns, deliveryOutbox } from '../src/database/schema/index.js';
import { requireCompatDatabaseUrl, uuid } from './helpers.js';

test('OneBot normalization rejects synthetic identifiers and ignores nickname identity', () => {
  const event = normalizeOneBotEvent({ post_type:'message', message_type:'private', self_id:100, user_id:200, message_id:300, time:1_800_000_000, message:[{type:'text',data:{text:'hello'}}], sender:{nickname:'Same'} });
  assert.equal(event?.senderPlatformId, '200');
  assert.equal(event?.text, 'hello');
  assert.equal(event?.conversationKind, 'private');
  assert.equal(normalizeOneBotEvent({ post_type:'message', message_type:'private', self_id:1, user_id:'local-cli:user:x', message_id:2, message:'x' }), null);
  const largeId = normalizeOneBotEvent({
    post_type:'message', message_type:'private', self_id:'10000000000000000001',
    user_id:'10000000000000000002', message_id:'10000000000000000003',
    time:1_800_000_000, message:'large identifiers',
  });
  assert.equal(largeId?.senderPlatformId, '10000000000000000002');
  assert.equal(largeId?.platform, 'qq');
  assert.equal(normalizeOneBotEvent({
    post_type:'message', message_type:'private', self_id:100, user_id:200, message_id:-300,
    time:1_800_000_000, message:'signed event ID',
  })?.eventId, '-300');
  assert.equal(normalizeOneBotEvent({
    post_type:'message', message_type:'private', self_id:100, user_id:'0200', message_id:300,
    time:1_800_000_000, message:'noncanonical account ID',
  }), null);
  assert.equal(normalizeOneBotEvent({
    post_type:'message', message_type:'private', self_id:1, user_id:2, message_id:3, message:'missing time',
  }), null);
  assert.equal(normalizeOneBotEvent({
    post_type:'message', message_type:'private', self_id:1, user_id:2, message_id:3,
    time:Number.MAX_SAFE_INTEGER, message:'out of range',
  }), null);
});

test('disabled adapter never connects and enabled adapter requires explicit authentication', () => {
  const database=createDatabase(requireCompatDatabaseUrl());
  try {
    const disabled=createOneBotAdapter({enabled:false,characterId:uuid(),database,onInbound:()=>{}});
    assert.doesNotThrow(()=>disabled.start());
    assert.throws(()=>createOneBotAdapter({enabled:true,url:'ws://127.0.0.1:1',characterId:uuid(),database,onInbound:()=>{}}),/token/);
  } finally { void database.close(); }
});

test('authenticated loopback fixture normalizes events and exposes only complete RPC roster', async () => {
  const wss=new WebSocketServer({port:0});
  await new Promise<void>(resolve=>wss.once('listening',resolve));
  const address=wss.address(); assert.ok(address&&typeof address==='object');
  let authSeen=false;
  const requestBodies:string[]=[];
  wss.on('connection',(socket,request)=>{
    authSeen=request.headers.authorization==='Bearer fixture-secret';
    socket.on('message',raw=>{
      requestBodies.push(raw.toString());
      const request=JSON.parse(raw.toString());
      const data=request.action==='get_group_member_list'
        ? [{user_id:200,nickname:'same'},{user_id:201,nickname:'same'}]
        : {message_id:9001};
      socket.send(JSON.stringify({echo:request.echo,status:'ok',retcode:0,data}));
    });
  });
  const database=createDatabase(requireCompatDatabaseUrl());
  const accepted:Array<{eventId:string; mentionedSelf:boolean; text:string; platform:string}>=[];
  const adapter=createOneBotAdapter({enabled:true,url:`ws://127.0.0.1:${address.port}`,accessToken:'fixture-secret',selfId:'100',characterId:uuid(),database,onInbound:(event,_evidence,metadata)=>{accepted.push({eventId:event.eventId,mentionedSelf:metadata?.mentionedSelf===true,text:event.text,platform:event.platform})}});
  try {
    await adapter.start();
    for(let i=0;i<50&&!authSeen;i++) await new Promise(r=>setTimeout(r,10));
    assert.equal(authSeen,true);
    const client=[...wss.clients][0]; assert.ok(client);
    const event={post_type:'message',message_type:'group',self_id:100,user_id:200,group_id:300,message_id:400,time:1800000000,message:[{type:'at',data:{qq:100}},{type:'text',data:{text:'hello'}}]};
    client.send(JSON.stringify(event)); client.send(JSON.stringify(event));
    for(let i=0;i<50&&accepted.length<1;i++) await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(accepted,[
      {eventId:'400',mentionedSelf:true,text:'hello',platform:'qq'},
      {eventId:'400',mentionedSelf:true,text:'hello',platform:'qq'},
    ]);
    const largeGroupId='30000000000000000001';
    const roster=await adapter.fetchCompleteRoster(largeGroupId);
    assert.deepEqual(roster.memberIds,['200','201']);
    assert.equal(roster.evidence.kind,'trusted-roster');
    assert.ok(requestBodies[0]?.includes(`"group_id":${largeGroupId}`));
  } finally {
    await adapter.stop(); await new Promise<void>(resolve=>wss.close(()=>resolve())); await database.close();
  }
});

test('start is idempotent, stop closes the connection, and post-stop events are ignored', async () => {
  const wss=new WebSocketServer({port:0}); await new Promise<void>(resolve=>wss.once('listening',resolve));
  const address=wss.address();assert.ok(address&&typeof address==='object');
  let connections=0;let serverSocket:WebSocket|null=null;let accepted=0;
  wss.on('connection',socket=>{connections+=1;serverSocket=socket;});
  const database=createDatabase(requireCompatDatabaseUrl());
  const adapter=createOneBotAdapter({enabled:true,url:`ws://127.0.0.1:${address.port}`,accessToken:'fixture-secret',selfId:'100',characterId:uuid(),database,onInbound:()=>{accepted+=1}});
  try {
    await adapter.start();await adapter.start();
    for(let i=0;i<50&&connections<1;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(connections,1);
    const retainedSocket=serverSocket as WebSocket|null;assert.ok(retainedSocket);
    await adapter.stop();
    retainedSocket.send(JSON.stringify({post_type:'message',message_type:'private',self_id:100,user_id:200,message_id:-12,time:1800000000,message:'late'}));
    await new Promise(r=>setTimeout(r,20));
    assert.equal(accepted,0);
    assert.equal(wss.clients.size,0);
  } finally {await adapter.stop();await new Promise<void>(resolve=>wss.close(()=>resolve()));await database.close();}
});

test('reconnect creates a replacement connection and its roster request completes', async () => {
  const wss=new WebSocketServer({port:0}); await new Promise<void>(resolve=>wss.once('listening',resolve));
  const address=wss.address();assert.ok(address&&typeof address==='object');
  const serverSockets:WebSocket[]=[];
  wss.on('connection',socket=>{
    serverSockets.push(socket);
    socket.on('message',raw=>{
      const request=JSON.parse(raw.toString());
      socket.send(JSON.stringify({echo:request.echo,status:'ok',retcode:0,data:[{user_id:200}]}));
    });
  });
  const database=createDatabase(requireCompatDatabaseUrl());
  const adapter=createOneBotAdapter({enabled:true,url:`ws://127.0.0.1:${address.port}`,accessToken:'fixture-secret',selfId:'100',characterId:uuid(),database,onInbound:()=>{},reconnectMinMs:10,reconnectMaxMs:10});
  try {
    await adapter.start();
    for(let i=0;i<50&&serverSockets.length<1;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(serverSockets.length,1);
    serverSockets[0]!.terminate();
    for(let i=0;i<100&&serverSockets.length<2;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(serverSockets.length,2);
    const request=adapter.fetchCompleteRoster('300');
    const roster=await request;
    assert.deepEqual(roster.memberIds,['200']);
  } finally {await adapter.stop();await new Promise<void>(resolve=>wss.close(()=>resolve()));await database.close();}
});

test('stop during WebSocket handshake prevents late connection events from being trusted', async () => {
  let enteredVerify!:()=>void;
  let releaseVerify!:(accepted:boolean)=>void;
  const verifyEntered=new Promise<void>(resolve=>{enteredVerify=resolve;});
  const wss=new WebSocketServer({
    port:0,
    verifyClient:(_info,callback)=>{
      enteredVerify();
      releaseVerify=callback;
    },
  });
  await new Promise<void>(resolve=>wss.once('listening',resolve));
  const address=wss.address();assert.ok(address&&typeof address==='object');
  const database=createDatabase(requireCompatDatabaseUrl());let accepted=0;
  const adapter=createOneBotAdapter({enabled:true,url:`ws://127.0.0.1:${address.port}`,accessToken:'fixture-secret',selfId:'100',characterId:uuid(),database,onInbound:()=>{accepted+=1}});
  try {
    await adapter.start();
    await verifyEntered;
    const stopping=adapter.stop();
    releaseVerify(true);
    await stopping;
    await new Promise(r=>setTimeout(r,30));
    assert.equal(accepted,0);
    assert.equal(wss.clients.size,0);
    assert.throws(()=>createOneBotAdapter({enabled:true,url:`ws://127.0.0.1:${address.port}`,accessToken:'fixture-secret',selfId:'0100',characterId:uuid(),database,onInbound:()=>{}}),/self ID/);
  } finally {await adapter.stop();await new Promise<void>(resolve=>wss.close(()=>resolve()));await database.close();}
});

test('delivery targets come from persisted conversation and echo distinguishes receipt from unknown', async () => {
  const wss=new WebSocketServer({port:0}); await new Promise<void>(resolve=>wss.once('listening',resolve));
  const address=wss.address();assert.ok(address&&typeof address==='object');
  let behavior:'receipt'|'failure'|'invalid_receipt'|'disconnect'='receipt';
  const requestBodies:string[]=[];
  wss.on('connection',socket=>socket.on('message',raw=>{
    const body=raw.toString();requestBodies.push(body);
    const request=JSON.parse(body);
    if(behavior==='disconnect'){socket.close();return;}
    if(behavior==='invalid_receipt'){
      socket.send(JSON.stringify({echo:request.echo,status:'ok',retcode:0,data:{message_id:{id:9001}}}));
      return;
    }
    socket.send(JSON.stringify(behavior==='receipt'?{echo:request.echo,status:'ok',retcode:0,data:{message_id:-9001}}:{echo:request.echo,status:'failed',retcode:1200,data:null}));
  }));
  const database=createDatabase(requireCompatDatabaseUrl());const suffix=uuid();
  const characterId=uuid(),personId=uuid(),conversationId=uuid(),messageId=uuid(),turnId=uuid(),deliveryId=uuid();
  const largeUserId='20000000000000000009';
  try{
    await migrateDatabase(database);
    await database.db.insert(characters).values({id:characterId,name:'onebot-fixture'});
    await database.db.insert(people).values({id:personId,displayName:'fixture'});
    await database.db.insert(conversations).values({id:conversationId,characterId,platform:'qq',platformConversationId:largeUserId,kind:'private'});
    await database.db.insert(messages).values({id:messageId,conversationId,platform:'qq',platformEventId:`onebot-fixture:${suffix}`,role:'user',text:'inbound'});
    await database.db.insert(turns).values({id:turnId,conversationId,inboundMessageId:messageId,personId,graphThreadId:`thread:${suffix}`});
    await database.db.insert(deliveryOutbox).values({id:deliveryId,turnId,conversationId,operationKey:`turn:${turnId}:deliver`,content:{text:'literal [CQ:at,qq=all]'},status:'pending'});
    let authorized=true;const adapter=createOneBotAdapter({enabled:true,url:`ws://127.0.0.1:${address.port}`,accessToken:'fixture-secret',selfId:'100',characterId,database,onInbound:()=>{},validateDeliveryContext:async()=>{if(!authorized)throw new Error('graph_context_changed');},requestTimeoutMs:80});
    await adapter.start();
    for(let i=0;i<50&&wss.clients.size===0;i++)await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(await adapter.sendDelivery(deliveryId),{kind:'receipt',receipt:'-9001'});
    assert.ok(requestBodies[0]?.includes(`"user_id":${largeUserId}`));
    const sentBody=JSON.parse(requestBodies[0]!);
    assert.equal(sentBody.params.message,'literal [CQ:at,qq=all]');
    assert.equal(sentBody.params.auto_escape,true);
    const requestsBeforeRevocation=requestBodies.length;authorized=false;
    assert.deepEqual(await adapter.sendDelivery(deliveryId),{kind:'not_sent',errorCode:'delivery_context_invalid'});
    assert.equal(requestBodies.length,requestsBeforeRevocation);
    authorized=true;
    behavior='failure';assert.deepEqual(await adapter.sendDelivery(deliveryId),{kind:'not_sent',errorCode:'onebot_api_failed'});
    behavior='invalid_receipt';assert.deepEqual(await adapter.sendDelivery(deliveryId),{kind:'unknown',errorCode:'onebot_send_unknown'});
    const otherCharacterAdapter=createOneBotAdapter({enabled:true,url:`ws://127.0.0.1:${address.port}`,accessToken:'fixture-secret',selfId:'100',characterId:uuid(),database,onInbound:()=>{}});
    assert.deepEqual(await otherCharacterAdapter.sendDelivery(deliveryId),{kind:'not_sent',errorCode:'invalid_delivery_target'});
    behavior='disconnect';const unknown=await adapter.sendDelivery(deliveryId);assert.equal(unknown.kind,'unknown');
    await adapter.stop();
  }finally{await database.close();await new Promise<void>(resolve=>wss.close(()=>resolve()));}
});

test('normalization rejects malformed and unsupported message events', () => {
  assert.equal(normalizeOneBotEvent({ post_type:'message', message_type:'group', self_id:1, user_id:2, group_id:3, message_id:4, message:[{type:'image'}] }), null);
  assert.equal(normalizeOneBotEvent({ post_type:'notice', self_id:1 }), null);
});
