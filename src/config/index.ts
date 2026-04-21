/**
 * 配置加载模块。
 *
 * 这个模块在 import 时立即完成 `.env` 读取和 schema 校验，并导出一个已经过类型收敛的配置对象。
 * 这样做的约束是：配置错误会在进程启动早期直接失败，而不是等到运行过程中才以业务异常形式暴露。
 */
import dotenv from 'dotenv';
import { envSchema, type EnvConfig } from './schema.js';
import { logger } from '../utils/logger.js';

// 配置在模块加载阶段一次性注入，避免后续模块各自重复读取环境变量。
dotenv.config();

// 使用 safeParse 保留完整错误信息，便于启动阶段一次性看到所有缺失或格式错误的字段。
const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  logger.error({ errors: parsed.error.flatten() }, 'Invalid environment variables');
  throw new Error('Environment validation failed');
}

/**
 * 全局只读运行配置。
 *
 * 隐含约束：业务代码应当消费这里导出的 `config`，
 * 而不是再次直接读取 `process.env`，否则会绕过 schema 的默认值与校验结果。
 */
export const config: EnvConfig = parsed.data;

// 启动时打印“关键但不敏感”的配置，便于确认当前连接的是哪个协议端和模型环境。
logger.info(
  {
    napcatWsUrl: config.NAPCAT_WS_URL,
    aiBaseUrl: config.AI_BASE_URL,
    aiModel: config.AI_MODEL,
    maxContextMessages: config.MAX_CONTEXT_MESSAGES,
    logLevel: config.LOG_LEVEL
  },
  'Configuration loaded'
);
