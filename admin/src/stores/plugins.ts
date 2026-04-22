import { defineStore } from 'pinia';
import { post, put, request } from '../api/client';
import type { PluginConfig, PluginTestResult } from '../types';

interface PluginState {
  items: PluginConfig[];
  loading: boolean;
  savingIds: string[];
  testingIds: string[];
}

export const usePluginStore = defineStore('plugins', {
  state: (): PluginState => ({
    items: [],
    loading: false,
    savingIds: [],
    testingIds: []
  }),
  actions: {
    async fetchPlugins(): Promise<void> {
      this.loading = true;
      try {
        this.items = await request<PluginConfig[]>('/admin/plugins');
      } finally {
        this.loading = false;
      }
    },
    async savePlugin(plugin: PluginConfig): Promise<void> {
      this.savingIds = [...this.savingIds, plugin.id];
      try {
        await put<{ ok: boolean }>(`/admin/plugins/${plugin.id}`, plugin);
        this.items = this.items.map((item) => (item.id === plugin.id ? plugin : item));
      } finally {
        this.savingIds = this.savingIds.filter((item) => item !== plugin.id);
      }
    },
    async testPlugin(plugin: PluginConfig, input: string): Promise<PluginTestResult> {
      this.testingIds = [...this.testingIds, plugin.id];
      try {
        return await post<PluginTestResult>(`/admin/plugins/${plugin.id}/test`, {
          plugin,
          input
        });
      } finally {
        this.testingIds = this.testingIds.filter((item) => item !== plugin.id);
      }
    }
  }
});
