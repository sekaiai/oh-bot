import { defineStore } from 'pinia';
import { ApiError, post, request } from '../api/client';

interface AuthState {
  authenticated: boolean;
  loading: boolean;
}

export const useAuthStore = defineStore('auth', {
  state: (): AuthState => ({
    authenticated: false,
    loading: false
  }),
  actions: {
    async login(password: string): Promise<void> {
      this.loading = true;
      try {
        await post<{ ok: boolean }>('/admin/login', { password });
        this.authenticated = true;
      } finally {
        this.loading = false;
      }
    },
    async logout(): Promise<void> {
      try {
        await post<{ ok: boolean }>('/admin/logout');
      } finally {
        this.authenticated = false;
      }
    },
    async restore(): Promise<void> {
      this.loading = true;
      try {
        await request('/admin/config-summary');
        this.authenticated = true;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          this.authenticated = false;
          return;
        }

        this.authenticated = false;
      } finally {
        this.loading = false;
      }
    }
  }
});
