import type { RuleConfig } from '../types/bot.js';
import { RulesStore } from '../storage/rules-store.js';

export class RuleService {
  constructor(private readonly rulesStore: RulesStore) {}

  async getRules(): Promise<RuleConfig> {
    return this.rulesStore.read();
  }

  async updateRules(patch: Partial<RuleConfig>): Promise<RuleConfig> {
    const current = await this.rulesStore.read();
    const next: RuleConfig = {
      ...current,
      ...patch
    };
    await this.rulesStore.write(next);
    return next;
  }

  async isAdmin(userId: string): Promise<boolean> {
    const rules = await this.getRules();
    return rules.admins.includes(userId);
  }
}
