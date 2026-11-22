import { z } from 'zod'
import { providers, type Config } from './config.js'
import { collection, type Database } from './db.js'

const integer = (min: number, max: number) => z.number().int().min(min).max(max)
const providerLimit = z.object({
  concurrency: integer(1, 100),
  requests_per_minute: integer(1, 100_000),
  tokens_per_minute: integer(1_000, 100_000_000),
}).strict()

export const runtimeSettingsSchema = z.object({
  usd_to_vnd: integer(1, 1_000_000_000),
  writer_concurrency: integer(1, 100),
  delivery_concurrency: integer(1, 100),
  worker_poll_ms: integer(100, 60_000),
  ai_timeout_ms: integer(1_000, 900_000),
  outline_timeout_ms: integer(1_000, 900_000),
  seo_repair_timeout_ms: integer(1_000, 900_000),
  writer_max_attempts: integer(1, 10),
  delivery_max_attempts: integer(1, 10),
  delivery_retry_minutes: integer(1, 1_440).default(5),
  webhook_timeout_ms: integer(1_000, 60_000),
  research_enabled: z.boolean(),
  research_timeout_ms: integer(1_000, 60_000),
  research_max_results: integer(1, 8),
  job_retention_days: integer(0, 3_650),
  delivery_retention_days: integer(0, 3_650),
  cleanup_interval_minutes: integer(5, 1_440),
  provider_limits: z.object({
    openai: providerLimit,
    anthropic: providerLimit,
    xai: providerLimit,
    'openai-compatible': providerLimit,
  }).strict(),
}).strict()

export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>
export interface SettingsDocument {
  _id: string
  revision: number
  values: RuntimeSettings
  updated_at: Date
  retention_updated_at?: Date
}
export const settingsId = 'crm'
// Leave one second for the worker supervisor within the UI's five-second window.
export const settingsRefreshMs = 4_000

/** Only operational values are persisted or returned to the browser. */
export function defaultSettings(config: Config): RuntimeSettings {
  return {
    usd_to_vnd: config.usdToVnd,
    writer_concurrency: config.workerConcurrency,
    delivery_concurrency: config.webhookConcurrency,
    worker_poll_ms: config.workerPollMs,
    ai_timeout_ms: config.aiTimeoutMs,
    outline_timeout_ms: config.outlineTimeoutMs,
    seo_repair_timeout_ms: config.seoRepairTimeoutMs,
    writer_max_attempts: config.writerMaxAttempts ?? 3,
    delivery_max_attempts: config.webhookMaxAttempts ?? 5,
    delivery_retry_minutes: config.webhookRetryMinutes ?? 5,
    webhook_timeout_ms: config.webhookTimeoutMs ?? 15_000,
    research_enabled: config.research.enabled,
    research_timeout_ms: config.research.timeoutMs,
    research_max_results: config.research.maxResults,
    job_retention_days: 0,
    delivery_retention_days: 0,
    cleanup_interval_minutes: 60,
    provider_limits: Object.fromEntries(providers.map(provider => [provider, {
      concurrency: config.providerLimits[provider].concurrency,
      requests_per_minute: config.providerLimits[provider].requestsPerMinute,
      tokens_per_minute: config.providerLimits[provider].tokensPerMinute,
    }])) as RuntimeSettings['provider_limits'],
  }
}

export async function readSettings(db: Database, config: Config) {
  const row = await collection<SettingsDocument>(db, 'runtime_settings').findOne({ _id: settingsId })
  const defaults = defaultSettings(config)
  return {
    values: row ? runtimeSettingsSchema.parse(row.values) : defaults,
    defaults,
    revision: row?.revision ?? 0,
    updated_at: row?.updated_at?.toISOString() ?? null,
    retention_updated_at: row?.retention_updated_at?.toISOString() ?? null,
  }
}

type Cache = { expiresAt: number, values: RuntimeSettings | null, pending?: Promise<RuntimeSettings | null> }
const cache = new WeakMap<Database, Cache>()

export function invalidateSettings(db: Database) { cache.delete(db) }

async function cachedSettings(db: Database): Promise<RuntimeSettings | null> {
  const previous = cache.get(db)
  if (previous?.pending) return previous.pending
  if (previous && previous.expiresAt > Date.now()) return previous.values
  const entry: Cache = { expiresAt: 0, values: null }
  entry.pending = (async () => {
    const row = await collection<SettingsDocument>(db, 'runtime_settings').findOne({ _id: settingsId })
    const values = row ? runtimeSettingsSchema.parse(row.values) : null
    entry.values = values
    entry.expiresAt = Date.now() + settingsRefreshMs
    return values
  })()
  cache.set(db, entry)
  try { return await entry.pending } finally { delete entry.pending }
}

/** Each claim receives its own snapshot; existing work keeps its original settings. */
export async function effectiveConfig(db: Database, base: Config): Promise<Config> {
  const values = await cachedSettings(db)
  if (!values) return { ...base, research: { ...base.research }, providerLimits: structuredClone(base.providerLimits) }
  return {
    ...base,
    usdToVnd: values.usd_to_vnd,
    workerConcurrency: values.writer_concurrency,
    webhookConcurrency: values.delivery_concurrency,
    workerPollMs: values.worker_poll_ms,
    aiTimeoutMs: values.ai_timeout_ms,
    outlineTimeoutMs: values.outline_timeout_ms,
    seoRepairTimeoutMs: values.seo_repair_timeout_ms,
    writerMaxAttempts: values.writer_max_attempts,
    webhookMaxAttempts: values.delivery_max_attempts,
    webhookRetryMinutes: values.delivery_retry_minutes,
    webhookTimeoutMs: values.webhook_timeout_ms,
    // Lease duration is internal. Keep it safely above all configurable timeouts.
    leaseMs: Math.max(base.leaseMs, Math.max(values.ai_timeout_ms, values.outline_timeout_ms,
      values.seo_repair_timeout_ms, values.webhook_timeout_ms) + values.research_timeout_ms + 30_000),
    research: {
      ...base.research,
      enabled: values.research_enabled,
      timeoutMs: values.research_timeout_ms,
      maxResults: values.research_max_results,
    },
    providerLimits: Object.fromEntries(providers.map(provider => [provider, {
      concurrency: values.provider_limits[provider].concurrency,
      requestsPerMinute: values.provider_limits[provider].requests_per_minute,
      tokensPerMinute: values.provider_limits[provider].tokens_per_minute,
    }])) as Config['providerLimits'],
  }
}
