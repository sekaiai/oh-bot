// Trusted configuration for the unattended coding and review APIs.
// API base URLs are provider roots, e.g. https://api.example.com/v1 (not /chat/completions).
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const present = (env, key) => typeof env[key] === 'string' ? env[key].trim() : '';

export function normalizeBaseUrl(value, name='API_BASE_URL') {
  if (!value) throw new Error(name+' is required');
  let url;
  try { url = new URL(value); }
  catch { throw new Error(name+' must be an absolute HTTPS URL'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error(name+' must be an HTTPS URL without credentials, query, or fragment');
  }
  if (/\/chat\/completions\/?$/.test(url.pathname)) {
    throw new Error(name+' must be the API root, not /chat/completions');
  }
  return url.href.replace(/\/+$/, '');
}

function modelId(value, name) {
  if (!value || /\s/.test(value)) throw new Error(name+' must be a non-empty model ID without whitespace');
  return value;
}

// Legacy credentials only go to DeepSeek. A custom coding endpoint requires its own
// secret; a distinct review endpoint also requires its own secret.
export function resolveApiConfig(env=process.env) {
  const customCodingBase = present(env,'CODING_API_BASE_URL');
  const customCodingKey = present(env,'CODING_API_KEY');
  const legacyKey = present(env,'DEEPSEEK_API_KEY');
  // A custom secret without a URL must never be sent to the default DeepSeek host.
  if (!customCodingBase && customCodingKey) {
    throw new Error('CODING_API_BASE_URL variable is required when CODING_API_KEY is set');
  }
  if (!customCodingBase && present(env,'CODING_API_MODEL')) {
    throw new Error('CODING_API_BASE_URL variable is required when CODING_API_MODEL is set');
  }
  const codingBase = normalizeBaseUrl(customCodingBase || DEFAULT_BASE,'CODING_API_BASE_URL');
  const legacy = !customCodingBase;
  const codingKey = legacy ? legacyKey : customCodingKey;
  if (!codingKey) throw new Error(customCodingBase
    ? 'CODING_API_KEY secret is required for a custom coding API URL'
    : 'Set CODING_API_KEY or the legacy DEEPSEEK_API_KEY secret');
  const fallbackModel = present(env,'DEEPSEEK_MODEL').replace(/^deepseek\//,'') || DEFAULT_MODEL;
  const codingModel = modelId(present(env,'CODING_API_MODEL') || fallbackModel,'CODING_API_MODEL');

  const customReviewBase = present(env,'REVIEW_API_BASE_URL');
  const explicitReviewKey = present(env,'REVIEW_API_KEY');
  if (!customReviewBase && explicitReviewKey) {
    throw new Error('REVIEW_API_BASE_URL variable is required when REVIEW_API_KEY is set');
  }
  const reviewBase = normalizeBaseUrl(customReviewBase || codingBase,'REVIEW_API_BASE_URL');
  const reviewKey = explicitReviewKey || (reviewBase === codingBase ? codingKey : '');
  if (!reviewKey) throw new Error('REVIEW_API_KEY secret is required when the review API URL differs from the coding URL');
  const reviewModel = modelId(present(env,'REVIEW_API_MODEL') || codingModel,'REVIEW_API_MODEL');
  return {
    coding:{baseUrl:codingBase,model:codingModel,apiKey:codingKey,legacy},
    review:{baseUrl:reviewBase,model:reviewModel,apiKey:reviewKey}
  };
}

export function openCodeProvider(coding) {
  const modelConfig = {name:'Configured coding model',tool_call:true,limit:{context:131072,output:8192}};
  if (coding.legacy) {
    return {
      selectedModel:'deepseek/'+coding.model,
      provider:{deepseek:{options:{apiKey:'{env:DEEPSEEK_API_KEY}'},models:{[coding.model]:modelConfig}}}
    };
  }
  return {
    selectedModel:'coding/'+coding.model,
    provider:{coding:{
      npm:'@ai-sdk/openai-compatible',
      name:'Configured coding API',
      options:{baseURL:coding.baseUrl,apiKey:'{env:CODING_API_KEY}'},
      models:{[coding.model]:modelConfig}
    }}
  };
}

// Return only verified assistant content; never include URLs, response bodies, or secrets
// in failure messages. Disable redirects so Authorization cannot reach another origin.
export async function chatCompletion(api,messages,params={},transport=fetch) {
  const response=await transport(api.baseUrl+'/chat/completions',{
    method:'POST',
    redirect:'error',
    headers:{'Content-Type':'application/json',Authorization:'Bearer '+api.apiKey},
    body:JSON.stringify({model:api.model,messages,...params}),
    signal:AbortSignal.timeout(120000)
  });
  if (!response.ok) throw new Error('Configured model API HTTP '+response.status);
  let data;
  try {data=await response.json();}
  catch {throw new Error('Configured model API returned invalid JSON');}
  const content=data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Configured model API did not return a non-empty chat completion');
  }
  return content;
}

// The coding provider can intermittently return an empty completion or transient
// transport error. Retry only those failures; permanent configuration/auth errors
// remain immediate. This bounded probe runs before OpenCode starts.
export async function probeApi(api,{transport=fetch,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
  for (let attempt=0; attempt<3; attempt++) {
    try {
      return await chatCompletion(api,[{role:'user',content:'Reply OK.'}],{max_tokens:16},transport);
    } catch (error) {
      const message=error instanceof Error ? error.message : '';
      const transient =
        message === 'Configured model API did not return a non-empty chat completion' ||
        message === 'Configured model API returned invalid JSON' ||
        /Configured model API HTTP (429|5\\d\\d)$/.test(message) ||
        error?.name === 'TimeoutError' ||
        error?.name === 'AbortError' ||
        error instanceof TypeError;
      if (!transient || attempt === 2) throw error;
      await sleep(250 * (attempt + 1));
    }
  }
  throw new Error('Configured model API probe failed');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === 'check') {
  const cfg=resolveApiConfig();
  console.log('Coding/review API settings valid; coding mode: '+(cfg.coding.legacy?'legacy DeepSeek':'custom OpenAI-compatible')+'.');
}
