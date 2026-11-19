export const providers = ['openai', 'anthropic', 'xai'] as const;
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
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set DATABASE_URL before starting the service');
  const encodedKey = process.env.ENCRYPTION_KEY || '';
  const encryptionKey = Buffer.from(encodedKey, 'base64');
  if (encryptionKey.length !== 32) {
    throw new Error('Set ENCRYPTION_KEY to a base64-encoded 32-byte key');
  }
  const aiTimeoutMs = positive('AI_TIMEOUT_MS', 120_000);
  const leaseMs = positive('LEASE_MS', 150_000);
  if (leaseMs <= aiTimeoutMs) throw new Error('LEASE_MS must exceed AI_TIMEOUT_MS');

  function limit(prefix: string): ProviderLimit {
    return {
      concurrency: positive(`${prefix}_CONCURRENCY`, 10),
      requestsPerMinute: positive(`${prefix}_REQUESTS_PER_MINUTE`, 60),
      tokensPerMinute: positive(`${prefix}_TOKENS_PER_MINUTE`, 120_000),
    };
  }

  return {
    databaseUrl, encryptionKey, origin, production,
    secureCookies: origin.startsWith('https://'),
    allowLocalWebhooks: !production && process.env.ALLOW_LOCAL_WEBHOOKS === 'true',
    host: process.env.HOST || '127.0.0.1',
    port: positive('PORT', 3210),
    poolSize: positive('DB_POOL_SIZE', 12),
    workerConcurrency: positive('WORKER_CONCURRENCY', 5),
    webhookConcurrency: positive('WEBHOOK_CONCURRENCY', 5),
    workerPollMs: positive('WORKER_POLL_MS', 500),
    aiTimeoutMs,
    leaseMs,
    providerLimits: { openai: limit('OPENAI'), anthropic: limit('ANTHROPIC'), xai: limit('XAI') },
    serviceKeys: {
      openai: process.env.OPENAI_API_KEY || undefined,
      anthropic: process.env.ANTHROPIC_API_KEY || undefined,
      xai: process.env.XAI_API_KEY || undefined,
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
