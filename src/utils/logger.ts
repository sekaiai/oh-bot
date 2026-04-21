/**
 * 全局日志实例。
 *
 * 当前实现保持最小化：只统一日志等级，不额外封装格式化与传输。
 * 这样做的意图是先保证全项目使用同一个日志入口，后续如果要接日志平台，
 * 可以在这里集中调整，而不是逐处替换日志库调用。
 */
import pino from 'pino';

// 配置模块初始化前也可能产生日志，因此这里直接从环境变量读取基础等级作为兜底。
const level = process.env.LOG_LEVEL ?? 'info';

/**
 * 共享的 pino logger。
 */
export const logger = pino({ level });
