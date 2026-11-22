import { randomUUID } from 'node:crypto'
import { isCompatibleProvider, providerKind, providers, type Config, type Provider } from '../config.js'
import { collection, sessionOf, transaction, type Database, type MongoSource } from '../db.js'
import { unseal } from '../security.js'
import { backoff, withLease } from './lease.js'
import { priceUsage } from './pricing.js'
import { monitorProviderSlot, providerHasCapacity, ProviderCapacityPending, reserveProviderRequest } from './provider-limits.js'
import {
  cleanArticle, estimateGenerationTokens, generateArticle, generateOutline, normalizeArticleFields, repairArticle, WorkerError,
  outlineTokenLimit, outputTokenLimit,
  type Article, type GenerateInput, type GenerateResult, type GenerationMetadata,
  type OutlineResult, type RepairInput,
} from './provider.js'
import { researchTopic, type ResearchContext, type ResearchConfig } from './research.js'
import { evaluateSeo, type SeoReport } from './seo.js'
import { jobEvents } from '../job-events.js'
import { foldSearchText, refreshInternalLinkCandidates, selectInternalLinkCandidates, type InternalLinkCandidate } from '../site-content.js'
import { enforceInternalLinks, extractArticleLinks } from './internal-links.js'
import { syncSiteContentCatalog, type CatalogSyncOptions } from '../site-content-pull.js'

let nextProvider = 0
type WritingStage = 'research' | 'outline' | 'draft' | 'seo_check' | 'seo_repair'
type RepairStatus = 'not_needed' | 'applied' | 'kept_draft' | 'skipped'
interface InternalLinkReport {
  status: 'checked' | 'no_candidates' | 'unavailable'
  candidates: number
  used: { url: string; anchor: string }[]
  removed: number
  checked_at: string
}
type Input = Omit<GenerateInput, 'signal' | 'onChunk'>
interface Job {
  _id: string
  site_id: string
  customer_id: string
  mode: 'scheduled' | 'preview' | 'rewrite'
  provider: Provider
  model: string
  keyword: string
  tone: string
  style: string
  length: number
  instructions: string | null
  use_research?: boolean
  exclude_content_ids?: string[]
  key_mode: 'own' | 'service'
  encrypted_key: string | null
  source_article_id: string | null
  retry_of_job_id?: string | null
  attempt_count: number
  capacity_deferred?: boolean
  outline?: GenerateInput['outline']
  lease_token: string | null
  result?: unknown[] | null
  seo_repair_status?: RepairStatus | null
  internal_link_report?: InternalLinkReport | null
}
interface Claim { job: Job; lease: string }
export interface WriterDependencies {
  research?: (keyword: string, config: ResearchConfig) => Promise<ResearchContext | null>
  outline?: (input: GenerateInput) => Promise<OutlineResult>
  generate?: (input: GenerateInput) => Promise<GenerateResult>
  repair?: (input: RepairInput) => Promise<GenerateResult>
  syncCatalog?: (db: Database, siteId: string, options?: CatalogSyncOptions) => ReturnType<typeof syncSiteContentCatalog>
}

function failureOf(error: unknown): WorkerError {
  return error instanceof WorkerError ? error
    : new WorkerError('AI_CONNECTION', 'Kết nối AI gián đoạn hoặc hết thời gian chờ.', true)
}

function keyFor(job: Job, config: Config, providerKey?: string | null): string {
  try {
    const key = job.key_mode === 'service'
      ? providerKey ? unseal(providerKey, config.encryptionKey)
        : job.provider === providerKind(job.provider) ? config.serviceKeys[providerKind(job.provider)] : undefined
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
  db: Database, config: Config, job: Job, article: Article | null, error: WorkerError | null,
  report: SeoReport | null = null, repairStatus: RepairStatus | null = null, expired = false,
  linkReport: InternalLinkReport | null = null,
) {
  let updateEvent: Record<string, unknown> | undefined
  const committed = await transaction(db, async source => {
    const session = sessionOf(source)
    const now = new Date()
    const retryMs = !article && error?.retryable && job.attempt_count < (config.writerMaxAttempts ?? 3)
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
      status, result: article ? [article] : null, writing_stage: null, capacity_deferred: false,
      seo_report: article ? report : null, seo_repair_status: article ? repairStatus : null,
      ...(linkReport ? { internal_link_report: linkReport } : {}),
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
    error: 'Tiến trình viết bị gián đoạn. Chưa nhận được kết quả đầy đủ từ nhà cung cấp AI.',
  } }, { session: sessionOf(source) })
}

