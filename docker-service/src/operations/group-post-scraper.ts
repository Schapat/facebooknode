import type { GroupPost, GroupPostScraperInput } from '@facebook-automation/shared-types';
import { FacebookHttpClient } from '../services/facebook-http-client';
import { SessionManager } from '../services/session-manager';
import { ScrapeError } from '../errors';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';

const log = createChildLogger({ service: 'GroupPostScraper' });

export class GroupPostScraper {
  private httpClient: FacebookHttpClient;

  constructor(private readonly sessionManager: SessionManager) {
    this.httpClient = new FacebookHttpClient(sessionManager);
  }

  async execute(sessionName: string, input: GroupPostScraperInput): Promise<GroupPost[]> {
    await this.httpClient.initSession(sessionName);
    const allPosts: GroupPost[] = [];
    const errors: { groupUrl: string; error: string }[] = [];

    try {
      for (let i = 0; i < input.groups.length; i++) {
        const groupUrl = input.groups[i];
        log.info({ groupUrl, index: i + 1, total: input.groups.length }, 'Scraping group posts via HTTP');
        try {
          const posts = await this.scrapeGroupWithRetry(groupUrl, input);
          allPosts.push(...posts);
          log.info({ groupUrl, postsFound: posts.length }, 'Group scraped successfully');
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          log.error({ groupUrl, error: msg }, 'Failed to scrape group');
          errors.push({ groupUrl, error: msg });
        }
        // Delay between groups to avoid rate-limiting
        if (i < input.groups.length - 1) {
          const baseDelay = input.groupDelay || 30000;
          const jitter = Math.floor(Math.random() * 5000); // 0-5s random jitter
          const delayMs = baseDelay + jitter;
          log.info({ delayMs, nextGroup: input.groups[i + 1] }, 'Waiting before next group');
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    } finally {
      // Always persist rotated cookies back to Redis
      await this.httpClient.persistCookies();
    }

    if (errors.length > 0) {
      log.warn({
        totalGroups: input.groups.length,
        successfulGroups: input.groups.length - errors.length,
        failedGroups: errors.length,
        errors,
      }, 'Some groups failed to scrape');
    }

    return allPosts;
  }

  private async scrapeGroupWithRetry(
    groupUrl: string,
    input: GroupPostScraperInput,
    maxRetries: number = 2,
  ): Promise<GroupPost[]> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.scrapeGroup(groupUrl, input);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const isRateLimit = lastError.message.includes('login page') ||
          lastError.message.includes('checkpoint') ||
          lastError.message.includes('Session expired');

        if (isRateLimit && attempt < maxRetries) {
          const backoffMs = (attempt + 1) * 15000; // 15s, 30s
          log.warn({ groupUrl, attempt: attempt + 1, backoffMs }, 'Rate-limited, backing off before retry');
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        throw lastError;
      }
    }

    throw lastError!;
  }

  private async scrapeGroup(
    groupUrl: string,
    input: GroupPostScraperInput,
  ): Promise<GroupPost[]> {
    const normalizedUrl = this.normalizeGroupUrl(groupUrl);
    const response = await this.httpClient.request(normalizedUrl);

    if (response.statusCode !== 200) {
      throw new ScrapeError(`HTTP ${response.statusCode} for ${normalizedUrl}`);
    }

    if (this.httpClient.isLoginPage(response.body)) {
      throw new ScrapeError('Session expired - redirected to login page');
    }

    const groupName = this.extractGroupName(response.body);
    const groupSlug = normalizedUrl.match(/groups\/([^/?]+)/)?.[1] || '';
    const maxPosts = input.maxPosts || 100;
    const cutoffTimestamp = input.lastScrapeTimestamp
      ? new Date(input.lastScrapeTimestamp).getTime()
      : 0;

    // Parse initial HTML posts
    const posts = this.parsePostsFromHtml(response.body, groupName, groupSlug, maxPosts, cutoffTimestamp);
    log.info({ groupName, initialPosts: posts.length, maxPosts }, 'Initial page parsed');

    // If we need more posts, paginate via GraphQL
    if (posts.length < maxPosts) {
      const seenIds = new Set(posts.map(p => p.postId));
      await this.paginateWithGraphQL(
        response.body,
        normalizedUrl,
        groupName,
        groupSlug,
        maxPosts,
        cutoffTimestamp,
        posts,
        seenIds,
      );
    }

    log.info({ groupName, postsCount: posts.length }, 'Group scraping complete');
    return posts;
  }

