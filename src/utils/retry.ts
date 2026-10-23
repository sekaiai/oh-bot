/**
 * 重试工具。
 *
 * 该模块用于把“失败后等待再试”的通用流程收敛到一个地方，
 * 避免每个调用点都手写各自的 while/try/catch/sleep 模板。
 */
import { sleep } from './helpers.js';

/**
 * 执行一个带重试的异步任务。
 *
 * 输入：
 * - `fn`：需要执行的异步函数；
 * - `options.retries`：失败后的最大重试次数，不包含首次执行；
 * - `options.delayMs`：首次重试前的等待时间；
 * - `options.factor`：每次失败后延迟的增长系数，默认 1.5。
 *
 * 输出：返回 `fn` 成功时的结果；如果所有尝试均失败，则抛出最后一次错误。
 *
 * 这里抛出“最后一次错误”而不是包装后的统一异常，
 * 是为了最大程度保留原始调用栈和底层错误语义，方便上层判断真实失败原因。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { retries: number; delayMs: number; factor?: number }
): Promise<T> {
  const factor = options.factor ?? 1.5;
  // `attempt` 只统计“已经发生过多少次失败后的重试”，因此 while 条件使用 `<=`。
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

      /**
       * 延迟增长在失败后生效，而不是预先计算所有时间，
       * 这样更容易保留“当前第几次重试使用了什么等待时间”的直觉。
       */
      await sleep(delay);
      delay = Math.ceil(delay * factor);
      attempt += 1;
    }
  }

  // 理论上只有至少失败过一次才会走到这里，因此直接抛出最后一次捕获到的错误。
  throw lastError;
}
