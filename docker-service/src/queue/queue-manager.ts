import { Queue, Worker, Job, QueueEvents } from 'bullmq';
import type {
  QueueJob,
  OperationType,
  ServiceConfig,
  GroupPostScraperInput,
  GroupMemberScraperInput,
  AutoMessageInput,
} from '@facebook-automation/shared-types';
import { RedisClient } from '../infrastructure/redis';
import { BrowserService } from '../services/browser-service';
import { SessionManager } from '../services/session-manager';
import { GroupPostScraper } from '../operations/group-post-scraper';
import { GroupMemberScraper } from '../operations/group-member-scraper';
import { AutoMessage } from '../operations/auto-message';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger({ service: 'QueueManager' });

const QUEUE_NAME = 'facebook-automation';

export class QueueManager {
  private queue: Queue;
  private worker: Worker | null = null;
  private queueEvents: QueueEvents;
  private postScraper: GroupPostScraper;
  private memberScraper: GroupMemberScraper;
  private autoMessage: AutoMessage;

  constructor(
    private readonly redis: RedisClient,
    private readonly config: ServiceConfig,
    private readonly browserService: BrowserService,
    private readonly sessionManager: SessionManager,
  ) {
    const connection = { connection: this.redis.getClient() };

    this.queue = new Queue(QUEUE_NAME, connection);
    this.queueEvents = new QueueEvents(QUEUE_NAME, connection);

    this.postScraper = new GroupPostScraper(browserService);
    this.memberScraper = new GroupMemberScraper(browserService);
    this.autoMessage = new AutoMessage(browserService);
  }

  async initialize(): Promise<void> {
    this.worker = new Worker(
      QUEUE_NAME,
      async (job: Job<QueueJob>) => {
        log.info({ jobId: job.id, type: job.data.operationType }, 'Processing job');
        return this.processJob(job);
      },
      {
        connection: this.redis.getClient(),
        concurrency: this.config.maxConcurrency,
        limiter: {
          max: 5,
          duration: 60000, // 5 jobs per minute
        },
      },
    );

    this.worker.on('completed', (job) => {
      log.info({ jobId: job.id }, 'Job completed');
    });

    this.worker.on('failed', (job, error) => {
      log.error({ jobId: job?.id, error: error.message }, 'Job failed');
    });

    this.worker.on('error', (error) => {
      log.error({ error }, 'Worker error');
    });

    log.info('Queue worker initialized');
  }

  private async processJob(job: Job<QueueJob>): Promise<unknown> {
    const { operationType, sessionName, input } = job.data;

    switch (operationType) {
      case 'scrape-posts':
        return this.postScraper.execute(sessionName, input as GroupPostScraperInput);
      case 'scrape-members':
        return this.memberScraper.execute(sessionName, input as GroupMemberScraperInput);
      case 'send-message':
        return this.autoMessage.execute(sessionName, input as AutoMessageInput);
      default:
        throw new Error(`Unknown operation type: ${operationType}`);
    }
  }

  async addJob(
    jobData: QueueJob,
  ): Promise<string> {
    const job = await this.queue.add(jobData.operationType, jobData, {
      priority: jobData.priority || 0,
      delay: jobData.delay || 0,
      attempts: jobData.retries || 3,
      backoff: {
        type: 'exponential',
        delay: 5000,
      },
      removeOnComplete: {
        age: 86400, // 24 hours
        count: 1000,
      },
      removeOnFail: {
        age: 604800, // 7 days
      },
    });

    log.info({ jobId: job.id, type: jobData.operationType }, 'Job added to queue');
    return job.id!;
  }

  async getJobStatus(jobId: string): Promise<{
    jobId: string;
    status: string;
    progress: number;
    result?: unknown;
    error?: string;
    createdAt: string;
    processedAt?: string;
    completedAt?: string;
    attemptsMade: number;
    attemptsTotal: number;
  }> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const state = await job.getState();

    return {
      jobId: job.id!,
      status: state,
      progress: typeof job.progress === 'number' ? job.progress : 0,
      result: job.returnvalue,
      error: job.failedReason,
      createdAt: new Date(job.timestamp).toISOString(),
      processedAt: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
      completedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
      attemptsMade: job.attemptsMade,
      attemptsTotal: job.opts.attempts || 3,
    };
  }

  async getQueueStats(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
  }> {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return { waiting, active, completed, failed, delayed };
  }

  async shutdown(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
    }
    await this.queue.close();
    await this.queueEvents.close();
    log.info('Queue system shut down');
  }
}
