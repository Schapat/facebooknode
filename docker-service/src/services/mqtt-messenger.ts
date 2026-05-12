import WebSocket from 'ws';
import * as zlib from 'zlib';
import { FacebookHttpClient } from './facebook-http-client';
import { createChildLogger } from '../utils/logger';

const log = createChildLogger({ service: 'MQTTMessenger' });

// Facebook Web app ID
const FB_APP_ID = 219994525426954;

// MQTT packet types
const PACKET_CONNACK = 2;
const PACKET_PUBLISH = 3;
const PACKET_PUBACK = 4;
const PACKET_SUBSCRIBE = 8;
const PACKET_PINGREQ = 12;
const PACKET_PINGRESP = 13;

// Thrift Compact Protocol types
const THRIFT_BOOL_TRUE = 1;
const THRIFT_BOOL_FALSE = 2;
const THRIFT_I32 = 5;
const THRIFT_I64 = 6;
const THRIFT_BINARY = 8; // string and binary
const THRIFT_LIST = 9;

// Topic IDs for subscribe_topics field in CONNECT
const TOPIC_T_MS = 1; // /t_ms (messages)

interface MQTTMessage {
  topic: string;
  payload: Buffer;
  qos: number;
  messageId?: number;
}

// ── Thrift Compact Protocol Writer ─────────────────────────────────
class ThriftWriter {
  private buf: number[] = [];
  private lastFieldId = 0;

  writeField(fieldId: number, type: number): void {
    const delta = fieldId - this.lastFieldId;
    if (delta > 0 && delta <= 15) {
      this.buf.push((delta << 4) | type);
    } else {
      this.buf.push(type);
      this.writeI16Raw(fieldId);
    }
    this.lastFieldId = fieldId;
  }

  writeI32(value: number): void {
    this.writeVarint(this.zigzag32(value));
  }

  writeI64(value: bigint): void {
    this.writeVarintBig(this.zigzag64(value));
  }

  writeString(value: string): void {
    const bytes = Buffer.from(value, 'utf-8');
    this.writeVarint(bytes.length);
    for (const b of bytes) this.buf.push(b);
  }

  writeListHeader(elemType: number, count: number): void {
    if (count < 15) {
      this.buf.push((count << 4) | elemType);
    } else {
      this.buf.push(0xf0 | elemType);
      this.writeVarint(count);
    }
  }

  writeStop(): void {
    this.buf.push(0);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buf);
  }

  private writeVarint(value: number): void {
    value = value >>> 0; // unsigned
    while (value > 0x7f) {
      this.buf.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    this.buf.push(value & 0x7f);
  }

  private writeVarintBig(value: bigint): void {
    if (value < 0n) value = value + (1n << 64n); // handle negative
    while (value > 0x7fn) {
      this.buf.push(Number(value & 0x7fn) | 0x80);
      value >>= 7n;
    }
    this.buf.push(Number(value & 0x7fn));
  }

  private writeI16Raw(value: number): void {
    // Zigzag + varint for i16
    this.writeVarint((value << 1) ^ (value >> 15));
  }

  private zigzag32(n: number): number {
    return (n << 1) ^ (n >> 31);
  }

  private zigzag64(n: bigint): bigint {
    return (n << 1n) ^ (n >> 63n);
  }
}

