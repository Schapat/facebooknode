import type { Page } from 'playwright';
import type { MessageResult, AutoMessageInput } from '@facebook-automation/shared-types';
import { BrowserService } from '../services/browser-service';
import { MessageSendError, UserNotFoundError } from '../errors';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';

const log = createChildLogger({ service: 'AutoMessage' });

// Language-agnostic selectors for Facebook Messenger
// "To" field labels: English="To", German="An", French="À", Spanish="Para"
const TO_FIELD_SELECTORS = [
  'input[aria-label*="To"]',
  'input[aria-label*="An"]',
  'input[aria-label*="À"]',
  'input[aria-label*="Para"]',
  'input[placeholder*="To"]',
  'input[placeholder*="An"]',
  'input[placeholder*="Suche"]',
  'input[placeholder*="Search"]',
  'input[name="participants"]',
  'input[type="text"][role="combobox"]',
].join(', ');

const USER_RESULT_SELECTORS = [
  '[role="listbox"] [role="option"]',
  '[role="list"] [role="listitem"]',
  'ul[role="listbox"] li',
  '[data-testid="mwthreadlist-item"]',
].join(', ');

const MESSAGE_INPUT_SELECTORS = [
  '[role="textbox"][contenteditable="true"]',
  'div[contenteditable="true"][aria-label]',
  'p[contenteditable="true"]',
  'div[data-contents="true"]',
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
      await page.waitForSelector('input, [contenteditable="true"]', { timeout: 15000 }).catch(() => null);
      await randomDelay(500, 1000);

      // Search for user in the "To" field
      log.info('Looking for recipient input field');
      const toField = await page.waitForSelector(TO_FIELD_SELECTORS, { timeout: 10000 }).catch(() => null);

      if (!toField) {
        const pageContent = await page.content();
        const hasLoginForm = pageContent.includes('login_form') || pageContent.includes('loginbutton');
        if (hasLoginForm) {
          throw new MessageSendError('Session expired - redirected to login page');
        }
        throw new MessageSendError('Could not find recipient input field - Messenger UI may have changed');
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
