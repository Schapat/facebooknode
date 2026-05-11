import type { GroupMember, GroupMemberScraperInput } from '@facebook-automation/shared-types';
import { FacebookHttpClient } from '../services/facebook-http-client';
import { SessionManager } from '../services/session-manager';
import { ScrapeError } from '../errors';
import { createChildLogger } from '../utils/logger';
import { randomDelay } from '../utils/helpers';

const log = createChildLogger({ service: 'GroupMemberScraper' });

export class GroupMemberScraper {
  private httpClient: FacebookHttpClient;

  constructor(private readonly sessionManager: SessionManager) {
    this.httpClient = new FacebookHttpClient(sessionManager);
  }

  async execute(sessionName: string, input: GroupMemberScraperInput): Promise<GroupMember[]> {
    await this.httpClient.initSession(sessionName);
    const allMembers: GroupMember[] = [];

    for (const groupUrl of input.groups) {
      log.info({ groupUrl }, 'Scraping group members via HTTP');
      try {
        const members = await this.scrapeMembers(groupUrl, input);
        allMembers.push(...members);
      } catch (error) {
        log.error({ groupUrl, error }, 'Failed to scrape members');
      }
      if (input.groups.indexOf(groupUrl) < input.groups.length - 1) {
        await randomDelay(2000, 5000);
      }
    }

    return allMembers;
  }

  private async scrapeMembers(
    groupUrl: string,
    input: GroupMemberScraperInput,
  ): Promise<GroupMember[]> {
    const normalizedUrl = this.normalizeGroupUrl(groupUrl).replace(/\/$/, '') + '/members';
    const response = await this.httpClient.request(normalizedUrl);

    if (response.statusCode !== 200) {
      throw new ScrapeError(`HTTP ${response.statusCode} for ${normalizedUrl}`);
    }

    if (this.httpClient.isLoginPage(response.body)) {
      throw new ScrapeError('Session expired - redirected to login page');
    }

    const groupName = this.extractGroupName(response.body);
    const maxMembers = input.maxMembers || 500;

    const members = this.parseMembersFromHtml(response.body, groupName, maxMembers);
    log.info({ groupName, membersCount: members.length }, 'Member scraping complete');
    return members;
  }

  private parseMembersFromHtml(
    html: string,
    groupName: string,
    maxMembers: number,
  ): GroupMember[] {
    const members: GroupMember[] = [];
    const seenProfiles = new Set<string>();

    // Strategy 1: Extract from embedded JSON relay data
    const jsonMembers = this.extractFromEmbeddedJson(html, groupName);
    for (const member of jsonMembers) {
      if (seenProfiles.has(member.profileUrl)) continue;
      seenProfiles.add(member.profileUrl);
      members.push(member);
      if (members.length >= maxMembers) break;
    }

    // Strategy 2: Fallback - extract profile links from HTML
    if (members.length === 0) {
      const htmlMembers = this.extractFromHtmlLinks(html, groupName);
      for (const member of htmlMembers) {
        if (seenProfiles.has(member.profileUrl)) continue;
        seenProfiles.add(member.profileUrl);
        members.push(member);
        if (members.length >= maxMembers) break;
      }
    }

    return members;
  }

