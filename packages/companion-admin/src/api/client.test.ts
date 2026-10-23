import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client';
import { z } from 'zod';

afterEach(() => vi.unstubAllGlobals());

describe('ApiClient', () => {
  it('sends bearer auth without browser credential storage or cookies', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const api = new ApiClient('https://companion.example/', () => 'memory-token', fetcher as typeof fetch);
    await api.get('/admin/operations/status');
    expect(fetcher).toHaveBeenCalledWith('https://companion.example/admin/operations/status', expect.objectContaining({
      credentials: 'omit', headers: expect.objectContaining({ Authorization: 'Bearer memory-token' })
    }));
  });

  it('validates responses with Zod and redacts secret-like error content', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'provider_key=sk-live-secret' }), { status: 503 }));
    const api = new ApiClient('', () => null, fetcher as typeof fetch);
    await expect(api.get('/admin/overview')).rejects.toMatchObject({ status: 503 });
    try { await api.get('/admin/overview'); } catch (error) {
      expect((error as ApiError).message).not.toContain('sk-live-secret');
    }
  });

  it('redacts key-addressed opaque values in structured server error strings', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: '{"accessToken":"opaque-access","password":"opaque-password"}' }), { status: 500 }));
    const api = new ApiClient('', () => null, fetcher as typeof fetch);
    try { await api.get('/admin/overview'); } catch (error) {
      expect((error as ApiError).message).not.toContain('opaque-access');
      expect((error as ApiError).message).not.toContain('opaque-password');
    }
  });

  it('rejects payloads that do not match the response schema', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ total: 'many' }), { status: 200 }));
    const api = new ApiClient('', () => null, fetcher as typeof fetch);
    await expect(api.get('/admin/overview', undefined, z.object({ total: z.number() }))).rejects.toThrow();
  });
});