  /**
   * Use Facebook's GraphQL API to load additional pages of posts.
   * Extracts cursor and tokens from HTML, then makes paginated requests.
   */
  private async paginateWithGraphQL(
    html: string,
    groupUrl: string,
    groupName: string,
    groupSlug: string,
    maxPosts: number,
    cutoffTimestamp: number,
    posts: GroupPost[],
    seenIds: Set<string>,
  ): Promise<void> {
    const tokens = this.httpClient.extractTokens(html);
    if (!tokens.fbDtsg) {
      log.warn('No fb_dtsg token found, cannot paginate');
      return;
    }

    // Find the group ID from the HTML
    const groupId = this.extractGroupId(html);
    if (!groupId) {
      log.warn('No group ID found, cannot paginate');
      return;
    }

    // Find initial end_cursor for pagination
    // Try to extract doc_id from the HTML, with fallbacks
    const docId = this.extractDocId(html);
    const relayProviderVars = this.extractRelayProviderVariables(html);
    log.info({ groupId, fbDtsg: tokens.fbDtsg.substring(0, 10) + '...', docId, relayVarsCount: Object.keys(relayProviderVars).length }, 'Pagination tokens found');

    let cursor = this.extractEndCursor(html);
    if (!cursor) {
      log.warn('No pagination cursor found in initial HTML');
      return;
    }

    const maxPages = 10; // Safety limit
    let page = 0;
    let hitCutoff = false;

    while (posts.length < maxPosts && page < maxPages && cursor && !hitCutoff) {
      page++;
      log.info({ page, postsCount: posts.length, maxPosts }, 'Fetching next page via GraphQL');

      await randomDelay(1000, 3000);

      try {
        const graphqlPosts = await this.fetchGraphQLPage(
          tokens,
          groupId,
          cursor,
          groupName,
          groupSlug,
          groupUrl,
          docId,
          relayProviderVars,
        );

        if (!graphqlPosts || graphqlPosts.posts.length === 0) {
          log.info({ page }, 'No more posts from GraphQL');
          break;
        }

        let newPostsAdded = 0;
        for (const post of graphqlPosts.posts) {
          if (seenIds.has(post.postId)) continue;
          seenIds.add(post.postId);

          if (cutoffTimestamp > 0 && post.createdAt) {
            const postTime = new Date(post.createdAt).getTime();
            if (!isNaN(postTime) && postTime < cutoffTimestamp) {
              hitCutoff = true;
              break;
            }
          }

          posts.push(post);
          newPostsAdded++;
          if (posts.length >= maxPosts) break;
        }

        log.info({ page, newPostsAdded, total: posts.length }, 'GraphQL page processed');

        if (newPostsAdded === 0) break;

        cursor = graphqlPosts.nextCursor || null;
      } catch (error) {
        log.warn({ error, page }, 'GraphQL pagination failed');
        break;
      }
    }
  }

