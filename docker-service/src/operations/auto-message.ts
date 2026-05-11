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
      const tokens = await this.extractTokens(username);

      const myUserId = this.httpClient.getUserId();
      if (!myUserId) {
        throw new MessageSendError('Could not determine own user ID from cookies');
      }

      // Step 2: Resolve username to Facebook user ID
      const recipientId = await this.resolveUserId(username, tokens);

      await randomDelay(1000, 2000);

      // Step 3: Send the message (mbasic first, then GraphQL/legacy fallbacks)
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

  private async extractTokens(
    username: string,
  ): Promise<{ fbDtsg: string; jazoest: string; lsd: string }> {
    // Try the target profile page first (if username is a URL) - gets tokens + helps with resolution
    if (username.startsWith('http')) {
      try {
        const response = await this.httpClient.request(username);
        const tokens = this.httpClient.extractTokens(response.body);
        if (tokens.fbDtsg) {
          log.debug('Extracted tokens from profile page');
          return tokens;
        }
      } catch (error) {
        log.warn({ error }, 'Failed to load profile page for tokens');
      }
    }

    // Try mbasic first — simpler page, more reliable token extraction
    try {
      log.debug('Trying mbasic.facebook.com for tokens');
      const response = await this.httpClient.request('https://mbasic.facebook.com/');

      if (this.httpClient.isLoginPage(response.body)) {
        log.warn('mbasic returned login page — session may be expired');
      } else {
        const dtsgMatch = response.body.match(/name="fb_dtsg"\s+value="([^"]+)"/);
        const jazoestMatch = response.body.match(/name="jazoest"\s+value="(\d+)"/);
        if (dtsgMatch) {
          log.debug('Extracted tokens from mbasic');
          return {
            fbDtsg: dtsgMatch[1],
            jazoest: jazoestMatch ? jazoestMatch[1] : '',
            lsd: '',
          };
        }
      }
    } catch (error) {
      log.warn({ error }, 'Failed to extract tokens from mbasic');
    }

    // Fallback: try main facebook.com pages
    const urls = [
      'https://www.facebook.com/',
      'https://www.facebook.com/me',
      'https://www.facebook.com/messages/',
    ];

    for (const url of urls) {
      try {
        const response = await this.httpClient.request(url);
        const tokens = this.httpClient.extractTokens(response.body);
        if (tokens.fbDtsg) {
          log.debug({ url }, 'Extracted tokens from page');
          return tokens;
        }
      } catch (error) {
        log.warn({ error, url }, 'Failed to load page for tokens');
      }
    }

    return { fbDtsg: '', jazoest: '', lsd: '' };
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

        // Priority 1: Profile-specific patterns (most reliable)
        const specificPatterns = [
          /"profileOwnerID"\s*:\s*"(\d+)"/,
          /content="fb:\/\/profile\/(\d+)"/,
          /"profile_owner"\s*:\{[^}]*?"id"\s*:\s*"(\d+)"/,
          /"userID"\s*:\s*"(\d+)"/,
        ];

        const myId = this.httpClient.getUserId();
        for (const pattern of specificPatterns) {
          const match = response.body.match(pattern);
          if (match && match[1] !== myId) {
            log.info({ userId: match[1], pattern: pattern.source.substring(0, 30) }, 'Resolved user ID from specific pattern');
            return match[1];
          }
        }

        // Priority 2: Frequency analysis - most common non-self ID is likely the profile owner
        const genericPatterns = [
          /"userID"\s*:\s*"(\d+)"/g,
          /"entity_id"\s*:\s*"(\d+)"/g,
          /"ownerID"\s*:\s*"(\d+)"/g,
          /"actorID"\s*:\s*"(\d+)"/g,
        ];

        const freq = new Map<string, number>();
        for (const gp of genericPatterns) {
          let m;
          while ((m = gp.exec(response.body)) !== null) {
            if (m[1] !== myId && m[1].length > 5) {
              freq.set(m[1], (freq.get(m[1]) || 0) + 1);
            }
          }
        }

        if (freq.size > 0) {
          const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
          log.info({ userId: sorted[0][0], count: sorted[0][1] }, 'Resolved user ID by frequency analysis');
          return sorted[0][0];
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

    // Strategy 1: mbasic search (most reliable, simple HTML parsing)
    try {
      const userId = await this.searchViaMbasic(query);
      if (userId) return userId;
    } catch (error) {
      log.warn({ error }, 'mbasic search failed');
    }

    // Strategy 2: Web search on Facebook
    try {
      const userId = await this.searchViaWebSearch(query);
      if (userId) return userId;
    } catch (error) {
      log.warn({ error }, 'Web search failed');
    }

    // Strategy 3: GraphQL search (may have outdated doc_id)
    if (tokens.fbDtsg) {
      try {
        const userId = await this.searchViaGraphQL(query, tokens);
        if (userId) return userId;
      } catch (error) {
        log.warn({ error }, 'GraphQL search failed');
      }

      // Strategy 4: Typeahead search (legacy endpoint)
      try {
        const userId = await this.searchViaTypeahead(query, tokens);
        if (userId) return userId;
      } catch (error) {
        log.warn({ error }, 'Typeahead search failed');
      }
    }

    throw new UserNotFoundError(query);
  }

  private async searchViaMbasic(query: string): Promise<string | null> {
    log.debug({ query }, 'Trying mbasic people search');

    const searchUrl = `https://mbasic.facebook.com/search/people/?q=${encodeURIComponent(query)}`;
    const response = await this.httpClient.request(searchUrl, {
      referer: 'https://mbasic.facebook.com/',
    });

    if (this.httpClient.isLoginPage(response.body)) {
      log.warn('mbasic search returned login page');
      return null;
    }

    const myId = this.httpClient.getUserId();

    // Pattern 1: profile.php?id=123 links (most common on mbasic)
    const profilePhpPattern = /\/profile\.php\?id=(\d+)/g;
    let m;
    while ((m = profilePhpPattern.exec(response.body)) !== null) {
      if (m[1] !== myId) {
        log.info({ userId: m[1], query }, 'Found user via mbasic profile.php link');
        return m[1];
      }
    }

    // Pattern 2: /messages/thread/USERID links
    const threadPattern = /\/messages\/thread\/(\d+)/g;
    while ((m = threadPattern.exec(response.body)) !== null) {
      if (m[1] !== myId) {
        log.info({ userId: m[1], query }, 'Found user via mbasic thread link');
        return m[1];
      }
    }

    // Pattern 3: profile_id in data attributes
    const profileIdPattern = /"profile_id"\s*:\s*(\d+)/g;
    while ((m = profileIdPattern.exec(response.body)) !== null) {
      if (m[1] !== myId) {
        log.info({ userId: m[1], query }, 'Found user via mbasic profile_id');
        return m[1];
      }
    }

    // Pattern 4: Resolve from username links — find <a href="/username"> links
    // and then load the profile to get the numeric ID
    const usernameLinks = response.body.match(/href="\/([a-zA-Z0-9._]+)"/g) || [];
    for (const link of usernameLinks) {
      const usernameMatch = link.match(/href="\/([a-zA-Z0-9._]+)"/);
      if (!usernameMatch) continue;
      const potentialUsername = usernameMatch[1];
      // Skip common non-profile paths
      if (['search', 'help', 'messages', 'login', 'a', 'images', 'settings', 'home', 'buddylist', 'composer'].includes(potentialUsername)) continue;
      if (potentialUsername.includes('.php')) continue;

      // Try loading this profile on mbasic to extract ID
      try {
        const profileResp = await this.httpClient.request(
          `https://mbasic.facebook.com/${potentialUsername}`,
          { referer: 'https://mbasic.facebook.com/' },
        );
        const idMatch = profileResp.body.match(/\/profile\.php\?id=(\d+)/) ||
          profileResp.body.match(/owner_id=(\d+)/) ||
          profileResp.body.match(/subject_id=(\d+)/);
        if (idMatch && idMatch[1] !== myId) {
          log.info({ userId: idMatch[1], username: potentialUsername, query }, 'Resolved user via mbasic profile page');
          return idMatch[1];
        }
      } catch {
        // Continue to next link
      }
      break; // Only try the first plausible link
    }

    log.debug({ query, bodyLength: response.body.length }, 'No user found on mbasic search');
    return null;
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

    if (response.statusCode !== 200 || body.includes('"was not found"')) {
      log.warn({ statusCode: response.statusCode }, 'GraphQL search endpoint returned error');
      return null;
    }

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
    const errors: string[] = [];

    // Strategy 1: mbasic.facebook.com HTML form (most reliable)
    try {
      await this.sendViaMbasic(recipientId, message);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn({ error: msg }, 'mbasic send failed, trying next strategy');
      errors.push(`mbasic: ${msg}`);
    }

    if (!tokens.fbDtsg) {
      throw new MessageSendError(`All message send strategies failed (no fb_dtsg for API calls): ${errors.join('; ')}`);
    }

    // Strategy 2: GraphQL API
    try {
      await this.sendViaGraphQL(recipientId, myUserId, message, tokens);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn({ error: msg }, 'GraphQL send failed, trying next strategy');
      errors.push(`graphql: ${msg}`);
    }

    // Strategy 3: Legacy /messaging/send/ endpoint
    try {
      await this.sendViaLegacyEndpoint(recipientId, myUserId, message, tokens);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn({ error: msg }, 'Legacy send failed');
      errors.push(`legacy: ${msg}`);
    }

    throw new MessageSendError(`All message send strategies failed: ${errors.join('; ')}`);
  }

  private async sendViaMbasic(recipientId: string, message: string): Promise<void> {
    log.info({ recipientId }, 'Sending message via mbasic.facebook.com');

    // Step 1: Load the compose page to get the form and hidden fields
    const composeUrl = `https://mbasic.facebook.com/messages/compose/?ids=${recipientId}`;
    const page = await this.httpClient.request(composeUrl, {
      referer: 'https://mbasic.facebook.com/',
    });

    if (this.httpClient.isLoginPage(page.body)) {
      throw new MessageSendError('Session not valid on mbasic (login page)');
    }

    // Step 2: Find the message send form (try multiple patterns)
    const formMatch =
      page.body.match(/<form[^>]*action="(\/messages\/[^"]*)"[^>]*method="post"/i) ||
      page.body.match(/<form[^>]*method="post"[^>]*action="(\/messages\/[^"]*)"/i) ||
      page.body.match(/<form[^>]*action="(\/messages\/send\/[^"]*)"[^>]*/i);

    if (!formMatch) {
      // Try alternate compose URL: direct thread
      const threadUrl = `https://mbasic.facebook.com/messages/read/?tid=cid.c.${recipientId}%3A${this.httpClient.getUserId()}`;
      log.debug({ threadUrl }, 'No compose form found, trying thread URL');

      const threadPage = await this.httpClient.request(threadUrl, {
        referer: 'https://mbasic.facebook.com/messages/',
      });

      const threadFormMatch =
        threadPage.body.match(/<form[^>]*action="(\/messages\/[^"]*)"[^>]*method="post"/i) ||
        threadPage.body.match(/<form[^>]*method="post"[^>]*action="(\/messages\/[^"]*)"/i);

      if (!threadFormMatch) {
        log.debug({ bodySnippet: page.body.substring(0, 2000) }, 'mbasic compose page preview');
        throw new MessageSendError('No message form found on mbasic compose or thread page');
      }

      return this.submitMbasicForm(threadPage.body, threadFormMatch[1], message, threadUrl);
    }

    return this.submitMbasicForm(page.body, formMatch[1], message, composeUrl);
  }

  private async submitMbasicForm(
    pageBody: string,
    rawFormAction: string,
    message: string,
    referer: string,
  ): Promise<void> {
    let formAction = rawFormAction.replace(/&amp;/g, '&');
    if (!formAction.startsWith('http')) {
      formAction = `https://mbasic.facebook.com${formAction}`;
    }

    // Extract hidden input fields from the form
    const params = new URLSearchParams();
    const hiddenRegex = /<input[^>]*type="hidden"[^>]*/gi;
    let match;
    while ((match = hiddenRegex.exec(pageBody)) !== null) {
      const tag = match[0];
      const nameMatch = tag.match(/name="([^"]*)"/);
      const valueMatch = tag.match(/value="([^"]*)"/);
      if (nameMatch) {
        params.append(
          nameMatch[1].replace(/&amp;/g, '&'),
          valueMatch ? valueMatch[1].replace(/&amp;/g, '&') : '',
        );
      }
    }

    // Add message body
    params.append('body', message);

    // Extract submit button value (German: "Senden", English: "Send", etc.)
    const submitMatch = pageBody.match(/<input[^>]*name="send"[^>]*value="([^"]*)"/i);
    params.append('send', submitMatch ? submitMatch[1] : 'Senden');

    log.debug({ formAction, hiddenFieldCount: [...params.keys()].length }, 'Submitting mbasic message form');

    const response = await this.httpClient.post(formAction, params.toString(), {
      referer,
    });

    if (response.statusCode >= 400) {
      throw new MessageSendError(`mbasic send returned HTTP ${response.statusCode}`);
    }

    // Check for success indicators
    const hasThread = response.body.includes('/messages/read/') || response.body.includes('/messages/thread/');
    if (hasThread) {
      log.info('Message confirmed sent via mbasic (thread link found in response)');
    } else if (response.body.includes('error') && response.body.length < 2000) {
      log.warn({ bodySnippet: response.body.substring(0, 500) }, 'mbasic response may contain error');
      // Don't throw — Facebook sometimes returns pages without thread links but message was still sent
    }

    log.info('Message sent via mbasic.facebook.com');
  }

  private async sendViaGraphQL(
    recipientId: string,
    myUserId: string,
    message: string,
    tokens: { fbDtsg: string; jazoest: string; lsd: string },
  ): Promise<void> {
    log.info({ recipientId }, 'Sending message via GraphQL API');

    // Try to extract a fresh doc_id from the Messenger page
    let docId = '7316395148464937'; // fallback
    try {
      const messengerPage = await this.httpClient.request(
        `https://www.facebook.com/messages/t/${recipientId}`,
        { referer: 'https://www.facebook.com/messages/' },
      );
      // Look for send message mutation doc_id in page bundle
      const docIdMatch =
        messengerPage.body.match(/useSendMessageMutation[^}]{0,500}?(?:doc_id|"id")\s*[:=]\s*"(\d{10,})"/) ||
        messengerPage.body.match(/(?:doc_id|"id")\s*[:=]\s*"(\d{10,})"[^}]{0,500}?useSendMessageMutation/);
      if (docIdMatch) {
        docId = docIdMatch[1];
        log.info({ docId }, 'Extracted fresh send message doc_id');
      }
    } catch (error) {
      log.debug({ error }, 'Could not extract fresh doc_id, using fallback');
    }

    const variables = JSON.stringify({
      input: {
        message: { text: message },
        otherUserFbId: recipientId,
        source: 'messenger:web',
        initiatingSource: 'messenger:send_message',
      },
    });

    const params = new URLSearchParams({
      fb_dtsg: tokens.fbDtsg,
      jazoest: tokens.jazoest,
      lsd: tokens.lsd,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'useSendMessageMutation',
      variables,
      doc_id: docId,
      __user: myUserId,
      __a: '1',
    });

    const response = await this.httpClient.post(
      'https://www.facebook.com/api/graphql/',
      params.toString(),
      { referer: 'https://www.facebook.com/messages/t/' + recipientId },
    );

    const body = response.body.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
    log.debug({ statusCode: response.statusCode, bodySnippet: body.substring(0, 500) }, 'GraphQL send response');

    if (response.statusCode !== 200) {
      throw new MessageSendError(`GraphQL returned HTTP ${response.statusCode}`);
    }

    // Check for errors in response
    try {
      // GraphQL responses can be multi-line JSON objects
      for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        const data = JSON.parse(trimmed);
        if (data.error === 1357001 || data.errorSummary) {
          throw new MessageSendError('GraphQL: session not authenticated');
        }
        if (data.errors && data.errors.length > 0) {
          const errMsg = data.errors[0]?.message || JSON.stringify(data.errors);
          throw new MessageSendError(`GraphQL error: ${errMsg}`);
        }
      }
    } catch (e) {
      if (e instanceof MessageSendError) throw e;
      // If we got 200 and body isn't valid JSON or no errors found, assume success
    }

    log.info({ recipientId }, 'Message sent via GraphQL');
  }

  private async sendViaLegacyEndpoint(
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
    params.append('__user', myUserId);
    params.append('__a', '1');

    log.debug({ recipientId, myUserId }, 'Sending via /messaging/send/');

    const response = await this.httpClient.post(
      'https://www.facebook.com/messaging/send/',
      params.toString(),
      { referer: 'https://www.facebook.com/messages/t/' + recipientId },
    );

    if (response.statusCode !== 200) {
      log.debug({ statusCode: response.statusCode, bodySnippet: response.body.substring(0, 500) }, 'messaging/send response');
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
