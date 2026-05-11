import type { MessageResult, AutoMessageInput } from '@facebook-automation/shared-types';
import { FacebookHttpClient } from '../services/facebook-http-client';
import { SessionManager } from '../services/session-manager';
import { MessageSendError, UserNotFoundError } from '../errors';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';

const log = createChildLogger({ service: 'AutoMessage' });

export class AutoMessage {
  private httpClient: FacebookHttpClient;

  constructor(private readonly sessionManager: SessionManager) {
    this.httpClient = new FacebookHttpClient(sessionManager);
  }

  async execute(sessionName: string, input: AutoMessageInput): Promise<MessageResult> {
    await this.httpClient.initSession(sessionName);
    try {
      return await this.sendMessage(input);
    } finally {
      await this.httpClient.persistCookies();
    }
  }

  private async sendMessage(input: AutoMessageInput): Promise<MessageResult> {
    const { username, message } = input;

    log.info({ username }, 'Sending message via HTTP');

    try {
      // Step 1: Get fb_dtsg and other tokens from Facebook
      const homeResponse = await this.httpClient.request('https://www.facebook.com/');
      const tokens = this.httpClient.extractTokens(homeResponse.body);

      if (!tokens.fbDtsg) {
        throw new MessageSendError('Could not extract fb_dtsg token - session may be expired');
      }

      const myUserId = this.httpClient.getUserId();
      if (!myUserId) {
        throw new MessageSendError('Could not determine own user ID from cookies');
      }

      // Step 2: Resolve username to Facebook user ID
      const recipientId = await this.resolveUserId(username, tokens);

      await randomDelay(1000, 2000);

      // Step 3: Send the message via /messaging/send/
      await this.sendViaMessaging(recipientId, myUserId, message, tokens);

      const sentAt = new Date().toISOString();
      log.info({ username, recipientId, sentAt }, 'Message sent successfully');

      return { success: true, sentAt, username };
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

  private async resolveUserId(
    username: string,
    tokens: { fbDtsg: string; jazoest: string; lsd: string },
  ): Promise<string> {
    // If the username is already a numeric ID, use it directly
    if (/^\d+$/.test(username)) {
      return username;
    }

    // Strip full URL to get just the username/path part
    let profilePath = username;
    if (username.startsWith('http')) {
      try {
        const url = new URL(username);
        profilePath = url.pathname.replace(/^\//, '').replace(/\/$/, '');
      } catch {
        // Not a valid URL, use as-is
      }
    }

    // Try to resolve by fetching the profile page
    const profileUrl = `https://www.facebook.com/${profilePath}`;
    log.info({ profileUrl }, 'Resolving user ID from profile');

    const response = await this.httpClient.request(profileUrl);

    // Try multiple patterns to extract user ID from the profile HTML
    const patterns = [
      /"userID":"(\d+)"/,
      /"entity_id":"(\d+)"/,
      /"ownerID":"(\d+)"/,
      /"profileID":"(\d+)"/,
      /content="fb:\/\/profile\/(\d+)"/,
      /"user_id":"(\d+)"/,
      /"actorID":"(\d+)"/,
    ];

    for (const pattern of patterns) {
      const match = response.body.match(pattern);
      if (match && match[1] !== this.httpClient.getUserId()) {
        log.info({ userId: match[1] }, 'Resolved user ID from profile page');
        return match[1];
      }
    }

    // Fallback: try the typeahead search
    return this.searchUser(profilePath, tokens);
  }

  private async searchUser(
    query: string,
    tokens: { fbDtsg: string; jazoest: string; lsd: string },
  ): Promise<string> {
    log.info({ query }, 'Searching for user via typeahead');

    const params = new URLSearchParams({
      value: query,
      fb_dtsg: tokens.fbDtsg,
      jazoest: tokens.jazoest,
      __a: '1',
    });

    const response = await this.httpClient.request(
      `https://www.facebook.com/ajax/typeahead/search.php?${params.toString()}&type=messenger_people`,
      { referer: 'https://www.facebook.com/messages/' },
    );

    // Facebook AJAX responses have "for (;;);" prefix
    const body = response.body.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');

    try {
      const data = JSON.parse(body);
      const entries = data?.payload?.entries || data?.entries || [];
      if (entries.length > 0) {
        const userId = String(entries[0].uid || entries[0].id);
        log.info({ userId, query }, 'Found user via typeahead search');
        return userId;
      }
    } catch {
      // Try regex fallback on the response
      const idMatch = body.match(/"uid"\s*:\s*(\d+)/);
      if (idMatch) {
        return idMatch[1];
      }
    }

    throw new UserNotFoundError(query);
  }

  private async sendViaMessaging(
    recipientId: string,
    myUserId: string,
    message: string,
    tokens: { fbDtsg: string; jazoest: string; lsd: string },
  ): Promise<void> {
    const timestamp = Date.now();
    const otherUserId = `fbid:${recipientId}`;
    const selfId = `fbid:${myUserId}`;

    const params = new URLSearchParams();
    params.append('fb_dtsg', tokens.fbDtsg);
    params.append('jazoest', tokens.jazoest);
    params.append('message_batch[0][action_type]', 'ma-type:user-generated-message');
    params.append('message_batch[0][author]', selfId);
    params.append('message_batch[0][body]', message);
    params.append('message_batch[0][ephemeral_ttl_mode]', '0');
    params.append('message_batch[0][has_attachment]', 'false');
    params.append('message_batch[0][is_spoof_warning]', 'false');
    params.append('message_batch[0][source]', 'source:web');
    params.append('message_batch[0][specific_to_list][0]', otherUserId);
    params.append('message_batch[0][specific_to_list][1]', selfId);
    params.append('message_batch[0][timestamp]', String(timestamp));
    params.append('__a', '1');

    const response = await this.httpClient.post(
      'https://www.facebook.com/messaging/send/',
      params.toString(),
      { referer: 'https://www.facebook.com/messages/' },
    );

    if (response.statusCode !== 200) {
      throw new MessageSendError(`HTTP ${response.statusCode} from messaging endpoint`);
    }

    // Facebook AJAX responses have "for (;;);" prefix
    const body = response.body.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');

    try {
      const data = JSON.parse(body);
      if (data.error) {
        throw new MessageSendError(
          `Facebook error: ${data.error.message || JSON.stringify(data.error)}`,
        );
      }
    } catch (e) {
      if (e instanceof MessageSendError) throw e;
      // If we can't parse the response but got 200, assume success
    }

    log.info({ recipientId }, 'Message sent via /messaging/send/');
  }
}
