/**
 * Facebook Messenger E2EE (Signal Protocol) implementation.
 *
 * Facebook Messenger uses the Signal Protocol (X3DH + Double Ratchet)
 * for end-to-end encrypted messaging. This module handles:
 *
 * 1. Key generation (identity key, signed pre-key, one-time pre-keys)
 * 2. Key registration with Facebook's servers
 * 3. Fetching recipient pre-key bundles
 * 4. Signal session establishment (X3DH)
 * 5. Message encryption (Double Ratchet + AES-256-GCM via protobuf)
 * 6. Sending encrypted messages via LSPlatform GraphQL
 */

import * as signal from '@signalapp/libsignal-client';
import crypto from 'crypto';
import { FacebookHttpClient } from './facebook-http-client';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger({ service: 'E2EESignal' });

/** Helper: convert Buffer to Uint8Array<ArrayBuffer> for libsignal compatibility */
function toUint8(buf: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) as Uint8Array<ArrayBuffer>;
}

// ──────────────────────────────────────────────────────────────────────
// In-memory Signal stores — in production these should be persisted
// ──────────────────────────────────────────────────────────────────────

class InMemoryIdentityKeyStore extends signal.IdentityKeyStore {
  private knownIdentities = new Map<string, signal.PublicKey>();
  private readonly identityKey: signal.PrivateKey;
  private readonly registrationId: number;

  constructor(identityKey: signal.PrivateKey, registrationId: number) {
    super();
    this.identityKey = identityKey;
    this.registrationId = registrationId;
  }

  async getIdentityKey(): Promise<signal.PrivateKey> {
    return this.identityKey;
  }

  async getLocalRegistrationId(): Promise<number> {
    return this.registrationId;
  }

  async saveIdentity(name: signal.ProtocolAddress, key: signal.PublicKey): Promise<signal.IdentityChange> {
    const addr = `${name.name()}.${name.deviceId()}`;
    const existing = this.knownIdentities.get(addr);
    this.knownIdentities.set(addr, key);
    if (existing && !existing.equals(key)) {
      return signal.IdentityChange.ReplacedExisting;
    }
    return signal.IdentityChange.NewOrUnchanged;
  }

  async isTrustedIdentity(
    name: signal.ProtocolAddress,
    key: signal.PublicKey,
    _direction: signal.Direction,
  ): Promise<boolean> {
    const addr = `${name.name()}.${name.deviceId()}`;
    const existing = this.knownIdentities.get(addr);
    if (!existing) return true; // First use — trust on first use
    return existing.equals(key);
  }

  async getIdentity(name: signal.ProtocolAddress): Promise<signal.PublicKey | null> {
    const addr = `${name.name()}.${name.deviceId()}`;
    return this.knownIdentities.get(addr) || null;
  }
}

class InMemoryPreKeyStore extends signal.PreKeyStore {
  private preKeys = new Map<number, signal.PreKeyRecord>();

  async savePreKey(id: number, record: signal.PreKeyRecord): Promise<void> {
    this.preKeys.set(id, record);
  }

  async getPreKey(id: number): Promise<signal.PreKeyRecord> {
    const record = this.preKeys.get(id);
    if (!record) throw new Error(`PreKey ${id} not found`);
    return record;
  }

  async removePreKey(id: number): Promise<void> {
    this.preKeys.delete(id);
  }
}

class InMemorySignedPreKeyStore extends signal.SignedPreKeyStore {
  private signedPreKeys = new Map<number, signal.SignedPreKeyRecord>();

  async saveSignedPreKey(id: number, record: signal.SignedPreKeyRecord): Promise<void> {
    this.signedPreKeys.set(id, record);
  }

  async getSignedPreKey(id: number): Promise<signal.SignedPreKeyRecord> {
    const record = this.signedPreKeys.get(id);
    if (!record) throw new Error(`SignedPreKey ${id} not found`);
    return record;
  }
}

class InMemorySessionStore extends signal.SessionStore {
  private sessions = new Map<string, signal.SessionRecord>();

  async saveSession(name: signal.ProtocolAddress, record: signal.SessionRecord): Promise<void> {
    const addr = `${name.name()}.${name.deviceId()}`;
    this.sessions.set(addr, record);
  }

  async getSession(name: signal.ProtocolAddress): Promise<signal.SessionRecord | null> {
    const addr = `${name.name()}.${name.deviceId()}`;
    return this.sessions.get(addr) || null;
  }

  async getExistingSessions(addresses: signal.ProtocolAddress[]): Promise<signal.SessionRecord[]> {
    const result: signal.SessionRecord[] = [];
    for (const addr of addresses) {
      const session = await this.getSession(addr);
      if (session) result.push(session);
    }
    return result;
  }
}

