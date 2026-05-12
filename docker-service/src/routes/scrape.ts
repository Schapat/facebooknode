import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionManager } from '../services/session-manager';
import type { QueueManager } from '../queue/queue-manager';
import { FacebookHttpClient } from '../services/facebook-http-client';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger({ service: 'ScrapeRoutes' });

const postScraperSchema = z.object({
  sessionName: z.string().min(1),
  groups: z.array(z.string()).min(1),
  lastScrapeTimestamp: z.string().optional(),
  maxPosts: z.number().optional(),
  scrollTimeout: z.number().optional(),
  groupDelay: z.number().optional(),
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
  sessionManager: SessionManager,
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
          groupDelay: { type: 'number' },
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
          groupDelay: body.groupDelay,
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

  // ── Diagnose ──────────────────────────────────────────────────
  app.post('/scrape/diagnose', {
    schema: {
      description: 'Diagnose scraping: check what Facebook returns for a group URL',
      tags: ['Scrape'],
    },
    handler: async (request, reply) => {
      const body = request.body as { sessionName: string; groupUrl: string };
      if (!body.sessionName || !body.groupUrl) {
        return reply.status(400).send({ error: 'sessionName and groupUrl required' });
      }

      const httpClient = new FacebookHttpClient(sessionManager);
      await httpClient.initSession(body.sessionName);

      try {
        let groupUrl = body.groupUrl.trim();
        if (!groupUrl.startsWith('http')) {
          groupUrl = `https://www.facebook.com/groups/${groupUrl}`;
        }

        const response = await httpClient.request(groupUrl);
        const isLogin = httpClient.isLoginPage(response.body);
        const titleMatch = response.body.match(/<title>([^<]*)<\/title>/i);
        const hasPostId = response.body.includes('post_id');
        const hasStoryId = response.body.includes('story_id');
        const hasCreationTime = response.body.includes('creation_time');
        const hasPermalink = response.body.includes('/permalink/');
        const scriptCount = (response.body.match(/<script/gi) || []).length;
        const bodyLen = response.body.length;

        // Check for common blocking indicators
        const hasCheckpoint = response.body.includes('checkpoint');
        const hasSecurityCheck = response.body.includes('security_check') || response.body.includes('captcha');
        const hasContentNotAvailable = response.body.includes('content isn\'t available') || response.body.includes('not available');
        const hasPrivateGroup = response.body.includes('private group') || response.body.includes('Join Group');
        
        // Extract a text snippet from the body
        const textSnippet = response.body
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 500);

        // Count JSON data blocks
        const sjsBlocks = (response.body.match(/data-sjs/gi) || []).length;
        const requireBlocks = (response.body.match(/__require\(/gi) || []).length;

        await httpClient.persistCookies();

        return reply.status(200).send({
          success: true,
          data: {
            statusCode: response.statusCode,
            bodyLength: bodyLen,
            title: titleMatch?.[1] || null,
            isLoginPage: isLogin,
            hasPostId,
            hasStoryId,
            hasCreationTime,
            hasPermalink,
            scriptCount,
            sjsBlocks,
            requireBlocks,
            hasCheckpoint,
            hasSecurityCheck,
            hasContentNotAvailable,
            hasPrivateGroup,
            textSnippet,
            cookieDebug: httpClient.getCookieDebugInfo(),
          },
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        await httpClient.persistCookies();
        return reply.status(500).send({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date().toISOString(),
        });
      }
    },
  });
}
