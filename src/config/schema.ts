import { z } from 'zod';

export const envSchema = z.object({
  NAPCAT_WS_URL: z.string().url(),
  NAPCAT_ACCESS_TOKEN: z.string().optional().default(''),
  AI_BASE_URL: z.string().url(),
  AI_API_KEY: z.string().optional().default(''),
  AI_MODEL: z.string().min(1),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MAX_CONTEXT_MESSAGES: z.coerce.number().int().positive().default(20),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info')
});

export type EnvConfig = z.infer<typeof envSchema>;
