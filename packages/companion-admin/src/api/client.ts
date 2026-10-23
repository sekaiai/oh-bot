import { z } from 'zod';
import { getBearerToken } from '../auth/session';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ApiError'; }
}

const secretPatterns = [/((?:api[-_ ]?key|token|secret|password|credential)\s*[=:]\s*)[^\s,;]+/gi, /sk-[A-Za-z0-9_-]{8,}/g];
export function redactSecrets(value: string): string {
  const keyed = value.replace(/(["']?(?:access.?token|token|password|credential|(?:api|provider)[_-]?key|secret)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1[已隐藏]');
  return secretPatterns.reduce((result, pattern) => result.replace(pattern, '$1[已隐藏]'), keyed);
}

export class ApiClient {
  private readonly base: string;
  constructor(baseUrl: string, private readonly token: () => string | null, private readonly fetcher?: typeof fetch) {
    this.base = baseUrl.trim().replace(/\/$/, '');
  }
  async request<T>(path: string, method: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await (this.fetcher ?? fetch)(`${this.base}${path}`, { method, credentials: 'omit', headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) {
      let message = `请求失败（${response.status}）`;
      try { const payload: unknown = await response.json(); if (typeof payload === 'object' && payload !== null && 'message' in payload && typeof payload.message === 'string') message = redactSecrets(payload.message); } catch { /* retain status message */ }
      throw new ApiError(response.status, message);
    }
    if (response.status === 204) return undefined as T;
    const data: unknown = await response.json();
    return schema ? schema.parse(data) : data as T;
  }
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>, schema?: z.ZodType<T>): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) params.set(key, String(value));
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request(`${path}${suffix}`, 'GET', undefined, schema);
  }
  post<T>(path: string, body?: unknown, schema?: z.ZodType<T>): Promise<T> { return this.request(path, 'POST', body, schema); }
  put<T>(path: string, body: unknown, schema?: z.ZodType<T>): Promise<T> { return this.request(path, 'PUT', body, schema); }
  patch<T>(path: string, body: unknown, schema?: z.ZodType<T>): Promise<T> { return this.request(path, 'PATCH', body, schema); }
  delete<T>(path: string, body?: unknown): Promise<T> { return this.request(path, 'DELETE', body); }
}

export const api = new ApiClient(import.meta.env.VITE_COMPANION_ADMIN_API_BASE_URL || (typeof window === 'undefined' ? '' : window.location.origin), getBearerToken);
