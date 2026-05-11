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

    // Parse initial HTML members (only used as seed, not capped by maxMembers)
    const seenProfiles = new Set<string>();
    const members = this.parseMembersFromHtml(response.body, groupName);
    for (const m of members) {
      seenProfiles.add(m.profileName);
    }
    log.info({ groupName, initialMembers: members.length, maxMembers }, 'Initial page parsed');

    // Always paginate via GraphQL to get properly structured data (edge-level fields)
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
          if (seenProfiles.has(member.profileName)) {
            // Update existing entry if this one has a URL and the existing doesn't
            if (member.profileUrl) {
              const existingIdx = members.findIndex(m => m.profileName === member.profileName && !m.profileUrl);
              if (existingIdx !== -1) members[existingIdx] = member;
            }
            continue;
          }
          seenProfiles.add(member.profileName);
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
  ): GroupMember[] {
    const members: GroupMember[] = [];
    const seenProfiles = new Set<string>();

    // Strategy 1: Extract from new_members edges directly (best data quality)
    const edgeMembers = this.extractFromNewMembersEdges(html, groupName);
    for (const member of edgeMembers) {
      const key = member.profileName;
      if (seenProfiles.has(key)) continue;
      seenProfiles.add(key);
      members.push(member);
    }

    // Strategy 2: Parse JSON from script tags and walk tree for member nodes
    const jsonMembers = this.extractFromJsonScripts(html, groupName);
    for (const member of jsonMembers) {
      const key = member.profileName;
      if (seenProfiles.has(key)) {
        // Replace existing if this one has more data
        const existingIdx = members.findIndex(m => m.profileName === member.profileName);
        if (existingIdx !== -1) {
          const existing = members[existingIdx];
          const existingScore = (existing.bio ? 1 : 0) + (existing.joinedDate ? 1 : 0) + (existing.location ? 1 : 0);
          const newScore = (member.bio ? 1 : 0) + (member.joinedDate ? 1 : 0) + (member.location ? 1 : 0);
          if (newScore > existingScore) members[existingIdx] = member;
        }
        continue;
      }
      seenProfiles.add(key);
      members.push(member);
    }

    // Strategy 3: Fallback - extract profile links from HTML
    if (members.length === 0) {
      const htmlMembers = this.extractFromHtmlLinks(html, groupName);
      for (const member of htmlMembers) {
        const key = member.profileName;
        if (seenProfiles.has(key)) continue;
        seenProfiles.add(key);
        members.push(member);
      }
    }

    return members;
  }

  // ==========================================
  // Strategy 1: Extract from new_members edges (best data)
  // ==========================================

  private extractFromNewMembersEdges(html: string, groupName: string): GroupMember[] {
    const members: GroupMember[] = [];
    const seenNames = new Set<string>();

    // Find the new_members JSON section in the HTML
    const newMembersIdx = html.indexOf('"new_members"');
    if (newMembersIdx === -1) return members;

    // Find the edges array after new_members
    const searchStart = newMembersIdx;
    const edgesIdx = html.indexOf('"edges"', searchStart);
    if (edgesIdx === -1 || edgesIdx - searchStart > 200) return members;

    // Try to extract the edges array by finding its bounds
    const arrayStart = html.indexOf('[', edgesIdx);
    if (arrayStart === -1) return members;

    // Parse edges by finding balanced brackets
    let depth = 0;
    let arrayEnd = -1;
    for (let i = arrayStart; i < Math.min(html.length, arrayStart + 500000); i++) {
      if (html[i] === '[') depth++;
      else if (html[i] === ']') {
        depth--;
        if (depth === 0) { arrayEnd = i + 1; break; }
      }
    }

    if (arrayEnd === -1) return members;

    try {
      const edgesJson = html.substring(arrayStart, arrayEnd);
      const edges = JSON.parse(edgesJson);

      if (!Array.isArray(edges)) return members;

      for (const edge of edges) {
        if (!edge || !edge.node || typeof edge.node !== 'object') continue;
        const node = edge.node as Record<string, unknown>;
        if (node.__typename !== 'User' || typeof node.name !== 'string') continue;

        const member = this.tryExtractMember(node, groupName, edge);
        if (member) {
          if (!seenNames.has(member.profileName)) {
            seenNames.add(member.profileName);
            members.push(member);
          }
        }
      }
    } catch {
      // JSON parse failed
    }

    log.debug({ count: members.length }, 'Members found via new_members edges');
    return members;
  }

  // ==========================================
  // Strategy 2: JSON tree walking
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
    parent?: Record<string, unknown>,
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

    // Check if this is an edge object with a "node" containing a User
    // Facebook GraphQL structure: edge = { node: { __typename: "User", name, url }, subtitle: {...}, join_status_text: {...}, ... }
    if (record.node && typeof record.node === 'object') {
      const node = record.node as Record<string, unknown>;
      if ((node.__typename === 'User' || node.__typename === 'GroupMember') && typeof node.name === 'string') {
        const member = this.tryExtractMember(node, groupName, record);
        if (member) {
          this.addMemberDeduped(member, members, seenNames);
          // Don't return - continue walking for nested members
        }
      }
    }

    // Also check if this record itself is a User node (for initial HTML data)
    if ((record.__typename === 'User' || record.__typename === 'GroupMember') && typeof record.name === 'string') {
      const member = this.tryExtractMember(record, groupName, parent);
      if (member) {
        this.addMemberDeduped(member, members, seenNames);
      }
    }

    // Continue walking - pass current record as parent context
    for (const value of Object.values(record)) {
      this.walkJsonForMembers(value, members, seenNames, groupName, depth + 1, record);
    }
  }

  private addMemberDeduped(member: GroupMember, members: GroupMember[], seenNames: Set<string>): void {
    if (seenNames.has(member.profileName)) {
      // If this one has more data, replace
      const existingIdx = members.findIndex(m => m.profileName === member.profileName);
      if (existingIdx !== -1) {
        const existing = members[existingIdx];
        const existingScore = (existing.profileUrl ? 1 : 0) + (existing.bio ? 1 : 0) + (existing.joinedDate ? 1 : 0) + (existing.location ? 1 : 0);
        const newScore = (member.profileUrl ? 1 : 0) + (member.bio ? 1 : 0) + (member.joinedDate ? 1 : 0) + (member.location ? 1 : 0);
        if (newScore > existingScore) {
          members[existingIdx] = member;
        }
      }
    } else {
      seenNames.add(member.profileName);
      members.push(member);
    }
  }

  private tryExtractMember(
    userNode: Record<string, unknown>,
    groupName: string,
    edgeOrParent?: Record<string, unknown>,
  ): GroupMember | null {
    const name = typeof userNode.name === 'string' ? userNode.name : '';
    if (!name || name.length < 2) return null;

    let url = '';
    if (typeof userNode.url === 'string') url = userNode.url;
    else if (typeof userNode.uri === 'string') url = userNode.uri;
    else if (typeof userNode.profile_url === 'string') url = userNode.profile_url;

    // Skip if URL points to a group, page, etc.
    if (url.includes('/groups/') || url.includes('/pages/')) return null;

    // Look for optional fields on the user node first, then on the parent/edge object
    const searchTargets = [userNode, ...(edgeOrParent ? [edgeOrParent] : [])];

    let bio = '';
    let joinDate = '';
    let mutualFriends = 0;

    for (const target of searchTargets) {
      if (!bio) bio = this.findStringField(target, ['bio_text', 'bio', 'subtitle', 'secondary_text', 'secondary_subtitle']);
      if (!joinDate) joinDate = this.findStringField(target, ['membership', 'join_status_text', 'joined', 'member_since', 'group_membership_info']);
      if (!mutualFriends) {
        // Check multiple patterns for mutual friends
        for (const key of ['mutual_friends', 'mutual_friends_count']) {
          const val = target[key];
          if (typeof val === 'number' && val > 0) { mutualFriends = val; break; }
          if (val && typeof val === 'object') {
            const mf = val as Record<string, unknown>;
            if (typeof mf.count === 'number' && mf.count > 0) { mutualFriends = mf.count; break; }
            if (typeof mf.text === 'string') {
              const num = parseInt(mf.text.replace(/\D/g, ''));
              if (num > 0) { mutualFriends = num; break; }
            }
          }
        }
      }
    }

    // Also deep-search the edge/parent object for nested fields (Facebook sometimes nests them)
    if (edgeOrParent && (!bio || !joinDate)) {
      for (const [key, val] of Object.entries(edgeOrParent)) {
        if (key === 'node') continue; // Skip the user node itself
        if (val && typeof val === 'object' && !Array.isArray(val)) {
          const nested = val as Record<string, unknown>;
          if (!bio && typeof nested.text === 'string' && nested.text.length > 0) {
            // Heuristic: check if this looks like a bio/subtitle field
            if (['subtitle', 'bio_text', 'secondary_text', 'secondary_subtitle', 'descriptive_text'].includes(key)) {
              bio = nested.text;
            }
          }
          if (!joinDate && typeof nested.text === 'string' && nested.text.length > 0) {
            if (['join_status_text', 'membership', 'group_membership_info', 'timestamp_text', 'member_since_text'].includes(key)) {
              joinDate = nested.text;
            }
          }
        }
      }
    }

    let location = '';
    let bioText = '';
    if (bio) {
      // Detect location patterns in multiple languages
      const locationPatterns = /^(?:Lives in|From|Wohnt in|Lebt in|Kommt aus|Vit à|Vive en)\s+/i;
      if (locationPatterns.test(bio)) {
        location = bio.replace(locationPatterns, '');
      } else {
        bioText = bio;
      }
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
  // Strategy 3: HTML link extraction
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
    // Try to get group name from the page title first (most reliable)
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
      const title = titleMatch[1]
        .replace(/\s*\|\s*Facebook.*$/, '')
        .replace(/\s*[-–]\s*Mitglieder.*$/i, '')
        .replace(/\s*[-–]\s*Members.*$/i, '')
        .trim();
      if (title && title !== 'Facebook' && title.length > 1) return this.decodeHtmlEntities(title);
    }

    // Try JSON pattern with __typename Group
    const groupNameMatch = html.match(/"__typename"\s*:\s*"Group"[^}]*"name"\s*:\s*"([^"]+)"/);
    if (groupNameMatch) return this.unescapeJson(groupNameMatch[1]);

    // Fallback: "name" near "groupID"
    const nearGroupId = html.match(/"groupID"\s*:\s*"\d+"[^}]{0,200}"name"\s*:\s*"([^"]+)"/);
    if (nearGroupId) return this.unescapeJson(nearGroupId[1]);

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