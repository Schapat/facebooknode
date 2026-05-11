import https from 'https';
import http from 'http';
import zlib from 'zlib';
import { URL } from 'url';
import type { FacebookCookie } from '@facebook-automation/shared-types';
import { SessionManager } from './session-manager';
import { SessionExpiredError } from '../errors';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger({ service: 'FacebookHttpClient' });

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Cache-Control': 'max-age=0',
};

const MAX_REDIRECTS = 5;

export class FacebookHttpClient {
  private cookies: Map<string, FacebookCookie> = new Map();
  private userAgent: string = DEFAULT_HEADERS['User-Agent'];
  private sessionName = '';
  private cookiesDirty = false;

  constructor(private readonly sessionManager: SessionManager) {}

  /**
   * Initialize session: load cookies from Redis, then do a warm-up request
   * to facebook.com to establish the cookie handshake (Facebook sets/rotates
   * cookies like fr, sb, xs on every visit).
   */
  async initSession(sessionName: string): Promise<void> {
    this.sessionName = sessionName;
    const session = await this.sessionManager.getSession(sessionName);
    if (!session.isValid) {
      throw new SessionExpiredError();
    }

    // Load cookies into our jar
    this.cookies.clear();
    for (const cookie of session.cookies) {
      this.cookies.set(cookie.name, cookie);
    }

    if (session.userAgent) {
      this.userAgent = session.userAgent;
    }

    // Warm-up request: visit facebook.com to get fresh cookie rotation
    log.debug('Performing warm-up request to establish cookie handshake');
    try {
      await this.request('https://www.facebook.com/', { timeout: 15000 });
      log.debug({ cookieCount: this.cookies.size }, 'Warm-up complete, cookies updated');
    } catch (error) {
      log.warn({ error }, 'Warm-up request failed, continuing with existing cookies');
    }
  }

  /**
   * Persist any updated cookies back to Redis.
   * Call this after all scraping is done.
   */
  async persistCookies(): Promise<void> {
    if (!this.cookiesDirty || !this.sessionName) return;

    try {
      const cookieArray = Array.from(this.cookies.values());
      await this.sessionManager.updateCookies(this.sessionName, cookieArray);
      this.cookiesDirty = false;
      log.debug({ sessionName: this.sessionName, count: cookieArray.length }, 'Cookies persisted to Redis');
    } catch (error) {
      log.warn({ error }, 'Failed to persist cookies');
    }
  }

  private buildCookieString(): string {
    const now = Date.now() / 1000;
    return Array.from(this.cookies.values())
      .filter((c) => {
        if (!c.domain.includes('facebook.com')) return false;
        // Skip expired cookies (expires === -1 means session cookie, always valid)
        if (c.expires > 0 && c.expires < now) return false;
        return true;
      })
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /**
   * Parse Set-Cookie headers from a response and merge into our cookie jar.
   */
  private processSetCookieHeaders(headers: Record<string, string | string[] | undefined>): void {
    const setCookieHeader = headers['set-cookie'];
    if (!setCookieHeader) return;

    const cookieStrings = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];

    for (const cookieStr of cookieStrings) {
      try {
        const cookie = this.parseSetCookie(cookieStr);
        if (cookie && cookie.domain.includes('facebook.com')) {
          this.cookies.set(cookie.name, cookie);
          this.cookiesDirty = true;
        }
      } catch {
        // Skip malformed cookies
      }
    }
  }

