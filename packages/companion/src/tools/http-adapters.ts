import { z } from 'zod';
import type { ToolDefinition } from './registry.js';

const sourceSchema = z.object({
  title: z.string().trim().min(1).max(300),
  url: z.string().url().max(2048),
  snippet: z.string().max(2000),
}).strict().superRefine((source, context) => {
  try {
    const url = new URL(source.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'unsafe source URL', path: ['url'] });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid source URL', path: ['url'] });
  }
});

const searchUnavailable = z.object({
  status: z.literal('unavailable'),
  results: z.array(z.never()),
}).strict();
const searchAvailable = z.object({
  status: z.literal('available'),
  results: z.array(sourceSchema).max(10),
}).strict();
const searchOutput = z.discriminatedUnion('status', [searchUnavailable, searchAvailable]);

const weatherUnavailable = z.object({ status: z.literal('unavailable') }).strict();
const weatherAvailable = z.object({
  status: z.literal('available'),
  location: z.string().trim().min(1).max(200),
  temperatureC: z.number().finite().min(-100).max(100),
  condition: z.string().trim().min(1).max(300),
  source: z.string().url().max(2048),
}).strict().superRefine((weather, context) => {
  try {
    if (!['https:', 'http:'].includes(new URL(weather.source).protocol)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'unsafe source URL', path: ['source'] });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid source URL', path: ['source'] });
  }
});
const weatherOutput = z.union([weatherUnavailable, weatherAvailable]);

type AdapterOptions = Readonly<{
  apiUrl?: string;
  credentialRef?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  timeoutMs?: number;
}>;

function safeEndpoint(value: string | undefined): URL | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function configuredToken(options: AdapterOptions): string | undefined {
  const reference = options.credentialRef;
  if (!reference || !/^[A-Z][A-Z0-9_]{0,127}$/.test(reference)) return undefined;
  const value = (options.env ?? process.env)[reference]?.trim();
  return value && !/^(?:<|\$\{|change-?me|replace[_-]?me|todo)/i.test(value) ? value : undefined;
}

async function postJson(options: AdapterOptions, payload: unknown, signal?: AbortSignal): Promise<unknown> {
  const endpoint = safeEndpoint(options.apiUrl);
  const token = configuredToken(options);
  if (!endpoint || !token) return undefined;

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), options.timeoutMs ?? 5_000);
  const requestSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await (options.fetch ?? fetch)(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
      signal: requestSignal,
      redirect: 'error',
    });
    if (!response.ok) return undefined;
    const body = await response.text();
    if (body.length > 64_000) return undefined;
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function createSearchHttpTool(options: AdapterOptions = {}): ToolDefinition {
  return {
    name: 'search',
    permission: 'search',
    input: z.object({ query: z.string().trim().min(1).max(500) }).strict(),
    output: searchOutput,
    run: async ({ query }, context) => {
      if (context.signal.aborted) return { status: 'unavailable', results: [] };
      const raw = await postJson(
        { ...options, timeoutMs: Math.min(options.timeoutMs ?? 5_000, context.budget.timeoutMs) },
        { query },
        context.signal,
      );
      const parsed = searchAvailable.safeParse(raw);
      return parsed.success ? parsed.data : { status: 'unavailable', results: [] };
    },
  };
}

export function createWeatherHttpTool(options: AdapterOptions = {}): ToolDefinition {
  return {
    name: 'weather',
    permission: 'weather',
    input: z.object({ location: z.string().trim().min(1).max(200) }).strict(),
    output: weatherOutput,
    run: async ({ location }, context) => {
      if (context.signal.aborted) return { status: 'unavailable' };
      const raw = await postJson(
        { ...options, timeoutMs: Math.min(options.timeoutMs ?? 5_000, context.budget.timeoutMs) },
        { location },
        context.signal,
      );
      const parsed = weatherAvailable.safeParse(raw);
      return parsed.success ? parsed.data : { status: 'unavailable' };
    },
  };
}
