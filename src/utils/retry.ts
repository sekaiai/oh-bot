import { sleep } from './helpers.js';

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries: number; delayMs: number; factor?: number }
): Promise<T> {
  const factor = options.factor ?? 1.5;
  let attempt = 0;
  let delay = options.delayMs;
  let lastError: unknown;

  while (attempt <= options.retries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === options.retries) {
        break;
      }
      await sleep(delay);
      delay = Math.ceil(delay * factor);
      attempt += 1;
    }
  }

  throw lastError;
}
