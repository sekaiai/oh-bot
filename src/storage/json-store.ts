import { promises as fs } from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

export class JsonStore<T extends object> {
  constructor(
    private readonly filePath: string,
    private readonly defaultData: T
  ) {}

  async init(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    try {
      await fs.access(this.filePath);
    } catch {
      await this.write(this.defaultData);
      logger.info({ filePath: this.filePath }, 'Initialized JSON store with default data');
    }
  }

  async read(): Promise<T> {
    await this.init();

    try {
      const raw = await fs.readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as T;
    } catch (error) {
      logger.error({ err: error, filePath: this.filePath }, 'Failed to read JSON store, resetting to defaults');
      await this.write(this.defaultData);
      return structuredClone(this.defaultData);
    }
  }

  async write(data: T): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    await fs.rename(tmpPath, this.filePath);
  }
}
