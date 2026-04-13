import dotenv from 'dotenv';
import { envSchema, type EnvConfig } from './schema.js';
import { logger } from '../utils/logger.js';

dotenv.config();

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  logger.error({ errors: parsed.error.flatten() }, 'Invalid environment variables');
  throw new Error('Environment validation failed');
}

export const config: EnvConfig = parsed.data;

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
