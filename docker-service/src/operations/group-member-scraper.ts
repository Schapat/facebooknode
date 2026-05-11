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

    // Parse initial HTML members
    const seenProfiles = new Set<string>();
    const members = this.parseMembersFromHtml(response.body, groupName, maxMembers);
    for (const m of members) {
      seenProfiles.add(m.profileName + '|' + m.profileUrl);
    }
    log.info({ groupName, initialMembers: members.length, maxMembers }, 'Initial page parsed');

    // If we need more members, paginate via GraphQL
    if (members.length < maxMembers) {
      await this.paginateWithGraphQL(
        response.body,
        normalizedUrl,
        groupName,
        maxMembers,
        members,
        seenProfiles,
      );
    }

    log.info({ groupName, membersCount: members.length }, 'Member scraping complete');
    return members;
  }

  private async paginateWithGraphQL(
    html: string,
    refererUrl: string,
    groupName: string,
    maxMembers: number,
    members: GroupMember[],
    seenProfiles: Set<string>,
  ): Promise<void> {
    const tokens = this.httpClient.extractTokens(html);
    if (!tokens.fbDtsg) {
      log.warn('No fb_dtsg token found, cannot paginate members');
      return;
    }

    const groupId = this.extractGroupId(html);
    if (!groupId) {
      log.warn('No group ID found, cannot paginate members');
      return;
    }

    const relayProviderVars = this.extractRelayProviderVariables(html);
    const docId = this.extractMemberDocId(html);
    log.info({ groupId, docId, relayVarsCount: Object.keys(relayProviderVars).length }, 'Member pagination tokens found');

    // Find the new_members cursor from the initial HTML
    let cursor = this.extractMemberCursor(html);
    if (!cursor) {
      log.warn('No member pagination cursor found in initial HTML');
      return;
    }

    const maxPages = 50; // Safety limit
    let page = 0;

    while (members.length < maxMembers && page < maxPages && cursor) {
      page++;
      log.info({ page, membersCount: members.length, maxMembers }, 'Fetching next members page via GraphQL');

      await randomDelay(1000, 3000);

      try {
        const result = await this.fetchMemberGraphQLPage(
          tokens,
          groupId,
          cursor,
          groupName,
          refererUrl,
          docId,
          relayProviderVars,
        );

        if (!result || result.members.length === 0) {
          log.info({ page }, 'No more members from GraphQL');
          break;
        }

        let newMembersAdded = 0;
        for (const member of result.members) {
          const key = member.profileName + '|' + member.profileUrl;
          if (seenProfiles.has(key)) continue;
          seenProfiles.add(key);
          members.push(member);
          newMembersAdded++;
          if (members.length >= maxMembers) break;
        }

        log.info({ page, newMembersAdded, total: members.length }, 'GraphQL members page processed');

        if (newMembersAdded === 0) break;
        cursor = result.nextCursor;
      } catch (error) {
        log.warn({ error, page }, 'GraphQL member pagination failed');
        break;
      }
    }
  }

  private async fetchMemberGraphQLPage(
    tokens: { fbDtsg: string; jazoest: string; lsd: string },
    groupId: string,
    cursor: string,
    groupName: string,
    referer: string,
    docId: string,
    relayProviderVars: Record<string, unknown>,
  ): Promise<{ members: GroupMember[]; nextCursor: string | null } | null> {
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
      fb_api_req_friendly_name: 'GroupsCometMembersPageNewMembersSectionRefetchQuery',
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
      log.warn({ statusCode: response.statusCode }, 'GraphQL member request failed');
      return null;
    }

    if (response.body.includes('was not found')) {
      log.warn({ docId }, 'Member doc_id not found');
      return null;
    }

    log.info({ docId, bodyLength: response.body.length }, 'GraphQL member response received');

    const members: GroupMember[] = [];
    const seenNames = new Set<string>();
    let nextCursor: string | null = null;

    const lines = response.body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) continue;

      try {
        const data = JSON.parse(trimmed);
        this.walkJsonForMembers(data, members, seenNames, groupName, 0);

        // Extract next cursor
        const cursorVal = this.deepFindEndCursor(data);
        if (cursorVal) nextCursor = cursorVal;
      } catch {
        // Not valid JSON
      }
    }

    return { members, nextCursor };
  }

  private extractMemberDocId(html: string): string {
    // Search for doc_id near member pagination query names
    const patterns = [
      /GroupsCometMembersPageNewMembersSectionRefetchQuery[^}]{0,500}?(?:doc_id|"id")\s*[:=]\s*"(\d{10,})"/,
      /(?:doc_id|"id")\s*[:=]\s*"(\d{10,})"[^}]{0,500}?GroupsCometMembersPageNewMembersSectionRefetchQuery/,
    ];

    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) {
        log.info({ docId: match[1] }, 'Extracted member doc_id from HTML');
        return match[1];
      }
    }

    log.info('Using default member doc_id');
    return '35128459116797905';
  }

  private extractMemberCursor(html: string): string | null {
    // Find the cursor in the new_members section
    const newMembersIdx = html.indexOf('"new_members"');
    if (newMembersIdx !== -1) {
      const afterNewMembers = html.substring(newMembersIdx, newMembersIdx + 50000);
      const pageInfoMatch = afterNewMembers.match(/"page_info"\s*:\s*\{[^}]*"end_cursor"\s*:\s*"([^"]+)"/);
      if (pageInfoMatch) return pageInfoMatch[1];
    }

    // Fallback: any 60-90 char cursor near member context
    for (const cm of html.matchAll(/"end_cursor"\s*:\s*"([^"]{50,100})"/g)) {
      const ctx = html.substring(Math.max(0, cm.index! - 500), cm.index!);
      if (ctx.includes('member') || ctx.includes('Member') || ctx.includes('User')) {
        return cm[1];
      }
    }

    return null;
  }

  private extractGroupId(html: string): string | null {
    const patterns = [
      /"groupID"\s*:\s*"(\d+)"/,
      /"group_id"\s*:\s*"(\d+)"/,
      /group\/(\d+)/,
      /fb:\/\/group\/(\d+)/,
      /entity_id\s*:\s*"(\d+)"/,
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

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