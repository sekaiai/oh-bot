import path from 'node:path';
import type { SessionMessage } from '../types/bot.js';
import { JsonStore } from './json-store.js';

export interface SessionsData {
  sessions: Record<string, SessionMessage[]>;
}

export class SessionsStore {
  private readonly store: JsonStore<SessionsData>;

  constructor(dataDir = path.resolve(process.cwd(), 'data')) {
    this.store = new JsonStore<SessionsData>(path.join(dataDir, 'sessions.json'), {
      sessions: {}
    });
  }

  async getSession(sessionKey: string): Promise<SessionMessage[]> {
    const data = await this.store.read();
    return data.sessions[sessionKey] ?? [];
  }

  async setSession(sessionKey: string, messages: SessionMessage[]): Promise<void> {
    const data = await this.store.read();
    data.sessions[sessionKey] = messages;
    await this.store.write(data);
  }

  async clearSession(sessionKey: string): Promise<void> {
    const data = await this.store.read();
    delete data.sessions[sessionKey];
    await this.store.write(data);
  }
}
