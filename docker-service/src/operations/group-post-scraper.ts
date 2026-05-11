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

    for (const groupUrl of input.groups) {
      log.info({ groupUrl }, 'Scraping group posts via HTTP');
      try {
        const posts = await this.scrapeGroup(groupUrl, input);
        allPosts.push(...posts);
      } catch (error) {
        log.error({ groupUrl, error }, 'Failed to scrape group');
      }
      if (input.groups.indexOf(groupUrl) < input.groups.length - 1) {
        await randomDelay(2000, 5000);
      }
    }

    return allPosts;
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
    const maxPosts = input.maxPosts || 100;
    const cutoffTimestamp = input.lastScrapeTimestamp
      ? new Date(input.lastScrapeTimestamp).getTime()
      : 0;

    const posts = this.parsePostsFromHtml(response.body, groupName, normalizedUrl, maxPosts, cutoffTimestamp);
    log.info({ groupName, postsCount: posts.length }, 'Group scraping complete');
    return posts;
  }

  private parsePostsFromHtml(
    html: string,
    groupName: string,
    groupUrl: string,
    maxPosts: number,
    cutoffTimestamp: number,
  ): GroupPost[] {
    const posts: GroupPost[] = [];
    const seenIds = new Set<string>();

    // Strategy 1: Parse embedded JSON data (Facebook embeds relay data as JSON in script tags)
    const jsonPosts = this.extractFromEmbeddedJson(html, groupName);
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

    // Strategy 2: Fallback - extract post links and basic data from HTML
    if (posts.length === 0) {
      const htmlPosts = this.extractFromHtmlStructure(html, groupName, groupUrl);
      for (const post of htmlPosts) {
        if (seenIds.has(post.postId)) continue;
        seenIds.add(post.postId);
        posts.push(post);
        if (posts.length >= maxPosts) break;
      }
    }

    return posts;
  }

  private extractFromEmbeddedJson(html: string, groupName: string): GroupPost[] {
    const posts: GroupPost[] = [];

    try {
      // Facebook embeds data as JSON in script tags or as require() calls
      // Look for story/post data in various JSON patterns

      // Pattern: "story_id":"..." or "post_id":"..."
      const storyIdRegex = /"(?:story_id|post_id)"\s*:\s*"(\d+)"/g;
      const storyIds = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = storyIdRegex.exec(html)) !== null) {
        storyIds.add(match[1]);
      }

      // Pattern: Look for message/text content near post IDs
      // Facebook's relay data contains "message":{"text":"..."} objects
      const messageRegex = /"message"\s*:\s*\{\s*"text"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/g;
      const messages: string[] = [];
      while ((match = messageRegex.exec(html)) !== null) {
        messages.push(this.unescapeJson(match[1]));
      }

      // Pattern: Author names from "name":"..." near actor/author contexts
      const actorRegex = /"(?:actor|author)"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/g;
      const authors: Array<{ name: string }> = [];
      while ((match = actorRegex.exec(html)) !== null) {
        authors.push({ name: this.unescapeJson(match[1]) });
      }

      // Pattern: Timestamps - creation_time is Unix epoch seconds
      const timeRegex = /"creation_time"\s*:\s*(\d{10,})/g;
      const timestamps: number[] = [];
      while ((match = timeRegex.exec(html)) !== null) {
        timestamps.push(parseInt(match[1], 10));
      }

      // Pattern: Reaction counts
      const reactionRegex = /"reaction_count"\s*:\s*\{\s*"count"\s*:\s*(\d+)/g;
      const reactions: number[] = [];
      while ((match = reactionRegex.exec(html)) !== null) {
        reactions.push(parseInt(match[1], 10));
      }

      // Pattern: Comment counts
      const commentRegex = /"comment_count"\s*:\s*\{\s*"total_count"\s*:\s*(\d+)/g;
      const commentCounts: number[] = [];
      while ((match = commentRegex.exec(html)) !== null) {
        commentCounts.push(parseInt(match[1], 10));
      }

      // Pattern: URLs - permalink_url or post URL
      const urlRegex = /"(?:permalink_url|url)"\s*:\s*"(https?:\\\/\\\/www\.facebook\.com\\\/groups\\\/[^"]+)"/g;
      const urls: string[] = [];
      while ((match = urlRegex.exec(html)) !== null) {
        urls.push(this.unescapeJson(match[1]));
      }

      // Combine: Try to build coherent post objects
      const storyIdArray = [...storyIds];
      const count = Math.min(storyIdArray.length, messages.length || storyIdArray.length);

      for (let i = 0; i < count; i++) {
        const post: GroupPost = {
          groupName,
          postId: storyIdArray[i] || `unknown-${i}`,
          authorName: authors[i]?.name || 'Unknown',
          authorProfileUrl: '',
          title: '',
          content: messages[i] || '',
          createdAt: timestamps[i]
            ? new Date(timestamps[i] * 1000).toISOString()
            : new Date().toISOString(),
          likes: reactions[i] || 0,
          comments: commentCounts[i] || 0,
          postUrl: urls[i] || '',
        };

        if (post.content || post.postUrl) {
          posts.push(post);
        }
      }
    } catch (error) {
      log.debug({ error }, 'Failed to extract from embedded JSON');
    }

    return posts;
  }

  private extractFromHtmlStructure(html: string, groupName: string, groupUrl: string): GroupPost[] {
    const posts: GroupPost[] = [];

    // Find all post/permalink links
    const postLinkRegex = /\/(?:groups\/[^/]+\/(?:posts|permalink)\/(\d+))/g;
    const postIds = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = postLinkRegex.exec(html)) !== null) {
      postIds.add(match[1]);
    }

    log.debug({ count: postIds.size }, 'Found post IDs from HTML links');

    for (const postId of postIds) {
      // Try to extract content around this post ID
      const postIdEscaped = postId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const contextRegex = new RegExp(
        `[\\s\\S]{0,3000}${postIdEscaped}[\\s\\S]{0,3000}`,
      );
      const contextMatch = html.match(contextRegex);
      const block = contextMatch?.[0] || '';

      // Try to get text content near this ID
      const textMatch = block.match(/"text"\s*:\s*"([^"]{10,}(?:\\.[^"]*)*)"/);
      const content = textMatch ? this.unescapeJson(textMatch[1]) : '';

      const nameMatch = block.match(/"name"\s*:\s*"([^"]+)"/);
      const authorName = nameMatch ? this.unescapeJson(nameMatch[1]) : 'Unknown';

      const timeMatch = block.match(/"creation_time"\s*:\s*(\d{10,})/);
      const createdAt = timeMatch
        ? new Date(parseInt(timeMatch[1], 10) * 1000).toISOString()
        : new Date().toISOString();

      const groupSlug = groupUrl.match(/groups\/([^/?]+)/)?.[1] || '';

      const post: GroupPost = {
        groupName,
        postId,
        authorName,
        authorProfileUrl: '',
        title: '',
        content,
        createdAt,
        likes: 0,
        comments: 0,
        postUrl: `https://www.facebook.com/groups/${groupSlug}/posts/${postId}`,
      };

      posts.push(post);
    }

    return posts;
  }

  private extractGroupName(html: string): string {
    // Try JSON pattern first
    const jsonMatch = html.match(/"group"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/);
    if (jsonMatch) return this.unescapeJson(jsonMatch[1]);

    // Try <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      const title = titleMatch[1].replace(/\s*\|\s*Facebook.*$/, '').trim();
      if (title && title !== 'Facebook') return this.decodeHtmlEntities(title);
    }

    // Try og:title meta tag
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
