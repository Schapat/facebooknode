import type { Page } from 'playwright';
import type { MessageResult, AutoMessageInput } from '@facebook-automation/shared-types';
import { BrowserService } from '../services/browser-service';
import { MessageSendError, UserNotFoundError } from '../errors';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';

const log = createChildLogger({ service: 'AutoMessage' });

// Language-agnostic selectors for Facebook Messenger
// Strategy 1: aria-label based (To/An/À/Para)
// Strategy 2: role-based (combobox, searchbox)
// Strategy 3: placeholder-based
// Strategy 4: generic input in Messenger context
const TO_FIELD_SELECTORS = [
  // Aria-label based - "To" field in multiple languages
  'input[aria-label*="To"]',
  'input[aria-label*="An"]',
  'input[aria-label*="À"]',
  'input[aria-label*="Para"]',
  'input[aria-label*="Recipient"]',
  'input[aria-label*="Empfänger"]',
  // Role-based selectors
  'input[role="combobox"]',
  'input[role="searchbox"]',
  // Placeholder-based
  'input[placeholder*="To"]',
  'input[placeholder*="An"]',
  'input[placeholder*="Search"]',
  'input[placeholder*="Suche"]',
  'input[placeholder*="Suchen"]',
  'input[placeholder*="Name"]',
  // Name/type based
  'input[name="participants"]',
  'input[name="query"]',
  // Messenger-specific structure: input within header/compose area
  '[data-testid="messenger-composer-contact-search-input"]',
  'form input[type="text"]',
  'form input[type="search"]',
  // Broader fallbacks
  '[role="banner"] input[type="text"]',
  '[role="dialog"] input[type="text"]',
  'input[type="search"]',
].join(', ');

const USER_RESULT_SELECTORS = [
  '[role="listbox"] [role="option"]',
  '[role="list"] [role="listitem"]',
  'ul[role="listbox"] li',
  'ul li[role="option"]',
  '[data-testid="mwthreadlist-item"]',
  // Generic clickable results below search
  '[role="listbox"] > *',
  '[aria-expanded="true"] ~ * [role="option"]',
].join(', ');

const MESSAGE_INPUT_SELECTORS = [
  '[role="textbox"][contenteditable="true"]',
  'div[contenteditable="true"][aria-label]',
  'div[contenteditable="true"][data-lexical-editor]',
  'div[contenteditable="true"][spellcheck]',
  'p[contenteditable="true"]',
  'div[data-contents="true"]',
  // Footer area textbox
  '[role="main"] [role="textbox"]',
  'footer [contenteditable="true"]',
].join(', ');

export class AutoMessage {
  constructor(private readonly browserService: BrowserService) {}

  async execute(sessionName: string, input: AutoMessageInput): Promise<MessageResult> {
    return this.browserService.executeWithSession(sessionName, async (page) => {
      return this.sendMessage(page, input);
    });
  }

  private async sendMessage(page: Page, input: AutoMessageInput): Promise<MessageResult> {
    const { username, message } = input;

    log.info({ username }, 'Sending message');

    try {
      // Navigate to Facebook Messenger new message page
      await page.goto('https://www.facebook.com/messages/new/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await randomDelay(2000, 4000);

      // Wait for Messenger UI to load - look for any input or textbox
      await page.waitForSelector('input, [contenteditable="true"], [role="textbox"]', { timeout: 15000 }).catch(() => null);
      await randomDelay(500, 1000);

      // Search for user in the "To" field - try multiple strategies
      log.info('Looking for recipient input field');
      let toField = await page.waitForSelector(TO_FIELD_SELECTORS, { timeout: 10000 }).catch(() => null);

      // Fallback: if no specific selector matched, try finding any visible text input on the page
      if (!toField) {
        log.info('Primary selectors failed, trying fallback input detection');
        const inputs = await page.$$('input[type="text"], input:not([type]), input[type="search"]');
        for (const input of inputs) {
          const visible = await input.isVisible().catch(() => false);
          if (visible) {
            toField = input;
            log.info('Found fallback input element');
            break;
          }
        }
      }

      if (!toField) {
        const pageContent = await page.content();
        const hasLoginForm = pageContent.includes('login_form') || pageContent.includes('loginbutton');
        if (hasLoginForm) {
          throw new MessageSendError('Session expired - redirected to login page');
        }
        // Log diagnostic info
        const pageUrl = page.url();
        const inputCount = (pageContent.match(/<input/gi) || []).length;
        const contentEditableCount = (pageContent.match(/contenteditable="true"/gi) || []).length;
        log.warn({ pageUrl, inputCount, contentEditableCount }, 'Could not find recipient input - page diagnostics');
        throw new MessageSendError(`Could not find recipient input field on ${pageUrl} (inputs: ${inputCount}, contenteditable: ${contentEditableCount})`);
      }

      // Type the username
      await toField.click();
      await randomDelay(300, 600);

      // Type username character by character for natural behavior
      for (const char of username) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 80) + 30 });
      }

      await randomDelay(2000, 3000);

      // Wait for search results and click the first matching user
      log.info('Waiting for user search results');
      const userResult = await page
        .waitForSelector(USER_RESULT_SELECTORS, { timeout: 10000 })
        .catch(() => null);

      if (!userResult) {
        throw new UserNotFoundError(username);
      }

      await userResult.click();
      await randomDelay(1000, 2000);

      // Find the message input - after selecting a recipient, a textbox should appear
      log.info('Looking for message input field');
      const messageInput = await page
        .waitForSelector(MESSAGE_INPUT_SELECTORS, { timeout: 10000 })
        .catch(() => null);

      if (!messageInput) {
        throw new MessageSendError('Could not find message input field');
      }

      // Type message with human-like delays
      await messageInput.click();
      await randomDelay(500, 1000);

      for (const char of message) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 60) + 20 });
      }

      await randomDelay(500, 1000);

      // Send the message with Enter
      await page.keyboard.press('Enter');
      await randomDelay(2000, 3000);

      const sentAt = new Date().toISOString();

      log.info({ username, sentAt }, 'Message sent successfully');

      return {
        success: true,
        sentAt,
        username,
      };
    } catch (error) {
      if (error instanceof UserNotFoundError || error instanceof MessageSendError) {
        throw error;
      }

      log.error({ error, username }, 'Failed to send message');
      return {
        success: false,
        sentAt: new Date().toISOString(),
        username,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
