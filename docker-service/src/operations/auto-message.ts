import type { Page } from 'playwright';
import type { MessageResult, AutoMessageInput } from '@facebook-automation/shared-types';
import { BrowserService } from '../services/browser-service';
import { MessageSendError, UserNotFoundError } from '../errors';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';

const log = createChildLogger({ service: 'AutoMessage' });

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
      // Navigate to Facebook Messenger
      await page.goto('https://www.facebook.com/messages/new/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await randomDelay(2000, 4000);

      // Search for user in the "To" field
      const toField = await page.waitForSelector(
        'input[placeholder*="To"], input[aria-label*="To"], input[name="participants"]',
        { timeout: 10000 },
      );

      if (!toField) {
        throw new MessageSendError('Could not find recipient input field');
      }

      // Type the username
      await toField.click();
      await randomDelay(300, 600);

      for (const char of username) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 80) + 30 });
      }

      await randomDelay(2000, 3000);

      // Wait for search results and click the first matching user
      const userResult = await page
        .waitForSelector(`[role="listbox"] [role="option"], [data-testid="mwthreadlist-item"]`, {
          timeout: 10000,
        })
        .catch(() => null);

      if (!userResult) {
        throw new UserNotFoundError(username);
      }

      await userResult.click();
      await randomDelay(1000, 2000);

      // Find the message input
      const messageInput = await page.waitForSelector(
        '[role="textbox"][contenteditable="true"], [aria-label*="Message"], div[data-contents="true"]',
        { timeout: 10000 },
      );

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

      // Send the message
      await page.keyboard.press('Enter');
      await randomDelay(2000, 3000);

      // Verify message was sent by checking for sent indicators
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
