import type { PersonaConfig } from '../types/bot.js';
import type { BotMessage } from '../types/bot.js';
import { PersonasStore } from '../storage/personas-store.js';

export class PersonaService {
  constructor(private readonly personasStore: PersonasStore) {}

  async listPersonas(): Promise<PersonaConfig[]> {
    const data = await this.personasStore.read();
    return data.personas;
  }

  async getDefaultPersona(): Promise<PersonaConfig> {
    const data = await this.personasStore.read();
    const persona = data.personas.find((item) => item.id === data.defaultPersonaId);
    if (!persona) {
      throw new Error(`Default persona not found: ${data.defaultPersonaId}`);
    }
    return persona;
  }

  async getCurrentPersona(sessionKey: string): Promise<PersonaConfig> {
    const data = await this.personasStore.read();
    const boundId = data.bindings[sessionKey] ?? data.defaultPersonaId;
    const persona = data.personas.find((item) => item.id === boundId);
    if (!persona) {
      return this.getDefaultPersona();
    }
    return persona;
  }

  async setSessionPersona(sessionKey: string, personaId: string): Promise<PersonaConfig> {
    const data = await this.personasStore.read();
    const persona = data.personas.find((item) => item.id === personaId);
    if (!persona) {
      throw new Error(`Persona not found: ${personaId}`);
    }

    data.bindings[sessionKey] = personaId;
    await this.personasStore.write(data);
    return persona;
  }

  resolveSessionKey(message: BotMessage): string {
    if (message.chatType === 'group') {
      return `group:${message.groupId}`;
    }
    return `private:${message.userId}`;
  }
}