export class MQTTMessenger {
  private ws: WebSocket | null = null;
  private httpClient: FacebookHttpClient;
  private userId: string = '';
  private deviceId: string;
  private sessionId: number;
  private messageIdCounter = 1;
  private pendingResponses: Map<string, {
    resolve: (data: unknown) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private receivedMessages: MQTTMessage[] = [];

  constructor(httpClient: FacebookHttpClient) {
    this.httpClient = httpClient;
    this.sessionId = Math.floor(Math.random() * 2 ** 32);
    this.deviceId = this.generateDeviceId();
  }

  private generateDeviceId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Connect to Facebook's MQTT WebSocket and authenticate
   */
  async connect(): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    // Extract tokens first (we need fb_dtsg and user ID)
    this.userId = this.httpClient.getUserId() || '';
    if (!this.userId) {
      return { error: 'No user ID (c_user cookie missing)' };
    }
    result.userId = this.userId;

    // Get cookies for WebSocket auth
    const cookies = (this.httpClient as any).buildCookieString();
    result.hasCookies = !!cookies;

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        result.error = 'Connection timeout (10s)';
        this.disconnect();
        resolve(result);
      }, 10000);

      try {
        this.ws = new WebSocket('wss://edge-chat.facebook.com/chat', ['chat'], {
          headers: {
            Origin: 'https://www.facebook.com',
            Cookie: cookies,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          },
        });

        this.ws.binaryType = 'arraybuffer';

        this.ws.on('open', () => {
          result.wsConnected = true;
          log.info('WebSocket connected to edge-chat.facebook.com');

          // Send MQTT CONNECT packet
          const connectPacket = this.buildConnectPacket();
          result.connectPacketSize = connectPacket.length;
          this.ws!.send(connectPacket);
          log.info({ size: connectPacket.length }, 'Sent CONNECT packet');
        });

        this.ws.on('message', (data: ArrayBuffer) => {
          const buf = Buffer.from(data);
          const packetType = (buf[0] >> 4) & 0x0f;
          const rawHex = buf.subarray(0, Math.min(50, buf.length)).toString('hex');

          log.info({ packetType, size: buf.length, hex: rawHex }, 'Received MQTT packet');

          // Store all raw responses for diagnostics
          if (!result.rawPackets) result.rawPackets = [];
          (result.rawPackets as string[]).push(`type=${packetType} size=${buf.length} hex=${rawHex}`);

          if (packetType === PACKET_CONNACK) {
            // CONNACK: byte 0 = type, byte 1 = remaining length, byte 2 = flags, byte 3 = return code
            const returnCode = buf.length >= 4 ? buf[3] : -1;
            result.connack = true;
            result.connackCode = returnCode;
            result.connackSuccess = returnCode === 0;
            result.connackCodeMeaning = this.getConnackMeaning(returnCode);

            if (returnCode === 0) {
              log.info('MQTT CONNACK success - authenticated!');
            } else {
              log.warn({ returnCode }, 'MQTT CONNACK failed');
            }

            clearTimeout(timeout);
            resolve(result);
          } else if (packetType === PACKET_PUBLISH) {
            const msg = this.parsePublishPacket(buf);
            if (msg) {
              this.receivedMessages.push(msg);
              log.info({ topic: msg.topic, size: msg.payload.length }, 'Received PUBLISH');
              // Auto-ACK QoS 1
              if (msg.qos >= 1 && msg.messageId != null) {
                this.sendPubAck(msg.messageId);
              }
            }
          } else if (packetType === PACKET_PINGREQ) {
            // Respond to PING
            this.ws!.send(Buffer.from([PACKET_PINGRESP << 4, 0]));
          } else if (packetType === 9) { // SUBACK
            log.info('Received SUBACK');
          }
        });

        this.ws.on('error', (err) => {
          result.error = err.message;
          log.error({ error: err.message }, 'WebSocket error');
          clearTimeout(timeout);
          resolve(result);
        });

        this.ws.on('close', (code, reason) => {
          result.wsClosed = true;
          result.closeCode = code;
          result.closeReason = reason.toString();
          log.info({ code, reason: reason.toString() }, 'WebSocket closed');
          if (!result.connack) {
            clearTimeout(timeout);
            resolve(result);
          }
        });
      } catch (err: any) {
        result.error = err.message;
        clearTimeout(timeout);
        resolve(result);
      }
    });
  }

  /**
   * After successful CONNACK, subscribe to topics and try sending
   */
  async testSend(recipientId: string, message: string): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { error: 'Not connected' };
    }

    // Subscribe to response topics
    const subscribeTopics = ['/ls_resp', '/t_ms', '/send_msg_resp', '/t_p'];
    await this.subscribe(subscribeTopics);
    result.subscribed = subscribeTopics;

    // Wait a bit for subscription confirmations
    await this.delay(500);

    // Try sending via /ls_req (LightSpeed over MQTT)
    const lsResult = await this.sendLSRequest(recipientId, message);
    result.lsSend = lsResult;

    // Collect any received messages
    await this.delay(3000);
    result.receivedCount = this.receivedMessages.length;
    result.receivedTopics = this.receivedMessages.map((m) => ({
      topic: m.topic,
      size: m.payload.length,
      preview: m.payload.subarray(0, 200).toString('utf-8').replace(/[^\x20-\x7E]/g, '.'),
    }));

    return result;
  }

  /**
   * Send an LS request via MQTT (equivalent to GraphQL lightspeed_web_request)
   */
  private async sendLSRequest(recipientId: string, message: string): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    // Extract fb_dtsg for the request
    let fbDtsg = '';
    try {
      const page = await this.httpClient.request('https://www.facebook.com/', {
        referer: 'https://www.facebook.com/',
      });
      const dtsgMatch = page.body.match(/"DTSGInitialData".*?"token":"([^"]+)"/);
      fbDtsg = dtsgMatch?.[1] || '';
    } catch {
      // fallback
    }
    result.hasFbDtsg = !!fbDtsg;

    // Build the LS task payload (same as we used for task 46)
    const otid = BigInt(Date.now()) * 4294967296n + BigInt(Math.floor(Math.random() * 4294967296));
    const taskPayload = JSON.stringify({
      thread_id: recipientId,
      otid: otid.toString(),
      source: 0,
      send_type: 1,
      text: message,
      initiating_source: 0,
    });

    // The LS request format for MQTT
    const epoch = Date.now();
    const lsPayload = JSON.stringify({
      app_id: FB_APP_ID.toString(),
      payload: JSON.stringify({
        tasks: [
          {
            label: '46',
            payload: taskPayload,
            queue_name: recipientId,
            task_id: 1,
            failure_count: null,
          },
        ],
        epoch_id: epoch,
        version_id: '35876584371954923',
      }),
      request_id: 1,
      type: 3,
    });

    // Publish to /ls_req
    this.publishMessage('/ls_req', Buffer.from(lsPayload));
    result.published = true;
    result.topic = '/ls_req';
    result.payloadSize = lsPayload.length;

    return result;
  }

  /**
   * Subscribe to MQTT topics
   */
  private subscribe(topics: string[]): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.resolve();

    const msgId = this.messageIdCounter++;

    // Build SUBSCRIBE packet
    const parts: Buffer[] = [];

    // Message ID
    const msgIdBuf = Buffer.alloc(2);
    msgIdBuf.writeUInt16BE(msgId, 0);
    parts.push(msgIdBuf);

    // Topics
    for (const topic of topics) {
      const topicBuf = Buffer.from(topic, 'utf-8');
      const topicLen = Buffer.alloc(2);
      topicLen.writeUInt16BE(topicBuf.length, 0);
      parts.push(topicLen, topicBuf);
      parts.push(Buffer.from([1])); // QoS 1
    }

    const payload = Buffer.concat(parts);
    const header = Buffer.from([
      (PACKET_SUBSCRIBE << 4) | 0x02, // SUBSCRIBE with QoS 1 flag
      ...this.encodeVarLength(payload.length),
    ]);

    this.ws.send(Buffer.concat([header, payload]));
    log.info({ topics, msgId }, 'Sent SUBSCRIBE');
    return Promise.resolve();
  }

  /**
   * Publish a message to an MQTT topic
   */
  private publishMessage(topic: string, payload: Buffer, qos = 1): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const topicBuf = Buffer.from(topic, 'utf-8');
    const topicLen = Buffer.alloc(2);
    topicLen.writeUInt16BE(topicBuf.length, 0);

    const parts: Buffer[] = [topicLen, topicBuf];

    if (qos >= 1) {
      const msgId = Buffer.alloc(2);
      msgId.writeUInt16BE(this.messageIdCounter++, 0);
      parts.push(msgId);
    }

    parts.push(payload);

    const body = Buffer.concat(parts);
    const header = Buffer.from([
      (PACKET_PUBLISH << 4) | (qos === 1 ? 0x02 : 0x00),
      ...this.encodeVarLength(body.length),
    ]);

    this.ws.send(Buffer.concat([header, body]));
    log.info({ topic, payloadSize: payload.length, qos }, 'Published message');
  }

  private sendPubAck(messageId: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const buf = Buffer.alloc(4);
    buf[0] = PACKET_PUBACK << 4;
    buf[1] = 2;
    buf.writeUInt16BE(messageId, 2);
    this.ws.send(buf);
  }

  /**
   * Build MQTToT CONNECT packet with Thrift compact binary username
   */
  private buildConnectPacket(): Buffer {
    // Build Thrift compact binary for username/payload
    const thrift = new ThriftWriter();

    // Field 1: user_id (string)
    thrift.writeField(1, THRIFT_BINARY);
    thrift.writeString(this.userId);

    // Field 2: user_agent (string) - browser UA
    thrift.writeField(2, THRIFT_BINARY);
    thrift.writeString('[FBAN/Orca-Threads/FBIOS;FBAV/248.1.0.24.111;FBDM/{density=3.0,width=1170,height=2532};FBLC/en_US;FBBK/1;]');

    // Field 3: capabilities (i64) - chat capabilities bitmask
    thrift.writeField(3, THRIFT_I64);
    thrift.writeI64(BigInt('8831014'));

    // Field 4: capabilities2 (i64) - extended capabilities
    thrift.writeField(4, THRIFT_I64);
    thrift.writeI64(BigInt('27'));

    // Field 5: require_ack (bool) = true
    thrift.writeField(5, THRIFT_BOOL_TRUE);

    // Field 6: no_auto_foreground (bool) = true
    thrift.writeField(6, THRIFT_BOOL_TRUE);

    // Field 7: device_id (string)
    thrift.writeField(7, THRIFT_BINARY);
    thrift.writeString(this.deviceId);

    // Field 8: is_initially_foreground (bool) = false
    thrift.writeField(8, THRIFT_BOOL_FALSE);

    // Field 9: network_type (i32) = 1 (wifi)
    thrift.writeField(9, THRIFT_I32);
    thrift.writeI32(1);

    // Field 10: network_subtype (i32) = 0
    thrift.writeField(10, THRIFT_I32);
    thrift.writeI32(0);

    // Field 11: mqtt_sid (i64)
    thrift.writeField(11, THRIFT_I64);
    thrift.writeI64(BigInt(this.sessionId));

    // Field 12: subscribe_topics (list<i32>)
    const topics = [TOPIC_T_MS]; // subscribe to messages
    thrift.writeField(12, THRIFT_LIST);
    thrift.writeListHeader(THRIFT_I32, topics.length);
    for (const t of topics) thrift.writeI32(t);

    // Field 13: client_stack (string)
    thrift.writeField(13, THRIFT_BINARY);
    thrift.writeString('3');

    // Field 14: no_diff (i64)
    thrift.writeField(14, THRIFT_I64);
    thrift.writeI64(1n);

    // Field 20: app_id (i64)
    thrift.writeField(20, THRIFT_I64);
    thrift.writeI64(BigInt(FB_APP_ID));

    thrift.writeStop();

    // Compress the Thrift binary with zlib
    const thriftBuf = thrift.toBuffer();
    const compressed = zlib.deflateRawSync(thriftBuf);

    // Protocol name: "MQTToT"
    const protocolName = Buffer.from('MQTToT');
    const protocolNameLen = Buffer.alloc(2);
    protocolNameLen.writeUInt16BE(protocolName.length, 0);

    // Protocol level: 3
    const protocolLevel = Buffer.from([3]);

    // Connect flags: username(0x80) + password(0x40) + clean_session(0x02) = 0xC2
    const connectFlags = Buffer.from([0xc2]);

    // Keep alive: 60 seconds
    const keepAlive = Buffer.alloc(2);
    keepAlive.writeUInt16BE(60, 0);

    // Variable header
    const variableHeader = Buffer.concat([protocolNameLen, protocolName, protocolLevel, connectFlags, keepAlive]);

    // Client ID (device UUID)
    const clientIdStr = Buffer.from(this.deviceId, 'utf-8');
    const clientIdLen = Buffer.alloc(2);
    clientIdLen.writeUInt16BE(clientIdStr.length, 0);
    const clientId = Buffer.concat([clientIdLen, clientIdStr]);

    // Username = compressed Thrift binary
    const usernameLen = Buffer.alloc(2);
    usernameLen.writeUInt16BE(compressed.length, 0);

    // Password (empty)
    const password = Buffer.alloc(2);
    password.writeUInt16BE(0, 0);

    // Payload
    const payload = Buffer.concat([clientId, usernameLen, compressed, password]);

    // Remaining length
    const remainingLength = variableHeader.length + payload.length;
    const remainingLengthBytes = Buffer.from(this.encodeVarLength(remainingLength));

    return Buffer.concat([Buffer.from([0x10]), remainingLengthBytes, variableHeader, payload]);
  }

  private parsePublishPacket(buf: Buffer): MQTTMessage | null {
    try {
      const qos = (buf[0] >> 1) & 0x03;
      let offset = 1;

      // Decode remaining length
      let multiplier = 1;
      let remainingLength = 0;
      let encodedByte;
      do {
        encodedByte = buf[offset++];
        remainingLength += (encodedByte & 127) * multiplier;
        multiplier *= 128;
      } while ((encodedByte & 128) !== 0);

      // Topic length
      const topicLen = buf.readUInt16BE(offset);
      offset += 2;

      // Topic
      const topic = buf.subarray(offset, offset + topicLen).toString('utf-8');
      offset += topicLen;

      // Message ID (QoS >= 1)
      let messageId: number | undefined;
      if (qos >= 1) {
        messageId = buf.readUInt16BE(offset);
        offset += 2;
      }

      // Payload
      const payload = buf.subarray(offset);

      return { topic, payload, qos, messageId };
    } catch {
      return null;
    }
  }

  private encodeVarLength(length: number): number[] {
    const bytes: number[] = [];
    do {
      let encodedByte = length % 128;
      length = Math.floor(length / 128);
      if (length > 0) {
        encodedByte |= 128;
      }
      bytes.push(encodedByte);
    } while (length > 0);
    return bytes;
  }

  private getConnackMeaning(code: number): string {
    switch (code) {
      case 0:
        return 'Connection accepted';
      case 1:
        return 'Unacceptable protocol version';
      case 2:
        return 'Identifier rejected';
      case 3:
        return 'Server unavailable';
      case 4:
        return 'Bad username or password';
      case 5:
        return 'Not authorized';
      default:
        return `Unknown (${code})`;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  disconnect(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}
