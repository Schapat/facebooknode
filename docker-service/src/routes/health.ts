import type { FastifyInstance } from 'fastify';
import type { RedisClient } from '../infrastructure/redis';

export function registerHealthRoutes(
  app: FastifyInstance,
  redis: RedisClient,
): void {
  app.get('/health', {
    schema: {
      description: 'Health check endpoint',
      tags: ['Health'],
    },
    handler: async (_request, reply) => {
      const redisHealthy = await redis.healthCheck();

      const status = redisHealthy ? 'healthy' : 'degraded';
      const statusCode = redisHealthy ? 200 : 503;

      return reply.status(statusCode).send({
        status,
        services: {
          redis: redisHealthy ? 'up' : 'down',
        },
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      });
    },
  });
}