  private extractFromEmbeddedJson(html: string, groupName: string): GroupMember[] {
    const members: GroupMember[] = [];

    try {
      // Facebook's relay data contains member info in various JSON structures
      // Pattern: "user":{"name":"...","url":"...","id":"..."} or similar

      // Find member nodes with names and profile URLs
      const memberRegex =
        /"(?:user|node)"\s*:\s*\{[^{}]*"name"\s*:\s*"([^"]+)"[^{}]*"(?:url|uri)"\s*:\s*"([^"]+)"/g;
      let match: RegExpExecArray | null;

      while ((match = memberRegex.exec(html)) !== null) {
        const name = this.unescapeJson(match[1]);
        const url = this.unescapeJson(match[2]);

        if (!url.includes('facebook.com') || url.includes('/groups/')) continue;
        if (!name || name.length < 2) continue;

        members.push({
          groupName,
          profileName: name,
          profileUrl: url,
          bio: '',
          location: '',
          mutualFriends: 0,
          joinedDate: '',
        });
      }

      // Alternative pattern: separate name and URL arrays in member list data
      if (members.length === 0) {
        // Look for "members_new_forum_members" or "group_members" data
        const profileRegex =
          /"(?:__typename)"\s*:\s*"(?:User|GroupMember)"[^}]*"name"\s*:\s*"([^"]+)"[^}]*"(?:url|profile_url)"\s*:\s*"([^"]+)"/g;

        while ((match = profileRegex.exec(html)) !== null) {
          const name = this.unescapeJson(match[1]);
          const url = this.unescapeJson(match[2]);

          if (!name || name.length < 2) continue;

          members.push({
            groupName,
            profileName: name,
            profileUrl: url.startsWith('http') ? url : `https://www.facebook.com${url}`,
            bio: '',
            location: '',
            mutualFriends: 0,
            joinedDate: '',
          });
        }
      }

      // Extract additional member data: bio/subtitle text
      const bioRegex =
        /"(?:bio_text|subtitle|secondary_text)"\s*:\s*\{\s*"text"\s*:\s*"([^"]+)"/g;
      const bios: string[] = [];
      while ((match = bioRegex.exec(html)) !== null) {
        bios.push(this.unescapeJson(match[1]));
      }

      // Enrich members with bios if counts match
      if (bios.length === members.length) {
        for (let i = 0; i < bios.length; i++) {
          const bio = bios[i];
          if (bio.startsWith('Lives in') || bio.startsWith('From')) {
            members[i].location = bio.replace(/^(?:Lives in|From)\s*/i, '');
          } else if (bio.includes('Joined')) {
            members[i].joinedDate = bio;
          } else {
            members[i].bio = bio;
          }
        }
      }

      // Extract mutual friends count
      const mutualRegex = /"mutual_friends"\s*:\s*\{\s*"count"\s*:\s*(\d+)/g;
      const mutualCounts: number[] = [];
      while ((match = mutualRegex.exec(html)) !== null) {
        mutualCounts.push(parseInt(match[1], 10));
      }

      if (mutualCounts.length === members.length) {
        for (let i = 0; i < mutualCounts.length; i++) {
          members[i].mutualFriends = mutualCounts[i];
        }
      }
    } catch (error) {
      log.debug({ error }, 'Failed to extract members from embedded JSON');
    }

    return members;
  }

  private extractFromHtmlLinks(html: string, groupName: string): GroupMember[] {
    const members: GroupMember[] = [];

    // Find profile links - Facebook profile URLs follow known patterns
    const profileRegex =
      /href="(https?:\/\/www\.facebook\.com\/(?:profile\.php\?id=\d+|[a-zA-Z0-9.]+))"/g;
    const seenUrls = new Set<string>();
    let match: RegExpExecArray | null;

    while ((match = profileRegex.exec(html)) !== null) {
      const url = match[1];

      // Skip non-profile links
      if (
        url.includes('/groups/') ||
        url.includes('/pages/') ||
        url.includes('/events/') ||
        url.includes('/watch/') ||
        url.includes('/marketplace/')
      ) {
        continue;
      }

      if (seenUrls.has(url)) continue;
      seenUrls.add(url);

      // Try to find a name near this URL
      const urlEscaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const nameNearUrl = new RegExp(`${urlEscaped}"[^>]*>([^<]+)<`, 'i');
      const nameMatch = html.match(nameNearUrl);
      const name = nameMatch?.[1]?.trim() || '';

      if (!name || name.length < 2) continue;

      members.push({
        groupName,
        profileName: name,
        profileUrl: url,
        bio: '',
        location: '',
        mutualFriends: 0,
        joinedDate: '',
      });
    }

    return members;
  }

  private extractGroupName(html: string): string {
    const jsonMatch = html.match(/"group"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/);
    if (jsonMatch) return this.unescapeJson(jsonMatch[1]);

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      const title = titleMatch[1].replace(/\s*\|\s*Facebook.*$/, '').trim();
      if (title && title !== 'Facebook') return this.decodeHtmlEntities(title);
    }

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
