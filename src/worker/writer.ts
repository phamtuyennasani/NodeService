import { createHmac, randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { providers, type Config, type Provider } from '../config.js'
import { transaction, type Database } from '../db.js'
import { unseal } from '../security.js'
import { backoff, withLease } from './lease.js'
import { priceUsage } from './pricing.js'
import {
  cleanArticle, generateArticle, outputTokenLimit, WorkerError,
  type GenerateInput, type GenerateResult,
} from './provider.js'

const maxAttempts = 3
let nextProvider = 0

interface Job {
  id: string
  site_id: string
  mode: 'scheduled' | 'preview' | 'rewrite'
  provider: Provider
  model: string
  keyword: string
  tone: string
  style: string
  length: number
  instructions: string | null
  key_mode: 'own' | 'service'
  encrypted_key: string | null
  source_article_id: string | null
  attempt_count: number
  lease_token: string | null
}

interface Claim {
  job: Job
  lease: string
  attemptId: string
  input: Omit<GenerateInput, 'signal'>
  pricing: unknown
  scope: string
  window: Date
  tokens: number
}

export interface WriterDependencies {
  generate?: (input: GenerateInput) => Promise<GenerateResult>
}

interface RateWindow {
  window_started_at: Date
  blocked_until: Date | null
  requests: number
  tokens: string
  now: Date
}

async function transition(
  client: PoolClient, job: Job, article: GenerateResult['article'] | null,
  error: WorkerError | null, retryMs: number | null = null,
) {
  const status = article ? 'ready' : retryMs !== null ? 'queued' : 'failed'
  await client.query(`
    UPDATE jobs SET status=$2,result=$3::jsonb,error_code=$4,error_message=$5,
      available_at=CASE WHEN $6::int IS NULL THEN available_at
        ELSE clock_timestamp()+($6::int*interval '1 ms') END,
      completed_at=CASE WHEN $2 IN ('ready', 'failed') THEN clock_timestamp() ELSE NULL END,
      encrypted_key=CASE WHEN $2 IN ('ready', 'failed') THEN NULL ELSE encrypted_key END,
      lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=$1
  `, [job.id, status, article && JSON.stringify([article]), error?.code ?? null, error?.message ?? null, retryMs])
  if (retryMs !== null) return
  await client.query(`
    UPDATE quota_reservations SET status=$2 WHERE job_id=$1 AND status='reserved'
  `, [job.id, article ? 'used' : 'released'])
  if (job.mode === 'scheduled') {
    await client.query(`
      INSERT INTO webhook_deliveries(job_id,site_id,event) VALUES($1,$2,$3)
      ON CONFLICT (job_id,event) DO NOTHING
    `, [job.id, job.site_id, article ? 'article.ready' : 'article.failed'])
  }
}

async function recoverExpiredWriter(client: PoolClient, provider: Provider) {
  const { rows: [expired] } = await client.query<Job>(`
    SELECT j.* FROM jobs j
    WHERE j.provider=$1 AND j.status='writing' AND j.lease_expires_at<=now()
    ORDER BY j.lease_expires_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
  `, [provider])
  if (!expired) return false
  const error = new WorkerError('AI_LEASE_EXPIRED', 'Tiến trình viết bị gián đoạn trước khi lưu kết quả.', true)
  await client.query(`
    UPDATE ai_attempts SET finished_at=clock_timestamp(),status='abandoned',
      cost_source='pending',error_code=$2,error=$3
    WHERE job_id=$1 AND finished_at IS NULL
  `, [expired.id, error.code, error.message])
  await transition(client, expired, null, error,
    expired.attempt_count < maxAttempts ? backoff(expired.attempt_count, 2_000) : null)
  return true
}

async function lockRateWindow(client: PoolClient, scope: string) {
  await client.query('INSERT INTO provider_limits(provider) VALUES($1) ON CONFLICT DO NOTHING', [scope])
  const { rows: [window] } = await client.query<RateWindow>(`
    SELECT *,clock_timestamp() AS now FROM provider_limits WHERE provider=$1 FOR UPDATE
  `, [scope])
  return window
}

function keyFor(job: Job, config: Config) {
  try {
    const key = job.key_mode === 'service' ? config.serviceKeys[job.provider]
      : job.encrypted_key && unseal(job.encrypted_key, config.encryptionKey)
    if (!key) throw new Error('Missing key')
    return key
  } catch {
    throw new WorkerError('AI_KEY_UNAVAILABLE', 'API key cho công việc này chưa được cấu hình hoặc không còn đọc được.', false)
  }
}

async function claimWriter(db: Database, config: Config, provider: Provider): Promise<Claim | boolean> {
  return transaction(db, async client => {
    const providerWindow = await lockRateWindow(client, provider)
    if (await recoverExpiredWriter(client, provider)) return true
    const limits = config.providerLimits[provider]
    const { rows: [{ running }] } = await client.query<{ running: number }>(`
      SELECT count(*)::int AS running FROM ai_attempts WHERE provider=$1 AND finished_at IS NULL
    `, [provider])
    if (running >= limits.concurrency) return false

    const { rows: [job] } = await client.query<Job>(`
      SELECT j.* FROM jobs j
      LEFT JOIN LATERAL (
        SELECT started_at FROM jobs
        WHERE customer_id=j.customer_id AND started_at IS NOT NULL
        ORDER BY started_at DESC LIMIT 1
      ) last_dispatch ON true
      WHERE j.provider=$1 AND j.status IN ('scheduled','queued')
        AND j.available_at<=now()
      ORDER BY last_dispatch.started_at NULLS FIRST,j.available_at,j.id
      LIMIT 1 FOR UPDATE OF j SKIP LOCKED
    `, [provider])
    if (!job) return false

    let key: string
    try {
      key = keyFor(job, config)
    } catch (error) {
      if (!(error instanceof WorkerError)) throw error
      await transition(client, job, null, error)
      return true
    }

    let source: GenerateInput['source'] = null
    if (job.source_article_id) {
      const { rows: [original] } = await client.query<{ result: unknown[] }>(`
        SELECT result FROM jobs WHERE id=$1 AND site_id=$2 AND status='ready'
      `, [job.source_article_id, job.site_id])
      try {
        source = cleanArticle(original?.result[0])
      } catch {
        await transition(client, job, null, new WorkerError('AI_SOURCE_INVALID', 'Không đọc được bài viết nguồn.', false))
        return true
      }
    }
    const input = {
      provider, key, model: job.model, keyword: job.keyword, tone: job.tone,
      style: job.style, length: job.length, instructions: job.instructions, source,
    }
    // Reserve completion capacity and estimate the prompt size before dispatch.
    const promptBytes = Buffer.byteLength(JSON.stringify({
      keyword: input.keyword, tone: input.tone, style: input.style,
      instructions: input.instructions, source: input.source,
    }))
    const tokens = outputTokenLimit(job.length) + 1_024 + Math.ceil(promptBytes / 2)
    if (tokens > limits.tokensPerMinute) {
      await transition(client, job, null, new WorkerError('AI_TOKEN_CAPACITY', 'Yêu cầu vượt giới hạn token/phút đã cấu hình cho nhà cung cấp.', false))
      return true
    }

    const scope = job.key_mode === 'service' || key === config.serviceKeys[provider] ? provider
      : provider + ':' + createHmac('sha256', config.encryptionKey).update(key).digest('hex')
    const window = scope === provider ? providerWindow : await lockRateWindow(client, scope)
    const windowEnd = window.window_started_at.getTime() + 60_000
    const reset = windowEnd <= window.now.getTime()
    const requests = reset ? 0 : window.requests
    const reservedTokens = reset ? 0 : Number(window.tokens)
    const availableAt = Math.max(
      window.blocked_until?.getTime() ?? 0,
      requests >= limits.requestsPerMinute || reservedTokens + tokens > limits.tokensPerMinute ? windowEnd : 0,
    )
    if (availableAt > window.now.getTime()) {
      await client.query('UPDATE jobs SET available_at=$2,updated_at=clock_timestamp() WHERE id=$1',
        [job.id, new Date(availableAt)])
      return true
    }
    const windowStartedAt = reset ? window.now : window.window_started_at
    await client.query(`
      UPDATE provider_limits SET window_started_at=$2,requests=$3,tokens=$4 WHERE provider=$1
    `, [scope, windowStartedAt, requests + 1, reservedTokens + tokens])

    const lease = randomUUID()
    await client.query(`
      UPDATE jobs SET status='writing',attempt_count=attempt_count+1,started_at=clock_timestamp(),
        lease_token=$2,lease_expires_at=clock_timestamp()+($3::int*interval '1 ms'),
        error_code=NULL,error_message=NULL,updated_at=clock_timestamp()
      WHERE id=$1
    `, [job.id, lease, config.leaseMs])
    const { rows: [attempt] } = await client.query<{ id: string; pricing_snapshot: unknown }>(`
      WITH dispatched AS (SELECT clock_timestamp() AS requested_at)
      INSERT INTO ai_attempts(job_id,provider,model,requested_at,pricing_id,pricing_snapshot,status)
      SELECT $1,$2,$3,d.requested_at,p.id,p.rates,'running' FROM dispatched d
      LEFT JOIN LATERAL (
        SELECT id,rates FROM model_prices WHERE provider=$2 AND model=$3 AND effective_at<=d.requested_at
        ORDER BY effective_at DESC LIMIT 1
      ) p ON true
      RETURNING id,pricing_snapshot
    `, [job.id, provider, job.model])
    job.attempt_count += 1
    return { job, lease, attemptId: attempt.id, input, pricing: attempt.pricing_snapshot,
      scope, window: windowStartedAt, tokens }
  })
}

async function settleWriter(db: Database, claim: Claim, result: GenerateResult | null, error: WorkerError | null) {
  const { job, lease } = claim
  const metadata = result ?? error?.metadata
  const usage = metadata?.usage ?? null
  const cost = priceUsage(job.provider, claim.pricing, usage)
  const delay = backoff(job.attempt_count, 2_000, error?.retryAfterMs)
  await transaction(db, async client => {
    await client.query('SELECT 1 FROM provider_limits WHERE provider=$1 FOR UPDATE', [job.provider])
    const { rowCount: owned } = await client.query(`
      SELECT 1 FROM jobs WHERE id=$1 AND status='writing' AND lease_token=$2
        AND lease_expires_at>clock_timestamp() FOR UPDATE
    `, [job.id, lease])
    if (owned || metadata) {
      await client.query(`
        UPDATE ai_attempts SET finished_at=clock_timestamp(),provider_response_id=$2,
          usage=$3::jsonb,cost_usd=$4,cost_source=$5,status=$6,error_code=$7,error=$8
        WHERE id=$1 AND status IN ('running','abandoned')
      `, [claim.attemptId, metadata?.responseId ?? null, usage && JSON.stringify(usage), cost.amount, cost.source,
        result ? 'succeeded' : 'failed', error?.code ?? null, error?.message ?? null])
    }
    if (!owned) return

    if (usage?.input != null && usage.output != null) {
      const actual = usage.input + usage.output + (usage.cachedInput ?? 0)
        + (usage.cacheWrite5m ?? 0) + (usage.cacheWrite1h ?? 0)
      await client.query(`
        UPDATE provider_limits SET tokens=greatest(0,tokens+$3::bigint)
        WHERE provider=$1 AND window_started_at=$2
      `, [claim.scope, claim.window, actual - claim.tokens])
    }
    if (error?.code === 'AI_RATE_LIMIT' || (error?.retryAfterMs ?? 0) > 0) {
      await client.query(`
        UPDATE provider_limits SET blocked_until=greatest(blocked_until,clock_timestamp()+($2::int*interval '1 ms'))
        WHERE provider=$1
      `, [claim.scope, delay])
    }
    const retryMs = error?.retryable && job.attempt_count < maxAttempts ? delay : null
    await transition(client, job, result?.article ?? null, error, retryMs)
  })
}

export async function runWriterOnce(db: Database, config: Config, deps: WriterDependencies = {}): Promise<boolean> {
  const firstProvider = nextProvider
  nextProvider = (nextProvider + 1) % providers.length
  for (let offset = 0; offset < providers.length; offset += 1) {
    const provider = providers[(firstProvider + offset) % providers.length]
    const claim = await claimWriter(db, config, provider)
    if (claim === false) continue
    if (claim === true) return true

    let result: GenerateResult | null = null
    let error: WorkerError | null = null
    const generate = deps.generate ?? generateArticle
    try {
      result = await withLease(db, config, 'jobs', claim.job.id, claim.lease, config.aiTimeoutMs,
        signal => generate({ ...claim.input, signal }))
    } catch (failure) {
      error = failure instanceof WorkerError ? failure
        : new WorkerError('AI_CONNECTION', 'Kết nối AI gián đoạn hoặc hết thời gian chờ.', true)
    }
    await settleWriter(db, claim, result, error)
    return true
  }
  return false
}
