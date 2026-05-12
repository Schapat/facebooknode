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

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

// Older but supported mobile Chrome UA — avoids both the Messenger SPA
// (served to modern UAs) and the "unsupported device" block (for ancient UAs)
const MBASIC_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 5.1.1; Nexus 5 Build/LMY48B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/53.0.2785.143 Mobile Safari/537.36';

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

    const preWarmupCookies = Array.from(this.cookies.keys());
    const hasCUserBefore = this.cookies.has('c_user');
    log.info({ cookieCount: preWarmupCookies.length, hasCUser: hasCUserBefore, cookieNames: preWarmupCookies }, 'Cookies loaded from Redis');

    // Warm-up request: visit facebook.com to get fresh cookie rotation
    log.debug('Performing warm-up request to establish cookie handshake');
    try {
      await this.request('https://www.facebook.com/', { timeout: 15000 });
      const postWarmupCookies = Array.from(this.cookies.keys());
      const hasCUserAfter = this.cookies.has('c_user');
      log.info({ cookieCount: postWarmupCookies.length, hasCUser: hasCUserAfter, cookieNames: postWarmupCookies }, 'Warm-up complete, cookies updated');
      if (hasCUserBefore && !hasCUserAfter) {
        log.error('c_user cookie was DELETED during warm-up request!');
      }
    } catch (error) {
      log.warn({ error }, 'Warm-up request failed, continuing with existing cookies');
    }
  }

  /**
   * Get the Facebook user ID (c_user cookie value).
   */
  getUserId(): string | null {
    return this.cookies.get('c_user')?.value || null;
  }

  /**
   * Get cookie names for debugging (no values exposed).
   */
  getCookieDebugInfo(): { names: string[]; count: number; hasCUser: boolean; hasXs: boolean } {
    const names = Array.from(this.cookies.keys());
    return {
      names,
      count: names.length,
      hasCUser: this.cookies.has('c_user'),
      hasXs: this.cookies.has('xs'),
    };
  }

  /**
   * Make a request with a custom User-Agent (for diagnose/testing).
   */
  async requestWithUA(
    url: string,
    userAgent: string,
    options: { referer?: string } = {},
  ): Promise<HttpResponse> {
    return this.request(url, { ...options, overrideUA: userAgent });
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
  private processSetCookieHeaders(headers: Record<string, string | string[] | undefined>, allowDeletion = true): void {
    const setCookieHeader = headers['set-cookie'];
    if (!setCookieHeader) return;

    // Never allow deletion of critical auth cookies — Facebook sometimes
    // sends expired Set-Cookie headers for these during redirects/warm-up
    const PROTECTED_COOKIES = new Set(['c_user', 'xs', 'fr', 'sb', 'datr']);

    const cookieStrings = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];

    for (const cookieStr of cookieStrings) {
      try {
        const nameMatch = cookieStr.match(/^([^=]+)=/);
        const cookieName = nameMatch ? nameMatch[1].trim() : '';
        const isProtected = PROTECTED_COOKIES.has(cookieName);

        const cookie = this.parseSetCookie(cookieStr, allowDeletion && !isProtected);
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
  private parseSetCookie(setCookieStr: string, allowDeletion = true): FacebookCookie | null {
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
      if (allowDeletion) {
        this.cookies.delete(name);
        this.cookiesDirty = true;
      }
      return null;
    }

    return { name, value, domain, path, expires, httpOnly, secure, sameSite };
  }

  /**
   * Extract Facebook-specific tokens (fb_dtsg, jazoest, etc.) from the HTML.
   * These are required for GraphQL API calls.
   */
  extractTokens(html: string): { fbDtsg: string; jazoest: string; lsd: string } {
    let fbDtsg = '';
    let jazoest = '';
    let lsd = '';

    // fb_dtsg token
    const dtsgMatch =
      html.match(/"DTSGInitialData"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
      html.match(/name="fb_dtsg"\s+value="([^"]+)"/) ||
      html.match(/"dtsg"\s*:\s*\{\s*"token"\s*:\s*"([^"]+)"/);
    if (dtsgMatch) fbDtsg = dtsgMatch[1];

    // jazoest
    const jazoestMatch =
      html.match(/name="jazoest"\s+value="(\d+)"/) ||
      html.match(/"jazoest"\s*:\s*"(\d+)"/);
    if (jazoestMatch) jazoest = jazoestMatch[1];

    // lsd token
    const lsdMatch =
      html.match(/"LSD"\s*,\s*\[\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
      html.match(/name="lsd"\s+value="([^"]+)"/);
    if (lsdMatch) lsd = lsdMatch[1];

    return { fbDtsg, jazoest, lsd };
  }

  /**
   * Make an HTTP(S) GET request with automatic:
   * - Cookie sending
   * - Set-Cookie processing (cookie jar update)
   * - Redirect following (up to MAX_REDIRECTS)
   */
  async request(
    url: string,
    options: { referer?: string; timeout?: number; overrideUA?: string } = {},
  ): Promise<HttpResponse> {
    return this.requestWithMethod('GET', url, options);
  }

  /**
   * Make an HTTP(S) POST request (used for GraphQL API calls).
   */
  async post(
    url: string,
    body: string,
    options: { referer?: string; timeout?: number; contentType?: string } = {},
  ): Promise<HttpResponse> {
    return this.requestWithMethod('POST', url, { ...options, body, contentType: options.contentType });
  }

  private async requestWithMethod(
    method: string,
    url: string,
    options: { referer?: string; timeout?: number; body?: string; contentType?: string; overrideUA?: string } = {},
  ): Promise<HttpResponse> {
    let currentUrl = url;
    let redirectCount = 0;

    while (redirectCount <= MAX_REDIRECTS) {
      const response = await this.rawRequest(currentUrl, method, options);

      // Process Set-Cookie headers from EVERY response (including redirects)
      // Don't let error responses (400+) delete auth cookies from our jar
      this.processSetCookieHeaders(response.headers, response.statusCode < 400);

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
    return this.rawRequest(currentUrl, 'GET', options);
  }

  /**
   * Single raw HTTP(S) request without redirect following.
   */
  private rawRequest(
    url: string,
    method: string,
    options: { referer?: string; timeout?: number; body?: string; contentType?: string; overrideUA?: string },
  ): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const timeout = options.timeout || 30000;
      const isHttps = urlObj.protocol === 'https:';
      const postBody = options.body ? Buffer.from(options.body, 'utf-8') : null;

      // Use older mobile UA for mbasic/0.facebook.com to get basic HTML rendering
      const isMbasic = urlObj.hostname.includes('mbasic.facebook.com') || urlObj.hostname.includes('0.facebook.com');
      const effectiveUA = options.overrideUA || (isMbasic ? MBASIC_USER_AGENT : this.userAgent);
      const headers: Record<string, string> = {
        ...DEFAULT_HEADERS,
        'User-Agent': effectiveUA,
        Cookie: this.buildCookieString(),
        Referer: options.referer || 'https://www.facebook.com/',
      };

      // Strip modern desktop-specific headers for mbasic/0.facebook.com
      if (isMbasic) {
        delete headers['sec-ch-ua'];
        delete headers['sec-ch-ua-mobile'];
        delete headers['sec-ch-ua-platform'];
      }

      if (postBody) {
        headers['Content-Type'] = options.contentType || 'application/x-www-form-urlencoded';
        headers['Content-Length'] = String(postBody.length);

        if (isMbasic) {
          // Feature phone POST: minimal headers, no Sec-Fetch
          headers['Origin'] = `https://${urlObj.hostname}`;
        } else {
          // AJAX/API requests
          headers['Sec-Fetch-Dest'] = 'empty';
          headers['Sec-Fetch-Mode'] = 'cors';
          headers['Sec-Fetch-Site'] = 'same-origin';
          headers['Origin'] = `https://${urlObj.hostname}`;
          delete headers['Upgrade-Insecure-Requests'];
          delete headers['Sec-Fetch-User'];

          // Add X-Requested-With for AJAX requests
          headers['X-Requested-With'] = 'XMLHttpRequest';
        }
      }

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
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

      if (postBody) {
        req.write(postBody);
      }
      req.end();
    });
  }

  isLoginPage(html: string): boolean {
    return (
      html.includes('login_form') ||
      html.includes('action="/login') ||
      html.includes('"loggedIn":false') ||
      (html.includes('checkpoint') && html.length < 5000)
    );
  }
}