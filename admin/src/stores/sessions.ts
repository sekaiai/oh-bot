import { defineStore } from 'pinia';
import { request, put } from '../api/client';
import type {
  SessionDetailResponse,
  SessionItemSummary,
  SessionsResponse,
  UpdateSessionSettingsPayload,
  UpdateSessionSettingsResponse
} from '../types';

interface SessionState {
  sessions: SessionItemSummary[];
  total: number;
  loading: boolean;
  selectedChatKey: string;
  detail: SessionDetailResponse | null;
  detailLoading: boolean;
  saving: boolean;
  refreshedAt: number | null;
}

export const useSessionsStore = defineStore('sessions', {
  state: (): SessionState => ({
    sessions: [],
    total: 0,
    loading: false,
    selectedChatKey: '',
    detail: null,
    detailLoading: false,
    saving: false,
    refreshedAt: null
  }),
  actions: {
    syncSummary(summary: SessionItemSummary): void {
      const currentIndex = this.sessions.findIndex((item) => item.chatKey === summary.chatKey);
      if (currentIndex >= 0) {
        this.sessions.splice(currentIndex, 1, summary);
      } else {
        this.sessions.unshift(summary);
        this.total = this.sessions.length;
      }

      if (this.detail?.chatKey === summary.chatKey) {
        this.detail = {
          ...this.detail,
          summary
        };
      }
    },
    async fetchSessions(options?: { silent?: boolean }): Promise<void> {
      if (!options?.silent) {
        this.loading = true;
      }
      try {
        const payload = await request<SessionsResponse>('/admin/sessions');
        this.sessions = payload.sessions;
        this.total = payload.total;
        this.refreshedAt = Date.now();
        if (this.selectedChatKey && !payload.sessions.some((item) => item.chatKey === this.selectedChatKey)) {
          this.selectedChatKey = '';
          this.detail = null;
        } else if (this.selectedChatKey && this.detail) {
          const nextSummary = payload.sessions.find((item) => item.chatKey === this.selectedChatKey);
          if (nextSummary) {
            this.detail = {
              ...this.detail,
              summary: nextSummary
            };
          }
        }
      } finally {
        if (!options?.silent) {
          this.loading = false;
        }
      }
    },
    async fetchSessionDetail(chatKey: string, options?: { silent?: boolean }): Promise<void> {
      this.selectedChatKey = chatKey;
      if (!options?.silent) {
        this.detailLoading = true;
      }
      try {
        const payload = await request<SessionDetailResponse>(`/admin/sessions?chatKey=${encodeURIComponent(chatKey)}`);
        this.detail = payload;
        this.syncSummary(payload.summary);
      } finally {
        if (!options?.silent) {
          this.detailLoading = false;
        }
      }
    },
    clearSelection(): void {
      this.selectedChatKey = '';
      this.detail = null;
    },
    async saveSessionSettings(payload: UpdateSessionSettingsPayload): Promise<SessionItemSummary> {
      this.saving = true;
      try {
        const response = await put<UpdateSessionSettingsResponse>('/admin/sessions/settings', payload);
        this.syncSummary(response.summary);
        return response.summary;
      } finally {
        this.saving = false;
      }
    }
  }
});
