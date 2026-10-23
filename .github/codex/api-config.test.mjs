import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveApiConfig,normalizeBaseUrl,openCodeProvider,chatCompletion} from './api-config.mjs';

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
 assert.throws(()=>resolveApiConfig({CODING_API_KEY:'secret',REVIEW_API_BASE_URL:'https://review.example.com/v1'}),/REVIEW_API_KEY/);
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
