import { randomUUID } from 'node:crypto'
import { providers, type Config, type Provider } from '../config.js'
import { collection, sessionOf, transaction, type Database, type MongoSource } from '../db.js'
import { unseal } from '../security.js'
import { backoff, withLease } from './lease.js'
import { priceUsage } from './pricing.js'
import {
  cleanArticle, estimateGenerationTokens, generateArticle, generateOutline, normalizeArticleFields, repairArticle, WorkerError,
  type Article, type GenerateInput, type GenerateResult, type GenerationMetadata,
  type OutlineResult, type RepairInput,
} from './provider.js'
import { researchTopic, type ResearchContext, type ResearchConfig } from './research.js'
import { evaluateSeo, type SeoReport } from './seo.js'
import { jobEvents } from '../job-events.js'

const maxAttempts = 3
let nextProvider = 0
type WritingStage = 'research' | 'outline' | 'draft' | 'seo_check' | 'seo_repair'
type RepairStatus = 'not_needed' | 'applied' | 'kept_draft' | 'skipped'
type Input = Omit<GenerateInput, 'signal' | 'onChunk'>
interface Job {
  _id: string
  site_id: string
  mode: 'scheduled' | 'preview' | 'rewrite'
  provider: Provider
  model: string
  keyword: string
  tone: string
  style: string
  length: number
  instructions: string | null
  use_research?: boolean
  key_mode: 'own' | 'service'
  encrypted_key: string | null
  source_article_id: string | null
  attempt_count: number
  lease_token: string | null
  result?: unknown[] | null
  seo_repair_status?: RepairStatus | null
}
interface Claim { job: Job; lease: string }
export interface WriterDependencies {
  research?: (keyword: string, config: ResearchConfig) => Promise<ResearchContext | null>
  outline?: (input: GenerateInput) => Promise<OutlineResult>
  generate?: (input: GenerateInput) => Promise<GenerateResult>
  repair?: (input: RepairInput) => Promise<GenerateResult>
}

function failureOf(error: unknown): WorkerError {
  return error instanceof WorkerError ? error
    : new WorkerError('AI_CONNECTION', 'Kết nối AI gián đoạn hoặc hết thời gian chờ.', true)
}

function keyFor(job: Job, config: Config, providerKey?: string | null): string {
  try {
    const key = job.key_mode === 'service'
      ? job.provider === 'openai-compatible'
        ? providerKey && unseal(providerKey, config.encryptionKey)
        : config.serviceKeys[job.provider]
      : job.encrypted_key && unseal(job.encrypted_key, config.encryptionKey)
    if (!key) throw new Error('Missing key')
    return key
  } catch {
    throw new WorkerError('AI_KEY_UNAVAILABLE', 'API key cho công việc này chưa được cấu hình hoặc không còn đọc được.', false)
  }
}

function owned(claim: Claim) {
  return { _id: claim.job._id, status: 'writing', lease_token: claim.lease, lease_expires_at: { $gt: new Date() } }
}

async function checkpoint(db: Database, claim: Claim, stage: WritingStage, values: Record<string, unknown> = {}) {
  const updatedAt = new Date()
  const updated = await collection(db, 'jobs').updateOne(owned(claim), {
    $set: { ...values, writing_stage: stage, updated_at: updatedAt },
  })
  if (!updated.matchedCount) throw new WorkerError('AI_LEASE_LOST', 'Công việc đã được tiến trình khác tiếp quản.', false)
  jobEvents.publish({ type: 'job.updated', job_id: claim.job._id, status: 'writing', writing_stage: stage, updated_at: updatedAt.toISOString() })
}

