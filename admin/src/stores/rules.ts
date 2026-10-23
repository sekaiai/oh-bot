import { defineStore } from 'pinia';
import { request, put } from '../api/client';
import type { RuleConfig } from '../types';

interface RuleState {
  rules: RuleConfig | null;
  loading: boolean;
  saving: boolean;
}

export const useRuleStore = defineStore('rules', {
  state: (): RuleState => ({
    rules: null,
    loading: false,
    saving: false
  }),
  actions: {
    async fetchRules(): Promise<void> {
      this.loading = true;
      try {
        this.rules = await request<RuleConfig>('/admin/rules');
      } finally {
        this.loading = false;
      }
    },
    async saveRules(rules: RuleConfig): Promise<void> {
      this.saving = true;
      try {
        await put<{ ok: boolean }>('/admin/rules', rules);
        this.rules = rules;
      } finally {
        this.saving = false;
      }
    }
  }
});
