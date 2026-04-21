import type { SessionMessage } from '../types/bot.js';
import { SessionsStore } from '../storage/sessions-store.js';

export class SessionManager {
  constructor(
    private readonly sessionsStore: SessionsStore,
    private readonly maxContextMessages: number
  ) {}

  async getMessages(sessionKey: string): Promise<SessionMessage[]> {
    return this.sessionsStore.getSession(sessionKey);
  }

  async appendMessage(sessionKey: string, message: SessionMessage): Promise<void> {
    const messages = await this.sessionsStore.getSession(sessionKey);
    messages.push(message);
    const trimmed = messages.slice(-this.maxContextMessages);
    await this.sessionsStore.setSession(sessionKey, trimmed);
  }

  async appendMessages(sessionKey: string, messagesToAdd: SessionMessage[]): Promise<void> {
    const messages = await this.sessionsStore.getSession(sessionKey);
    messages.push(...messagesToAdd);
    const trimmed = messages.slice(-this.maxContextMessages);
    await this.sessionsStore.setSession(sessionKey, trimmed);
  }

  async clearSession(sessionKey: string): Promise<void> {
    await this.sessionsStore.clearSession(sessionKey);
  }
}