/** The job, quota and delivery must commit together; collection() does not attach sessions. */
async function transition(
  db: Database, job: Job, article: Article | null, error: WorkerError | null,
  report: SeoReport | null = null, repairStatus: RepairStatus | null = null, expired = false,
) {
  let updateEvent: Record<string, unknown> | undefined
  const committed = await transaction(db, async source => {
    const session = sessionOf(source)
    const now = new Date()
    const retryMs = !article && error?.retryable && job.attempt_count < maxAttempts
      ? backoff(job.attempt_count, 2_000, error.retryAfterMs) : null
    const status = article ? 'ready' : retryMs !== null ? 'queued' : 'failed'
    updateEvent = {
      type: 'job.updated', job_id: job._id, status: status === 'ready' ? 'completed' : status,
      writing_stage: null, updated_at: now.toISOString(),
      completed_at: retryMs === null ? now.toISOString() : null,
      error_code: article ? null : error?.code ?? null,
      error_message: article ? null : error?.message ?? null,
    }
    const updated = await collection(source, 'jobs').updateOne({
      _id: job._id, status: 'writing', lease_token: job.lease_token,
      lease_expires_at: expired ? { $lte: now } : { $gt: now },
    }, { $set: {
      status, result: article ? [article] : null, writing_stage: null,
      seo_report: article ? report : null, seo_repair_status: article ? repairStatus : null,
      error_code: article ? null : error?.code ?? null,
      error_message: article ? null : error?.message ?? null,
      ...(retryMs !== null ? { available_at: new Date(now.getTime() + retryMs) } : {}),
      completed_at: retryMs === null ? now : null,
      encrypted_key: retryMs === null ? null : job.encrypted_key,
      lease_token: null, lease_expires_at: null, updated_at: now,
    } }, { session })
    if (!updated.matchedCount) return false

    if (expired) await abandonAttempts(source, job._id, now)
    if (retryMs !== null) return true
    await collection(source, 'quota_reservations').updateOne({ job_id: job._id, status: 'reserved' }, {
      $set: { status: article ? 'used' : 'released' },
    }, { session })
    if (job.mode === 'scheduled') {
      const event = article ? 'article.ready' : 'article.failed'
      await collection(source, 'webhook_deliveries').updateOne({ job_id: job._id, event }, {
        $setOnInsert: {
          _id: randomUUID(), job_id: job._id, site_id: job.site_id, event, status: 'pending',
          next_attempt_at: now, attempt_count: 0, lease_token: null, lease_expires_at: null,
          delivered_at: null, error: null, http_status: null, created_at: now, updated_at: now,
        },
      }, { upsert: true, session })
    }
    return true
  })
  if (committed && updateEvent) jobEvents.publish(updateEvent as any)
  return committed
}

async function abandonAttempts(source: MongoSource, jobId: string, now: Date) {
  await collection(source, 'ai_attempts').updateMany({ job_id: jobId, status: 'running' }, { $set: {
    status: 'abandoned', finished_at: now, error_code: 'AI_LEASE_EXPIRED',
    error: 'Tiến trình viết bị gián đoạn. Usage và chi phí cần được đối soát nếu nhà cung cấp đã nhận yêu cầu.',
  } }, { session: sessionOf(source) })
}

function repairable(report: SeoReport) {
  return report.warnings.filter(item => item.repairable)
}

async function recoverExpired(db: Database, job: Job) {
  let article: Article | null = null
  try { article = cleanArticle(normalizeArticleFields(job.result?.[0])) } catch { /* No durable, valid draft yet. */ }
  if (article) {
    const site = await collection(db, 'sites').findOne({ _id: job.site_id })
    const report = evaluateSeo(article, { keyword: job.keyword, siteUrl: site?.domain })
    await transition(db, job, article, null, report,
      job.seo_repair_status ?? (repairable(report).length ? 'kept_draft' : 'not_needed'), true)
  } else {
    await transition(db, job, null,
      new WorkerError('AI_LEASE_EXPIRED', 'Tiến trình viết bị gián đoạn trước khi lưu kết quả.', true),
      null, null, true)
  }
}

async function claimWriter(db: Database, config: Config, provider: Provider): Promise<Claim | boolean> {
  const now = new Date()
  const expired = await collection<Job>(db, 'jobs').findOne({ provider, status: 'writing', lease_expires_at: { $lte: now } })
  if (expired) { await recoverExpired(db, expired); return true }
  const lease = randomUUID()
  const job = await collection<Job>(db, 'jobs').findOneAndUpdate({
    provider, status: { $in: ['scheduled', 'queued'] }, available_at: { $lte: now },
  }, { $set: {
    status: 'writing', writing_stage: 'research', lease_token: lease,
    lease_expires_at: new Date(now.getTime() + config.leaseMs), started_at: now,
    error_code: null, error_message: null, result: null, outline: null,
    seo_report: null, seo_repair_status: null, updated_at: now,
  }, $inc: { attempt_count: 1 } }, { sort: { available_at: 1, _id: 1 }, returnDocument: 'after' })
  if (job) jobEvents.publish({ type: 'job.updated', job_id: job._id, status: 'writing', writing_stage: 'research', updated_at: now.toISOString(), started_at: now.toISOString() })
  return job ? { job, lease } : false
}

/** Bounds an optional step by inactivity while the outer lease timeout remains the overall guard. */
async function bounded<T>(
  signal: AbortSignal,
  duration: number | null,
  timeout: WorkerError,
  call: (signal: AbortSignal, touch?: () => void) => Promise<T>,
): Promise<T> {
  const deadline = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const combined = AbortSignal.any([signal, deadline.signal])
  const touch = () => {
    if (combined.aborted || duration === null) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => deadline.abort(timeout), duration)
    timer.unref?.()
  }
  touch()
  let onAbort: () => void = () => {}
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(deadline.signal.aborted ? timeout
        : new WorkerError('AI_CONNECTION', 'Kết nối AI gián đoạn hoặc hết thời gian chờ.', true))
      if (combined.aborted) onAbort()
      else combined.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([cancelled, Promise.resolve().then(() => {
      combined.throwIfAborted()
      return call(combined, touch)
    })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    combined.removeEventListener('abort', onAbort)
  }
}

