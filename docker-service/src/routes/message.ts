import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { QueueManager } from '../queue/queue-manager';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger({ service: 'MessageRoutes' });

const messageSchema = z.object({
  sessionName: z.string().min(1),
  username: z.string().min(1),
  message: z.string().min(1),
  priority: z.number().optional(),
});

export function registerMessageRoutes(
  app: FastifyInstance,
  queueManager: QueueManager,
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
}