  /**
   * Parse a single Set-Cookie header string into a FacebookCookie.
   */
  private parseSetCookie(setCookieStr: string): FacebookCookie | null {
    const parts = setCookieStr.split(';').map((p) => p.trim());
    if (parts.length === 0) return null;

    const [nameValue, ...attrs] = parts;
    const eqIndex = nameValue.indexOf('=');
    if (eqIndex < 0) return null;

    const name = nameValue.substring(0, eqIndex).trim();
    const value = nameValue.substring(eqIndex + 1).trim();
    if (!name) return null;

    let domain = '.facebook.com';
    let path = '/';
    let expires = -1;
    let httpOnly = false;
    let secure = false;
    let sameSite: 'Strict' | 'Lax' | 'None' | undefined;

    for (const attr of attrs) {
      const lowerAttr = attr.toLowerCase();

      if (lowerAttr.startsWith('domain=')) {
        domain = attr.substring(7).trim();
        if (!domain.startsWith('.')) domain = '.' + domain;
      } else if (lowerAttr.startsWith('path=')) {
        path = attr.substring(5).trim();
      } else if (lowerAttr.startsWith('expires=')) {
        const dateStr = attr.substring(8).trim();
        const ts = Date.parse(dateStr);
        if (!isNaN(ts)) expires = ts / 1000;
      } else if (lowerAttr.startsWith('max-age=')) {
        const maxAge = parseInt(attr.substring(8).trim(), 10);
        if (!isNaN(maxAge)) expires = Date.now() / 1000 + maxAge;
      } else if (lowerAttr === 'httponly') {
        httpOnly = true;
      } else if (lowerAttr === 'secure') {
        secure = true;
      } else if (lowerAttr.startsWith('samesite=')) {
        const val = attr.substring(9).trim();
        if (val === 'Strict' || val === 'Lax' || val === 'None') {
          sameSite = val;
        }
      }
    }

    // If a cookie is being deleted (max-age=0 or expires in the past), remove it
    if (expires > 0 && expires < Date.now() / 1000) {
      this.cookies.delete(name);
      this.cookiesDirty = true;
      return null;
    }

    return { name, value, domain, path, expires, httpOnly, secure, sameSite };
  }

  /**
   * Make an HTTP(S) request with automatic:
   * - Cookie sending
   * - Set-Cookie processing (cookie jar update)
   * - Redirect following (up to MAX_REDIRECTS)
   */
  async request(
    url: string,
    options: { referer?: string; timeout?: number } = {},
  ): Promise<HttpResponse> {
    let currentUrl = url;
    let redirectCount = 0;

    while (redirectCount <= MAX_REDIRECTS) {
      const response = await this.rawRequest(currentUrl, options);

      // Process Set-Cookie headers from EVERY response (including redirects)
      this.processSetCookieHeaders(response.headers);

      // Follow redirects
      const statusCode = response.statusCode;
      if ((statusCode === 301 || statusCode === 302 || statusCode === 303 || statusCode === 307) && response.headers.location) {
        redirectCount++;
        const location = Array.isArray(response.headers.location)
          ? response.headers.location[0]
          : response.headers.location;
        if (!location) break;

        // Resolve relative URLs
        currentUrl = location.startsWith('http')
          ? location
          : new URL(location, currentUrl).toString();

        log.debug({ redirectCount, to: currentUrl }, 'Following redirect');
        continue;
      }

      return response;
    }

    // If we exhausted redirects, make one final request
    return this.rawRequest(currentUrl, options);
  }

  /**
   * Single raw HTTP(S) request without redirect following.
   */
  private rawRequest(
    url: string,
    options: { referer?: string; timeout?: number },
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const timeout = options.timeout || 30000;
      const isHttps = urlObj.protocol === 'https:';

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          ...DEFAULT_HEADERS,
          'User-Agent': this.userAgent,
          Cookie: this.buildCookieString(),
          Referer: options.referer || 'https://www.facebook.com/',
        },
      };

      const handler = (res: http.IncomingMessage) => {
        const buffer: Buffer[] = [];

        res.on('data', (chunk: Buffer) => buffer.push(chunk));
        res.on('end', () => {
          const dataBuffer = Buffer.concat(buffer);
          let body: string;

          const encoding = res.headers['content-encoding'];
          try {
            if (encoding === 'gzip') {
              body = zlib.gunzipSync(dataBuffer).toString('utf-8');
            } else if (encoding === 'deflate') {
              body = zlib.inflateSync(dataBuffer).toString('utf-8');
            } else if (encoding === 'br') {
              body = zlib.brotliDecompressSync(dataBuffer).toString('utf-8');
            } else {
              body = dataBuffer.toString('utf-8');
            }
          } catch {
            body = dataBuffer.toString('utf-8');
          }

          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body,
          });
        });
      };

      const req = isHttps
        ? https.request(requestOptions, handler)
        : http.request(requestOptions, handler);

      req.on('error', reject);
      req.setTimeout(timeout, () => {
        req.destroy();
        reject(new Error(`Request timeout after ${timeout}ms`));
      });

      req.end();
    });
  }

  isLoginPage(html: string): boolean {
    return (
      html.includes('/login/') ||
      html.includes('login_form') ||
      html.includes('"loggedIn":false') ||
      (html.includes('checkpoint') && html.length < 5000)
    );
  }
}