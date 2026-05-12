// ============================================
// Facebook Automation - Shared Types
// ============================================

// ---- Cookie Types ----

export interface FacebookCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface PlaywrightStorageState {
  cookies: FacebookCookie[];
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export interface SessionData {
  sessionId: string;
  accountName: string;
  cookies: FacebookCookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  userAgent: string;
  proxy?: ProxyConfig;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt: string;
  isValid: boolean;
  expiresAt?: string;
}

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

// ---- Operation Inputs ----

export interface GroupPostScraperInput {
  groups: string[];
  lastScrapeTimestamp?: string;
  maxPosts?: number;
  scrollTimeout?: number;
  groupDelay?: number;
}

export interface GroupMemberScraperInput {
  groups: string[];
  maxMembers?: number;
  scrollTimeout?: number;
}

// ---- Operation Outputs ----

export interface GroupPost {
  groupName: string;
  postId: string;
  authorName: string;
  authorProfileUrl: string;
  title: string;
  content: string;
  createdAt: string;
  likes: number;
  comments: number;
  postUrl: string;
}

export interface GroupMember {
  groupName: string;
  profileName: string;
  profileUrl: string;
  bio: string;
  location: string;
  mutualFriends: number;
  joinedDate: string;
}

export interface MessageResult {
  success: boolean;
  sentAt: string;
  username: string;
  error?: string;
}

// ---- API Types ----

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
  requiresRelogin?: boolean;
  jobId?: string;
  timestamp: string;
}

export interface JobStatus {
  jobId: string;
  status: 'waiting' | 'active' | 'completed' | 'failed' | 'delayed';
  progress: number;
  result?: unknown;
  error?: string;
  createdAt: string;
  processedAt?: string;
  completedAt?: string;
  attemptsMade: number;
  attemptsTotal: number;
}

export interface SessionImportRequest {
  sessionName: string;
  cookies: FacebookCookie[] | Record<string, string>[] | string;
  format: CookieFormat;
  userAgent?: string;
  proxy?: ProxyConfig;
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

export interface SessionStatusResponse {
  sessionName: string;
  isValid: boolean;
  lastValidated: string;
  expiresAt?: string;
  accountName?: string;
}

export interface SessionExportResponse {
  sessionName: string;
  cookies: FacebookCookie[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  exportedAt: string;
}

export type CookieFormat =
  | 'chrome-export'
  | 'editthiscookie'
  | 'playwright-state'
  | 'puppeteer-array'
  | 'json';

// ---- Queue Types ----

export type OperationType = 'scrape-posts' | 'scrape-members';

export interface QueueJob {
  operationType: OperationType;
  sessionName: string;
  input: GroupPostScraperInput | GroupMemberScraperInput;
  priority?: number;
  delay?: number;
  retries?: number;
}

// ---- Error Codes ----

export enum ErrorCode {
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  SESSION_INVALID = 'SESSION_INVALID',
  COOKIE_PARSE_ERROR = 'COOKIE_PARSE_ERROR',
  BROWSER_ERROR = 'BROWSER_ERROR',
  NAVIGATION_ERROR = 'NAVIGATION_ERROR',
  ELEMENT_NOT_FOUND = 'ELEMENT_NOT_FOUND',
  SCRAPE_ERROR = 'SCRAPE_ERROR',
  MESSAGE_SEND_ERROR = 'MESSAGE_SEND_ERROR',
  USER_NOT_FOUND = 'USER_NOT_FOUND',
  RATE_LIMITED = 'RATE_LIMITED',
  QUEUE_ERROR = 'QUEUE_ERROR',
  AUTH_ERROR = 'AUTH_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  PROXY_ERROR = 'PROXY_ERROR',
}

// ---- Webhook Events ----

export interface WebhookEvent {
  event: string;
  jobId: string;
  timestamp: string;
  data: unknown;
}

// ---- Config ----

export interface ServiceConfig {
  port: number;
  host: string;
  apiKeys: string[];
  jwtSecret: string;
  redisUrl: string;
  encryptionKey: string;
  browserHeadless: boolean;
  maxConcurrency: number;
  defaultTimeout: number;
  screenshotOnError: boolean;
  htmlDumpOnError: boolean;
  logLevel: string;
  webhookUrl?: string;
  dataDir: string;
}
