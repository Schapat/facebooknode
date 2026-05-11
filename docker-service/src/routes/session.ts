import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionManager } from '../services/session-manager';
import type { CookieFormat } from '@facebook-automation/shared-types';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger({ service: 'SessionRoutes' });

const importSchema = z.object({
  sessionName: z.string().min(1),
  cookies: z.unknown(),
  format: z.enum(['chrome-export', 'editthiscookie', 'playwright-state', 'puppeteer-array', 'json']).default('json'),
  userAgent: z.string().optional(),
  proxy: z
    .object({
      server: z.string(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  localStorage: z.record(z.string()).optional(),
  sessionStorage: z.record(z.string()).optional(),
});

export function registerSessionRoutes(
  app: FastifyInstance,
  sessionManager: SessionManager,
): void {
  app.post('/session/import', {
    schema: {
      description: 'Import a Facebook session with cookies',
      tags: ['Session'],
      body: {
        type: 'object',
        required: ['sessionName', 'cookies'],
        properties: {
          sessionName: { type: 'string' },
          cookies: {},
          format: { type: 'string', enum: ['chrome-export', 'editthiscookie', 'playwright-state', 'puppeteer-array', 'json'] },
          userAgent: { type: 'string' },
          proxy: {
            type: 'object',
            properties: {
              server: { type: 'string' },
              username: { type: 'string' },
              password: { type: 'string' },
            },
          },
          localStorage: { type: 'object' },
          sessionStorage: { type: 'object' },
        },
      },
    },
    handler: async (request, reply) => {
      const body = importSchema.parse(request.body);

      const session = await sessionManager.importSession({
        sessionName: body.sessionName,
        cookies: body.cookies,
        format: body.format as CookieFormat,
        userAgent: body.userAgent,
        proxy: body.proxy,
        localStorage: body.localStorage,
        sessionStorage: body.sessionStorage,
      });

      return reply.status(201).send({
        success: true,
        data: {
          sessionName: session.accountName,
          sessionId: session.sessionId,
          isValid: session.isValid,
        },
        timestamp: new Date().toISOString(),
      });
    },
  });

  app.get('/session/status', {
    schema: {
      description: 'Get session status',
      tags: ['Session'],
      querystring: {
        type: 'object',
        required: ['sessionName'],
        properties: {
          sessionName: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { sessionName } = request.query as { sessionName: string };
      const status = await sessionManager.getSessionStatus(sessionName);

      return reply.send({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    },
  });

  app.post('/session/refresh', {
    schema: {
      description: 'Refresh a session',
      tags: ['Session'],
      body: {
        type: 'object',
        required: ['sessionName'],
        properties: {
          sessionName: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { sessionName } = request.body as { sessionName: string };
      const session = await sessionManager.refreshSession(sessionName);

      return reply.send({
        success: true,
        data: {
          sessionName: session.accountName,
          isValid: session.isValid,
          lastValidated: session.lastValidatedAt,
        },
        timestamp: new Date().toISOString(),
      });
    },
  });

  app.get('/session/export', {
    schema: {
      description: 'Export session cookies and storage',
      tags: ['Session'],
      querystring: {
        type: 'object',
        required: ['sessionName'],
        properties: {
          sessionName: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { sessionName } = request.query as { sessionName: string };
      const exported = await sessionManager.exportSession(sessionName);

      return reply.send({
        success: true,
        data: exported,
        timestamp: new Date().toISOString(),
      });
    },
  });

  app.get('/session/list', {
    schema: {
      description: 'List all sessions',
      tags: ['Session'],
    },
    handler: async (_request, reply) => {
      const sessions = await sessionManager.listSessions();

      return reply.send({
        success: true,
        data: { sessions },
        timestamp: new Date().toISOString(),
      });
    },
  });
}
