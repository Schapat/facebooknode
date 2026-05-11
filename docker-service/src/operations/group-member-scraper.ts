import type { Page } from 'playwright';
import type { GroupMember, GroupMemberScraperInput } from '@facebook-automation/shared-types';
import { BrowserService } from '../services/browser-service';
import { ScrapeError } from '../errors';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';

const log = createChildLogger({ service: 'GroupMemberScraper' });

export class GroupMemberScraper {
  constructor(private readonly browserService: BrowserService) {}

  async execute(sessionName: string, input: GroupMemberScraperInput): Promise<GroupMember[]> {
    const allMembers: GroupMember[] = [];

    for (const groupUrl of input.groups) {
      log.info({ groupUrl }, 'Scraping group members');
      const members = await this.browserService.executeWithSession(sessionName, async (page) => {
        return this.scrapeMembers(page, groupUrl, input);
      });
      allMembers.push(...members);
    }

    return allMembers;
  }

  private async scrapeMembers(
    page: Page,
    groupUrl: string,
    input: GroupMemberScraperInput,
  ): Promise<GroupMember[]> {
    const normalizedUrl = this.normalizeGroupUrl(groupUrl);
    const membersUrl = normalizedUrl.replace(/\/$/, '') + '/members';

    await page.goto(membersUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(3000, 5000);

    const groupName = await this.getGroupName(page);
    const members: GroupMember[] = [];
    const seenProfiles = new Set<string>();
    const maxMembers = input.maxMembers || 500;
    const scrollTimeout = input.scrollTimeout || 120000;

    const startTime = Date.now();
    let noNewMembersCount = 0;

    while (members.length < maxMembers && Date.now() - startTime < scrollTimeout) {
      const newMembers = await page.evaluate(() => {
        // Find member cards/rows
        const memberElements = document.querySelectorAll(
          '[data-visualcompletion="ignore-dynamic"] a[href*="facebook.com"]',
        );
        const results: Array<{
          profileName: string;
          profileUrl: string;
          bio: string;
          location: string;
          joinedDate: string;
        }> = [];

        const processed = new Set<string>();

        memberElements.forEach((el) => {
          try {
            const href = el.getAttribute('href') || '';
            if (!href || processed.has(href)) return;
            if (href.includes('/groups/')) return; // Skip group links

            processed.add(href);

            const nameEl = el.querySelector('span') || el;
            const profileName = nameEl.textContent?.trim() || '';
            if (!profileName) return;

            // Get parent container for additional info
            const container = el.closest('[data-visualcompletion="ignore-dynamic"]');
            const allText = container?.textContent || '';

            // Try to extract bio/subtitle
            const spans = container?.querySelectorAll('span');
            let bio = '';
            let location = '';
            let joinedDate = '';

            spans?.forEach((span) => {
              const text = span.textContent?.trim() || '';
              if (text.includes('Joined')) {
                joinedDate = text;
              } else if (text.includes('Lives in') || text.includes('From')) {
                location = text.replace(/^(Lives in|From)\s*/i, '');
              } else if (text !== profileName && text.length > 5 && text.length < 200) {
                if (!bio) bio = text;
              }
            });

            results.push({
              profileName,
              profileUrl: href.startsWith('http') ? href : `https://www.facebook.com${href}`,
              bio,
              location,
              joinedDate,
            });
          } catch {
            // Skip malformed entries
          }
        });

        return results;
      });

      let addedNew = false;
      for (const rawMember of newMembers) {
        if (seenProfiles.has(rawMember.profileUrl)) continue;
        seenProfiles.add(rawMember.profileUrl);

        const member: GroupMember = {
          groupName,
          profileName: rawMember.profileName,
          profileUrl: rawMember.profileUrl,
          bio: rawMember.bio,
          location: rawMember.location,
          mutualFriends: 0,
          joinedDate: rawMember.joinedDate,
        };

        members.push(member);
        addedNew = true;

        if (members.length >= maxMembers) break;
      }

      if (!addedNew) {
        noNewMembersCount++;
        if (noNewMembersCount >= 8) {
          log.info('No new members found after 8 scroll attempts, stopping');
          break;
        }
      } else {
        noNewMembersCount = 0;
      }

      await this.browserService.humanScroll(page, 3);
      await randomDelay(2000, 4000);
    }

    log.info({ groupName, membersCount: members.length }, 'Member scraping complete');
    return members;
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
}
