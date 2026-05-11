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
        // Handle profile.php?id=123 style URLs
        const idParam = url.searchParams.get('id');
        if (idParam && /^\d+$/.test(idParam)) {
          return idParam;
        }
      } catch {
        // Not a valid URL, use as-is
      }
    }

    // If it looks like a Facebook username (no spaces, not a display name),
    // try fetching the profile page first
    const isDisplayName = /\s/.test(profilePath);

    if (!isDisplayName) {
      const profileUrl = `https://www.facebook.com/${encodeURIComponent(profilePath)}`;
      log.info({ profileUrl }, 'Resolving user ID from profile');

      try {
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
      } catch (error) {
        log.warn({ error, profilePath }, 'Failed to fetch profile page, falling back to search');
      }
    }

    // Search by name using multiple strategies
    return this.searchUser(username, tokens);
  }

  private async searchUser(
    query: string,
    tokens: { fbDtsg: string; jazoest: string; lsd: string },
  ): Promise<string> {
    log.info({ query }, 'Searching for user');

    // Strategy 1: GraphQL search (modern Facebook)
    try {
      const userId = await this.searchViaGraphQL(query, tokens);
      if (userId) return userId;
    } catch (error) {
      log.warn({ error }, 'GraphQL search failed');
    }

    // Strategy 2: Typeahead search (legacy endpoint)
    try {
      const userId = await this.searchViaTypeahead(query, tokens);
      if (userId) return userId;
    } catch (error) {
      log.warn({ error }, 'Typeahead search failed');
    }

    // Strategy 3: Web search on Facebook
    try {
      const userId = await this.searchViaWebSearch(query);
      if (userId) return userId;
    } catch (error) {
      log.warn({ error }, 'Web search failed');
    }

    throw new UserNotFoundError(query);
  }

  private async searchViaGraphQL(
    query: string,
    tokens: { fbDtsg: string; jazoest: string; lsd: string },
  ): Promise<string | null> {
    log.debug({ query }, 'Trying GraphQL search');

    const variables = JSON.stringify({
      rawQuery: query,
      querySource: 'MESSAGING_SEARCH',
      searchRequestID: `search_${Date.now()}`,
    });

    const params = new URLSearchParams({
      fb_dtsg: tokens.fbDtsg,
      jazoest: tokens.jazoest,
      lsd: tokens.lsd,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'SearchCometResultsPaginatedResultsQuery',
      variables,
      doc_id: '6071559492883486',
      __a: '1',
    });

    const response = await this.httpClient.post(
      'https://www.facebook.com/api/graphql/',
      params.toString(),
      { referer: 'https://www.facebook.com/messages/' },
    );

    const body = response.body.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');

    // Try to find user IDs in the GraphQL response
    const idPatterns = [
      /"id"\s*:\s*"(\d+)"/g,
      /"user_id"\s*:\s*"(\d+)"/g,
      /"uid"\s*:\s*"?(\d+)"?/g,
      /"entity_id"\s*:\s*"(\d+)"/g,
    ];

    const myId = this.httpClient.getUserId();
    const candidates: string[] = [];

    for (const pattern of idPatterns) {
      let match;
      while ((match = pattern.exec(body)) !== null) {
        if (match[1] !== myId && match[1].length > 5) {
          candidates.push(match[1]);
        }
      }
    }

    if (candidates.length > 0) {
      // Return the most frequently occurring ID (most likely the search result)
      const freq = new Map<string, number>();
      for (const id of candidates) {
        freq.set(id, (freq.get(id) || 0) + 1);
      }
      const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
      log.info({ userId: sorted[0][0], query }, 'Found user via GraphQL search');
      return sorted[0][0];
    }

    return null;
  }

  private async searchViaTypeahead(
    query: string,
    tokens: { fbDtsg: string; jazoest: string; lsd: string },
  ): Promise<string | null> {
    log.debug({ query }, 'Trying typeahead search');

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
      const idMatch = body.match(/"uid"\s*:\s*(\d+)/);
      if (idMatch) {
        return idMatch[1];
      }
    }

    return null;
  }

  private async searchViaWebSearch(query: string): Promise<string | null> {
    log.debug({ query }, 'Trying web search');

    const searchUrl = `https://www.facebook.com/search/people/?q=${encodeURIComponent(query)}`;
    const response = await this.httpClient.request(searchUrl, {
      referer: 'https://www.facebook.com/',
    });

    // Look for profile links and user IDs in the search results page
    const patterns = [
      /"entity_id"\s*:\s*"(\d+)"/,
      /"userID"\s*:\s*"(\d+)"/,
      /"id"\s*:\s*"(\d{8,})"/,
      /\/profile\/(\d+)/,
    ];

    const myId = this.httpClient.getUserId();

    for (const pattern of patterns) {
      const match = response.body.match(pattern);
      if (match && match[1] !== myId && match[1].length > 5) {
        log.info({ userId: match[1], query }, 'Found user via web search');
        return match[1];
      }
    }

    return null;
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
