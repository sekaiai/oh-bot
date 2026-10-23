import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAuthStore } from './auth';
import { getBearerToken, setBearerToken } from '../auth/session';

afterEach(() => { vi.unstubAllGlobals(); setBearerToken(null); });

describe('memory-only admin login', () => {
  it('keeps bearer in page memory, attaches it to calls, and clears it on logout', async () => {
    setActivePinia(createPinia());
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: 'session-bearer' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const auth = useAuthStore();
    await auth.login('password');
    expect(auth.authenticated).toBe(true);
    expect(getBearerToken()).toBe('session-bearer');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit' });
    expect(localStorage.getItem('token')).toBeNull();
    expect(sessionStorage.getItem('token')).toBeNull();
    await auth.logout();
    expect(getBearerToken()).toBeNull();
    expect(auth.authenticated).toBe(false);
  });
});
