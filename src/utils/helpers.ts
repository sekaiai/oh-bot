/**
 * 通用辅助函数。
 *
 * 这里放的是无业务语义、可被多个模块复用的基础工具。
 * 保持这一层足够薄，有助于避免“杂项逻辑”逐步长成难以维护的工具黑盒。
 */
/**
 * 将可能来自外部协议的 ID 统一转换为字符串。
 *
 * 输入：未知类型的 ID 值。
 * 输出：有效 string；若输入不可用则返回空字符串。
 *
 * 这里故意不返回 `undefined`/`null`，是为了让调用方可以统一用“空字符串判空”处理，
 * 减少不同空值语义在适配层扩散。
 */
export function toStringId(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return '';
}

/**
 * 基于 Promise 的睡眠函数。
 *
 * 主要用于重试、退避等时序控制逻辑。
 * 它本身没有取消能力，因此在需要中断等待的场景下，不能单独依赖这个工具。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
