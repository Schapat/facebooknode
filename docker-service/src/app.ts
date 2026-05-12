import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { ServiceConfig } from '@facebook-automation/shared-types';
import type { RedisClient } from './infrastructure/redis';
import type { SessionManager } from './services/session-manager';
import type { QueueManager } from './queue/queue-manager';
import { authMiddleware } from './middleware/auth';
import { registerScrapeRoutes } from './routes/scrape';
import { registerSessionRoutes } from './routes/session';
import { registerJobRoutes } from './routes/jobs';
import { registerHealthRoutes } from './routes/health';
import { AppError } from './errors';
import { logger } from './utils/logger';

interface AppDependencies {
  config: ServiceConfig;
  redis: RedisClient;
  sessionManager: SessionManager;
  queueManager: QueueManager;
}

export async function createApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false, // We use pino directly
    trustProxy: true,
  });

  // Plugins
  await app.register(cors, { origin: true });
  await app.register(helmet);
  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  // Swagger
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Facebook Automation API',
        description: 'REST API for Facebook automation via HTTP',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            name: 'Authorization',
            in: 'header',
            description: 'API Key: "Bearer <key>" or "ApiKey <key>"',
          },
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [{ apiKey: [] }, { bearerAuth: [] }],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Request logging
  app.addHook('onRequest', async (request) => {
    logger.info(
      {
        method: request.method,
        url: request.url,
        ip: request.ip,
      },
      'Incoming request',
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info(
      {
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      'Request completed',
    );
  });

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      logger.warn(
        {
          errorCode: error.errorCode,
          statusCode: error.statusCode,
          message: error.message,
          url: request.url,
        },
        'Application error',
      );

      return reply.status(error.statusCode).send({
        success: false,
        error: error.message,
        errorCode: error.errorCode,
        requiresRelogin: error.requiresRelogin,
        timestamp: new Date().toISOString(),
      });
    }

    // Zod validation errors
    if (error.name === 'ZodError') {
      return reply.status(400).send({
        success: false,
        error: 'Validation error',
        errorCode: 'VALIDATION_ERROR',
        details: JSON.parse(error.message),
        timestamp: new Date().toISOString(),
      });
    }

    logger.error({ err: error, url: request.url }, 'Unhandled error');

    return reply.status(500).send({
      success: false,
      error: 'Internal server error',
      errorCode: 'INTERNAL_ERROR',
      timestamp: new Date().toISOString(),
    });
  });

  // Public routes (no auth)
  registerHealthRoutes(app, deps.redis);

  // Protected routes
  app.register(
    async (protectedApp) => {
      protectedApp.addHook('onRequest', authMiddleware);

      registerSessionRoutes(protectedApp, deps.sessionManager);
      registerScrapeRoutes(protectedApp, deps.queueManager);
      registerJobRoutes(protectedApp, deps.queueManager);
    },
    { prefix: '/api' },
  );

  return app;
}
