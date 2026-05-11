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

    try {
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
    } finally {
      // Always persist rotated cookies back to Redis
      await this.httpClient.persistCookies();
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

    // Strategy 1: Parse JSON from script tags and walk tree for member nodes
    const jsonMembers = this.extractFromJsonScripts(html, groupName);
    for (const member of jsonMembers) {
      const key = member.profileUrl || member.profileName;
      if (seenProfiles.has(key)) continue;
      seenProfiles.add(key);
      members.push(member);
      if (members.length >= maxMembers) break;
    }

    // Strategy 2: Fallback - extract profile links from HTML
    if (members.length === 0) {
      const htmlMembers = this.extractFromHtmlLinks(html, groupName);
      for (const member of htmlMembers) {
        const key = member.profileUrl || member.profileName;
        if (seenProfiles.has(key)) continue;
        seenProfiles.add(key);
        members.push(member);
        if (members.length >= maxMembers) break;
      }
    }

    return members;
  }

  // ==========================================
  // Strategy 1: JSON tree walking
  // ==========================================

  private extractFromJsonScripts(html: string, groupName: string): GroupMember[] {
    const members: GroupMember[] = [];
    const seenNames = new Set<string>();

    const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
    let scriptMatch;

    while ((scriptMatch = scriptRegex.exec(html)) !== null) {
      const content = scriptMatch[1].trim();
      if (!content || content.length < 200) continue;
      if (!content.startsWith('{') && !content.startsWith('[')) continue;

      // Quick pre-filter: only parse scripts that likely contain member data
      if (!content.includes('User') && !content.includes('member') && !content.includes('profile')) {
        continue;
      }

      try {
        const data = JSON.parse(content);
        this.walkJsonForMembers(data, members, seenNames, groupName, 0);
      } catch {
        // Not valid JSON
      }
    }

    log.debug({ count: members.length }, 'Members found via JSON tree walking');
    return members;
  }

  private walkJsonForMembers(
    obj: unknown,
    members: GroupMember[],
    seenNames: Set<string>,
    groupName: string,
    depth: number,
  ): void {
    if (depth > 40 || !obj) return;

    // Handle embedded JSON strings
    if (typeof obj === 'string') {
      if (obj.length > 100 && (obj.startsWith('{') || obj.startsWith('['))) {
        try {
          const parsed = JSON.parse(obj);
          this.walkJsonForMembers(parsed, members, seenNames, groupName, depth + 1);
        } catch { /* not JSON */ }
      }
      return;
    }

    if (typeof obj !== 'object') return;

    if (Array.isArray(obj)) {
      for (const item of obj) {
        this.walkJsonForMembers(item, members, seenNames, groupName, depth + 1);
      }
      return;
    }

    const record = obj as Record<string, unknown>;

    // Check if this looks like a User node with name + URL
    const member = this.tryExtractMember(record, groupName);
    if (member && !seenNames.has(member.profileName + '|' + member.profileUrl)) {
      seenNames.add(member.profileName + '|' + member.profileUrl);
      members.push(member);
    }

    // Continue walking
    for (const value of Object.values(record)) {
      this.walkJsonForMembers(value, members, seenNames, groupName, depth + 1);
    }
  }

  private tryExtractMember(obj: Record<string, unknown>, groupName: string): GroupMember | null {
    // A member node should be a User-typed object with name + URL
    const typename = obj.__typename;
    if (typename !== 'User' && typename !== 'GroupMember') return null;

    const name = typeof obj.name === 'string' ? obj.name : '';
    if (!name || name.length < 2) return null;

    let url = '';
    if (typeof obj.url === 'string') url = obj.url;
    else if (typeof obj.uri === 'string') url = obj.uri;
    else if (typeof obj.profile_url === 'string') url = obj.profile_url;

    // Skip if URL points to a group, page, etc.
    if (url.includes('/groups/') || url.includes('/pages/')) return null;

    // Extract optional fields from this node's subtree
    const bio = this.findStringField(obj, ['bio_text', 'bio', 'subtitle', 'secondary_text']);
    const joinDate = this.findStringField(obj, ['membership', 'join_status_text']);

    let location = '';
    let bioText = '';
    if (bio) {
      if (bio.startsWith('Lives in') || bio.startsWith('From')) {
        location = bio.replace(/^(?:Lives in|From)\s*/i, '');
      } else {
        bioText = bio;
      }
    }

    // Extract mutual friends count
    let mutualFriends = 0;
    if (obj.mutual_friends && typeof obj.mutual_friends === 'object') {
      const mf = obj.mutual_friends as Record<string, unknown>;
      if (typeof mf.count === 'number') mutualFriends = mf.count;
    }

    return {
      groupName,
      profileName: name,
      profileUrl: url.startsWith('http') ? url : url ? `https://www.facebook.com${url}` : '',
      bio: bioText,
      location,
      mutualFriends,
      joinedDate: joinDate || '',
    };
  }

  private findStringField(obj: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0) return val;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        const nested = val as Record<string, unknown>;
        if (typeof nested.text === 'string' && nested.text.length > 0) return nested.text;
      }
    }
    return '';
  }

  // ==========================================
  // Strategy 2: HTML link extraction
  // ==========================================

  private extractFromHtmlLinks(html: string, groupName: string): GroupMember[] {
    const members: GroupMember[] = [];

    const profileRegex =
      /href="(https?:\/\/www\.facebook\.com\/(?:profile\.php\?id=\d+|[a-zA-Z0-9.]+))"/g;
    const seenUrls = new Set<string>();
    let match;

    while ((match = profileRegex.exec(html)) !== null) {
      const url = match[1];

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