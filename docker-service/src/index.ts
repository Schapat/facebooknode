import 'dotenv/config';
import { createApp } from './app';
import { logger } from './utils/logger';
import { config } from './config';
import { RedisClient } from './infrastructure/redis';
import { QueueManager } from './queue/queue-manager';
import { SessionManager } from './services/session-manager';

async function bootstrap(): Promise<void> {
  const redis = new RedisClient(config.redisUrl);
  await redis.connect();
  logger.info('Redis connected');

  const sessionManager = new SessionManager(redis, config);
  const queueManager = new QueueManager(redis, config, sessionManager);

  await queueManager.initialize();
  logger.info('Queue system initialized');

  const app = await createApp({
    config,
    redis,
    sessionManager,
    queueManager,
  });

  await app.listen({ port: config.port, host: config.host });
  logger.info(`Server running on ${config.host}:${config.port}`);

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received, shutting down gracefully...`);
    await queueManager.shutdown();
    await redis.disconnect();
    await app.close();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Failed to start service');
  process.exit(1);
});
