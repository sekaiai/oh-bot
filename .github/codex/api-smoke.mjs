// Live, read-only smoke test for the unattended coding and review model endpoints.
// Does not touch the repository, start a coding task, or print credentials.
import {resolveApiConfig,chatCompletion,openCodeProvider} from './api-config.mjs';

async function main() {
  const cfg=resolveApiConfig();
  const provider=openCodeProvider(cfg.coding);
  if (!provider.selectedModel || !provider.provider) throw new Error('Invalid OpenCode model configuration');
  const coding=await chatCompletion(cfg.coding,[
    {role:'user',content:'Reply with the word READY.'}
  ],{max_tokens:64});
  if (!coding.trim()) throw new Error('Coding model returned empty output');
  console.log('PASS: coding API authenticated and returned a chat completion');

  const review=await chatCompletion(cfg.review,[
    {role:'system',content:'Return only a JSON object with an ok boolean.'},
    {role:'user',content:'Return {"ok":true}.'}
  ],{temperature:0,max_tokens:128,response_format:{type:'json_object'}});
  let parsed;
  try {parsed=JSON.parse(review);} catch {throw new Error('Review model did not return valid JSON');}
  if (parsed?.ok !== true) throw new Error('Review model JSON schema smoke test failed');
  console.log('PASS: review API authenticated and returned valid JSON');
  console.log('NOTE: this is a live API connectivity test, not a complete OpenCode tool-use or code-delivery verification');
}
main().catch(error=>{
  // api-config.mjs deliberately avoids printing provider response bodies or secrets.
  console.error('FAIL: '+error.message);
  process.exitCode=1;
});