  private async fetchGraphQLPage(
    tokens: { fbDtsg: string; jazoest: string; lsd: string },
    groupId: string,
    cursor: string,
    groupName: string,
    groupSlug: string,
    referer: string,
    docId: string,
    relayProviderVars: Record<string, unknown>,
  ): Promise<{ posts: GroupPost[]; nextCursor: string | null } | null> {
    const variables: Record<string, unknown> = {
      count: 10,
      cursor,
      groupID: groupId,
      id: groupId,
      scale: 1,
      ...relayProviderVars,
    };

    const params = new URLSearchParams({
      av: this.httpClient.getUserId() || '0',
      __a: '1',
      __comet_req: '15',
      fb_dtsg: tokens.fbDtsg,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'GroupsCometFeedRegularStoriesPaginationQuery',
      variables: JSON.stringify(variables),
      server_timestamps: 'true',
      doc_id: docId,
    });

    if (tokens.jazoest) params.set('jazoest', tokens.jazoest);
    if (tokens.lsd) params.set('lsd', tokens.lsd);

    const response = await this.httpClient.post(
      'https://www.facebook.com/api/graphql/',
      params.toString(),
      { referer, timeout: 20000 },
    );

    if (response.statusCode !== 200) {
      log.warn({ statusCode: response.statusCode }, 'GraphQL request failed');
      return null;
    }

    // Check if the doc_id was rejected (specific "not found" error)
    if (response.body.includes('was not found')) {
      log.warn({ docId }, 'doc_id not found, cannot paginate');
      return null;
    }

    log.info({ docId, bodyLength: response.body.length }, 'GraphQL response received');

    const posts: GroupPost[] = [];
    const seenIds = new Set<string>();
    let nextCursor: string | null = null;

    // Facebook returns streaming JSONL - multiple JSON objects separated by newlines
    const lines = response.body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) continue;

