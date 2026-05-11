import type {
  FacebookCookie,
  CookieFormat,
  PlaywrightStorageState,
} from '@facebook-automation/shared-types';
import { CookieParseError } from '../errors';

export class CookieParser {
  static parse(input: unknown, format: CookieFormat): FacebookCookie[] {
    switch (format) {
      case 'chrome-export':
        return this.parseChromeExport(input);
      case 'editthiscookie':
        return this.parseEditThisCookie(input);
      case 'playwright-state':
        return this.parsePlaywrightState(input);
      case 'puppeteer-array':
        return this.parsePuppeteerArray(input);
      case 'json':
        return this.parseGenericJson(input);
      default:
        throw new CookieParseError(`Unknown cookie format: ${format}`);
    }
  }

  static autoDetectAndParse(input: unknown): FacebookCookie[] {
    const data = typeof input === 'string' ? JSON.parse(input) : input;

    // Playwright storage state
    if (data && typeof data === 'object' && 'cookies' in data && 'origins' in data) {
      return this.parsePlaywrightState(data);
    }

    if (Array.isArray(data)) {
      if (data.length === 0) throw new CookieParseError('Empty cookie array');

      // EditThisCookie format has 'storeId'
      if ('storeId' in data[0]) return this.parseEditThisCookie(data);

      // Standard cookie array (Puppeteer or Chrome export)
      if ('name' in data[0] && 'value' in data[0]) {
        return this.parsePuppeteerArray(data);
      }
    }

    throw new CookieParseError('Could not auto-detect cookie format');
  }

  private static parseChromeExport(input: unknown): FacebookCookie[] {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    if (!Array.isArray(data)) throw new CookieParseError('Chrome export must be an array');

    return data.map((c: Record<string, unknown>) => this.normalizeCookie(c));
  }

  private static parseEditThisCookie(input: unknown): FacebookCookie[] {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    if (!Array.isArray(data)) throw new CookieParseError('EditThisCookie must be an array');

    return data.map((c: Record<string, unknown>) => ({
      name: String(c.name || ''),
      value: String(c.value || ''),
      domain: String(c.domain || '.facebook.com'),
      path: String(c.path || '/'),
      expires: typeof c.expirationDate === 'number' ? c.expirationDate : -1,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: this.normalizeSameSite(c.sameSite),
    }));
  }

  private static parsePlaywrightState(input: unknown): FacebookCookie[] {
    const data = (typeof input === 'string' ? JSON.parse(input) : input) as PlaywrightStorageState;
    if (!data.cookies || !Array.isArray(data.cookies)) {
      throw new CookieParseError('Invalid Playwright storage state');
    }

    return data.cookies.map((c) => this.normalizeCookie(c));
  }

  private static parsePuppeteerArray(input: unknown): FacebookCookie[] {
    const data = typeof input === 'string' ? JSON.parse(input) : input;
    if (!Array.isArray(data)) throw new CookieParseError('Puppeteer array must be an array');

    return data.map((c: Record<string, unknown>) => this.normalizeCookie(c));
  }

  private static parseGenericJson(input: unknown): FacebookCookie[] {
    return this.autoDetectAndParse(input);
  }

  private static normalizeCookie(c: Record<string, unknown>): FacebookCookie {
    return {
      name: String(c.name || ''),
      value: String(c.value || ''),
      domain: String(c.domain || '.facebook.com'),
      path: String(c.path || '/'),
      expires: typeof c.expires === 'number' ? c.expires : -1,
      httpOnly: Boolean(c.httpOnly),
      secure: Boolean(c.secure),
      sameSite: this.normalizeSameSite(c.sameSite),
    };
  }

  private static normalizeSameSite(value: unknown): 'Strict' | 'Lax' | 'None' | undefined {
    const str = String(value || '').toLowerCase();
    if (str === 'strict') return 'Strict';
    if (str === 'lax') return 'Lax';
    if (str === 'none') return 'None';
    return undefined;
  }
}