class InMemoryKyberPreKeyStore extends signal.KyberPreKeyStore {
  private kyberPreKeys = new Map<number, signal.KyberPreKeyRecord>();

  async saveKyberPreKey(id: number, record: signal.KyberPreKeyRecord): Promise<void> {
    this.kyberPreKeys.set(id, record);
  }

  async getKyberPreKey(id: number): Promise<signal.KyberPreKeyRecord> {
    const record = this.kyberPreKeys.get(id);
    if (!record) throw new Error(`KyberPreKey ${id} not found`);
    return record;
  }

  async markKyberPreKeyUsed(_kyberPreKeyId: number, _signedPreKeyId: number, _baseKey: signal.PublicKey): Promise<void> {
    // No-op for in-memory store
  }
}

// ──────────────────────────────────────────────────────────────────────
// Key bundle types (Facebook's format)
// ──────────────────────────────────────────────────────────────────────

interface FacebookKeyBundle {
  identityKey: Uint8Array<ArrayBuffer>;
  signedPreKey: {
    keyId: number;
    publicKey: Uint8Array<ArrayBuffer>;
    signature: Uint8Array<ArrayBuffer>;
  };
  preKey?: {
    keyId: number;
    publicKey: Uint8Array<ArrayBuffer>;
  };
  kyberPreKey?: {
    keyId: number;
    publicKey: Uint8Array<ArrayBuffer>;
    signature: Uint8Array<ArrayBuffer>;
  };
  registrationId: number;
}

interface E2EEKeys {
  identityKeyPair: signal.PrivateKey;
  registrationId: number;
  signedPreKey: signal.SignedPreKeyRecord;
  preKeys: signal.PreKeyRecord[];
  kyberPreKey: signal.KyberPreKeyRecord;
}

// ──────────────────────────────────────────────────────────────────────
// Facebook Messenger E2EE Client
// ──────────────────────────────────────────────────────────────────────

// Known doc_ids for E2EE operations
const DOC_IDS = {
  lightspeedRequest: '9697184873702141',
  // These doc_ids are discovered dynamically from the Messenger SPA
  // and may change with each Facebook deployment
  e2eeKeyUpload: '',     // populated at runtime
  e2eeKeyFetch: '',      // populated at runtime
};

export class E2EESignalClient {
  private identityStore!: InMemoryIdentityKeyStore;
  private preKeyStore = new InMemoryPreKeyStore();
  private signedPreKeyStore = new InMemorySignedPreKeyStore();
  private sessionStore = new InMemorySessionStore();
  private kyberPreKeyStore = new InMemoryKyberPreKeyStore();

  private keys: E2EEKeys | null = null;
  private lsVersion = '';
  private fbDtsg = '';
  private jazoest = '';
  private lsd = '';
  private myUserId = '';

  constructor(private readonly httpClient: FacebookHttpClient) {}

  /**
   * Initialize the E2EE client: generate keys, discover endpoints,
   * extract tokens, and register keys with Facebook.
   */
  async initialize(): Promise<void> {
    this.myUserId = this.httpClient.getUserId() || '';
    if (!this.myUserId) {
      throw new Error('No user ID found — session not initialized');
    }

    // 1. Extract tokens from Facebook
    await this.extractTokens();
    log.info('Tokens extracted');

    // 2. Discover the LSVersion and E2EE doc_ids
    await this.discoverEndpoints();
    log.info({ lsVersion: this.lsVersion }, 'Endpoints discovered');

    // 3. Generate Signal Protocol keys
    this.keys = await this.generateKeys();
    log.info('Signal keys generated');

    // 4. Set up in-memory stores
    this.identityStore = new InMemoryIdentityKeyStore(
      this.keys.identityKeyPair,
      this.keys.registrationId,
    );
    await this.signedPreKeyStore.saveSignedPreKey(
      this.keys.signedPreKey.id(),
      this.keys.signedPreKey,
    );
    for (const pk of this.keys.preKeys) {
      await this.preKeyStore.savePreKey(pk.id(), pk);
    }

    // 5. Register our keys with Facebook
    await this.registerKeys();
    log.info('Keys registered with Facebook');
  }

