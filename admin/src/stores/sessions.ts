import { defineStore } from 'pinia';
import { request } from '../api/client';
import type { SessionDetailResponse, SessionItemSummary, SessionsResponse } from '../types';

interface SessionState {
  sessions: SessionItemSummary[];
  total: number;
  loading: boolean;
  selectedChatKey: string;
  detail: SessionDetailResponse['session'];
  detailLoading: boolean;
}

export const useSessionsStore = defineStore('sessions', {
  state: (): SessionState => ({
    sessions: [],
    total: 0,
    loading: false,
    selectedChatKey: '',
    detail: null,
    detailLoading: false
  }),
  actions: {
    async fetchSessions(): Promise<void> {
      this.loading = true;
      try {
        const payload = await request<SessionsResponse>('/admin/sessions');
        this.sessions = payload.sessions;
        this.total = payload.total;
      } finally {
        this.loading = false;
      }
    },
    async fetchSessionDetail(chatKey: string): Promise<void> {
      this.selectedChatKey = chatKey;
      this.detailLoading = true;
      try {
        const payload = await request<SessionDetailResponse>(`/admin/sessions?chatKey=${encodeURIComponent(chatKey)}`);
        this.detail = payload.session;
      } finally {
        this.detailLoading = false;
      }
    }
  }
});
