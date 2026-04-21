import path from 'node:path';
import type { PersonaConfig } from '../types/bot.js';
import { JsonStore } from './json-store.js';

export interface PersonasData {
  defaultPersonaId: string;
  personas: PersonaConfig[];
  bindings: Record<string, string>;
}

const defaultPersonasData: PersonasData = {
  defaultPersonaId: 'assistant',
  personas: [
    {
      id: 'assistant',
      name: 'Assistant',
      systemPrompt: '你是一个可靠、简洁、友好的 QQ 助手。',
      temperature: 0.7,
      maxTokens: 512
    },
    {
      id: 'funny',
      name: 'Funny',
      systemPrompt: '你是一个幽默风趣的 QQ 群聊搭子，回答轻松但不要低俗。',
      temperature: 0.9,
      maxTokens: 512
    }
  ],
  bindings: {}
};

export class PersonasStore {
  private readonly store: JsonStore<PersonasData>;

  constructor(dataDir = path.resolve(process.cwd(), 'data')) {
    this.store = new JsonStore<PersonasData>(path.join(dataDir, 'personas.json'), defaultPersonasData);
  }

  async read(): Promise<PersonasData> {
    return this.store.read();
  }

  async write(data: PersonasData): Promise<void> {
    await this.store.write(data);
  }
}