function repairable(report: SeoReport) {
  return report.warnings.filter(item => item.repairable)
}

async function recoverExpired(db: Database, config: Config, job: Job, deps: WriterDependencies = {}) {
  let article: Article | null = null
  try { article = cleanArticle(normalizeArticleFields(job.result?.[0])) } catch { /* No durable, valid draft yet. */ }
  if (article) {
    const site = await collection(db, 'sites').findOne({ _id: job.site_id })
    let linkReport: InternalLinkReport | null = null
    if (site?.content_catalog_url || site?.site_content_synced_at || job.internal_link_report) {
      let candidates: InternalLinkCandidate[] = []
      let preservedLinks: string[] = []
      let unavailable = false
      if (job.source_article_id) {
        try {
          const source = await collection(db, 'jobs').findOne({ _id: job.source_article_id, site_id: job.site_id, customer_id: job.customer_id, status: 'ready' })
          preservedLinks = extractArticleLinks(cleanArticle(normalizeArticleFields(source?.result?.[0])).Content)
        } catch { /* Missing source is not an allowlist. */ }
      }
      try {
        if (site?.content_catalog_url) {
          const synced = await (deps.syncCatalog ?? syncSiteContentCatalog)(db, job.site_id, {
            expectedCustomerId: job.customer_id, expectedDomain: site.domain, expectedUrl: site.content_catalog_url,
          })
          if (!['synced', 'cached'].includes(synced.status)) throw new Error('Catalog unavailable')
        }
        const urls = job.internal_link_report?.used.slice(0, 3).map(row => row.url) ?? []
        if (urls.length && site?.customer_id === job.customer_id) {
          const rows = await collection(db, 'site_content').find({
            site_id: job.site_id, customer_id: job.customer_id, url: { $in: urls },
          }, { projection: { external_id: 1, url: 1, title: 1, summary: 1, categories: 1 }, maxTimeMS: 5_000 }).limit(3).toArray()
          candidates = rows.filter(row => !job.exclude_content_ids?.includes(row.external_id))
            .map(row => ({ id: row.external_id, url: row.url, title: row.title, summary: row.summary, categories: row.categories }))
        }
      } catch { unavailable = true }
      const checked = enforceInternalLinks(article.Content, { candidates, siteDomain: site?.domain, preserveUrls: preservedLinks })
      article = { ...article, Content: checked.content }
      linkReport = {
        status: unavailable ? 'unavailable' : candidates.length ? 'checked' : 'no_candidates',
        candidates: job.internal_link_report?.candidates ?? 0, used: checked.used,
        removed: (job.internal_link_report?.removed ?? 0) + checked.removed, checked_at: new Date().toISOString(),
      }
    }
    const report = evaluateSeo(article, { keyword: job.keyword, siteUrl: site?.domain })
    await transition(db, config, job, article, null, report,
      job.seo_repair_status ?? (repairable(report).length ? 'kept_draft' : 'not_needed'), true, linkReport)
  } else {
    await transition(db, config, job, null,
      new WorkerError('AI_LEASE_EXPIRED', 'Tiến trình viết bị gián đoạn trước khi lưu kết quả.', true),
      null, null, true)
  }
}

