import https from 'https';
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

export class FacebookHttpClient {
  private cookies: FacebookCookie[] = [];
  private userAgent: string = DEFAULT_HEADERS['User-Agent'];

  constructor(private readonly sessionManager: SessionManager) {}

  async initSession(sessionName: string): Promise<void> {
    const session = await this.sessionManager.getSession(sessionName);
    if (!session.isValid) {
      throw new SessionExpiredError();
    }
    this.cookies = session.cookies;
    if (session.userAgent) {
      this.userAgent = session.userAgent;
    }
  }

  private buildCookieString(): string {
    return this.cookies
      .filter((c) => c.domain.includes('facebook.com'))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  async request(url: string, options: { referer?: string; timeout?: number } = {}): Promise<HttpResponse> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const timeout = options.timeout || 30000;

      const requestOptions: https.RequestOptions = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
          ...DEFAULT_HEADERS,
          'User-Agent': this.userAgent,
          Cookie: this.buildCookieString(),
          Referer: options.referer || 'https://www.facebook.com/',
        },
      };

      const req = https.request(requestOptions, (res) => {
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
      });

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
