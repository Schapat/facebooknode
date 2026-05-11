import type { Page } from 'playwright';
import type { GroupPost, GroupPostScraperInput } from '@facebook-automation/shared-types';
import { BrowserService } from '../services/browser-service';
import { ScrapeError } from '../errors';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';

const log = createChildLogger({ service: 'GroupPostScraper' });

export class GroupPostScraper {
  constructor(private readonly browserService: BrowserService) {}

  async execute(sessionName: string, input: GroupPostScraperInput): Promise<GroupPost[]> {
    const allPosts: GroupPost[] = [];

    for (const groupUrl of input.groups) {
      log.info({ groupUrl }, 'Scraping group posts');
      const posts = await this.browserService.executeWithSession(sessionName, async (page) => {
        return this.scrapeGroup(page, groupUrl, input);
      });
      allPosts.push(...posts);
    }

    return allPosts;
  }

  private async scrapeGroup(
    page: Page,
    groupUrl: string,
    input: GroupPostScraperInput,
  ): Promise<GroupPost[]> {
    const normalizedUrl = this.normalizeGroupUrl(groupUrl);
    await page.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(3000, 5000);

    const groupName = await this.getGroupName(page);
    const posts: GroupPost[] = [];
    const seenPostIds = new Set<string>();
    const maxPosts = input.maxPosts || 100;
    const scrollTimeout = input.scrollTimeout || 60000;
    const cutoffTimestamp = input.lastScrapeTimestamp
      ? new Date(input.lastScrapeTimestamp).getTime()
      : 0;

    const startTime = Date.now();
    let noNewPostsCount = 0;

    while (posts.length < maxPosts && Date.now() - startTime < scrollTimeout) {
      const newPosts = await page.evaluate(() => {
        const postElements = document.querySelectorAll('[role="article"]');
        const results: Array<{
          postId: string;
          authorName: string;
          authorProfileUrl: string;
          content: string;
          timeText: string;
          postUrl: string;
          likesText: string;
          commentsText: string;
        }> = [];

        postElements.forEach((el) => {
          try {
            // Extract post ID from data attributes or links
            const postLink = el.querySelector('a[href*="/posts/"], a[href*="permalink"]');
            const postUrl = postLink?.getAttribute('href') || '';
            const postId =
              postUrl.match(/\/posts\/(\d+)/)?.[1] ||
              postUrl.match(/permalink\/(\d+)/)?.[1] ||
              Math.random().toString(36).substr(2, 9);

            // Author info
            const authorEl = el.querySelector('h3 a, h4 a, [data-ad-preview="message"] a');
            const authorName = authorEl?.textContent?.trim() || 'Unknown';
            const authorProfileUrl = authorEl?.getAttribute('href') || '';

            // Content
            const contentEl = el.querySelector(
              '[data-ad-preview="message"], [data-ad-comet-above-more-menu]',
            );
            const content = contentEl?.textContent?.trim() || '';

            // Timestamp
            const timeEl = el.querySelector('abbr, [data-utime], a[href*="permalink"] span');
            const timeText = timeEl?.textContent?.trim() || '';

            // Reactions
            const likesEl = el.querySelector('[aria-label*="reaction"], [aria-label*="like"]');
            const likesText = likesEl?.getAttribute('aria-label') || '0';

            // Comments count
            const commentsEl = el.querySelector('a[href*="comment"]');
            const commentsText = commentsEl?.textContent?.trim() || '0';

            results.push({
              postId,
              authorName,
              authorProfileUrl,
              content,
              timeText,
              postUrl: postUrl.startsWith('http')
                ? postUrl
                : `https://www.facebook.com${postUrl}`,
              likesText,
              commentsText,
            });
          } catch {
            // Skip malformed posts
          }
        });

        return results;
      });

      let addedNew = false;
      for (const rawPost of newPosts) {
        if (seenPostIds.has(rawPost.postId)) continue;
        seenPostIds.add(rawPost.postId);

        const post: GroupPost = {
          groupName,
          postId: rawPost.postId,
          authorName: rawPost.authorName,
          authorProfileUrl: rawPost.authorProfileUrl.startsWith('http')
            ? rawPost.authorProfileUrl
            : `https://www.facebook.com${rawPost.authorProfileUrl}`,
          title: '',
          content: rawPost.content,
          createdAt: rawPost.timeText,
          likes: this.parseCount(rawPost.likesText),
          comments: this.parseCount(rawPost.commentsText),
          postUrl: rawPost.postUrl,
        };

        posts.push(post);
        addedNew = true;

        if (posts.length >= maxPosts) break;
      }

      if (!addedNew) {
        noNewPostsCount++;
        if (noNewPostsCount >= 5) {
          log.info('No new posts found after 5 scroll attempts, stopping');
          break;
        }
      } else {
        noNewPostsCount = 0;
      }

      // Scroll down
      await this.browserService.humanScroll(page, 2);
      await randomDelay(2000, 4000);
    }

    log.info({ groupName, postsCount: posts.length }, 'Group scraping complete');
    return posts;
  }

  private async getGroupName(page: Page): Promise<string> {
    try {
      const name = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        return h1?.textContent?.trim() || 'Unknown Group';
      });
      return name;
    } catch {
      return 'Unknown Group';
    }
  }

  private normalizeGroupUrl(url: string): string {
    if (url.startsWith('http')) return url;
    if (url.startsWith('/')) return `https://www.facebook.com${url}`;
    return `https://www.facebook.com/groups/${url}`;
  }

  private parseCount(text: string): number {
    const match = text.match(/[\d,.]+/);
    if (!match) return 0;
    const num = match[0].replace(/,/g, '');
    const parsed = parseInt(num, 10);
    return isNaN(parsed) ? 0 : parsed;
  }
}
