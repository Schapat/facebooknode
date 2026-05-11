import Redis from 'ioredis';
import { logger } from '../utils/logger';

export class RedisClient {
  private client: Redis;
  private subscriber: Redis;
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
    this.client = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy(times: number) {
        const delay = Math.min(times * 100, 3000);
        return delay;
      },
    });

    this.subscriber = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });

    this.client.on('error', (err) => logger.error({ err }, 'Redis client error'));
    this.subscriber.on('error', (err) => logger.error({ err }, 'Redis subscriber error'));
  }

  async connect(): Promise<void> {
    await this.client.ping();
    logger.info('Redis connection established');
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
    await this.subscriber.quit();
    logger.info('Redis disconnected');
  }

  getClient(): Redis {
    return this.client;
  }

  getSubscriber(): Redis {
    return this.subscriber;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.client.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch {
      return false;
    }
  }
}