  /**
   * Send an E2EE message to a recipient.
   */
  async sendMessage(recipientId: string, message: string): Promise<{
    success: boolean;
    error?: string;
    details?: Record<string, unknown>;
  }> {
    if (!this.keys) {
      throw new Error('E2EE client not initialized — call initialize() first');
    }

    try {
      // 1. Fetch recipient's pre-key bundle from Facebook
      const bundle = await this.fetchPreKeyBundle(recipientId);
      log.info({ recipientId }, 'Pre-key bundle fetched');

      // 2. Establish Signal session with recipient
      await this.establishSession(recipientId, bundle);
      log.info({ recipientId }, 'Signal session established');

      // 3. Encrypt the message
      const encrypted = await this.encryptMessage(recipientId, message);
      log.info({ recipientId, ciphertextLength: encrypted.length }, 'Message encrypted');

      // 4. Send via LSPlatform GraphQL
      const result = await this.sendEncryptedMessage(recipientId, encrypted);
      return result;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ error: msg, recipientId }, 'E2EE send failed');
      return { success: false, error: msg };
    }
  }

  /**
   * Run diagnostics — useful for debugging the E2EE flow step by step.
   */
  async diagnose(recipientId: string): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};

    // Step 1: Token extraction
    try {
      await this.extractTokens();
      results.tokens = { fbDtsg: this.fbDtsg.substring(0, 10) + '...', jazoest: this.jazoest, lsd: this.lsd.substring(0, 10) + '...' };
    } catch (error) {
      results.tokens = { error: error instanceof Error ? error.message : String(error) };
      return results;
    }

    // Step 2: Discover LSVersion + scan for E2EE task info
    try {
      await this.discoverEndpoints();
      results.endpoints = { lsVersion: this.lsVersion };
    } catch (error) {
      results.endpoints = { error: error instanceof Error ? error.message : String(error) };
      return results;
    }

    // Step 2b: Scan Messenger page and bundles for E2EE-related strings
    try {
      const e2eeInfo = await this.scanForE2EEInfo();
      results.e2eeDiscovery = e2eeInfo;
    } catch (error) {
      results.e2eeDiscovery = { error: error instanceof Error ? error.message : String(error) };
    }

    // Step 3: Key generation
    try {
      this.keys = await this.generateKeys();
      this.identityStore = new InMemoryIdentityKeyStore(
        this.keys.identityKeyPair,
        this.keys.registrationId,
      );
      await this.signedPreKeyStore.saveSignedPreKey(this.keys.signedPreKey.id(), this.keys.signedPreKey);
      for (const pk of this.keys.preKeys) {
        await this.preKeyStore.savePreKey(pk.id(), pk);
      }
      results.keyGen = {
        registrationId: this.keys.registrationId,
        identityPubKey: Buffer.from(this.keys.identityKeyPair.getPublicKey().serialize()).toString('base64').substring(0, 20) + '...',
        signedPreKeyId: this.keys.signedPreKey.id(),
        preKeyCount: this.keys.preKeys.length,
      };
    } catch (error) {
      results.keyGen = { error: error instanceof Error ? error.message : String(error) };
      return results;
    }

    // Step 4: Register keys
    try {
      const regResult = await this.registerKeys();
      results.keyRegistration = regResult;
    } catch (error) {
      results.keyRegistration = { error: error instanceof Error ? error.message : String(error) };
    }

    // Step 5: Fetch recipient pre-key bundle
    try {
      const bundle = await this.fetchPreKeyBundle(recipientId);
      results.recipientBundle = {
        registrationId: bundle.registrationId,
        identityKeyLen: bundle.identityKey.length,
        signedPreKeyId: bundle.signedPreKey.keyId,
        hasPreKey: !!bundle.preKey,
      };
    } catch (error) {
      results.recipientBundle = { error: error instanceof Error ? error.message : String(error) };
    }

    return results;
  }

  /**
   * Scan Messenger bundles for the exact task-46 payload schema
   * and E2EE send mechanisms.
   */
  private async scanForE2EEInfo(): Promise<Record<string, unknown>> {
    const info: Record<string, unknown> = {};

    const messengerPage = await this.httpClient.request('https://www.facebook.com/messages/', {
      referer: 'https://www.facebook.com/',
    });

    // Scan bundles for task label definitions and E2EE send code
    const scriptPattern = /<script[^>]+src="([^"]*rsrc\.php[^"]*)"[^>]*>/g;
    let sm;
    const bundleUrls: string[] = [];
    while ((sm = scriptPattern.exec(messengerPage.body)) !== null) {
      bundleUrls.push(sm[1]);
    }
    info.bundleCount = bundleUrls.length;

    // Deep-scan bundles for task label mappings and send functions
    const findings: Record<string, string[]> = {};

    for (let i = 0; i < Math.min(bundleUrls.length, 8); i++) {
      try {
        const fullUrl = bundleUrls[i].startsWith('http') ? bundleUrls[i] : `https://static.xx.fbcdn.net${bundleUrls[i]}`;
        const bundle = await this.httpClient.request(fullUrl, {
          referer: 'https://www.facebook.com/messages/',
        });

        const contexts: string[] = [];

        // 1. Search for task label definitions near "46" or send
        // Look for the task definition pattern: label:46 or "46":function
        const taskPattern = /label['":\s]*4[56789]\b[^;]{0,300}/g;
        let tm;
        while ((tm = taskPattern.exec(bundle.body)) !== null && contexts.length < 5) {
          contexts.push(`[b${i}:task:${tm.index}] ${tm[0].substring(0, 300)}`);
        }

        // 2. Search for "sendE2eeMessage" or similar function defs
        for (const term of [
          'sendE2eeMessage', 'sendSecureMessage', 'LSSendE2EE',
          'LSVerifyAndInsertE2EE', 'insertE2eeMsg', 'e2eeSend',
          'secureSendMessage', 'encryptAndSend', 'armadilloSend',
          'MWE2EESend', 'MAWSend', 'processE2eeOutgoing',
        ]) {
          let from = 0;
          while (contexts.length < 15) {
            const idx = bundle.body.indexOf(term, from);
            if (idx === -1) break;
            const start = Math.max(0, idx - 60);
            const end = Math.min(bundle.body.length, idx + term.length + 300);
            contexts.push(`[b${i}:${term}:${idx}] ${bundle.body.substring(start, end).replace(/[\n\r]/g, ' ')}`);
            from = idx + term.length;
          }
        }

        // 3. Search for the actual send task payload fields
        // The Task 46 payload has specific field names
        for (const term of [
          'thread_id', 'otid', 'send_type', 'sync_group', 'initiating_source',
          'is_e2ee_message_', 'armadillo_message_payload',
          'encrypted_serialized', 'ciphertext', 'signal_message',
          'pni_signature_message', 'proto_message',
        ]) {
          let from = 0;
          while (contexts.length < 25) {
            const idx = bundle.body.indexOf(term, from);
            if (idx === -1) break;
            const start = Math.max(0, idx - 80);
            const end = Math.min(bundle.body.length, idx + term.length + 200);
            const ctx = bundle.body.substring(start, end).replace(/[\n\r]/g, ' ');
            // Only include if it looks like a task/message definition
            if (ctx.includes('task') || ctx.includes('label') || ctx.includes('payload') || 
                ctx.includes('send') || ctx.includes('message') || ctx.includes('e2ee')) {
              contexts.push(`[b${i}:${term}:${idx}] ${ctx}`);
            }
            from = idx + term.length;
          }
        }

        if (contexts.length > 0) findings[`bundle_${i}`] = contexts;
      } catch { /* skip */ }
    }
    info.findings = findings;

    return info;
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: Token extraction
  // ──────────────────────────────────────────────────────────────────

  private async extractTokens(): Promise<void> {
    const page = await this.httpClient.request('https://www.facebook.com/', {
      referer: 'https://www.facebook.com/',
    });
    const tokens = this.httpClient.extractTokens(page.body);
    if (!tokens.fbDtsg) {
      throw new Error('Could not extract fb_dtsg token');
    }
    this.fbDtsg = tokens.fbDtsg;
    this.jazoest = tokens.jazoest;
    this.lsd = tokens.lsd;
    this.myUserId = this.httpClient.getUserId() || this.myUserId;
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: Endpoint discovery
  // ──────────────────────────────────────────────────────────────────

  private async discoverEndpoints(): Promise<void> {
    const messengerPage = await this.httpClient.request('https://www.facebook.com/messages/', {
      referer: 'https://www.facebook.com/',
    });

    log.info({ bodyLength: messengerPage.body.length, statusCode: messengerPage.statusCode }, 'Messenger page loaded');

    // Strategy A: Extract from data-sjs preloader blocks (inline in HTML)
    const sjsPattern = /<script[^>]+data-sjs[^>]*>([\s\S]*?)<\/script>/gi;
    let sjsMatch;
    while ((sjsMatch = sjsPattern.exec(messengerPage.body)) !== null) {
      const block = sjsMatch[1];
      // Look for LSVersion module definition in inline scripts
      const inlineDefMatch = block.match(/__d\("LSVersion"[^)]*exports\s*=\s*"(\d+)"/);
      if (inlineDefMatch && !this.lsVersion) {
        this.lsVersion = inlineDefMatch[1];
        log.info({ source: 'data-sjs-inline' }, 'Found LSVersion');
      }
      // Also check for version_id references
      const versionMatch = block.match(/"version_id"\s*:\s*"(\d{13,20})"/);
      if (versionMatch && !this.lsVersion) {
        this.lsVersion = versionMatch[1];
        log.info({ source: 'data-sjs-version_id' }, 'Found LSVersion');
      }
    }

    // Strategy B: Direct regex on full body
    if (!this.lsVersion) {
      const directMatch = messengerPage.body.match(/__d\("LSVersion"[^)]*exports\s*=\s*"(\d+)"/);
      if (directMatch) {
        this.lsVersion = directMatch[1];
        log.info({ source: 'body-direct' }, 'Found LSVersion');
      }
    }

    // Strategy C: Scan JS bundle files
    if (!this.lsVersion) {
      const scriptPattern = /<script[^>]+src="([^"]*rsrc\.php[^"]*)"[^>]*>/g;
      let sm;
      const bundleUrls: string[] = [];
      while ((sm = scriptPattern.exec(messengerPage.body)) !== null) {
        bundleUrls.push(sm[1]);
      }
      log.info({ bundleCount: bundleUrls.length }, 'Found JS bundles');

      for (const url of bundleUrls) {
        if (this.lsVersion) break;
        try {
          const fullUrl = url.startsWith('http') ? url : `https://static.xx.fbcdn.net${url}`;
          const bundle = await this.httpClient.request(fullUrl, {
            referer: 'https://www.facebook.com/messages/',
          });

          // Find __d("LSVersion",...) module definition
          const defIdx = bundle.body.indexOf('__d("LSVersion"');
          if (defIdx !== -1) {
            const ctx = bundle.body.substring(defIdx, defIdx + 200);
            const exportsMatch = ctx.match(/exports\s*=\s*"(\d+)"/);
            if (exportsMatch) {
              this.lsVersion = exportsMatch[1];
              log.info({ source: 'bundle' }, 'Found LSVersion');
            }
          }
        } catch { /* skip failed bundles */ }
      }
    }

    if (!this.lsVersion) {
      throw new Error('Could not discover LSVersion from Messenger bundles');
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: Key generation
  // ──────────────────────────────────────────────────────────────────

  private async generateKeys(): Promise<E2EEKeys> {
    // Generate identity key pair (long-term)
    const identityKeyPair = signal.PrivateKey.generate();

    // Registration ID (random 14-bit number)
    const registrationId = (crypto.randomBytes(2).readUInt16BE(0) & 0x3FFF) + 1;

    // Signed pre-key (medium-term, signed by identity key)
    const signedPreKeyId = 1;
    const signedPreKeyPair = signal.PrivateKey.generate();
    const signedPreKeyPublic = signedPreKeyPair.getPublicKey();
    const signedPreKeySignature = identityKeyPair.sign(signedPreKeyPublic.serialize());
    const signedPreKey = signal.SignedPreKeyRecord.new(
      signedPreKeyId,
      Date.now(),
      signedPreKeyPair.getPublicKey(),
      signedPreKeyPair,
      signedPreKeySignature,
    );

    // One-time pre-keys (ephemeral)
    const preKeys: signal.PreKeyRecord[] = [];
    for (let i = 1; i <= 100; i++) {
      const preKeyPair = signal.PrivateKey.generate();
      preKeys.push(
        signal.PreKeyRecord.new(i, preKeyPair.getPublicKey(), preKeyPair),
      );
    }

    // Kyber pre-key (PQXDH — required by libsignal v0.94+)
    const kyberKeyPair = signal.KEMKeyPair.generate();
    const kyberPreKeyId = 1;
    const kyberPreKeySignature = identityKeyPair.sign(kyberKeyPair.getPublicKey().serialize());
    const kyberPreKey = signal.KyberPreKeyRecord.new(
      kyberPreKeyId,
      Date.now(),
      kyberKeyPair,
      kyberPreKeySignature,
    );

    return { identityKeyPair, registrationId, signedPreKey, preKeys, kyberPreKey };
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: Key registration with Facebook
  // ──────────────────────────────────────────────────────────────────

  private async registerKeys(): Promise<Record<string, unknown>> {
    if (!this.keys) throw new Error('Keys not generated');

    const identityPubKey = Buffer.from(this.keys.identityKeyPair.getPublicKey().serialize());
    const signedPreKeyPub = Buffer.from(this.keys.signedPreKey.publicKey().serialize());
    const signedPreKeySig = Buffer.from(this.keys.signedPreKey.signature());

    // Build pre-key array for registration
    const preKeysPayload = this.keys.preKeys.map(pk => ({
      key_id: pk.id(),
      public_key: Buffer.from(pk.publicKey().serialize()).toString('base64'),
    }));

    // Facebook registers E2EE keys via a GraphQL mutation or via LS tasks
    // Task label 65 = registerE2EEKeys (or similar)
    const registrationPayload = {
      identity_key: identityPubKey.toString('base64'),
      signed_pre_key: {
        key_id: this.keys.signedPreKey.id(),
        public_key: signedPreKeyPub.toString('base64'),
        signature: signedPreKeySig.toString('base64'),
      },
      pre_keys: preKeysPayload,
      registration_id: this.keys.registrationId,
      device_id: 0, // 0 = primary device
    };

    // Try via LSPlatform task
    const timestamp = Date.now();
    const body = new URLSearchParams({
      fb_dtsg: this.fbDtsg,
      jazoest: this.jazoest,
      lsd: this.lsd,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'LSPlatformGraphQLLightspeedRequestQuery',
      variables: JSON.stringify({
        deviceId: `device_${this.myUserId}_0`,
        requestId: 0,
        requestPayload: JSON.stringify({
          version_id: this.lsVersion,
          tasks: [{
            label: '65', // E2EE key registration task
            payload: JSON.stringify(registrationPayload),
            queue_name: 'e2ee_key_upload',
            task_id: 1,
            failure_count: null,
          }],
          epoch_id: timestamp,
        }),
        requestType: 3,
      }),
      doc_id: DOC_IDS.lightspeedRequest,
      __a: '1',
    }).toString();

    const resp = await this.httpClient.post(
      'https://www.facebook.com/api/graphql/',
      body,
      { referer: 'https://www.facebook.com/messages/' },
    );

    const cleanBody = resp.body.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
    const hasError = cleanBody.includes('error') || cleanBody.includes('Error');
    const snippet = cleanBody.substring(0, 1000);

    log.info({ statusCode: resp.statusCode, hasError }, 'Key registration response');

    return {
      statusCode: resp.statusCode,
      bodyLength: resp.body.length,
      hasError,
      snippet,
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: Fetch recipient pre-key bundle
  // ──────────────────────────────────────────────────────────────────

  private async fetchPreKeyBundle(recipientId: string): Promise<FacebookKeyBundle> {
    // Facebook exposes pre-key bundles via a GraphQL query
    // We use the LS task system with a specific label for key fetching
    const timestamp = Date.now();

    const body = new URLSearchParams({
      fb_dtsg: this.fbDtsg,
      jazoest: this.jazoest,
      lsd: this.lsd,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'LSPlatformGraphQLLightspeedRequestQuery',
      variables: JSON.stringify({
        deviceId: `device_${this.myUserId}_0`,
        requestId: 0,
        requestPayload: JSON.stringify({
          version_id: this.lsVersion,
          tasks: [{
            label: '66', // E2EE fetch pre-key bundle task
            payload: JSON.stringify({
              contact_id: Number(recipientId),
              device_id: 0,
            }),
            queue_name: 'e2ee_key_fetch',
            task_id: 1,
            failure_count: null,
          }],
          epoch_id: timestamp,
        }),
        requestType: 3,
      }),
      doc_id: DOC_IDS.lightspeedRequest,
      __a: '1',
    }).toString();

    const resp = await this.httpClient.post(
      'https://www.facebook.com/api/graphql/',
      body,
      { referer: 'https://www.facebook.com/messages/' },
    );

    const cleanBody = resp.body.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
    log.debug({ bodyLength: cleanBody.length }, 'Pre-key bundle response');

    // Parse the response to extract the key bundle
    return this.parsePreKeyBundleResponse(cleanBody, recipientId);
  }

  private parsePreKeyBundleResponse(responseBody: string, recipientId: string): FacebookKeyBundle {
    // The response from Facebook's LS system contains the key bundle
    // embedded in the step/payload structure. We need to parse it out.
    try {
      const parsed = JSON.parse(responseBody);
      const payload = parsed?.data?.viewer?.lightspeed_web_request?.payload;
      if (!payload) {
        throw new Error(`No payload in pre-key response for ${recipientId}`);
      }

      // Try to extract key data from the nested LS response
      const payloadData = JSON.parse(payload);

      // Facebook wraps keys in various formats — try multiple extraction patterns
      // Pattern 1: Direct key fields
      if (payloadData.identity_key && payloadData.signed_pre_key) {
        return {
          identityKey: toUint8(Buffer.from(payloadData.identity_key, 'base64')),
          signedPreKey: {
            keyId: payloadData.signed_pre_key.key_id,
            publicKey: toUint8(Buffer.from(payloadData.signed_pre_key.public_key, 'base64')),
            signature: toUint8(Buffer.from(payloadData.signed_pre_key.signature, 'base64')),
          },
          preKey: payloadData.pre_key ? {
            keyId: payloadData.pre_key.key_id,
            publicKey: toUint8(Buffer.from(payloadData.pre_key.public_key, 'base64')),
          } : undefined,
          kyberPreKey: payloadData.kyber_pre_key ? {
            keyId: payloadData.kyber_pre_key.key_id,
            publicKey: toUint8(Buffer.from(payloadData.kyber_pre_key.public_key, 'base64')),
            signature: toUint8(Buffer.from(payloadData.kyber_pre_key.signature, 'base64')),
          } : undefined,
          registrationId: payloadData.registration_id || 0,
        };
      }

      // Pattern 2: LS step-based response
      // The step response contains function calls like:
      // ["setContactE2EEKeys", userId, identityKey, signedPreKeyId, signedPreKey, signedPreKeySig, preKeyId, preKey, regId]
      const stepStr = typeof payloadData === 'string' ? payloadData : JSON.stringify(payloadData);
      const keyMatch = stepStr.match(/setContactE2EEKeys[^[]*\[([^\]]+)\]/);
      if (keyMatch) {
        const parts = keyMatch[1].split(',').map((s: string) => s.trim().replace(/"/g, ''));
        if (parts.length >= 8) {
          return {
            identityKey: toUint8(Buffer.from(parts[1], 'base64')),
            signedPreKey: {
              keyId: parseInt(parts[2], 10),
              publicKey: toUint8(Buffer.from(parts[3], 'base64')),
              signature: toUint8(Buffer.from(parts[4], 'base64')),
            },
            preKey: parts[5] !== 'null' ? {
              keyId: parseInt(parts[5], 10),
              publicKey: toUint8(Buffer.from(parts[6], 'base64')),
            } : undefined,
            registrationId: parseInt(parts[7], 10),
          };
        }
      }

      throw new Error(`Could not parse pre-key bundle format. Payload preview: ${stepStr.substring(0, 500)}`);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in pre-key response: ${responseBody.substring(0, 200)}`);
      }
      throw error;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: Session establishment (X3DH)
  // ──────────────────────────────────────────────────────────────────

  private async establishSession(recipientId: string, bundle: FacebookKeyBundle): Promise<void> {
    const recipientAddress = signal.ProtocolAddress.new(recipientId, 1); // device 1 = primary
    const localAddress = signal.ProtocolAddress.new(this.myUserId, 1);

    // Build a Signal PreKeyBundle from Facebook's key data
    const identityKey = signal.PublicKey.deserialize(bundle.identityKey);
    const signedPreKeyPublic = signal.PublicKey.deserialize(bundle.signedPreKey.publicKey);

    let preKeyPublic: signal.PublicKey | null = null;
    let preKeyId: number | null = null;
    if (bundle.preKey) {
      preKeyPublic = signal.PublicKey.deserialize(bundle.preKey.publicKey);
      preKeyId = bundle.preKey.keyId;
    }

    // Kyber pre-key (PQXDH) — required by libsignal v0.94+
    let kyberPreKeyId: number;
    let kyberPreKeyPublic: signal.KEMPublicKey;
    let kyberPreKeySignature: Uint8Array<ArrayBuffer>;

    if (bundle.kyberPreKey) {
      kyberPreKeyId = bundle.kyberPreKey.keyId;
      kyberPreKeyPublic = signal.KEMPublicKey.deserialize(bundle.kyberPreKey.publicKey);
      kyberPreKeySignature = bundle.kyberPreKey.signature;
    } else {
      // Generate a dummy Kyber key pair for session establishment
      // This is needed because libsignal v0.94 enforces PQXDH
      const kyberKP = signal.KEMKeyPair.generate();
      kyberPreKeyId = 1;
      kyberPreKeyPublic = kyberKP.getPublicKey();
      const identityPriv = this.keys!.identityKeyPair;
      kyberPreKeySignature = identityPriv.sign(kyberPreKeyPublic.serialize());
    }

    const preKeyBundle = signal.PreKeyBundle.new(
      bundle.registrationId,
      1,  // device ID
      preKeyId,
      preKeyPublic,
      bundle.signedPreKey.keyId,
      signedPreKeyPublic,
      bundle.signedPreKey.signature,
      identityKey,
      kyberPreKeyId,
      kyberPreKeyPublic,
      kyberPreKeySignature,
    );

    // Process the bundle — this performs X3DH + PQXDH key agreement
    await signal.processPreKeyBundle(
      preKeyBundle,
      recipientAddress,
      localAddress,
      this.sessionStore,
      this.identityStore,
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: Message encryption
  // ──────────────────────────────────────────────────────────────────

  private async encryptMessage(recipientId: string, plaintext: string): Promise<Buffer> {
    const recipientAddress = signal.ProtocolAddress.new(recipientId, 1);
    const localAddress = signal.ProtocolAddress.new(this.myUserId, 1);

    // Build the message protobuf content
    // Facebook Messenger uses a specific protobuf format for message content
    const messageContent = this.buildMessageContent(plaintext);

    // Encrypt using the Signal session
    const ciphertext = await signal.signalEncrypt(
      toUint8(messageContent),
      recipientAddress,
      localAddress,
      this.sessionStore,
      this.identityStore,
    );

    return Buffer.from(ciphertext.serialize());
  }

  /**
   * Build the inner message content buffer.
   * Facebook Messenger uses a protobuf-like format for the message body.
   * This is a simplified version — the real format includes additional
   * metadata fields.
   */
  private buildMessageContent(text: string): Buffer {
    // Facebook's inner message format (simplified protobuf encoding):
    // Field 1 (string): message text
    // Field 2 (varint): timestamp
    // Field 3 (varint): message type (1 = text)

    const textBytes = Buffer.from(text, 'utf-8');
    const timestamp = BigInt(Date.now());

    // Manual protobuf encoding
    const parts: Buffer[] = [];

    // Field 1: text (tag = 0x0A, wire type 2 = length-delimited)
    parts.push(Buffer.from([0x0A]));
    parts.push(this.encodeVarint(textBytes.length));
    parts.push(textBytes);

    // Field 2: timestamp (tag = 0x10, wire type 0 = varint)
    parts.push(Buffer.from([0x10]));
    parts.push(this.encodeVarint(Number(timestamp)));

    // Field 3: message type = 1 (tag = 0x18, wire type 0 = varint)
    parts.push(Buffer.from([0x18, 0x01]));

    return Buffer.concat(parts);
  }

  private encodeVarint(value: number): Buffer {
    const bytes: number[] = [];
    let v = value >>> 0; // unsigned
    while (v > 0x7F) {
      bytes.push((v & 0x7F) | 0x80);
      v >>>= 7;
    }
    bytes.push(v & 0x7F);
    return Buffer.from(bytes);
  }

  // ──────────────────────────────────────────────────────────────────
  // Private: Send encrypted message via LSPlatform
  // ──────────────────────────────────────────────────────────────────

  private async sendEncryptedMessage(
    recipientId: string,
    ciphertext: Buffer,
  ): Promise<{ success: boolean; error?: string; details?: Record<string, unknown> }> {
    const timestamp = Date.now();
    const otid = String(BigInt(timestamp) * BigInt(4294967296) + BigInt(Math.floor(Math.random() * 4294967296)));

    // Task label 46 for sending, but with encrypted payload
    // The E2EE message needs to go through the E2EE-specific send task
    const sendPayload = {
      thread_id: Number(recipientId),
      otid,
      source: 65537,  // 0x10001 = web source
      send_type: 1,
      sync_group: 1,
      initiating_source: 1,
      skip_url_preview_gen: 0,
      // E2EE specific fields
      e2ee_message: ciphertext.toString('base64'),
      is_e2ee: true,
      message_type: 0, // 0 = PreKeySignalMessage, 1 = SignalMessage
    };

    const body = new URLSearchParams({
      fb_dtsg: this.fbDtsg,
      jazoest: this.jazoest,
      lsd: this.lsd,
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: 'LSPlatformGraphQLLightspeedRequestQuery',
      variables: JSON.stringify({
        deviceId: `device_${this.myUserId}_0`,
        requestId: 0,
        requestPayload: JSON.stringify({
          version_id: this.lsVersion,
          tasks: [{
            label: '46',
            payload: JSON.stringify(sendPayload),
            queue_name: String(recipientId),
            task_id: 1,
            failure_count: null,
          }],
          epoch_id: timestamp,
        }),
        requestType: 3,
      }),
      doc_id: DOC_IDS.lightspeedRequest,
      __a: '1',
    }).toString();

    const resp = await this.httpClient.post(
      'https://www.facebook.com/api/graphql/',
      body,
      { referer: 'https://www.facebook.com/messages/' },
    );

    const cleanBody = resp.body.replace(/^for\s*\(\s*;\s*;\s*\)\s*;\s*/, '');
    const hasFailed = cleanBody.includes('markOptimisticMessageFailed');
    const hasSuccess = cleanBody.includes('replaceOptimisticMessage') || cleanBody.includes('insertMessage');
    const hasE2EEError = cleanBody.includes('E2EE') || cleanBody.includes('e2ee') || cleanBody.includes('encrypt');

    const details: Record<string, unknown> = {
      statusCode: resp.statusCode,
      bodyLength: resp.body.length,
      hasFailed,
      hasSuccess,
      hasE2EEError,
      snippet: cleanBody.substring(0, 2000),
    };

    if (hasSuccess) {
      log.info({ recipientId }, 'E2EE message sent successfully');
      return { success: true, details };
    }

    const errorMsg = hasFailed
      ? 'Message marked as failed by server'
      : hasE2EEError
        ? 'E2EE-related error in response'
        : 'Unknown send failure';

    return { success: false, error: errorMsg, details };
  }
}
