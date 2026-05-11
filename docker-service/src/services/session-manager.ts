import { v4 as uuidv4 } from 'uuid';
import type {
  SessionData,
  FacebookCookie,
  ServiceConfig,
  CookieFormat,
  ProxyConfig,
} from '@facebook-automation/shared-types';
import { RedisClient } from '../infrastructure/redis';
import { encrypt, decrypt } from '../utils/encryption';
import { CookieParser } from '../utils/cookie-parser';
import { createChildLogger } from '../utils/logger';
import { SessionNotFoundError, SessionExpiredError, SessionInvalidError } from '../errors';

const SESSION_PREFIX = 'session:';
const SESSION_TTL = 86400 * 30; // 30 days

const log = createChildLogger({ service: 'SessionManager' });

export class SessionManager {
  constructor(
    private readonly redis: RedisClient,
    private readonly config: ServiceConfig,
  ) {}

  async importSession(params: {
    sessionName: string;
    cookies: unknown;
    format: CookieFormat;
    userAgent?: string;
    proxy?: ProxyConfig;
    localStorage?: Record<string, string>;
    sessionStorage?: Record<string, string>;
  }): Promise<SessionData> {
    const cookies = CookieParser.parse(params.cookies, params.format);
    const sessionId = uuidv4();
    const now = new Date().toISOString();

    const session: SessionData = {
      sessionId,
      accountName: params.sessionName,
      cookies,
      localStorage: params.localStorage || {},
      sessionStorage: params.sessionStorage || {},
      userAgent: params.userAgent || '',
      proxy: params.proxy,
      createdAt: now,
      updatedAt: now,
      lastValidatedAt: now,
      isValid: true,
    };

    await this.saveSession(params.sessionName, session);
    log.info({ sessionName: params.sessionName }, 'Session imported');
    return session;
  }

  async getSession(sessionName: string): Promise<SessionData> {
    const key = SESSION_PREFIX + sessionName;
    const encrypted = await this.redis.get(key);

    if (!encrypted) {
      throw new SessionNotFoundError(sessionName);
    }

    const decrypted = decrypt(encrypted, this.config.encryptionKey);
    return JSON.parse(decrypted) as SessionData;
  }

  async saveSession(sessionName: string, session: SessionData): Promise<void> {
    const key = SESSION_PREFIX + sessionName;
    const serialized = JSON.stringify(session);
    const encrypted = encrypt(serialized, this.config.encryptionKey);
    await this.redis.set(key, encrypted, SESSION_TTL);
  }

  async updateCookies(sessionName: string, cookies: FacebookCookie[]): Promise<void> {
    const session = await this.getSession(sessionName);
    session.cookies = cookies;
    session.updatedAt = new Date().toISOString();
    await this.saveSession(sessionName, session);
    log.info({ sessionName }, 'Cookies updated');
  }

  async updateStorage(
    sessionName: string,
    localStorage: Record<string, string>,
    sessionStorage: Record<string, string>,
  ): Promise<void> {
    const session = await this.getSession(sessionName);
    session.localStorage = localStorage;
    session.sessionStorage = sessionStorage;
    session.updatedAt = new Date().toISOString();
    await this.saveSession(sessionName, session);
  }

  async markValid(sessionName: string): Promise<void> {
    const session = await this.getSession(sessionName);
    session.isValid = true;
    session.lastValidatedAt = new Date().toISOString();
    await this.saveSession(sessionName, session);
  }

  async markInvalid(sessionName: string): Promise<void> {
    const session = await this.getSession(sessionName);
    session.isValid = false;
    session.updatedAt = new Date().toISOString();
    await this.saveSession(sessionName, session);
    log.warn({ sessionName }, 'Session marked as invalid');
  }

  async validateSession(sessionName: string): Promise<boolean> {
    try {
      const session = await this.getSession(sessionName);

      // Check if cookies have expired
      const now = Date.now() / 1000;
      const hasValidCookies = session.cookies.some(
        (c) => c.name === 'c_user' && (c.expires === -1 || c.expires > now),
      );

      if (!hasValidCookies) {
        await this.markInvalid(sessionName);
        return false;
      }

      return session.isValid;
    } catch (error) {
      if (error instanceof SessionNotFoundError) return false;
      throw error;
    }
  }

  async deleteSession(sessionName: string): Promise<void> {
    const key = SESSION_PREFIX + sessionName;
    await this.redis.del(key);
    log.info({ sessionName }, 'Session deleted');
  }

  async listSessions(): Promise<string[]> {
    const keys = await this.redis.keys(SESSION_PREFIX + '*');
    return keys.map((k) => k.replace(SESSION_PREFIX, ''));
  }

  async getSessionStatus(sessionName: string): Promise<{
    sessionName: string;
    isValid: boolean;
    lastValidated: string;
    expiresAt?: string;
    accountName?: string;
  }> {
    const session = await this.getSession(sessionName);

    // Find the c_user cookie expiry
    const cUser = session.cookies.find((c) => c.name === 'c_user');
    const expiresAt =
      cUser && cUser.expires > 0 ? new Date(cUser.expires * 1000).toISOString() : undefined;

    return {
      sessionName: session.accountName,
      isValid: session.isValid,
      lastValidated: session.lastValidatedAt,
      expiresAt,
      accountName: session.accountName,
    };
  }

  async exportSession(sessionName: string): Promise<{
    sessionName: string;
    cookies: FacebookCookie[];
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
    exportedAt: string;
  }> {
    const session = await this.getSession(sessionName);
    return {
      sessionName: session.accountName,
      cookies: session.cookies,
      localStorage: session.localStorage,
      sessionStorage: session.sessionStorage,
      exportedAt: new Date().toISOString(),
    };
  }

  async refreshSession(sessionName: string): Promise<SessionData> {
    const session = await this.getSession(sessionName);
    if (!session.isValid) {
      throw new SessionExpiredError();
    }
    session.lastValidatedAt = new Date().toISOString();
    await this.saveSession(sessionName, session);
    return session;
  }
}
