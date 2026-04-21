import path from 'node:path';
import type { RuleConfig } from '../types/bot.js';
import { JsonStore } from './json-store.js';

const defaultRules: RuleConfig = {
  admins: [],
  whitelistGroups: [],
  blacklistUsers: [],
  requireAtInGroup: true,
  aiEnabled: true,
  commandPrefix: '/',
  cooldownSeconds: 3
};

export class RulesStore {
  private readonly store: JsonStore<RuleConfig>;

  constructor(dataDir = path.resolve(process.cwd(), 'data')) {
    this.store = new JsonStore<RuleConfig>(path.join(dataDir, 'rules.json'), defaultRules);
  }

  async read(): Promise<RuleConfig> {
    return this.store.read();
  }

  async write(rules: RuleConfig): Promise<void> {
    await this.store.write(rules);
  }
}
