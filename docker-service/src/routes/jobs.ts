import type { FastifyInstance } from 'fastify';
import type { QueueManager } from '../queue/queue-manager';

export function registerJobRoutes(
  app: FastifyInstance,
  queueManager: QueueManager,
): void {
  app.get('/job/:jobId', {
    schema: {
      description: 'Get job status',
      tags: ['Jobs'],
      params: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'string' },
        },
      },
    },
    handler: async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const status = await queueManager.getJobStatus(jobId);

      return reply.send({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    },
  });

  app.get('/queue/stats', {
    schema: {
      description: 'Get queue statistics',
      tags: ['Jobs'],
    },
    handler: async (_request, reply) => {
      const stats = await queueManager.getQueueStats();

      return reply.send({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    },
  });
}
