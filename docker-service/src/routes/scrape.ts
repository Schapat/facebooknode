import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionManager } from '../services/session-manager';
import type { QueueManager } from '../queue/queue-manager';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger({ service: 'ScrapeRoutes' });

const postScraperSchema = z.object({
  sessionName: z.string().min(1),
  groups: z.array(z.string()).min(1),
  lastScrapeTimestamp: z.string().optional(),
  maxPosts: z.number().optional(),
  scrollTimeout: z.number().optional(),
  priority: z.number().optional(),
});

const memberScraperSchema = z.object({
  sessionName: z.string().min(1),
  groups: z.array(z.string()).min(1),
  maxMembers: z.number().optional(),
  scrollTimeout: z.number().optional(),
  priority: z.number().optional(),
});

export function registerScrapeRoutes(
  app: FastifyInstance,
  queueManager: QueueManager,
): void {
  app.post('/scrape/posts', {
    schema: {
      description: 'Scrape posts from Facebook groups',
      tags: ['Scrape'],
      body: {
        type: 'object',
        required: ['sessionName', 'groups'],
        properties: {
          sessionName: { type: 'string' },
          groups: { type: 'array', items: { type: 'string' } },
          lastScrapeTimestamp: { type: 'string' },
          maxPosts: { type: 'number' },
          scrollTimeout: { type: 'number' },
          priority: { type: 'number' },
        },
      },
    },
    handler: async (request, reply) => {
      const body = postScraperSchema.parse(request.body);

      const jobId = await queueManager.addJob({
        operationType: 'scrape-posts',
        sessionName: body.sessionName,
        input: {
          groups: body.groups,
          lastScrapeTimestamp: body.lastScrapeTimestamp,
          maxPosts: body.maxPosts,
          scrollTimeout: body.scrollTimeout,
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

  app.post('/scrape/members', {
    schema: {
      description: 'Scrape members from Facebook groups',
      tags: ['Scrape'],
      body: {
        type: 'object',
        required: ['sessionName', 'groups'],
        properties: {
          sessionName: { type: 'string' },
          groups: { type: 'array', items: { type: 'string' } },
          maxMembers: { type: 'number' },
          scrollTimeout: { type: 'number' },
          priority: { type: 'number' },
        },
      },
    },
    handler: async (request, reply) => {
      const body = memberScraperSchema.parse(request.body);

      const jobId = await queueManager.addJob({
        operationType: 'scrape-members',
        sessionName: body.sessionName,
        input: {
          groups: body.groups,
          maxMembers: body.maxMembers,
          scrollTimeout: body.scrollTimeout,
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
