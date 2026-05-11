import { z } from 'zod';
import type { ServiceConfig } from '@facebook-automation/shared-types';

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  API_KEYS: z.string().transform((val) => val.split(',').map((k) => k.trim())),
  JWT_SECRET: z.string().min(32),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ENCRYPTION_KEY: z.string().min(32),
  MAX_CONCURRENCY: z.coerce.number().default(2),
  DEFAULT_TIMEOUT: z.coerce.number().default(60000),
  LOG_LEVEL: z.string().default('info'),
  WEBHOOK_URL: z.string().optional(),
  DATA_DIR: z.string().default('/data'),
});

const env = envSchema.parse(process.env);

export const config: ServiceConfig = {
  port: env.PORT,
  host: env.HOST,
  apiKeys: env.API_KEYS,
  jwtSecret: env.JWT_SECRET,
  redisUrl: env.REDIS_URL,
  encryptionKey: env.ENCRYPTION_KEY,
  browserHeadless: true,
  maxConcurrency: env.MAX_CONCURRENCY,
  defaultTimeout: env.DEFAULT_TIMEOUT,
  screenshotOnError: false,
  htmlDumpOnError: false,
  logLevel: env.LOG_LEVEL,
  webhookUrl: env.WEBHOOK_URL,
  dataDir: env.DATA_DIR,
};
