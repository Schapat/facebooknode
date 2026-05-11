import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { ServiceConfig, SessionData, FacebookCookie } from '@facebook-automation/shared-types';
import { SessionManager } from './session-manager';
import { BrowserError, SessionExpiredError } from '../errors';
import { createChildLogger } from '../utils/logger';
import { randomDelay, getRandomUserAgent } from '../utils/helpers';
import * as path from 'path';
import * as fs from 'fs';

const log = createChildLogger({ service: 'BrowserService' });

export class BrowserService {
  private browser: Browser | null = null;
  private contexts: Map<string, BrowserContext> = new Map();

  constructor(
    private readonly config: ServiceConfig,
    private readonly sessionManager: SessionManager,
  ) {}

  async getBrowser(): Promise<Browser> {
    if (!this.browser || !this.browser.isConnected()) {
      log.info('Launching browser');
      this.browser = await chromium.launch({
        headless: this.config.browserHeadless,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
      });
      log.info('Browser launched');
    }
    return this.browser;
  }

  async getContext(sessionName: string): Promise<BrowserContext> {
    const existing = this.contexts.get(sessionName);
    if (existing) {
      try {
        // Test if context is still alive
        await existing.pages();
        return existing;
      } catch {
        this.contexts.delete(sessionName);
      }
    }

    const session = await this.sessionManager.getSession(sessionName);
    const browser = await this.getBrowser();

    const contextDir = path.join(this.config.dataDir, 'contexts', sessionName);
    fs.mkdirSync(contextDir, { recursive: true });

    const userAgent = session.userAgent || getRandomUserAgent();

    const context = await browser.newContext({
      userAgent,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      timezoneId: 'America/New_York',
      storageState: {
        cookies: session.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          expires: c.expires,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite || 'Lax',
        })),
        origins: [
          {
            origin: 'https://www.facebook.com',
            localStorage: Object.entries(session.localStorage).map(([name, value]) => ({
              name,
              value,
            })),
          },
        ],
      },
      proxy: session.proxy
        ? {
            server: session.proxy.server,
            username: session.proxy.username,
            password: session.proxy.password,
          }
        : undefined,
      javaScriptEnabled: true,
      ignoreHTTPSErrors: true,
    });

    // Add stealth scripts
    await context.addInitScript(() => {
      // Override webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => false });

      // Override plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5],
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Chrome runtime
      (window as any).chrome = { runtime: {} };

      // Permissions
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters: any) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : originalQuery(parameters);
    });

    this.contexts.set(sessionName, context);
    log.info({ sessionName }, 'Browser context created');
    return context;
  }

  async getPage(sessionName: string): Promise<Page> {
    const context = await this.getContext(sessionName);
    const pages = context.pages();
    return pages.length > 0 ? pages[0] : await context.newPage();
  }

  async validateLoginStatus(page: Page): Promise<boolean> {
    try {
      await page.goto('https://www.facebook.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await randomDelay(2000, 4000);

      // Check if redirected to login page
      const url = page.url();
      if (url.includes('/login') || url.includes('checkpoint')) {
        return false;
      }

      // Check for logged-in indicators (language-agnostic)
      const loggedIn = await page.evaluate(() => {
        // Check for profile link in any language (EN: "Your profile", DE: "Dein Profil", etc.)
        const profileLink = document.querySelector('[aria-label="Your profile"], [aria-label="Dein Profil"], [aria-label="Votre profil"], [aria-label="Tu perfil"]');
        const navBar = document.querySelector('[role="navigation"]');
        const feed = document.querySelector('[role="feed"]');
        // Also check for the account menu or messenger icon as logged-in indicator
        const accountMenu = document.querySelector('[aria-label="Account"], [aria-label="Konto"], [aria-label="Compte"], [aria-label="Cuenta"]');
        const messenger = document.querySelector('[aria-label="Messenger"]');
        return !!(profileLink || accountMenu || messenger || (navBar && feed));
      });

      return loggedIn;
    } catch (error) {
      log.error({ error }, 'Error validating login status');
      return false;
    }
  }

  async executeWithSession<T>(
    sessionName: string,
    operation: (page: Page) => Promise<T>,
  ): Promise<T> {
    const page = await this.getPage(sessionName);

    try {
      // Validate login
      const isLoggedIn = await this.validateLoginStatus(page);
      if (!isLoggedIn) {
        await this.sessionManager.markInvalid(sessionName);
        throw new SessionExpiredError();
      }

      await this.sessionManager.markValid(sessionName);

      // Execute operation
      const result = await operation(page);

      // Save updated cookies after operation
      await this.saveCurrentState(sessionName, page);

      return result;
    } catch (error) {
      // Take screenshot on error
      if (this.config.screenshotOnError) {
        await this.takeErrorScreenshot(sessionName, page);
      }
      if (this.config.htmlDumpOnError) {
        await this.takeHtmlDump(sessionName, page);
      }
      throw error;
    }
  }

  async saveCurrentState(sessionName: string, page: Page): Promise<void> {
    try {
      const context = page.context();
      const cookies = await context.cookies();

      const fbCookies: FacebookCookie[] = cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite === 'Strict' ? 'Strict' : c.sameSite === 'Lax' ? 'Lax' : 'None',
      }));

      await this.sessionManager.updateCookies(sessionName, fbCookies);

      // Save localStorage and sessionStorage
      const storage = await page.evaluate(() => {
        const ls: Record<string, string> = {};
        const ss: Record<string, string> = {};

        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key) ls[key] = localStorage.getItem(key) || '';
        }

        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key) ss[key] = sessionStorage.getItem(key) || '';
        }

        return { localStorage: ls, sessionStorage: ss };
      });

      await this.sessionManager.updateStorage(
        sessionName,
        storage.localStorage,
        storage.sessionStorage,
      );

      log.debug({ sessionName }, 'Session state saved');
    } catch (error) {
      log.warn({ sessionName, error }, 'Failed to save session state');
    }
  }

  private async takeErrorScreenshot(sessionName: string, page: Page): Promise<void> {
    try {
      const screenshotDir = path.join(this.config.dataDir, 'screenshots');
      fs.mkdirSync(screenshotDir, { recursive: true });
      const filename = `${sessionName}_${Date.now()}.png`;
      await page.screenshot({ path: path.join(screenshotDir, filename), fullPage: true });
      log.info({ sessionName, filename }, 'Error screenshot saved');
    } catch (err) {
      log.warn({ err }, 'Failed to take error screenshot');
    }
  }

  private async takeHtmlDump(sessionName: string, page: Page): Promise<void> {
    try {
      const dumpDir = path.join(this.config.dataDir, 'html-dumps');
      fs.mkdirSync(dumpDir, { recursive: true });
      const filename = `${sessionName}_${Date.now()}.html`;
      const content = await page.content();
      fs.writeFileSync(path.join(dumpDir, filename), content, 'utf-8');
      log.info({ sessionName, filename }, 'HTML dump saved');
    } catch (err) {
      log.warn({ err }, 'Failed to take HTML dump');
    }
  }

  async humanScroll(page: Page, scrolls: number = 3): Promise<void> {
    for (let i = 0; i < scrolls; i++) {
      const scrollAmount = Math.floor(Math.random() * 400) + 200;
      await page.mouse.wheel(0, scrollAmount);
      await randomDelay(800, 2000);
    }
  }

  async humanClick(page: Page, selector: string): Promise<void> {
    const element = await page.$(selector);
    if (!element) return;

    const box = await element.boundingBox();
    if (!box) return;

    // Move mouse to element with slight randomness
    const x = box.x + box.width * (0.3 + Math.random() * 0.4);
    const y = box.y + box.height * (0.3 + Math.random() * 0.4);

    await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 20) + 10 });
    await randomDelay(100, 300);
    await page.mouse.click(x, y);
  }

  async humanType(page: Page, selector: string, text: string): Promise<void> {
    await this.humanClick(page, selector);
    await randomDelay(200, 500);

    for (const char of text) {
      await page.keyboard.type(char, { delay: Math.floor(Math.random() * 100) + 30 });
    }
  }

  async closeContext(sessionName: string): Promise<void> {
    const context = this.contexts.get(sessionName);
    if (context) {
      await context.close();
      this.contexts.delete(sessionName);
      log.info({ sessionName }, 'Browser context closed');
    }
  }

  async closeAll(): Promise<void> {
    for (const [name, context] of this.contexts) {
      try {
        await context.close();
      } catch {
        // ignore
      }
    }
    this.contexts.clear();

    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    log.info('All browser resources closed');
  }
}