async function claimWriter(db: Database, config: Config, provider: Provider, deps: WriterDependencies = {}): Promise<Claim | boolean> {
  const now = new Date()
  const expired = await collection<Job>(db, 'jobs').findOne({ provider, status: 'writing', lease_expires_at: { $lte: now } })
  if (expired) { await recoverExpired(db, config, expired, deps); return true }
  if (!await providerHasCapacity(db, config, provider)) return false
  const lease = randomUUID()
  const job = await collection<Job>(db, 'jobs').findOneAndUpdate({
    provider, status: { $in: ['scheduled', 'queued'] }, available_at: { $lte: now },
  }, { $set: {
    status: 'writing', writing_stage: 'research', lease_token: lease,
    lease_expires_at: new Date(now.getTime() + config.leaseMs), started_at: now,
    error_code: null, error_message: null, result: null,
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
  const cost = claim.job.key_mode === 'own' ? { amount: null, source: null } : priceUsage(providerKind(claim.job.provider), pricing, usage)
  // An old worker may finish after recovery. It may settle usage, but cannot replace the job.
  await collection(db, 'ai_attempts').updateOne({ _id: attemptId, status: { $in: ['running', 'abandoned'] } }, { $set: {
    finished_at: new Date(), provider_response_id: metadata?.responseId ?? null,
    usage, cost_usd: cost.amount, cost_source: cost.source, status: error ? 'failed' : 'succeeded',
    error_code: error?.code ?? null, error: error?.message ?? null,
    generation: metadata?.generation ?? null,
  } })
}

async function callAi<T extends GenerationMetadata>(
  db: Database, config: Config, claim: Claim, stage: 'outline' | 'draft' | 'seo_repair',
  tokens: number, duration: number | null,
  call: (signal: AbortSignal, onChunk: () => void, beforeCompatibilityRetry: (signal: AbortSignal) => Promise<void>) => Promise<T>,
): Promise<T> {
  const { provider, model } = claim.job
  if (tokens > config.providerLimits[providerKind(provider)].tokensPerMinute) {
    throw new WorkerError('AI_TOKEN_CAPACITY', 'Yêu cầu vượt giới hạn token/phút đã cấu hình cho nhà cung cấp.', false)
  }
  await checkpoint(db, claim, stage)
  const attemptId = randomUUID()
  const timeout = new WorkerError(stage === 'outline' ? 'AI_OUTLINE_TIMEOUT' : 'AI_SEO_REPAIR_TIMEOUT',
    stage === 'outline' ? 'Bước lập dàn ý đã hết thời gian chờ.' : 'Bước chỉnh SEO đã hết thời gian chờ; giữ bản viết ban đầu.', false)

  return withLease(db, config, 'jobs', claim.job._id, claim.lease, Math.max(config.aiTimeoutMs, duration ?? 0), async (signal, touch) => {
    const deadline = duration === null ? null : Date.now() + duration
    const waitDeadline = duration === null ? null : AbortSignal.timeout(duration)
    const waitSignal = waitDeadline ? AbortSignal.any([signal, waitDeadline]) : signal
    try {
      await reserveProviderRequest(db, config, provider, attemptId, tokens, waitSignal)
    } catch (error) {
      if (waitDeadline?.aborted) throw timeout
      throw error
    }

    const slot = monitorProviderSlot(db, config, provider, attemptId)
    let retryAfter = 0
    try {
      if (waitDeadline?.aborted) throw timeout
      const callSignal = AbortSignal.any([signal, slot.signal])
      callSignal.throwIfAborted()
      const requestedAt = new Date()
      const pricing = claim.job.key_mode === 'service' ? await collection(db, 'model_prices').findOne({
        provider, model, effective_at: { $lte: requestedAt },
      }, { sort: { effective_at: -1 } }) : null
      await collection(db, 'ai_attempts').insertOne({
        _id: attemptId, job_id: claim.job._id, provider, model,
        stage, lease_token: claim.lease, requested_at: requestedAt, finished_at: null,
        provider_response_id: null, pricing_id: pricing?._id ?? null, pricing_snapshot: pricing?.rates ?? null,
        usage: null, cost_usd: null, cost_source: null, status: 'running', error_code: null, error: null,
      })
      let result: T
      try {
        const remaining = deadline === null ? null : deadline - Date.now()
        if (remaining !== null && remaining <= 0) throw timeout
        touch()
        result = await bounded(callSignal, remaining, timeout, (boundedSignal, boundedTouch) => call(boundedSignal, () => {
          touch()
          boundedTouch?.()
        }, retrySignal => reserveProviderRequest(db, config, provider, attemptId, tokens, retrySignal, true)))
      } catch (failure) {
        const error = failureOf(failure)
        retryAfter = claim.job.key_mode === 'service' ? error.retryAfterMs : 0
        await recordAttempt(db, claim, attemptId, pricing?.rates, error.metadata, error)
        throw error
      }
      await recordAttempt(db, claim, attemptId, pricing?.rates, result, null)
      return result
    } finally {
      try { await slot.release(retryAfter) } catch { /* The slot expires if MongoDB is unavailable. */ }
    }
  }, false)
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
  let outlineForDraft: GenerateInput['outline'] | undefined
  let linkCandidates: InternalLinkCandidate[] = []
  let preservedLinks: string[] = []
  let linkSelectionUnavailable = false
  let catalogEnabled = false
  let catalogUrl: string | null = null
  let linkReport: InternalLinkReport | null = null
  let removedLinks = 0
  const checkLinks = async (article: Article): Promise<Article> => {
    let candidates = linkCandidates
    if (candidates.length || catalogEnabled) {
      if (candidates.length) try {
        candidates = await refreshInternalLinkCandidates(db, {
          siteId: job.site_id, customerId: job.customer_id, siteDomain,
          candidates, excludeIds: job.exclude_content_ids, expectedCatalogUrl: catalogUrl,
        })
      } catch { candidates = []; linkSelectionUnavailable = true }
      // The CMS supplies the authoritative self-page ID through exclude_content_ids.
      // Exact title matches are an additional conservative safeguard for a new draft.
      candidates = candidates.filter(candidate => foldSearchText(candidate.title) !== foldSearchText(article.Title))
      const checked = enforceInternalLinks(article.Content, { candidates, siteDomain, preserveUrls: preservedLinks, maxLinks: 3 })
      removedLinks += checked.removed
      linkReport = {
        status: linkSelectionUnavailable ? 'unavailable' : linkCandidates.length ? 'checked' : 'no_candidates', candidates: linkCandidates.length,
        used: checked.used, removed: removedLinks, checked_at: new Date().toISOString(),
      }
      return { ...article, Content: checked.content }
    }
    linkReport = {
      status: linkSelectionUnavailable ? 'unavailable' : 'no_candidates', candidates: 0,
      used: [], removed: 0, checked_at: new Date().toISOString(),
    }
    return article
  }
  try {
    if (job.key_mode === 'service' && !await collection(db, 'quota_reservations').findOne({
      job_id: job._id, customer_id: job.customer_id, status: 'reserved',
    }, { projection: { _id: 1 } })) {
      throw new WorkerError('QUOTA_RESERVATION_MISSING', 'Yêu cầu chưa được giữ lượt viết. Hãy gửi lại yêu cầu.', false)
    }
    const settings = await collection(db, 'ai_providers').findOne({ _id: job.provider })
    const key = keyFor(job, config, settings?.encrypted_api_key)
    const model = await collection(db, 'ai_models').findOne({ _id: job.model, provider: job.provider }, { projection: { upstream_model: 1 } })
    if (job.provider !== providerKind(job.provider) && !model?.upstream_model) {
      throw new WorkerError('AI_MODEL_UNAVAILABLE', 'Model của kết nối này không còn trong danh mục.', false)
    }
    const site = await collection(db, 'sites').findOne({ _id: job.site_id })
    siteDomain = site?.domain ?? null
    catalogUrl = site?.content_catalog_url ?? null
    catalogEnabled = Boolean(catalogUrl || site?.site_content_synced_at)
    let source: Article | null = null
    if (job.source_article_id) {
      const original = await collection<Job>(db, 'jobs').findOne({ _id: job.source_article_id, site_id: job.site_id, status: 'ready' })
      try { source = cleanArticle(normalizeArticleFields(original?.result?.[0])) }
      catch { throw new WorkerError('AI_SOURCE_INVALID', 'Không đọc được bài viết nguồn.', false) }
    }
    preservedLinks = source ? extractArticleLinks(source.Content) : []
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
      provider: providerKind(job.provider), key, model: model?.upstream_model ?? job.model, keyword: job.keyword, tone: job.tone, style: job.style,
      length: job.length, instructions: job.instructions, source, research, siteDomain,
      baseUrl: settings?.base_url ?? undefined,
    }
    // Manual retry creates a new job. Reuse only its verified predecessor's matching connection/model.
    const historyIds = [job._id]
    if (job.retry_of_job_id) {
      const predecessor = await collection<Job>(db, 'jobs').findOne({
        _id: job.retry_of_job_id, site_id: job.site_id, customer_id: job.customer_id,
        provider: job.provider, model: job.model, status: 'failed',
      }, { projection: { _id: 1 } })
      if (predecessor) historyIds.push(predecessor._id)
    }
    // Learn only from the actual connection/model, without storing response content.
    const previous = await collection<{
      stage?: string, usage?: GenerationMetadata['usage'], generation?: GenerationMetadata['generation'], error_code?: string,
    }>(db, 'ai_attempts').find({
      job_id: { $in: historyIds }, provider: job.provider, model: job.model, status: { $in: ['failed', 'succeeded'] },
    }, { projection: { _id: 0, stage: 1, usage: 1, generation: 1, error_code: 1 } }).toArray()
    const tokenCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(32_768, value) : 0
    const observeUsage = (metadata: Pick<GenerationMetadata, 'usage'>) => {
      const reasoning = tokenCount(metadata.usage?.reasoning)
      if (reasoning) input.tokenBudget = {
        ...input.tokenBudget, reasoningTokens: Math.max(input.tokenBudget?.reasoningTokens ?? 0, reasoning),
      }
    }
    for (const attempt of previous) {
      observeUsage({ usage: attempt.usage ?? null })
      const stage = attempt.stage === 'outline' ? 'outline' : attempt.stage === 'draft' ? 'article' : attempt.stage === 'seo_repair' ? 'repair' : null
      if (!stage) continue
      const legacyLimit = stage === 'outline' ? outlineTokenLimit : outputTokenLimit(job.length)
      const requested = tokenCount(attempt.generation?.maxOutputTokens)
      const truncated = attempt.generation?.invalidReason === 'truncated'
        || !attempt.generation && attempt.error_code === 'AI_ARTICLE' && tokenCount(attempt.usage?.output) >= legacyLimit
      if (!truncated) continue
      input.tokenBudget = { ...input.tokenBudget, minimumOutputTokens: {
        ...input.tokenBudget?.minimumOutputTokens,
        [stage]: Math.max(input.tokenBudget?.minimumOutputTokens?.[stage] ?? 0, Math.min(32_768, (requested || legacyLimit) * 2)),
      } }
    }
    if (estimateGenerationTokens(input, 'article') > config.providerLimits[providerKind(job.provider)].tokensPerMinute) {
      throw new WorkerError('AI_TOKEN_CAPACITY', 'Yêu cầu vượt giới hạn token/phút đã cấu hình cho nhà cung cấp.', false)
    }

    if (job.capacity_deferred) input.outline = job.outline ?? null
    else try {
      const planned = await callAi(db, config, claim, 'outline', estimateGenerationTokens(input, 'outline'),
        config.outlineTimeoutMs ?? Math.min(300_000, config.aiTimeoutMs),
        (signal, onChunk, beforeCompatibilityRetry) => (deps.outline ?? generateOutline)({ ...input, signal, onChunk, beforeCompatibilityRetry }))
      input.outline = planned.outline
      observeUsage(planned)
    } catch (failure) {
      if (failure instanceof ProviderCapacityPending || failureOf(failure).code === 'AI_LEASE_LOST') throw failure
      input.outline = null
    }

    try {
      if (catalogUrl) {
        const synced = await withLease(db, config, 'jobs', job._id, claim.lease, Math.max(config.aiTimeoutMs, 20_000),
          signal => (deps.syncCatalog ?? syncSiteContentCatalog)(db, job.site_id, {
            signal, expectedCustomerId: job.customer_id, expectedDomain: siteDomain ?? undefined, expectedUrl: catalogUrl,
          }))
        if (!['synced', 'cached'].includes(synced.status)) throw new Error('Catalog unavailable')
      }
      linkCandidates = await selectInternalLinkCandidates(db, {
        siteId: job.site_id, customerId: job.customer_id, siteDomain, keyword: job.keyword,
        context: input.outline ? [input.outline.title, ...input.outline.sections.map(section => section.heading)].join(' ') : undefined,
        excludeTitles: [source?.Title, input.outline?.title].filter((value): value is string => Boolean(value)),
        excludeIds: job.exclude_content_ids,
      })
      if (linkCandidates.length || catalogEnabled) input.internalLinks = linkCandidates
    } catch (failure) {
      if (failureOf(failure).code === 'AI_LEASE_LOST') throw failure
      linkSelectionUnavailable = true
      if (catalogEnabled) input.internalLinks = []
    }
    // Optional catalog metadata must not make an otherwise valid request exceed capacity.
    if (input.internalLinks && estimateGenerationTokens(input, 'article') > config.providerLimits[providerKind(job.provider)].tokensPerMinute) {
      delete input.internalLinks
      linkCandidates = []
    }
    if (estimateGenerationTokens(input, 'article') > config.providerLimits[providerKind(job.provider)].tokensPerMinute) input.outline = null
    outlineForDraft = input.outline
    await checkpoint(db, claim, 'draft', { outline: outlineForDraft ?? null })
    const written = await callAi(db, config, claim, 'draft', estimateGenerationTokens(input, 'article'), null,
      async (signal, onChunk, beforeCompatibilityRetry) => {
        const result = await (deps.generate ?? generateArticle)({ ...input, signal, onChunk, beforeCompatibilityRetry })
        signal.throwIfAborted()
        draft = await checkLinks(cleanArticle(result.article))
        report = evaluateSeo(draft, { keyword: job.keyword, siteUrl: siteDomain })
        // Save before usage settlement as well: an accounting outage must not lose the article.
        await checkpoint(db, claim, 'seo_check', { result: [draft], seo_report: report, internal_link_report: linkReport })
        return { ...result, article: draft }
      })
    draft = written.article
    observeUsage(written)
    report = evaluateSeo(draft, { keyword: job.keyword, siteUrl: siteDomain })
    const issues = repairable(report)
    repairStatus = 'not_needed'
    if (issues.length) {
      const repairInput: Omit<RepairInput, 'signal' | 'onChunk'> = { ...input, draft, issues }
      repairStatus = 'kept_draft'
      try {
        const revised = await callAi(db, config, claim, 'seo_repair', estimateGenerationTokens(repairInput, 'repair'),
          config.seoRepairTimeoutMs ?? Math.min(90_000, config.aiTimeoutMs),
          async (signal, onChunk, beforeCompatibilityRetry) => {
            const result = await (deps.repair ?? repairArticle)({ ...repairInput, signal, onChunk, beforeCompatibilityRetry })
            return { ...result, article: await checkLinks(cleanArticle(result.article)) }
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
    draft = await checkLinks(draft)
    report = evaluateSeo(draft, { keyword: job.keyword, siteUrl: siteDomain })
    await transition(db, config, job, draft, null, report, repairStatus, false, linkReport)
  } catch (failure) {
    if (failure instanceof ProviderCapacityPending) {
      const now = Date.now()
      const deferred = await collection(db, 'jobs').updateOne(owned(claim), { $set: {
        status: 'queued', capacity_deferred: outlineForDraft !== undefined, outline: outlineForDraft ?? null,
        available_at: new Date(now + failure.retryInMs), updated_at: new Date(now),
        writing_stage: null, lease_token: null, lease_expires_at: null,
      }, $inc: { attempt_count: -1 } })
      if (deferred.matchedCount) jobEvents.publish({
        type: 'job.updated', job_id: job._id, status: 'queued', writing_stage: null,
        updated_at: new Date(now).toISOString(),
      })
      return
    }
    const error = failureOf(failure)
    if (error.code === 'AI_LEASE_LOST') return
    // A valid draft remains deliverable even if optional processing is interrupted.
    await transition(db, config, job, draft, draft ? null : error,
      draft ? report ?? evaluateSeo(draft, { keyword: job.keyword, siteUrl: siteDomain }) : null,
      draft ? repairStatus ?? 'kept_draft' : null, false, linkReport)
  }
}

export async function runWriterOnce(db: Database, config: Config, deps: WriterDependencies = {}): Promise<boolean> {
  // Each compatible connection owns its queue and capacity window. Disabled
  // providers still finish jobs that were accepted before they were disabled.
  const configured = await collection<{ _id: Provider }>(db, 'ai_providers').find({}, { projection: { _id: 1 } }).toArray()
  const available: Provider[] = [...providers, ...configured.map(row => row._id)
    .filter(provider => provider !== 'openai-compatible' && isCompatibleProvider(provider)).sort()]
  const first = nextProvider
  nextProvider = (nextProvider + 1) % available.length
  for (let offset = 0; offset < available.length; offset += 1) {
    const claim = await claimWriter(db, config, available[(first + offset) % available.length], deps)
    if (claim === false) continue
    if (claim !== true) await writeClaim(db, config, claim, deps)
    return true
  }
  return false
}
