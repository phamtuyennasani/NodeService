import type { ResearchConfig } from './worker/research.js';

export const providers = ['openai', 'anthropic', 'xai', 'openai-compatible'] as const;
export type Provider = typeof providers[number];

export interface ProviderLimit {
  concurrency: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
}

function positive(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function loadConfig() {
  const production = process.env.NODE_ENV === 'production';
  const origin = new URL(process.env.APP_ORIGIN || 'http://localhost:3210').origin;
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
  const outlineTimeoutMs = positive('AI_OUTLINE_TIMEOUT_MS', 300_000);
  const seoRepairTimeoutMs = positive('AI_SEO_REPAIR_TIMEOUT_MS', 120_000);
  const leaseMs = positive('LEASE_MS', 150_000);
  const researchTimeoutMs = positive('RESEARCH_TIMEOUT_MS', 8_000);
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
    secureCookies: origin.startsWith('https://'),
    allowLocalWebhooks: !production && process.env.ALLOW_LOCAL_WEBHOOKS === 'true',
    host: process.env.HOST || '127.0.0.1',
    port: positive('PORT', 3210),
    poolSize: positive('DB_POOL_SIZE', 12),
    workerConcurrency: positive('WORKER_CONCURRENCY', 5),
    webhookConcurrency: positive('WEBHOOK_CONCURRENCY', 5),
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
