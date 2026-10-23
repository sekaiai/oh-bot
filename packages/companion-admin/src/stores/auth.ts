import { defineStore } from 'pinia';
import { api, ApiError } from '../api/client';
import { loginSchema, successSchema } from '../api/schemas';
import { getBearerToken, setBearerToken } from '../auth/session';

export const useAuthStore = defineStore('auth', {
  state: () => ({ authenticated: Boolean(getBearerToken()), busy: false, error: '' }),
  actions: {
    async login(password: string) {
      this.busy = true; this.error = '';
      try { const result = await api.post('/admin/login', { password }, loginSchema); setBearerToken(result.token); this.authenticated = true; }
      catch (error) { this.error = error instanceof Error ? error.message : '登录失败'; throw error; }
      finally { this.busy = false; }
    },
    async restore() {
      if (!getBearerToken()) { this.authenticated = false; return; }
      try { await api.get('/admin/operations/status'); this.authenticated = true; }
      catch (error) { if (error instanceof ApiError && error.status === 401) { setBearerToken(null); this.authenticated = false; } }
    },
    async logout() {
      try { await api.post('/admin/logout', {}, successSchema); } catch { /* local logout must still clear memory */ }
      setBearerToken(null); this.authenticated = false;
    }
  }
});
