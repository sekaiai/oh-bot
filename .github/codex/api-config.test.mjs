import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveApiConfig,normalizeBaseUrl,openCodeProvider,chatCompletion,probeApi,chatCompletionWithRetry} from './api-config.mjs';

test('legacy DeepSeek configuration remains functional',()=>{
 const c=resolveApiConfig({DEEPSEEK_API_KEY:'legacy-key'});
 assert.equal(c.coding.baseUrl,'https://api.deepseek.com');
 assert.equal(c.review.apiKey,'legacy-key');
 assert.equal(openCodeProvider(c.coding).selectedModel,'deepseek/deepseek-chat');
});
test('custom coding and review endpoints have independent secrets',()=>{
 const c=resolveApiConfig({CODING_API_BASE_URL:'https://code.example.com/v1',CODING_API_KEY:'code-secret',CODING_API_MODEL:'model-a',REVIEW_API_BASE_URL:'https://review.example.com/v1',REVIEW_API_KEY:'review-secret',REVIEW_API_MODEL:'model-b'});
 assert.equal(openCodeProvider(c.coding).selectedModel,'coding/model-a');
 assert.equal(c.review.model,'model-b');
 assert.equal(c.review.apiKey,'review-secret');
 assert.equal(openCodeProvider(c.coding).provider.coding.npm,'@ai-sdk/openai-compatible');
});
test('do not leak legacy key to a custom endpoint',()=>{
 assert.throws(()=>resolveApiConfig({DEEPSEEK_API_KEY:'legacy',CODING_API_BASE_URL:'https://code.example.com/v1'}),/CODING_API_KEY/);
});
test('review API at another origin requires its own key',()=>{
 assert.throws(()=>resolveApiConfig({CODING_API_BASE_URL:'https://code.example.com/v1',CODING_API_KEY:'secret',REVIEW_API_BASE_URL:'https://review.example.com/v1'}),/REVIEW_API_KEY/);
});
test('reject insecure or credential-bearing endpoints',()=>{
 for(const u of ['http://example.com/v1','https://user:pass@example.com/v1','https://example.com/v1?token=secret','https://example.com/chat/completions']) {
   assert.throws(()=>normalizeBaseUrl(u));
 }
});
test('API probe uses selected URL, model and secret without redirects',async()=>{
 const c=resolveApiConfig({CODING_API_BASE_URL:'https://code.example.com/v1',CODING_API_KEY:'test-secret',CODING_API_MODEL:'custom'});
 const output=await chatCompletion(c.coding,[{role:'user',content:'hello'}],{max_tokens:16},async (url,options)=>{
   assert.equal(url,'https://code.example.com/v1/chat/completions');
   assert.equal(options.redirect,'error');
   assert.equal(options.headers.Authorization,'Bearer test-secret');
   assert.equal(JSON.parse(options.body).model,'custom');
   return {ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})};
 });
 assert.equal(output,'OK');
});
test('API errors do not disclose response body or secrets',async()=>{
 const c=resolveApiConfig({DEEPSEEK_API_KEY:'secret-value'});
 await assert.rejects(()=>chatCompletion(c.coding,[],{},async()=>({ok:false,status:401,text:async()=> 'secret-value'})),e=>e.message==='Configured model API HTTP 401');
});

test('reject new coding secret without coding URL rather than sending it to DeepSeek',()=>{
 assert.throws(()=>resolveApiConfig({DEEPSEEK_API_KEY:'legacy-key',CODING_API_KEY:'custom-key'}),/CODING_API_BASE_URL/);
});
test('reject new review secret without review URL rather than sending it to coding provider',()=>{
 assert.throws(()=>resolveApiConfig({DEEPSEEK_API_KEY:'legacy-key',REVIEW_API_KEY:'review-key'}),/REVIEW_API_BASE_URL/);
});
test('reject custom coding model without a coding URL',()=>{
 assert.throws(()=>resolveApiConfig({DEEPSEEK_API_KEY:'legacy-key',CODING_API_MODEL:'my-model'}),/CODING_API_BASE_URL/);
});


test('coding API probe retries empty, rate-limited and server-error responses within a bound',async()=>{
 const c=resolveApiConfig({DEEPSEEK_API_KEY:'legacy-key'});
 let calls=0;
 const delays=[];
 const content=await probeApi(c.coding,{
  sleep:async ms=>{delays.push(ms);},
  transport:async()=>{
   calls++;
   if(calls===1)return {ok:false,status:503};
   if(calls===2)return {ok:true,json:async()=>({choices:[{message:{content:'  '}}]})};
   return {ok:true,json:async()=>({choices:[{message:{content:'OK'}}]})};
  }
 });
 assert.equal(content,'OK');
 assert.equal(calls,3);
 assert.deepEqual(delays,[250,500]);
});
test('coding API probe fails fast for authentication errors',async()=>{
 const c=resolveApiConfig({DEEPSEEK_API_KEY:'legacy-key'});
 let calls=0;
 await assert.rejects(()=>probeApi(c.coding,{
  sleep:async()=>{throw new Error('must not retry');},
  transport:async()=>{calls++;return {ok:false,status:401};}
 }),/HTTP 401/);
 assert.equal(calls,1);
});


test('retrying chat completions preserve the review payload and JSON response format',async()=>{
 const c=resolveApiConfig({DEEPSEEK_API_KEY:'legacy-key'});
 const messages=[{role:'system',content:'return JSON'},{role:'user',content:'review'}];
 const params={temperature:0,max_tokens:4096,response_format:{type:'json_object'}};
 let calls=0;
 const delays=[];
 const output=await chatCompletionWithRetry(c.review,messages,params,{
  sleep:async ms=>{delays.push(ms);},
  transport:async(url,options)=>{
   calls++;
   assert.equal(url,c.review.baseUrl+'/chat/completions');
   assert.deepEqual(JSON.parse(options.body),{model:c.review.model,messages,...params});
   if(calls===1)return {ok:true,json:async()=>({choices:[{message:{content:''}}]})};
   return {ok:true,json:async()=>({choices:[{message:{content:'{"approved":true,"findings":[]}'}}]})};
  }
 });
 assert.equal(output,'{"approved":true,"findings":[]}');
 assert.equal(calls,2);
 assert.deepEqual(delays,[250]);
});
