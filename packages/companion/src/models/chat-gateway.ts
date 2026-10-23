import { z } from 'zod';

export const chatRoleSchema = z.enum(['system', 'user', 'assistant']);
export type ChatRole = z.infer<typeof chatRoleSchema>;

export const chatMessageSchema = z
  .object({ role: chatRoleSchema, content: z.string().min(1).max(32000) })
  .strict();
export type ChatMessage = Readonly<z.infer<typeof chatMessageSchema>>;

export const chatRequestSchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1).max(200),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(100_000).optional(),
    timeoutMs: z.number().int().min(100).max(3_600_000).optional(),
  })
  .strict();
export type ChatRequest = Readonly<z.infer<typeof chatRequestSchema>>;

export type ChatReply = Readonly<{
  text: string;
  model: string;
  finishReason: string | null;
  usage: Readonly<{ promptTokens: number; completionTokens: number; totalTokens: number }> | null;
}>;

export type ModelGateway = Readonly<{ complete(request: ChatRequest): Promise<ChatReply> }>;

export const chatProviderConfigSchema = z
  .object({ baseUrl: z.string().min(1), apiKey: z.string().min(1), model: z.string().min(1) })
  .strict();
export type ChatProviderConfig = Readonly<z.infer<typeof chatProviderConfigSchema>>;

export const DEFAULT_CHAT_MODEL_TIMEOUT_MS = 30_000;

const gatewayErrorCodes = [
  'model_not_configured',
  'model_invalid_config',
  'model_unauthorized',
  'model_rate_limited',
  'model_timeout',
  'model_unreachable',
  'model_invalid_response',
  'model_upstream_error',
] as const;
export type ModelGatewayErrorCode = typeof gatewayErrorCodes[number];

export class ModelGatewayError extends Error {
  constructor(readonly code: ModelGatewayErrorCode) {
    super(code);
  }
}

const businessChatEnvSchema = z.object({
  COMPANION_CHAT_API_URL: z.string().optional(),
  COMPANION_CHAT_API_KEY: z.string().optional(),
  COMPANION_CHAT_MODEL: z.string().optional(),
});
function isPlaceholder(value: string): boolean {
  return (
    value.startsWith('<') ||
    value.startsWith('${') ||
    /^(?:change-?me|replace[_-]?me|todo|your.*|replace.*)$/i.test(value)
  );
}

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '' && !isPlaceholder(value.trim());
}

/** Reads only explicitly configured business chat credentials; never falls back to coding/model-automation secrets. */
export function loadChatProviderConfig(env: NodeJS.ProcessEnv): ChatProviderConfig {
  const parsed = businessChatEnvSchema.safeParse(env);
  if (
    !parsed.success ||
    !present(parsed.data.COMPANION_CHAT_API_URL) ||
    !present(parsed.data.COMPANION_CHAT_API_KEY) ||
    !present(parsed.data.COMPANION_CHAT_MODEL)
  ) {
    throw new ModelGatewayError('model_not_configured');
  }
  const config = {
    baseUrl: parsed.data.COMPANION_CHAT_API_URL.trim(),
    apiKey: parsed.data.COMPANION_CHAT_API_KEY.trim(),
    model: parsed.data.COMPANION_CHAT_MODEL.trim(),
  };
  if (!resolveChatCompletionsUrl(config.baseUrl)) {
    throw new ModelGatewayError('model_invalid_config');
  }
  return Object.freeze({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model });
}

/** Accepts a base URL (with or without `/v1`) or an explicit `/chat/completions` endpoint. */
export function resolveChatCompletionsUrl(baseUrl: string): URL | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  if (url.search || url.hash) return undefined;
  url.search = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) {
    url.pathname = pathname;
  } else {
    url.pathname = `${pathname}/chat/completions`;
  }
  return url;
}

const completionResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.string().nullable().optional() }).passthrough().optional(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
    model: z.string().optional(),
    usage: z
      .object({
        prompt_tokens: z.number().optional(),
        completion_tokens: z.number().optional(),
        total_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export type ChatGatewayOptions = Readonly<{
  config: ChatProviderConfig;
  fetch?: typeof fetch;
  defaultTimeoutMs?: number;
}>;

/**
 * Minimal OpenAI-compatible Chat Completions client. Messages are the only payload
 * sent upstream; no actor, memory, or credential data is added implicitly.
 */
export class OpenAiCompatibleChatGateway implements ModelGateway {
  private readonly config: ChatProviderConfig;
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultTimeoutMs: number;

  constructor(options: ChatGatewayOptions) {
    const parsed = chatProviderConfigSchema.safeParse(options.config);
    if (!parsed.success) throw new ModelGatewayError('model_invalid_config');
    const endpoint = resolveChatCompletionsUrl(parsed.data.baseUrl);
    if (!endpoint) throw new ModelGatewayError('model_invalid_config');
    this.config = Object.freeze({ baseUrl: parsed.data.baseUrl, apiKey: parsed.data.apiKey, model: parsed.data.model });
    this.endpoint = endpoint;
    this.fetchImpl = options.fetch ?? fetch;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_CHAT_MODEL_TIMEOUT_MS;
  }

  /** Safe to log: never contains the API key. */
  get target(): Readonly<{ host: string; path: string; model: string }> {
    return Object.freeze({ host: this.endpoint.host, path: this.endpoint.pathname, model: this.config.model });
  }

  async complete(rawRequest: ChatRequest): Promise<ChatReply> {
    const request = chatRequestSchema.parse(rawRequest);
    const body: Record<string, unknown> = { model: this.config.model, messages: request.messages, stream: false };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ModelGatewayError('model_timeout');
      if (error instanceof TypeError) throw new ModelGatewayError('model_unreachable');
      throw new ModelGatewayError('model_upstream_error');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      // Drain the body so the socket can be reused; never surface provider text.
      try {
        await response.arrayBuffer();
      } catch {
        // Ignoring a failed drain keeps the stable classified error.
      }
      if (response.status === 401 || response.status === 403) throw new ModelGatewayError('model_unauthorized');
      if (response.status === 429) throw new ModelGatewayError('model_rate_limited');
      if (response.status === 408 || response.status === 504) throw new ModelGatewayError('model_timeout');
      if (response.status >= 300 && response.status < 400) throw new ModelGatewayError('model_invalid_config');
      throw new ModelGatewayError('model_upstream_error');
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ModelGatewayError('model_invalid_response');
    }
    const parsed = completionResponseSchema.safeParse(payload);
    if (!parsed.success) throw new ModelGatewayError('model_invalid_response');
    const choice = parsed.data.choices[0];
    const content = choice?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ModelGatewayError('model_invalid_response');
    }
    const usage = parsed.data.usage
      ? Object.freeze({
          promptTokens: numberOr(parsed.data.usage.prompt_tokens, 0),
          completionTokens: numberOr(parsed.data.usage.completion_tokens, 0),
          totalTokens: numberOr(parsed.data.usage.total_tokens, 0),
        })
      : null;
    return Object.freeze({
      text: content,
      model: typeof parsed.data.model === 'string' && parsed.data.model.length > 0 ? parsed.data.model : this.config.model,
      finishReason: choice?.finish_reason ?? null,
      usage,
    });
  }
}

export function createChatGatewayFromEnv(env: NodeJS.ProcessEnv, options: { fetch?: typeof fetch } = {}): OpenAiCompatibleChatGateway {
  return new OpenAiCompatibleChatGateway({ config: loadChatProviderConfig(env), fetch: options.fetch });
}