async function recordAttempt(
  db: Database, claim: Claim, attemptId: string, pricing: unknown,
  metadata: GenerationMetadata | undefined, error: WorkerError | null,
) {
  const usage = metadata?.usage ?? null
  const cost = priceUsage(claim.job.provider, pricing, usage)
  // An old worker may finish after recovery. It may settle usage, but cannot replace the job.
  await collection(db, 'ai_attempts').updateOne({ _id: attemptId, status: { $in: ['running', 'abandoned'] } }, { $set: {
    finished_at: new Date(), provider_response_id: metadata?.responseId ?? null,
    usage, cost_usd: cost.amount, cost_source: cost.source, status: error ? 'failed' : 'succeeded',
    error_code: error?.code ?? null, error: error?.message ?? null,
  } })
}

async function callAi<T extends GenerationMetadata>(
  db: Database, config: Config, claim: Claim, stage: 'outline' | 'draft' | 'seo_repair',
  tokens: number, duration: number | null, call: (signal: AbortSignal, onChunk?: () => void) => Promise<T>,
): Promise<T> {
  if (tokens > config.providerLimits[claim.job.provider].tokensPerMinute) {
    throw new WorkerError('AI_TOKEN_CAPACITY', 'Yêu cầu vượt giới hạn token/phút đã cấu hình cho nhà cung cấp.', false)
  }
  await checkpoint(db, claim, stage)
  const requestedAt = new Date()
  const pricing = await collection(db, 'model_prices').findOne({
    provider: claim.job.provider, model: claim.job.model, effective_at: { $lte: requestedAt },
  }, { sort: { effective_at: -1 } })
  const attemptId = randomUUID()
  await collection(db, 'ai_attempts').insertOne({
    _id: attemptId, job_id: claim.job._id, provider: claim.job.provider, model: claim.job.model,
    stage, lease_token: claim.lease, requested_at: requestedAt, finished_at: null,
    provider_response_id: null, pricing_id: pricing?._id ?? null, pricing_snapshot: pricing?.rates ?? null,
    usage: null, cost_usd: null, cost_source: null, status: 'running', error_code: null, error: null,
  })
  let result: T
  try {
    const timeout = new WorkerError(stage === 'outline' ? 'AI_OUTLINE_TIMEOUT' : 'AI_SEO_REPAIR_TIMEOUT',
      stage === 'outline' ? 'Bước lập dàn ý đã hết thời gian chờ.' : 'Bước chỉnh SEO đã hết thời gian chờ; giữ bản viết ban đầu.', false)
    const idleTimeout = config.aiTimeoutMs
    const operationTimeout = duration === null ? idleTimeout : Math.max(idleTimeout, duration)
    result = await withLease(db, config, 'jobs', claim.job._id, claim.lease, operationTimeout,
      (signal, touch) => bounded(signal, duration, timeout,
        (boundedSignal, boundedTouch) => call(boundedSignal, () => {
          touch?.()
          boundedTouch?.()
        })))
  } catch (failure) {
    const error = failureOf(failure)
    await recordAttempt(db, claim, attemptId, pricing?.rates, error.metadata, error)
    throw error
  }
  await recordAttempt(db, claim, attemptId, pricing?.rates, result, null)
  return result
}

function improvesSeo(before: SeoReport, after: SeoReport): boolean {
  const passed = new Set(after.findings.filter(item => item.applicable && item.passed).map(item => item.key))
  return before.findings.every(item => !item.applicable || !item.passed || passed.has(item.key))
    && repairable(before).some(item => passed.has(item.key))
}

