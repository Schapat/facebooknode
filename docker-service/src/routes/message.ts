import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { QueueManager } from '../queue/queue-manager';
import { AutoMessage } from '../operations/auto-message';
import { SessionManager } from '../services/session-manager';
import { FacebookHttpClient } from '../services/facebook-http-client';
import { E2EESignalClient } from '../services/e2ee-signal';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger({ service: 'MessageRoutes' });

const messageSchema = z.object({
  sessionName: z.string().min(1),
  username: z.string().min(1),
  message: z.string().min(1),
  priority: z.number().optional(),
});

const diagnoseSchema = z.object({
  sessionName: z.string().min(1),
  recipientId: z.string().min(1),
});

const e2eeSendSchema = z.object({
  sessionName: z.string().min(1),
  recipientId: z.string().min(1),
  message: z.string().min(1),
});

export function registerMessageRoutes(
  app: FastifyInstance,
  queueManager: QueueManager,
  sessionManager: SessionManager,
): void {
  app.post('/message/send', {
    schema: {
      description: 'Send a message to a Facebook user',
      tags: ['Message'],
      body: {
        type: 'object',
        required: ['sessionName', 'username', 'message'],
        properties: {
          sessionName: { type: 'string' },
          username: { type: 'string' },
          message: { type: 'string' },
          priority: { type: 'number' },
        },
      },
    },
    handler: async (request, reply) => {
      const body = messageSchema.parse(request.body);

      const jobId = await queueManager.addJob({
        operationType: 'send-message',
        sessionName: body.sessionName,
        input: {
          username: body.username,
          message: body.message,
        },
        priority: body.priority,
      });

      return reply.status(202).send({
        success: true,
        jobId,
        timestamp: new Date().toISOString(),
      });
    },
  });

  app.post('/message/diagnose', {
    schema: {
      description: 'Debug: inspect what mbasic/mobile compose pages return for a recipient',
      tags: ['Message'],
      body: {
        type: 'object',
        required: ['sessionName', 'recipientId'],
        properties: {
          sessionName: { type: 'string' },
          recipientId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const body = diagnoseSchema.parse(request.body);
      const autoMessage = new AutoMessage(sessionManager);

      try {
        const result = await autoMessage.diagnose(body.sessionName, body.recipientId);
        return reply.status(200).send({
          success: true,
          data: result,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        log.error({ error }, 'Diagnosis failed');
        return reply.status(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    },
  });

  // ── E2EE Send ──────────────────────────────────────────────────
  app.post('/message/e2ee-send', {
    schema: {
      description: 'Send an E2EE-encrypted message via Signal Protocol',
      tags: ['Message'],
      body: {
        type: 'object',
        required: ['sessionName', 'recipientId', 'message'],
        properties: {
          sessionName: { type: 'string' },
          recipientId: { type: 'string' },
          message: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const body = e2eeSendSchema.parse(request.body);

      try {
        const httpClient = new FacebookHttpClient(sessionManager);
        await httpClient.initSession(body.sessionName);
        const e2ee = new E2EESignalClient(httpClient);
        await e2ee.initialize();
        const result = await e2ee.sendMessage(body.recipientId, body.message);
        await httpClient.persistCookies();

        return reply.status(result.success ? 200 : 502).send({
          ...result,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        log.error({ error }, 'E2EE send failed');
        return reply.status(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    },
  });

  // ── E2EE Diagnose ──────────────────────────────────────────────
  app.post('/message/e2ee-diagnose', {
    schema: {
      description: 'Diagnose E2EE flow step by step',
      tags: ['Message'],
      body: {
        type: 'object',
        required: ['sessionName', 'recipientId'],
        properties: {
          sessionName: { type: 'string' },
          recipientId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const body = diagnoseSchema.parse(request.body);

      try {
        const httpClient = new FacebookHttpClient(sessionManager);
        await httpClient.initSession(body.sessionName);
        const e2ee = new E2EESignalClient(httpClient);
        const result = await e2ee.diagnose(body.recipientId);
        await httpClient.persistCookies();

        return reply.status(200).send({
          success: true,
          data: result,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        log.error({ error }, 'E2EE diagnosis failed');
        return reply.status(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    },
  });
}
