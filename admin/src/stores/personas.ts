import { defineStore } from 'pinia';
import { request, put } from '../api/client';
import type { PersonaRegistry } from '../types';

interface PersonaState {
  data: PersonaRegistry | null;
  loading: boolean;
  saving: boolean;
}

export const usePersonaStore = defineStore('personas', {
  state: (): PersonaState => ({
    data: null,
    loading: false,
    saving: false
  }),
  actions: {
    async fetchPersonas(): Promise<void> {
      this.loading = true;
      try {
        this.data = await request<PersonaRegistry>('/admin/personas');
      } finally {
        this.loading = false;
      }
    },
    async savePersonas(data: PersonaRegistry): Promise<void> {
      this.saving = true;
      try {
        await put<{ ok: boolean }>('/admin/personas', data);
        this.data = data;
      } finally {
        this.saving = false;
      }
    }
  }
});
