/**
 * 环境变量 schema。
 *
 * 这里同时承担三件事：
 * 1. 约束配置格式；
 * 2. 提供默认值；
 * 3. 把字符串环境变量转换为业务代码真正需要的类型。
 *
 * 后续新增配置时，应优先在这里补齐默认值和类型转换，
 * 不要把解析逻辑散落到业务模块里。
 */
import { z } from 'zod';

/**
 * 运行时环境变量定义。
 *
 * 设计上优先保证“启动即失败”，而不是在使用到某个字段时再晚失败。
 * `MAX_CONTEXT_MESSAGES` 使用 `coerce` 是因为环境变量天然是字符串，
 * 在这里集中转为 number 可以减少下游重复处理。
 */
export const envSchema = z.object({
  NAPCAT_WS_URL: z.string().url(),
  NAPCAT_ACCESS_TOKEN: z.string().optional().default(''),
  AI_BASE_URL: z.string().url(),
  AI_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().min(1),
  MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(20),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

/**
 * 由 schema 推导出的规范配置类型。
 *
 * 这个类型不是手写接口，而是直接绑定校验规则，
 * 目的是防止“类型允许，但运行时校验不允许”的漂移。
 */
export type EnvConfig = z.infer<typeof envSchema>;
