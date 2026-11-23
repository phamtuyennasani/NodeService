import type { ResearchConfig } from './worker/research.js';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export const providers = ['openai', 'anthropic', 'xai', 'openai-compatible'] as const;
export type BuiltinProvider = typeof providers[number];
export type Provider = BuiltinProvider | `openai-compatible-${string}`;

export function isCompatibleProvider(provider: string): boolean {
  return provider === 'openai-compatible' || provider.startsWith('openai-compatible-');
}

/** A connection has its own identity while sharing an API protocol and defaults. */
export function providerKind(provider: Provider): BuiltinProvider {
  return isCompatibleProvider(provider) ? 'openai-compatible' : provider as BuiltinProvider;
}

export interface ProviderLimit {
  concurrency: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export interface CrmMailConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  user?: string;
  password?: string;
  allowInsecureLocal: boolean;
}

/** Mail is optional at startup; OTP delivery fails closed until configured. */
export function loadMailConfig(production: boolean, env: NodeJS.ProcessEnv = process.env): CrmMailConfig | undefined {
  const host = env.SMTP_HOST?.trim();
  if (!host) return undefined;
  if (host.length > 253 || /[\s/@?#\\]/.test(host) || (!isIP(host) && !/^[a-z0-9.-]+$/i.test(host))) {
    throw new Error('SMTP_HOST must be a hostname or IP address without a URL or credentials');
  }
  const port = Number(env.SMTP_PORT || 465);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT must be between 1 and 65535');
  if (env.SMTP_SECURE && !['true', 'false'].includes(env.SMTP_SECURE)) throw new Error('SMTP_SECURE must be true or false');
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465;
  const local = host === '127.0.0.1' || host === '::1' || host.toLowerCase() === 'localhost';
  if (env.SMTP_ALLOW_INSECURE_LOCAL === 'true' && (production || !local)) {
    throw new Error('SMTP_ALLOW_INSECURE_LOCAL is restricted to loopback development mail servers');
  }
  const from = env.SMTP_FROM?.trim().toLowerCase() || '';
  if (from.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(from)) {
    throw new Error('SMTP_FROM must be a single email address without a display name');
  }
  const user = env.SMTP_USER;
  const password = env.SMTP_PASSWORD;
  if (Boolean(user) !== Boolean(password) || (user && /[\r\n]/.test(user))) throw new Error('Set SMTP_USER and SMTP_PASSWORD together');
  return { host, port, secure, from, user, password, allowInsecureLocal: !production && local && env.SMTP_ALLOW_INSECURE_LOCAL === 'true' };
}

function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function bounded(name: string, fallback: number, maximum: number) {
  const value = positive(name, fallback);
  if (value > maximum) throw new Error(`${name} must be between 1 and ${maximum}`);
  return value;
}

/** Forwarded headers are trusted only from explicitly named proxy networks. */
function trustedProxies() {
  const input = process.env.TRUSTED_PROXIES?.trim();
  if (!input) return [] as string[];
  const values = input.split(',').map(value => value.trim());
  if (values.length > 64) throw new Error('TRUSTED_PROXIES must contain at most 64 IP addresses or CIDRs');
  for (const value of values) {
    const [address, prefix, extra] = value.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined || (prefix !== undefined &&
        (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error('TRUSTED_PROXIES must contain explicit IP addresses or non-universal CIDRs, never true, wildcards or hop counts');
    }
    if (prefix !== undefined && !ipaddr.isValidCIDR(value)) throw new Error('Invalid TRUSTED_PROXIES CIDR');
  }
  return values;
}

export function loadConfig() {
  const production = process.env.NODE_ENV === 'production';
  let appUrl: URL;
  try { appUrl = new URL(process.env.APP_ORIGIN || 'http://localhost:3210'); }
  catch { throw new Error('APP_ORIGIN must be a valid HTTP(S) URL without credentials'); }
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password) {
    throw new Error('APP_ORIGIN must be a valid HTTP(S) URL without credentials');
  }
  const origin = appUrl.origin;
  if (production && !origin.startsWith('https://')) {
    throw new Error('APP_ORIGIN must use HTTPS in production');
  }
  const mongodbUri = process.env.MONGODB_URI;
  if (!mongodbUri || !/^mongodb(?:\+srv)?:\/\//i.test(mongodbUri)) {
    throw new Error('Set MONGODB_URI to a MongoDB connection string before starting the service');
  }
  const mongodbDatabase = process.env.MONGODB_DATABASE || 'node_service';
  const usdToVnd = positive('USD_TO_VND', 25_000);
  const encodedKey = process.env.ENCRYPTION_KEY || '';
  const encryptionKey = Buffer.from(encodedKey, 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error('Set ENCRYPTION_KEY to a base64-encoded 32-byte key');
  }
  const aiTimeoutMs = positive('AI_TIMEOUT_MS', 120_000);
  const outlineTimeoutMs = positive('AI_OUTLINE_TIMEOUT_MS', aiTimeoutMs);
  const seoRepairTimeoutMs = positive('AI_SEO_REPAIR_TIMEOUT_MS', 90_000);
  const leaseMs = positive('LEASE_MS', 150_000);
  const researchTimeoutMs = positive('RESEARCH_TIMEOUT_MS', 8_000);
  const webhookRetryMinutes = positive('WEBHOOK_RETRY_MINUTES', 5);
  if (webhookRetryMinutes > 1_440) throw new Error('WEBHOOK_RETRY_MINUTES must be between 1 and 1440');
  if (leaseMs <= aiTimeoutMs + researchTimeoutMs) throw new Error('LEASE_MS must exceed AI_TIMEOUT_MS plus RESEARCH_TIMEOUT_MS');
  const researchProvider: ResearchConfig['provider'] = process.env.RESEARCH_PROVIDER === 'tavily' ? 'tavily' : 'duckduckgo';
  const researchEndpoint = process.env.RESEARCH_ENDPOINT || (researchProvider === 'tavily' ? 'https://api.tavily.com/search' : undefined);
  if (researchEndpoint) {
    const parsed = new URL(researchEndpoint);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('RESEARCH_ENDPOINT must be a public HTTP(S) URL without credentials or query parameters');
    }
  }

  function limit(prefix: string): ProviderLimit {
    return {
      concurrency: positive(`${prefix}_CONCURRENCY`, 10),
      requestsPerMinute: positive(`${prefix}_REQUESTS_PER_MINUTE`, 60),
      tokensPerMinute: positive(`${prefix}_TOKENS_PER_MINUTE`, 120_000),
    };
  }

  return {
    databaseUrl: mongodbUri, mongodbUri, mongodbDatabase, usdToVnd, encryptionKey, origin, production,
    mail: loadMailConfig(production),
    secureCookies: origin.startsWith('https://'),
    allowLocalWebhooks: !production && process.env.ALLOW_LOCAL_WEBHOOKS === 'true',
    host: process.env.HOST || '127.0.0.1',
    port: positive('PORT', 3210),
    security: {
      trustedProxies: trustedProxies(),
      requestsPerMinute: bounded('RATE_LIMIT_PER_IP', 600, 60_000),
      apiRequestsPerMinute: bounded('RATE_LIMIT_API_PER_IP', 240, 60_000),
      writeRequestsPerMinute: bounded('RATE_LIMIT_WRITE_PER_IP', 60, 60_000),
      totalRequestsPerMinute: bounded('RATE_LIMIT_GLOBAL', 12_000, 1_000_000),
      maxTrackedIps: bounded('RATE_LIMIT_MAX_IPS', 10_000, 100_000),
      maxConcurrentRequests: bounded('HTTP_MAX_CONCURRENT_REQUESTS', 200, 10_000),
      maxConcurrentPerIp: bounded('HTTP_MAX_CONCURRENT_PER_IP', 20, 1_000),
      maxConnections: bounded('HTTP_MAX_CONNECTIONS', 1_000, 100_000),
      requestTimeoutMs: bounded('HTTP_REQUEST_TIMEOUT_MS', 15_000, 120_000),
      connectionTimeoutMs: bounded('HTTP_CONNECTION_TIMEOUT_MS', 30_000, 120_000),
      headersTimeoutMs: bounded('HTTP_HEADERS_TIMEOUT_MS', 10_000, 60_000),
    },
    maxPendingJobsPerCustomer: bounded('MAX_PENDING_JOBS_PER_CUSTOMER', 100, 10_000),
    poolSize: positive('DB_POOL_SIZE', 12),
    workerConcurrency: positive('WORKER_CONCURRENCY', 5),
    webhookConcurrency: positive('WEBHOOK_CONCURRENCY', 5),
    writerMaxAttempts: 3,
    webhookMaxAttempts: 5,
    webhookTimeoutMs: 15_000,
    webhookRetryMinutes,
    workerPollMs: positive('WORKER_POLL_MS', 500),
    aiTimeoutMs,
    outlineTimeoutMs,
    seoRepairTimeoutMs,
    leaseMs,
    research: {
      enabled: process.env.RESEARCH_ENABLED !== 'false',
      timeoutMs: researchTimeoutMs,
      maxResults: Math.min(8, positive('RESEARCH_MAX_RESULTS', 5)),
      provider: researchProvider,
      endpoint: researchEndpoint,
      apiKey: process.env.TAVILY_API_KEY || undefined,
    },
    providerLimits: {
      openai: limit('OPENAI'),
      anthropic: limit('ANTHROPIC'),
      xai: limit('XAI'),
      'openai-compatible': limit('OPENAI_COMPATIBLE'),
    },
    serviceKeys: {
      openai: process.env.OPENAI_API_KEY || undefined,
      anthropic: process.env.ANTHROPIC_API_KEY || undefined,
      xai: process.env.XAI_API_KEY || undefined,
      'openai-compatible': undefined,
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
// @ts-nocheck