async function writeClaim(db: Database, config: Config, claim: Claim, deps: WriterDependencies) {
  const { job } = claim
  let draft: Article | null = null
  let report: SeoReport | null = null
  let repairStatus: RepairStatus | null = null
  let siteDomain: string | null = null
  try {
    const settings = await collection(db, 'ai_providers').findOne({ _id: job.provider })
    const key = keyFor(job, config, settings?.encrypted_api_key)
    const site = await collection(db, 'sites').findOne({ _id: job.site_id })
    siteDomain = site?.domain ?? null
    let source: Article | null = null
    if (job.source_article_id) {
      const original = await collection<Job>(db, 'jobs').findOne({ _id: job.source_article_id, site_id: job.site_id, status: 'ready' })
      try { source = cleanArticle(normalizeArticleFields(original?.result?.[0])) }
      catch { throw new WorkerError('AI_SOURCE_INVALID', 'Không đọc được bài viết nguồn.', false) }
    }
    const researchConfig = config.research ?? { enabled: false, timeoutMs: 8_000, maxResults: 5, provider: 'duckduckgo' }
    let research: ResearchContext | null = null
    // Jobs created before this option existed have no field and retain the
    // previous behavior of researching whenever the provider is enabled.
    if (job.use_research !== false && researchConfig.enabled) {
      try {
        research = await withLease(db, config, 'jobs', job._id, claim.lease, researchConfig.timeoutMs + 1_000,
          signal => bounded(signal, researchConfig.timeoutMs,
            new WorkerError('AI_RESEARCH_TIMEOUT', 'Nghiên cứu đã hết thời gian chờ.', false),
            () => (deps.research ?? researchTopic)(job.keyword, researchConfig)))
      } catch { /* Search outages do not fail scheduled articles. */ }
    }
    const input: Input = {
      provider: job.provider, key, model: job.model, keyword: job.keyword, tone: job.tone, style: job.style,
      length: job.length, instructions: job.instructions, source, research, siteDomain,
      baseUrl: settings?.base_url ?? undefined,
    }
    if (estimateGenerationTokens(input, 'article') > config.providerLimits[job.provider].tokensPerMinute) {
      throw new WorkerError('AI_TOKEN_CAPACITY', 'Yêu cầu vượt giới hạn token/phút đã cấu hình cho nhà cung cấp.', false)
    }

    try {
      const planned = await callAi(db, config, claim, 'outline', estimateGenerationTokens(input, 'outline'),
        config.outlineTimeoutMs ?? Math.min(300_000, config.aiTimeoutMs),
        (signal, onChunk) => (deps.outline ?? generateOutline)({ ...input, signal, onChunk }))
      input.outline = planned.outline
      if (estimateGenerationTokens(input, 'article') > config.providerLimits[job.provider].tokensPerMinute) input.outline = null
      await checkpoint(db, claim, 'draft', { outline: input.outline })
    } catch (failure) {
      if (failureOf(failure).code === 'AI_LEASE_LOST') throw failure
      input.outline = null
    }

    const written = await callAi(db, config, claim, 'draft', estimateGenerationTokens(input, 'article'), null,
      async (signal, onChunk) => {
        const result = await (deps.generate ?? generateArticle)({ ...input, signal, onChunk })
        signal.throwIfAborted()
        draft = cleanArticle(result.article)
        report = evaluateSeo(draft, { keyword: job.keyword, siteUrl: siteDomain })
        // Save before usage settlement as well: an accounting outage must not lose the article.
        await checkpoint(db, claim, 'seo_check', { result: [draft], seo_report: report })
        return { ...result, article: draft }
      })
    draft = written.article
    report = evaluateSeo(draft, { keyword: job.keyword, siteUrl: siteDomain })
    const issues = repairable(report)
    repairStatus = 'not_needed'
    if (issues.length) {
      const repairInput: Omit<RepairInput, 'signal' | 'onChunk'> = { ...input, draft, issues }
      repairStatus = 'kept_draft'
      try {
        const revised = await callAi(db, config, claim, 'seo_repair', estimateGenerationTokens(repairInput, 'repair'),
          config.seoRepairTimeoutMs ?? Math.min(90_000, config.aiTimeoutMs),
          async (signal, onChunk) => {
            const result = await (deps.repair ?? repairArticle)({ ...repairInput, signal, onChunk })
            return { ...result, article: cleanArticle(result.article) }
          })
        const revisedReport = evaluateSeo(revised.article, { keyword: job.keyword, siteUrl: siteDomain })
        if (improvesSeo(report, revisedReport)) {
          draft = revised.article
          report = revisedReport
          repairStatus = 'applied'
        }
      } catch (failure) {
        const error = failureOf(failure)
        if (error.code === 'AI_LEASE_LOST') throw error
        if (error.code === 'AI_TOKEN_CAPACITY') repairStatus = 'skipped'
      }
    }
    await transition(db, job, draft, null, report, repairStatus)
  } catch (failure) {
    const error = failureOf(failure)
    if (error.code === 'AI_LEASE_LOST') return
    // A valid draft remains deliverable even if optional processing is interrupted.
    await transition(db, job, draft, draft ? null : error,
      draft ? report ?? evaluateSeo(draft, { keyword: job.keyword, siteUrl: siteDomain }) : null,
      draft ? repairStatus ?? 'kept_draft' : null)
  }
}

export async function runWriterOnce(db: Database, config: Config, deps: WriterDependencies = {}): Promise<boolean> {
  const first = nextProvider
  nextProvider = (nextProvider + 1) % providers.length
  for (let offset = 0; offset < providers.length; offset += 1) {
    const claim = await claimWriter(db, config, providers[(first + offset) % providers.length])
    if (claim === false) continue
    if (claim !== true) await writeClaim(db, config, claim, deps)
    return true
  }
  return false
}
