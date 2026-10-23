import { defineStore } from 'pinia';
import { request } from '../api/client';
import type { ConfigSummary } from '../types';

interface SummaryState {
  data: ConfigSummary | null;
  loading: boolean;
}

export const useSummaryStore = defineStore('summary', {
  state: (): SummaryState => ({
    data: null,
    loading: false
  }),
  actions: {
    async fetchSummary(): Promise<void> {
      this.loading = true;
      try {
        this.data = await request<ConfigSummary>('/admin/config-summary');
      } finally {
        this.loading = false;
      }
    }
  }
});
