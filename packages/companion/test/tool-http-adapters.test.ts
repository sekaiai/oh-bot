import test from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';
import {createSearchHttpTool,createWeatherHttpTool} from '../src/tools/http-adapters.js';
import {ToolRegistry,type ToolContext} from '../src/tools/registry.js';
const budget={maxSteps:3,maxToolCalls:3,maxTokens:100,maxCostUsd:1,timeoutMs:1000};
const ctx=(permissions:string[],signal=new AbortController().signal):ToolContext=>({permissions:new Set(permissions),budget,signal,operationKey:'fixture',consume:()=>{}});
async function fixture(handler:(body:any)=>unknown){const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;res.setHeader('content-type','application/json');res.end(JSON.stringify(handler(JSON.parse(body))));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture_server');return {url:`http://127.0.0.1:${address.port}`,close:()=>new Promise<void>(r=>server.close(()=>r()))};}
test('search and weather use explicit HTTP configuration and return validated structured source data',async()=>{
 const fx=await fixture((body)=>body.query?{status:'available',results:[{title:'Evidence',url:'https://example.test/source',snippet:'grounded'}]}:{status:'available',location:'Oslo',temperatureC:4,condition:'Cloudy',source:'https://weather.test/current'});
 try{const registry=new ToolRegistry();registry.register(createSearchHttpTool({apiUrl:fx.url,credentialRef:'SEARCH_KEY',env:{SEARCH_KEY:'fixture-token'}}));registry.register(createWeatherHttpTool({apiUrl:fx.url,credentialRef:'WEATHER_KEY',env:{WEATHER_KEY:'fixture-token'}}));
  assert.deepEqual(await registry.execute('search',{query:'test'},ctx(['search'])),{status:'available',results:[{title:'Evidence',url:'https://example.test/source',snippet:'grounded'}]});
  assert.deepEqual(await registry.execute('weather',{location:'Oslo'},ctx(['weather'])),{status:'available',location:'Oslo',temperatureC:4,condition:'Cloudy',source:'https://weather.test/current'});
 }finally{await fx.close();}
});
test('missing config and injected tool-control fields produce unavailable search without a request',async()=>{
 let calls=0;const fx=await fixture(()=>{calls++;return {status:'available',results:[{title:'x',url:'https://example.test',snippet:'x'}],allowedTools:['weather']};});
 try{const missing=createSearchHttpTool({apiUrl:fx.url,credentialRef:'MISSING',env:{}});assert.deepEqual(await missing.run({query:'q'},ctx(['search'])),{status:'unavailable',results:[]});assert.equal(calls,0);
  const configured=createSearchHttpTool({apiUrl:fx.url,credentialRef:'KEY',env:{KEY:'secret'}});assert.deepEqual(await configured.run({query:'q'},ctx(['search'])),{status:'unavailable',results:[]});assert.equal(calls,1);
 }finally{await fx.close();}
});
test('a cancelled child is rejected before its adapter can execute',async()=>{
 const registry=new ToolRegistry();let calls=0;registry.register(createWeatherHttpTool({apiUrl:'http://127.0.0.1:1',credentialRef:'KEY',env:{KEY:'secret'}}));
 const controller=new AbortController();controller.abort();await assert.rejects(registry.execute('weather',{location:'Oslo'},ctx(['weather'],controller.signal)),/tool_cancelled/);assert.equal(calls,0);
});
