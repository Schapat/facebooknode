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

  /**
   * Diagnostic method: loads mbasic compose page for a recipientId and returns
   * raw page details (forms found, body snippet, status) for debugging.
   */
  async diagnose(sessionName: string, recipientId: string): Promise<Record<string, unknown>> {
    await this.httpClient.initSession(sessionName);
    try {
      return await this.runDiagnosis(recipientId);
    } finally {
      await this.httpClient.persistCookies();
    }
  }

  private async runDiagnosis(recipientId: string): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};
    const myUserId = this.httpClient.getUserId();
    results.myUserId = myUserId;
    results.cookieDebug = this.httpClient.getCookieDebugInfo();

    // 1. Test mbasic homepage — confirm session works, extract tokens
    try {
      const home = await this.httpClient.request('https://mbasic.facebook.com/', {
        referer: 'https://mbasic.facebook.com/',
      });
      const dtsgMatch = home.body.match(/name="fb_dtsg"\s+value="([^"]+)"/);
      const jazoestMatch = home.body.match(/name="jazoest"\s+value="(\d+)"/);
      // Also try SPA-style token extraction
      const spaTokens = this.httpClient.extractTokens(home.body);
      results['mbasic-home'] = {
        statusCode: home.statusCode,
        bodyLength: home.body.length,
        isLoginPage: this.httpClient.isLoginPage(home.body),
        hasFbDtsg: !!(dtsgMatch || spaTokens.fbDtsg),
        fbDtsg: dtsgMatch ? dtsgMatch[1].substring(0, 20) + '...' : (spaTokens.fbDtsg ? spaTokens.fbDtsg.substring(0, 20) + '...' : null),
        jazoest: jazoestMatch ? jazoestMatch[1] : spaTokens.jazoest || null,
        hasUnsupported: home.body.includes('unsupported-interstitial'),
        isSPA: home.body.length > 500000,
      };
    } catch (error) {
      results['mbasic-home'] = { error: error instanceof Error ? error.message : String(error) };
    }

    // 2. Test mbasic inbox — does the messaging section work at all?
    try {
      const inbox = await this.httpClient.request('https://mbasic.facebook.com/messages/', {
        referer: 'https://mbasic.facebook.com/',
      });
      const textContent = inbox.body
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 500);
      results['mbasic-inbox'] = {
        statusCode: inbox.statusCode,
        bodyLength: inbox.body.length,
        isLoginPage: this.httpClient.isLoginPage(inbox.body),
        hasUnsupported: inbox.body.includes('unsupported-interstitial'),
        hasThreadLinks: inbox.body.includes('/messages/read/') || inbox.body.includes('/messages/thread/'),
        textContent,
      };
    } catch (error) {
      results['mbasic-inbox'] = { error: error instanceof Error ? error.message : String(error) };
    }

    // 3. Test m.facebook.com compose (different from mbasic)
    try {
      const mCompose = await this.httpClient.request(
        `https://m.facebook.com/messages/compose/?ids=${recipientId}`,
        { referer: 'https://m.facebook.com/messages/' },
      );
      const titleMatch = mCompose.body.match(/<title>([^<]*)<\/title>/i);
      results['m-compose'] = {
        statusCode: mCompose.statusCode,
        bodyLength: mCompose.body.length,
        isLoginPage: this.httpClient.isLoginPage(mCompose.body),
        title: titleMatch ? titleMatch[1] : null,
        hasBodyField: mCompose.body.includes('name="body"'),
        hasTextarea: /<textarea/i.test(mCompose.body),
        hasUnsupported: mCompose.body.includes('unsupported-interstitial'),
        isReactSPA: mCompose.body.includes('__bbox') || mCompose.body.length > 500000,
      };
    } catch (error) {
      results['m-compose'] = { error: error instanceof Error ? error.message : String(error) };
    }

    // 4. Try direct POST to known send endpoints (blind send, no form scraping)
    // Get tokens from www.facebook.com (desktop) since mbasic now returns SPA
    let fbDtsg = '';
    let jazoest = '';
    let lsd = '';
    const tokenSources = [
      'https://www.facebook.com/',
      'https://www.facebook.com/messages/',
      'https://mbasic.facebook.com/',
    ];
    for (const tokenUrl of tokenSources) {
      if (fbDtsg) break;
      try {
        const tokenPage = await this.httpClient.request(tokenUrl, {
          referer: 'https://www.facebook.com/',
        });
        const tokens = this.httpClient.extractTokens(tokenPage.body);
        if (tokens.fbDtsg) {
          fbDtsg = tokens.fbDtsg;
          jazoest = tokens.jazoest;
          lsd = tokens.lsd;
          results.tokenSource = tokenUrl;
        }
      } catch { /* try next */ }
    }

    if (fbDtsg) {
      // The Lightspeed doc_id for sending messages (discovered via SPA extraction)
      const LS_DOC_ID = '9697184873702141';

      // First: extract the real version_id from the Messenger SPA
      let versionId = '0';
      let messengerBody = '';
      try {
        const messengerPage = await this.httpClient.request('https://www.facebook.com/messages/', {
          referer: 'https://www.facebook.com/',
        });
        messengerBody = messengerPage.body;
        results.messengerPageLength = messengerBody.length;

        // Strategy 1: Search for specific version-related strings and dump context
        const searchTerms = [
          'version_id',
          'schemaVersion',
          'databaseVersion',
          'LSPlatformGraphQLLightspeedVariables',
          'LightspeedConfig',
          'syncVersion',
          'DatabaseVersion',
          'MqttWebConfig',
          'ls_version',
          'MercuryConfig',
        ];
        const stringContexts: Record<string, string[]> = {};
        for (const term of searchTerms) {
          const contexts: string[] = [];
          let searchFrom = 0;
          while (contexts.length < 3) {
            const idx = messengerBody.indexOf(term, searchFrom);
            if (idx === -1) break;
            const start = Math.max(0, idx - 40);
            const end = Math.min(messengerBody.length, idx + term.length + 160);
            contexts.push(messengerBody.substring(start, end).replace(/[\n\r]/g, ' '));
            searchFrom = idx + term.length;
          }
          if (contexts.length > 0) {
            stringContexts[term] = contexts;
          }
        }
        results.stringContexts = stringContexts;

        // Strategy 2: Find script bundle URLs for external JS
        const scriptUrls: string[] = [];
        const scriptPattern = /<script[^>]+src="([^"]*rsrc\.php[^"]*)"[^>]*>/g;
        let sm;
        while ((sm = scriptPattern.exec(messengerBody)) !== null) {
          scriptUrls.push(sm[1]);
          if (scriptUrls.length >= 30) break;
        }
        results.scriptBundleCount = scriptUrls.length;
        // Show first 5 URLs for reference
        results.scriptBundleSamples = scriptUrls.slice(0, 5);

        // Strategy 3: Search for version in ScheduledServerJS handle calls
        // These embed config data in the HTML
        const handlePattern = /handle\(\{[^}]*(?:Lightspeed|LS(?:Platform|Config)|Mercury|version)[^}]{0,500}\}/gi;
        const handleMatches: string[] = [];
        let hm;
        while ((hm = handlePattern.exec(messengerBody)) !== null) {
          handleMatches.push(hm[0].substring(0, 300));
          if (handleMatches.length >= 5) break;
        }
        results.handleMatches = handleMatches;

        // Strategy 4: Known version patterns
        const versionPatterns = [
          /["']schemaVersion["']\s*:\s*["']?(\d{13,20})["']?/i,
          /["']version_id["']\s*:\s*["'](\d{13,20})["']/i,
          /["']lsVersion["']\s*:\s*["'](\d{13,20})["']/i,
          /databaseVersion['"]\s*:\s*['"]*(\d{13,20})/i,
          /["']currentDatabaseVersion["']\s*:\s*(\d{13,20})/i,
        ];
        for (const pat of versionPatterns) {
          const m = messengerBody.match(pat);
          if (m) {
            versionId = m[1];
            results.versionIdSource = pat.source.substring(0, 40);
            break;
          }
        }

        // Strategy 5: Extract ALL 16-19 digit numbers (up to 50)
        const allLargeNums = new Set<string>();
        const numPattern = /[=:,\[]\s*"?(\d{16,19})"?/g;
        let nm;
        while ((nm = numPattern.exec(messengerBody)) !== null) {
          allLargeNums.add(nm[1]);
          if (allLargeNums.size >= 50) break;
        }
        results.largeNumbers = Array.from(allLargeNums).slice(0, 50);
      } catch (error) {
        results.versionExtractError = error instanceof Error ? error.message : String(error);
      }
      results.versionId = versionId;

      // Step 1: Find LSVersion module + search data-sjs blocks + JS bundles
      try {
        // Strategy A: Search for LSVersion module definition in HTML
        // Facebook defines modules with __d("LSVersion",[],function(a,b,c,d,e,f){e.exports="..."})
        const lsVersionContexts: string[] = [];
        let searchFrom = 0;
        while (lsVersionContexts.length < 5) {
          const idx = messengerBody.indexOf('LSVersion', searchFrom);
          if (idx === -1) break;
          const start = Math.max(0, idx - 30);
          const end = Math.min(messengerBody.length, idx + 200);
          lsVersionContexts.push(messengerBody.substring(start, end).replace(/[\n\r]/g, ' '));
          searchFrom = idx + 9;
        }
        results.lsVersionContexts = lsVersionContexts;

        // Also search for LSPlatformMessengerSyncParams (contains sync params module)
        const syncParamIdx = messengerBody.indexOf('LSPlatformMessengerSyncParams');
        if (syncParamIdx !== -1) {
          results.syncParamsContext = messengerBody.substring(syncParamIdx, syncParamIdx + 300).replace(/[\n\r]/g, ' ');
        }

        // Strategy B: Parse data-sjs blocks - get the LS preloaded response (contains version)
        const sjsBlocks: string[] = [];
        const sjsPattern = /<script[^>]+data-sjs[^>]*>([\s\S]*?)<\/script>/gi;
        let sjsMatch;
        while ((sjsMatch = sjsPattern.exec(messengerBody)) !== null) {
          const block = sjsMatch[1];
          // Get the LS Lightspeed preloader result (this contains the initial sync data!)
          if (block.includes('LSPlatformGraphQLLightspeedRequestQueryRelayPreloader')) {
            // This block contains the preloaded sync response - get more of it
            sjsBlocks.push(block.substring(0, 2000));
          } else if (/LSVersion|lightspeed|syncParams/i.test(block)) {
            sjsBlocks.push(block.substring(0, 500));
          }
        }
        results.sjsLsBlocks = sjsBlocks;

        // Strategy C: Search ALL JS bundles for LSVersion module definition
        const scriptPattern2 = /<script[^>]+src="([^"]*rsrc\.php[^"]*)"[^>]*>/g;
        let sm2;
        const bundleUrls: string[] = [];
        while ((sm2 = scriptPattern2.exec(messengerBody)) !== null) {
          bundleUrls.push(sm2[1]);
        }
        results.totalBundles = bundleUrls.length;

        const bundleResults: Array<{idx: number; size: number; found: string | null; lsVersionHit: string | null}> = [];
        for (let i = 0; i < bundleUrls.length; i++) {
          const url = bundleUrls[i];
          try {
            const fullUrl = url.startsWith('http') ? url : `https://static.xx.fbcdn.net${url}`;
            const bundle = await this.httpClient.request(fullUrl, {
              referer: 'https://www.facebook.com/messages/',
            });
            let foundVersion: string | null = null;
            let lsVersionHit: string | null = null;

            // Primary: Search for LSVersion module definition
            const lvIdx = bundle.body.indexOf('"LSVersion"');
            if (lvIdx === -1) {
              const lvIdx2 = bundle.body.indexOf("'LSVersion'");
              if (lvIdx2 !== -1) {
                lsVersionHit = bundle.body.substring(lvIdx2 - 20, lvIdx2 + 200).replace(/[\n\r]/g, ' ');
              }
            } else {
              lsVersionHit = bundle.body.substring(Math.max(0, lvIdx - 20), lvIdx + 200).replace(/[\n\r]/g, ' ');
            }

            // Also try to extract the actual version number near LSVersion
            if (lsVersionHit) {
              const verMatch = lsVersionHit.match(/(\d{13,20})/);
              if (verMatch) {
                foundVersion = verMatch[1];
                versionId = verMatch[1];
              }
            }

            // Fallback: regex patterns
            if (!foundVersion) {
              const bundlePatterns = [
                /["']LSVersion["'][^}]*?["'](\d{13,20})["']/,
                /exports\s*=\s*["'](\d{13,20})["']/,
              ];
              for (const pat of bundlePatterns) {
                const m = bundle.body.match(pat);
                if (m) {
                  foundVersion = m[1];
                  versionId = m[1];
                  break;
                }
              }
            }

            if (lsVersionHit || foundVersion) {
              bundleResults.push({ idx: i, size: bundle.body.length, found: foundVersion, lsVersionHit });
            }
            if (foundVersion) break;
          } catch { /* skip failed bundles */ }
        }
        results.bundleSearch = bundleResults;
      } catch (error) {
        results.bundleSearchError = error instanceof Error ? error.message : String(error);
      }

      // Step 2: Try a SYNC request (requestType=1)
      try {
        const syncBody = new URLSearchParams({
          fb_dtsg: fbDtsg,
          jazoest,
          lsd,
          fb_api_caller_class: 'RelayModern',
          fb_api_req_friendly_name: 'LSPlatformGraphQLLightspeedRequestQuery',
          variables: JSON.stringify({
            deviceId: `device_${myUserId}_${Date.now()}`,
            requestId: 0,
            requestPayload: JSON.stringify({
              version_id: '9477666248971112',
              database: 1,
              epoch_id: 0,
              last_applied_cursor: null,
              sync_params: '',
              tasks: [],
            }),
            requestType: 1,  // SYNC — not execute
          }),
          doc_id: LS_DOC_ID,
          __a: '1',
        }).toString();
        const syncResp = await this.httpClient.post(
          'https://www.facebook.com/api/graphql/',
          syncBody,
          { referer: 'https://www.facebook.com/messages/' },
        );
        const syncClean = syncResp.body.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
        // Look for version numbers in the sync response
        const syncVersionMatch = syncClean.match(/"?version"?\s*:\s*"?(\d{13,20})"?/);
        if (syncVersionMatch) {
          versionId = syncVersionMatch[1];
          results.versionFromSync = versionId;
        }
        results['sync-request'] = {
          statusCode: syncResp.statusCode,
          bodyLength: syncResp.body.length,
          snippet: syncClean.substring(0, 2000),
        };
      } catch (error) {
        results['sync-request'] = { error: error instanceof Error ? error.message : String(error) };
      }

      // Step 3: Try sending with best version_id + corrected payload
      const timestamp = Date.now();
      const versionsToTry = versionId !== '0' ? [versionId] : ['9477666248971112'];

      for (const vid of versionsToTry) {
        // Generate a proper otid (19-digit snowflake-like ID)
        const otid = String(BigInt(timestamp) * BigInt(4294967296) + BigInt(Math.floor(Math.random() * 4294967296)));

        const gqlBody = new URLSearchParams({
          fb_dtsg: fbDtsg,
          jazoest,
          lsd,
          fb_api_caller_class: 'RelayModern',
          fb_api_req_friendly_name: 'LSPlatformGraphQLLightspeedRequestQuery',
          variables: JSON.stringify({
            deviceId: `device_${myUserId}_${timestamp}`,
            requestId: 0,
            requestPayload: JSON.stringify({
              version_id: vid,
              tasks: [{
                label: '46',
                payload: JSON.stringify({
                  thread_id: Number(recipientId),
                  otid,
                  source: 65537,  // 0x10001 = web source
                  send_type: 1,
                  sync_group: 1,
                  text: 'Test Nachricht',
                  initiating_source: 1,
                  skip_url_preview_gen: 0,
                }),
                queue_name: recipientId,
                task_id: 1,
                failure_count: null,
              }],
              epoch_id: timestamp,
            }),
            requestType: 3,
          }),
          doc_id: LS_DOC_ID,
          __a: '1',
        }).toString();

        try {
          const gqlResp = await this.httpClient.post(
            'https://www.facebook.com/api/graphql/',
            gqlBody,
            { referer: 'https://www.facebook.com/messages/' },
          );
          const cleanBody = gqlResp.body.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
          const hasFailed = cleanBody.includes('markOptimisticMessageFailed');
          const hasSuccess = cleanBody.includes('replaceOptimisticMessage') || cleanBody.includes('insertMessage');
          const hasRefresh = cleanBody.includes('forceWebClientRefresh');
          results[`send-v${vid.substring(0, 8)}`] = {
            versionId: vid,
            statusCode: gqlResp.statusCode,
            bodyLength: gqlResp.body.length,
            hasFailed,
            hasSuccess,
            hasRefresh,
            snippet: cleanBody.substring(0, 2000),
          };
        } catch (error) {
          results[`send-v${vid.substring(0, 8)}`] = { versionId: vid, error: error instanceof Error ? error.message : String(error) };
        }
      }
    }

    results.fbDtsgFound = !!fbDtsg;
    return results;
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

      // Step 3: Send the message (mbasic first, then m.facebook.com fallback)
      await this.sendViaMessaging(recipientId, message);

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
    message: string,
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

    // Strategy 2: m.facebook.com (mobile web — different from mbasic)
    try {
      await this.sendViaMobileSite(recipientId, message);
      return;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn({ error: msg }, 'Mobile site send failed');
      errors.push(`mobile: ${msg}`);
    }

    throw new MessageSendError(`All message send strategies failed: ${errors.join('; ')}`);
  }

  /**
   * Find a POST form on an mbasic/mobile page.
   * Returns the form action or null. Tries multiple patterns to handle
   * Facebook page structure changes.
   */
  private findPostForm(body: string): string | null {
    // Pattern 1: form action starts with /messages/
    const msgFormPatterns = [
      /<form[^>]*action="(\/messages\/[^"]*)"[^>]*method="post"/i,
      /<form[^>]*method="post"[^>]*action="(\/messages\/[^"]*)"/i,
    ];
    for (const pattern of msgFormPatterns) {
      const match = body.match(pattern);
      if (match) return match[1];
    }

    // Pattern 2: any POST form that contains a textarea or input[name="body"]
    // (the message compose form always has a body field)
    const formBlocks = body.match(/<form[^>]*method="post"[^>]*>[\s\S]*?<\/form>/gi) ||
      body.match(/<form[^>]*method="post"[^>]*>[\s\S]*?(?=<form|$)/gi) || [];
    for (const formBlock of formBlocks) {
      if (formBlock.includes('name="body"') || formBlock.match(/<textarea[^>]*name="body"/i)) {
        const actionMatch = formBlock.match(/<form[^>]*action="([^"]*)"/i);
        if (actionMatch) return actionMatch[1];
      }
    }

    // Pattern 3: any POST form with an action URL (last resort)
    const anyFormMatch = body.match(/<form[^>]*action="(\/[^"]*)"[^>]*method="post"/i) ||
      body.match(/<form[^>]*method="post"[^>]*action="(\/[^"]*)"/i);
    if (anyFormMatch) {
      const action = anyFormMatch[1];
      // Verify it's not a login or settings form
      if (!action.includes('/login') && !action.includes('/settings') && !action.includes('/checkpoint')) {
        return action;
      }
    }

    return null;
  }

  private async sendViaMbasic(recipientId: string, message: string): Promise<void> {
    log.info({ recipientId }, 'Sending message via mbasic.facebook.com');

    // Try multiple mbasic and 0.facebook.com URLs in order
    const mbasicUrls = [
      `https://mbasic.facebook.com/messages/compose/?ids=${recipientId}`,
      `https://0.facebook.com/messages/compose/?ids=${recipientId}`,
      `https://mbasic.facebook.com/messages/thread/${recipientId}/`,
      `https://0.facebook.com/messages/thread/${recipientId}/`,
      `https://mbasic.facebook.com/messages/read/?tid=cid.c.${recipientId}%3A${this.httpClient.getUserId()}`,
    ];

    for (const url of mbasicUrls) {
      log.debug({ url }, 'Trying mbasic URL');

      try {
        const page = await this.httpClient.request(url, {
          referer: 'https://mbasic.facebook.com/messages/',
        });

        if (this.httpClient.isLoginPage(page.body)) {
          throw new MessageSendError('Session not valid on mbasic (login page)');
        }

        const formAction = this.findPostForm(page.body);
        if (formAction) {
          log.info({ url, formAction }, 'Found message form on mbasic');
          return this.submitMbasicForm(page.body, formAction, message, url);
        }

        log.debug({ url, bodyLength: page.body.length }, 'No message form found on this mbasic URL');
      } catch (error) {
        if (error instanceof MessageSendError && (error.message.includes('login page') || error.message.includes('mbasic send returned'))) {
          throw error;
        }
        log.debug({ error: error instanceof Error ? error.message : String(error), url }, 'mbasic URL attempt failed');
      }
    }

    // Log page content for debugging
    try {
      const debugPage = await this.httpClient.request(mbasicUrls[0], {
        referer: 'https://mbasic.facebook.com/',
      });
      log.debug({
        bodySnippet: debugPage.body.substring(0, 3000),
        bodyLength: debugPage.body.length,
        allForms: (debugPage.body.match(/<form[^>]*>/gi) || []).map((f: string) => f.substring(0, 200)),
      }, 'mbasic compose page debug info');
    } catch { /* ignore */ }

    throw new MessageSendError('No message form found on any mbasic page');
  }

  private async sendViaMobileSite(recipientId: string, message: string): Promise<void> {
    log.info({ recipientId }, 'Sending message via m.facebook.com');

    // m.facebook.com has a different compose interface than mbasic
    const composeUrl = `https://m.facebook.com/messages/compose/?ids=${recipientId}`;
    const page = await this.httpClient.request(composeUrl, {
      referer: 'https://m.facebook.com/messages/',
    });

    if (this.httpClient.isLoginPage(page.body)) {
      throw new MessageSendError('Session not valid on m.facebook.com (login page)');
    }

    const formAction = this.findPostForm(page.body);
    if (formAction) {
      return this.submitMbasicForm(page.body, formAction, message, composeUrl);
    }

    // Try thread URL on m.facebook.com
    const threadUrl = `https://m.facebook.com/messages/read/?tid=cid.c.${recipientId}%3A${this.httpClient.getUserId()}`;
    const threadPage = await this.httpClient.request(threadUrl, {
      referer: 'https://m.facebook.com/messages/',
    });

    const threadFormAction = this.findPostForm(threadPage.body);
    if (threadFormAction) {
      return this.submitMbasicForm(threadPage.body, threadFormAction, message, threadUrl);
    }

    throw new MessageSendError('No message form found on m.facebook.com');
  }

  private async submitMbasicForm(
    pageBody: string,
    rawFormAction: string,
    message: string,
    referer: string,
  ): Promise<void> {
    let formAction = rawFormAction.replace(/&amp;/g, '&');

    // Determine the base URL from the referer
    const refererUrl = new URL(referer);
    const baseUrl = `${refererUrl.protocol}//${refererUrl.hostname}`;

    if (!formAction.startsWith('http')) {
      formAction = `${baseUrl}${formAction}`;
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
    const submitMatch =
      pageBody.match(/<input[^>]*name="send"[^>]*value="([^"]*)"/i) ||
      pageBody.match(/<button[^>]*name="send"[^>]*value="([^"]*)"/i);
    if (submitMatch) {
      params.append('send', submitMatch[1]);
    } else {
      // Try common submit button names
      const altSubmit =
        pageBody.match(/<input[^>]*type="submit"[^>]*name="([^"]*)"[^>]*value="([^"]*)"/i) ||
        pageBody.match(/<button[^>]*type="submit"[^>]*name="([^"]*)"[^>]*value="([^"]*)"/i);
      if (altSubmit) {
        params.append(altSubmit[1], altSubmit[2]);
      } else {
        params.append('send', 'Senden');
      }
    }

    log.debug({ formAction, hiddenFieldCount: [...params.keys()].length }, 'Submitting message form');

    const response = await this.httpClient.post(formAction, params.toString(), {
      referer,
    });

    if (response.statusCode >= 400) {
      throw new MessageSendError(`mbasic send returned HTTP ${response.statusCode}`);
    }

    // Check for success indicators
    const hasThread = response.body.includes('/messages/read/') ||
      response.body.includes('/messages/thread/') ||
      response.body.includes('message_sent');
    if (hasThread) {
      log.info('Message confirmed sent (thread/success indicator found in response)');
    } else if (this.httpClient.isLoginPage(response.body)) {
      throw new MessageSendError('Session expired during send (redirected to login)');
    } else if (response.body.includes('error') && response.body.length < 2000) {
      log.warn({ bodySnippet: response.body.substring(0, 500) }, 'Response may contain error');
    }

    log.info('Message sent via mobile/mbasic form submit');
  }
}