      try {
        const data = JSON.parse(trimmed);
        this.walkJsonForPosts(data, posts, seenIds, groupName, groupSlug, 0);
        const cursorVal = this.deepFindEndCursor(data);
        if (cursorVal) nextCursor = cursorVal;
      } catch {
        // Not valid JSON
      }
    }

    return { posts, nextCursor };
  }

  private extractGroupId(html: string): string | null {
    // Try multiple patterns
    const patterns = [
      /"groupID"\s*:\s*"(\d+)"/,
      /"group_id"\s*:\s*"(\d+)"/,
      /group\/(\d+)/,
      /"id"\s*:\s*"(\d+)"[^}]*"__typename"\s*:\s*"Group"/,
      /"Group"[^}]*"id"\s*:\s*"(\d+)"/,
      /fb:\/\/group\/(\d+)/,
      /content="fb:\/\/group\/(\d+)"/,
      /entity_id\s*:\s*"(\d+)"/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) return match[1];
    }

    return null;
  }

  /**
   * Extract doc_id candidates from page HTML.
   * Facebook embeds relay query doc_ids in their JavaScript bundles.
   * We search for any doc_id near pagination-related keywords.
   */
  private extractDocId(html: string): string {
    // Strategy 1: Look for doc_id patterns near GroupsCometFeed references
    const patterns = [
      /GroupsCometFeedRegularStoriesPaginationQuery[^}]{0,500}?(?:doc_id|"id")\s*[:=]\s*"(\d{10,})"/,
      /(?:doc_id|"id")\s*[:=]\s*"(\d{10,})"[^}]{0,500}?GroupsCometFeedRegularStoriesPaginationQuery/,
      /"(\d{10,})"[^}]{0,200}?"GroupsCometFeedRegularStoriesPaginationQuery"/,
      /GroupsCometFeedRegularStoriesPaginationQuery"[^}]{0,200}?"(\d{10,})"/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        log.info({ docId: match[1] }, 'Extracted doc_id from HTML');
        return match[1];
      }
    }

    // Strategy 2: Look for any doc_id near "GroupsCometFeed" in Relay preload data
    // Facebook often has: preloadQuery("NNNN", {groupID:...})
    const preloadMatch = html.match(/preload(?:Query|ed)\s*\(\s*"(\d{10,})"[^)]*groupID/i);
    if (preloadMatch) {
      log.info({ docId: preloadMatch[1] }, 'Extracted doc_id from preloadQuery');
      return preloadMatch[1];
    }

    log.info('Could not extract doc_id from HTML, using default');
    return '26953539974284126';
  }

  private extractEndCursor(html: string): string | null {
    // Find the long cursor near group_feed context (not short values like "3")
    for (const cm of html.matchAll(/"end_cursor"\s*:\s*"([^"]{10,})"/g)) {
      const ctx = html.substring(Math.max(0, cm.index! - 500), cm.index!);
      if (ctx.includes('group_feed')) {
        return cm[1];
      }
    }

    // Fallback: any long end_cursor
    const fallback = html.match(/"end_cursor"\s*:\s*"([^"]{10,})"/)
      || html.match(/"endCursor"\s*:\s*"([^"]{10,})"/);
    if (fallback) return fallback[1];

    return null;
  }

  /**
   * Extract __relay_internal__pv__ provided variable values from the HTML.
   * Facebook embeds these in the initial page data. They include booleans,
   * numbers, and strings that the Relay runtime needs for queries.
   */
  private extractRelayProviderVariables(html: string): Record<string, unknown> {
    const pvValues: Record<string, unknown> = {};
    for (const pvm of html.matchAll(/"(__relay_internal__pv__[^"]+)"\s*:\s*(true|false|null|\d+|"[^"]*")/g)) {
      const name = pvm[1];
      const raw = pvm[2];
      if (raw === 'true') pvValues[name] = true;
      else if (raw === 'false') pvValues[name] = false;
      else if (raw === 'null') pvValues[name] = null;
      else if (/^\d+$/.test(raw)) pvValues[name] = parseInt(raw);
      else pvValues[name] = raw.replace(/^"|"$/g, '');
    }
    return pvValues;
  }

  private deepFindEndCursor(obj: unknown, depth = 0): string | null {
    if (depth > 30 || !obj || typeof obj !== 'object') return null;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = this.deepFindEndCursor(item, depth + 1);
        if (r) return r;
      }
      return null;
    }

    const record = obj as Record<string, unknown>;

    // Check for page_info with end_cursor
    if (record.page_info && typeof record.page_info === 'object') {
      const pi = record.page_info as Record<string, unknown>;
      if (pi.has_next_page === true && typeof pi.end_cursor === 'string') {
        return pi.end_cursor;
      }
    }

    for (const value of Object.values(record)) {
      const r = this.deepFindEndCursor(value, depth + 1);
      if (r) return r;
    }
    return null;
  }

  private parsePostsFromHtml(
    html: string,
    groupName: string,
    groupSlug: string,
    maxPosts: number,
    cutoffTimestamp: number,
  ): GroupPost[] {
    const posts: GroupPost[] = [];
    const seenIds = new Set<string>();

    // Strategy 1: Parse JSON from script tags and walk tree for story nodes
    const jsonPosts = this.extractFromJsonScripts(html, groupName, groupSlug);
    for (const post of jsonPosts) {
      if (seenIds.has(post.postId)) continue;
      seenIds.add(post.postId);

      if (cutoffTimestamp > 0 && post.createdAt) {
        const postTime = new Date(post.createdAt).getTime();
        if (!isNaN(postTime) && postTime < cutoffTimestamp) continue;
      }

      posts.push(post);
      if (posts.length >= maxPosts) break;
    }

    // Strategy 2: Context-based extraction around post permalink IDs
    if (posts.length === 0) {
      const contextPosts = this.extractByPostContext(html, groupName, groupSlug);
      for (const post of contextPosts) {
        if (seenIds.has(post.postId)) continue;
        seenIds.add(post.postId);

        if (cutoffTimestamp > 0 && post.createdAt) {
          const postTime = new Date(post.createdAt).getTime();
          if (!isNaN(postTime) && postTime < cutoffTimestamp) continue;
        }

        posts.push(post);
        if (posts.length >= maxPosts) break;
      }
    }

    return posts;
  }

  // ==========================================
  // Strategy 1: JSON tree walking
  // ==========================================

  private extractFromJsonScripts(html: string, groupName: string, groupSlug: string): GroupPost[] {
    const posts: GroupPost[] = [];
    const seenIds = new Set<string>();

    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let scriptMatch;

    while ((scriptMatch = scriptRegex.exec(html)) !== null) {
      const content = scriptMatch[1].trim();
      if (!content || content.length < 200) continue;
      if (!content.startsWith('{') && !content.startsWith('[')) continue;

      // Quick pre-filter: only parse scripts that might contain post data
      if (
        !content.includes('post_id') &&
        !content.includes('story_id') &&
        !content.includes('creation_time')
      ) {
        continue;
      }

      try {
        const data = JSON.parse(content);
        this.walkJsonForPosts(data, posts, seenIds, groupName, groupSlug, 0);
      } catch {
        // Not valid JSON, skip
      }
    }

    log.debug({ count: posts.length }, 'Posts found via JSON tree walking');
    return posts;
  }

  private walkJsonForPosts(
    obj: unknown,
    posts: GroupPost[],
    seenIds: Set<string>,
    groupName: string,
    groupSlug: string,
    depth: number,
  ): void {
    if (depth > 40 || !obj) return;

    // Handle embedded JSON strings (Facebook double-encodes some relay data)
    if (typeof obj === 'string') {
      if (obj.length > 100 && (obj.startsWith('{') || obj.startsWith('['))) {
        try {
          const parsed = JSON.parse(obj);
          this.walkJsonForPosts(parsed, posts, seenIds, groupName, groupSlug, depth + 1);
        } catch { /* not JSON */ }
      }
      return;
    }

    if (typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        this.walkJsonForPosts(item, posts, seenIds, groupName, groupSlug, depth + 1);
      }
      return;
    }

    const record = obj as Record<string, unknown>;

    // Check if this node has a post_id with meaningful content
    const postId = this.getPostId(record);
    if (postId && !seenIds.has(postId)) {
      const post = this.buildPostFromNode(record, postId, groupName, groupSlug);
      if (post) {
        seenIds.add(postId);
        posts.push(post);
      }
    }

    // Continue walking child values to find more posts
    for (const value of Object.values(record)) {
      this.walkJsonForPosts(value, posts, seenIds, groupName, groupSlug, depth + 1);
    }
  }

  private getPostId(obj: Record<string, unknown>): string | null {
    for (const key of ['post_id', 'story_id', 'legacy_story_id']) {
      const val = obj[key];
      if (typeof val === 'string' && /^\d+$/.test(val)) return val;
    }
    return null;
  }

  private buildPostFromNode(
    obj: Record<string, unknown>,
    postId: string,
    groupName: string,
    groupSlug: string,
  ): GroupPost | null {
    // Search within THIS node's subtree for all post data
    const message = this.deepFindMessageText(obj);
    const creationTime = this.deepFindNumber(obj, 'creation_time');

    // Only create a post if we have meaningful data (not just a bare reference)
    if (!message && !creationTime) return null;

    const author = this.deepFindAuthor(obj) || this.deepFindOwningProfile(obj);
    const likes = this.deepFindNestedCount(obj, 'reaction_count', 'count');
    const comments =
      this.deepFindNestedCount(obj, 'comment_count', 'total_count') ??
      this.deepFindNumber(obj, 'total_comment_count');

    return {
      groupName,
      postId,
      authorName: author?.name || 'Unknown',
      authorProfileUrl: author?.url || '',
      title: '',
      content: message || '',
      createdAt: creationTime
        ? new Date(creationTime * 1000).toISOString()
        : new Date().toISOString(),
      likes: likes ?? 0,
      comments: comments ?? 0,
      postUrl: `https://www.facebook.com/groups/${groupSlug}/posts/${postId}`,
    };
  }

  // ---- Deep-find helpers (search within a single node's subtree) ----

  private deepFindOwningProfile(obj: unknown, depth = 0): { name: string; url: string } | null {
    if (depth > 20 || !obj || typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = this.deepFindOwningProfile(item, depth + 1);
        if (r) return r;
      }
      return null;
    }
    const record = obj as Record<string, unknown>;
    if (record.owning_profile && typeof record.owning_profile === 'object') {
      const op = record.owning_profile as Record<string, unknown>;
      if (typeof op.name === 'string' && op.name.length > 1) {
        return { name: op.name, url: typeof op.url === 'string' ? op.url : '' };
      }
    }
    for (const value of Object.values(record)) {
      const r = this.deepFindOwningProfile(value, depth + 1);
      if (r) return r;
    }
    return null;
  }

  private deepFindMessageText(obj: unknown, depth = 0): string | null {
    if (depth > 20 || !obj || typeof obj !== 'object') return null;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = this.deepFindMessageText(item, depth + 1);
        if (r) return r;
      }
      return null;
    }

    const record = obj as Record<string, unknown>;

    // Check if this object has message.text
    if (record.message && typeof record.message === 'object' && !Array.isArray(record.message)) {
      const msg = record.message as Record<string, unknown>;
      if (typeof msg.text === 'string' && msg.text.length > 0) {
        return msg.text;
      }
    }

    for (const value of Object.values(record)) {
      const r = this.deepFindMessageText(value, depth + 1);
      if (r) return r;
    }
    return null;
  }

  private deepFindNumber(obj: unknown, key: string, depth = 0): number | null {
    if (depth > 20 || !obj || typeof obj !== 'object') return null;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = this.deepFindNumber(item, key, depth + 1);
        if (r !== null) return r;
      }
      return null;
    }

    const record = obj as Record<string, unknown>;
    if (key in record && typeof record[key] === 'number') {
      return record[key] as number;
    }

    for (const value of Object.values(record)) {
      const r = this.deepFindNumber(value, key, depth + 1);
      if (r !== null) return r;
    }
    return null;
  }

  private deepFindAuthor(obj: unknown, depth = 0): { name: string; url: string } | null {
    if (depth > 20 || !obj || typeof obj !== 'object') return null;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = this.deepFindAuthor(item, depth + 1);
        if (r) return r;
      }
      return null;
    }

    const record = obj as Record<string, unknown>;

    // Check actors array (most common Facebook pattern)
    if (Array.isArray(record.actors) && record.actors.length > 0) {
      const actor = record.actors[0] as Record<string, unknown>;
      if (typeof actor.name === 'string' && actor.name.length > 1) {
        return {
          name: actor.name,
          url: typeof actor.url === 'string' ? actor.url : '',
        };
      }
    }

    // Check actor object
    if (record.actor && typeof record.actor === 'object' && !Array.isArray(record.actor)) {
      const actor = record.actor as Record<string, unknown>;
      if (typeof actor.name === 'string' && actor.name.length > 1) {
        return {
          name: actor.name,
          url: typeof actor.url === 'string' ? actor.url : '',
        };
      }
    }

    // Check author object
    if (record.author && typeof record.author === 'object' && !Array.isArray(record.author)) {
      const author = record.author as Record<string, unknown>;
      if (typeof author.name === 'string' && author.name.length > 1) {
        return {
          name: author.name,
          url: typeof author.url === 'string' ? author.url : '',
        };
      }
    }

    for (const value of Object.values(record)) {
      const r = this.deepFindAuthor(value, depth + 1);
      if (r) return r;
    }
    return null;
  }

  private deepFindNestedCount(
    obj: unknown,
    parentKey: string,
    countKey: string,
    depth = 0,
  ): number | null {
    if (depth > 20 || !obj || typeof obj !== 'object') return null;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        const r = this.deepFindNestedCount(item, parentKey, countKey, depth + 1);
        if (r !== null) return r;
      }
      return null;
    }

    const record = obj as Record<string, unknown>;
    if (record[parentKey] && typeof record[parentKey] === 'object') {
      const parent = record[parentKey] as Record<string, unknown>;
      if (typeof parent[countKey] === 'number') {
        return parent[countKey] as number;
      }
    }

    for (const value of Object.values(record)) {
      const r = this.deepFindNestedCount(value, parentKey, countKey, depth + 1);
      if (r !== null) return r;
    }
    return null;
  }

  // ==========================================
  // Strategy 2: Context-based extraction
  // ==========================================

  private extractByPostContext(html: string, groupName: string, groupSlug: string): GroupPost[] {
    const posts: GroupPost[] = [];

    // Find post IDs from permalink URLs
    const postLinkRegex = /\/groups\/[^/]+\/(?:posts|permalink)\/(\d+)/g;
    const postIds = new Set<string>();
    let match;
    while ((match = postLinkRegex.exec(html)) !== null) {
      postIds.add(match[1]);
    }

    // Also find post_id values from JSON patterns
    const postIdJsonRegex = /"post_id"\s*:\s*"(\d+)"/g;
    while ((match = postIdJsonRegex.exec(html)) !== null) {
      postIds.add(match[1]);
    }

    log.debug({ count: postIds.size }, 'Post IDs for context extraction');

    for (const postId of postIds) {
      const idRegex = new RegExp(postId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      let bestPost: GroupPost | null = null;
      let bestScore = 0;

      let idMatch;
      while ((idMatch = idRegex.exec(html)) !== null) {
        const start = Math.max(0, idMatch.index - 8000);
        const end = Math.min(html.length, idMatch.index + 8000);
        const context = html.substring(start, end);

        const post = this.extractPostFromContext(context, postId, groupName, groupSlug);
        if (post) {
          let score = 0;
          if (post.content) score += 3;
          if (post.authorName !== 'Unknown') score += 2;
          if (post.likes > 0) score += 1;
          if (post.comments > 0) score += 1;
          if (score > bestScore) {
            bestScore = score;
            bestPost = post;
          }
        }
      }

      if (bestPost) {
        posts.push(bestPost);
      }
    }

    return posts;
  }

  private extractPostFromContext(
    context: string,
    postId: string,
    groupName: string,
    groupSlug: string,
  ): GroupPost | null {
    const textMatch = context.match(/"message"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const content = textMatch ? this.unescapeJson(textMatch[1]) : '';

    let authorName = 'Unknown';
    let authorUrl = '';
    const actorMatch = context.match(
      /"(?:actors?|author)"\s*:\s*\[?\s*\{[^}]*?"name"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    );
    if (actorMatch) authorName = this.unescapeJson(actorMatch[1]);

    const urlMatch = context.match(
      /"(?:actors?|author)"\s*:\s*\[?\s*\{[^}]*?"url"\s*:\s*"((?:[^"\\]|\\.)*)"/,
    );
    if (urlMatch) authorUrl = this.unescapeJson(urlMatch[1]);

    const timeMatch = context.match(/"creation_time"\s*:\s*(\d{10,})/);
    const createdAt = timeMatch
      ? new Date(parseInt(timeMatch[1], 10) * 1000).toISOString()
      : new Date().toISOString();

    const reactionMatch = context.match(/"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/);
    const likes = reactionMatch ? parseInt(reactionMatch[1], 10) : 0;

    const commentMatch = context.match(/"comment_count"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/);
    const comments = commentMatch ? parseInt(commentMatch[1], 10) : 0;

    if (!content && !timeMatch) return null;

    return {
      groupName,
      postId,
      authorName,
      authorProfileUrl: authorUrl,
      title: '',
      content,
      createdAt,
      likes,
      comments,
      postUrl: `https://www.facebook.com/groups/${groupSlug}/posts/${postId}`,
    };
  }

  // ==========================================
  // Utility methods
  // ==========================================

  private extractGroupName(html: string): string {
    const jsonMatch = html.match(/"group"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/);
    if (jsonMatch) return this.unescapeJson(jsonMatch[1]);

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      const title = titleMatch[1].replace(/\s*\|\s*Facebook.*$/, '').trim();
      if (title && title !== 'Facebook') return this.decodeHtmlEntities(title);
    }

    const ogMatch = html.match(/property="og:title"\s+content="([^"]+)"/i);
    if (ogMatch) return this.decodeHtmlEntities(ogMatch[1]);

    return 'Unknown Group';
  }

  private normalizeGroupUrl(url: string): string {
    let normalized = url.trim();
    if (normalized.startsWith('http')) return normalized;
    if (normalized.startsWith('/')) return `https://www.facebook.com${normalized}`;
    return `https://www.facebook.com/groups/${normalized}`;
  }

  private unescapeJson(str: string): string {
    try {
      return JSON.parse(`"${str}"`);
    } catch {
      return str
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .replace(/\\u[\dA-Fa-f]{4}/g, (m) =>
          String.fromCharCode(parseInt(m.slice(2), 16)),
        )
        .replace(/\\\//g, '/');
    }
  }

  private decodeHtmlEntities(text: string): string {
    const entities: Record<string, string> = {
      '&quot;': '"',
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&#39;': "'",
      '&apos;': "'",
      '&nbsp;': ' ',
    };
    let decoded = text;
    for (const [entity, char] of Object.entries(entities)) {
      decoded = decoded.replaceAll(entity, char);
    }
    return decoded;
  }
}