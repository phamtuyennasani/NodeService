import { randomUUID } from 'node:crypto'
import { Decimal } from 'decimal.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { isCompatibleProvider, providers } from '../config.js'
import { collection, sessionOf, transaction, type Database } from '../db.js'
import { resolveDatabase, rootDatabase } from '../db.js'
import { accountAccess } from '../workspaces.js'
import { createJob, writingFields, type Site } from './public.js'
import { languageMetadata } from '../article-language.js'
import { articleIdentity, articleIdentityFields } from '../article-group.js'
import { articleGroupRows, groupArticleRows } from './article-groups.js'
import { modelIdSchema, providerIdSchema } from './catalog.js'
import { ApiError, articleLengthSchema, idSchema, notFound, periodSchema, timestampSchema } from './errors.js'
import { pageOf, readCursor } from './public.js'
import { cleanArticle, normalizeArticleFields } from '../worker/provider.js'
import { DatabaseJobEvents, publishJobEvent } from '../job-events.js'
import { excludedContentIdsSchema } from '../site-content.js'
import { digest } from '../security.js'
import { crmSessionCookieName } from './crm-session.js'
import { registerJobPdfRoute } from './crm-job-pdf.js'

const keys = z.object({ customer_id: idSchema.optional(), website_id: idSchema.optional() })
const listSchema = keys.extend({ from: periodSchema.optional(), to: periodSchema.optional(), limit: z.coerce.number().int().min(1).max(250).default(100), cursor: z.string().max(512).optional(), q: z.string().trim().max(160).optional() })
const reportFilters = listSchema.pick({ customer_id: true, website_id: true, from: true, to: true }).refine(
  ({ from, to }) => !from || !to || from <= to,
  'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.',
)
const jobsSchema = listSchema.extend({ article_group_id: idSchema.optional(), status: z.enum(['scheduled', 'queued', 'writing', 'ready', 'completed', 'failed', 'canceled']).optional(), source: z.enum(['scheduled', 'schedule', 'preview', 'immediate', 'widget', 'rewrite']).optional(), provider: providerIdSchema.optional(), key_mode: z.enum(['own', 'service']).optional(), date_basis: z.literal('cost').optional(), issue: z.enum(['queue', 'overdue', 'future', 'stale', 'unpriced']).optional() })
const deliveriesSchema = listSchema.extend({ status: z.enum(['pending', 'sending', 'delivered', 'failed']).optional(), event: z.enum(['article.ready', 'article.failed']).optional(), issue: z.enum(['queue', 'stale']).optional() })
const idParams = z.object({ id: idSchema })
const scheduleFields = z.object({ customer_id: idSchema.optional(), website_id: idSchema, model: writingFields.shape.model, keyword: z.string().trim().min(1).max(500), tone: z.string().trim().min(1).max(240), style: z.string().trim().min(1).max(500), length: articleLengthSchema, instructions: z.string().trim().max(4000).optional(), base_url: writingFields.shape.base_url, keyAI: writingFields.shape.keyAI, key_mode: writingFields.shape.key_mode, ...articleIdentityFields, languages: writingFields.shape.languages, locale: writingFields.shape.locale, translation_source: writingFields.shape.translation_source, use_research: z.boolean().default(true), scheduled_at: timestampSchema }).strict()
const immediateFields = scheduleFields.omit({ scheduled_at: true }).extend({ exclude_content_ids: excludedContentIdsSchema.optional() })
const rewriteFields = z.object({ instructions: z.string().trim().max(4000).optional(), base_url: writingFields.shape.base_url, keyAI: writingFields.shape.keyAI, key_mode: writingFields.shape.key_mode, exclude_content_ids: excludedContentIdsSchema.optional() }).strict()
const DAY = 86_400_000
const VIETNAM_OFFSET = 7 * 60 * 60 * 1000
const ReportDecimal = Decimal.clone({ precision: 40 })
const dateStart = (date: string) => new Date(`${date}T00:00:00+07:00`)
const dateEnd = (date: string) => new Date(dateStart(date).getTime() + DAY)
const localDay = (time: number) => new Date(time + VIETNAM_OFFSET).toISOString().slice(0, 10)

function scopedJobs(filters: z.infer<typeof keys>) {
  return {
    ...(filters.customer_id ? { customer_id: filters.customer_id } : {}),
    ...(filters.website_id ? { site_id: filters.website_id } : {}),
  }
}

function reportPeriod(from?: string, to?: string) {
  const last = dateStart(to ?? localDay(Date.now()))
  const start = from ? dateStart(from).getTime() : last.getTime() - 13 * DAY
  const end = last.getTime() + DAY
  if (end <= start || end - start > 366 * DAY) {
    throw new ApiError(400, 'invalid_report_period', 'Chọn khoảng báo cáo tối đa 366 ngày.')
  }
  return { start, end }
}

async function joinedJobs(db: Database, filters: z.infer<typeof keys>) {
  const [jobs, sites, customers] = await Promise.all([
    collection<any>(db, 'jobs').find(scopedJobs(filters)).toArray(),
    collection<any>(db, 'sites').find(filters.website_id ? { _id: filters.website_id } : {}).toArray(),
    collection<any>(db, 'customers').find(filters.customer_id ? { _id: filters.customer_id } : {}).toArray(),
  ])
  const siteMap = new Map(sites.map(site => [site._id, site]))
  const customerMap = new Map(customers.map(customer => [customer._id, customer]))
  return jobs.map(job => ({ ...job, customer: customerMap.get(job.customer_id), site: siteMap.get(job.site_id) }))
}
function reportJob(row: any) {
  return {
    ...articleIdentity(row),
    is_translation: Boolean(row.translation_source || row.translation_of_job_id),
    article_title: row.result?.[0]?.Title ?? null,
    id: row._id, job_id: row._id, customer_id: row.customer_id, customer_name: row.customer?.name ?? '',
    website_id: row.site_id, website_name: row.site?.name ?? '', mode: row.mode, source: row.mode === 'preview' ? 'immediate' : row.mode,
    status: row.status === 'ready' ? 'completed' : row.status,
    writing_stage: row.status === 'writing' ? row.writing_stage ?? null : null,
    can_rewrite: row.status === 'failed' || (row.status === 'ready' && Boolean(row.result?.[0])),
    keyword: row.keyword, provider: row.provider, model: row.model,
    ...(row.provider_display_name ? { provider_display_name: row.provider_display_name } : {}),
    ...(row.upstream_model ? { upstream_model: row.upstream_model } : {}),
    tone: row.tone, style: row.style, length: row.length,
    ...(row.languages ? { languages: row.languages, locale: row.locale ?? row.languages.source } : {}),
    use_research: row.use_research ?? true,
    key_mode: row.key_mode, created_at: row.created_at, updated_at: row.updated_at, scheduled_at: row.scheduled_at, started_at: row.started_at, completed_at: row.completed_at,
    source_article_id: row.source_article_id, retry_of_job_id: row.retry_of_job_id ?? null, idempotency_key: row.client_request_id,
    error_code: row.error_code, error_message: row.error_message,
  }
}

/** Resolve custom connection names with a positive projection; never load credentials. */
async function connectionLabels(db: Database, rows: any[]) {
  const custom = rows.filter(row => typeof row.provider === 'string' && row.provider !== 'openai-compatible' && isCompatibleProvider(row.provider))
  if (!custom.length) return (row: any) => row
  const [connections, models] = await Promise.all([
    collection<any>(db, 'ai_providers').find({ _id: { $in: [...new Set(custom.map(row => row.provider))] } }, { projection: { _id: 1, display_name: 1 } }).toArray(),
    collection<any>(db, 'ai_models').find({ _id: { $in: [...new Set(custom.map(row => row.model))] } }, { projection: { _id: 1, provider: 1, upstream_model: 1 } }).toArray(),
  ])
  const names = new Map(connections.map(row => [row._id, row.display_name]))
  const modelMap = new Map(models.map(row => [row._id, row]))
  return (row: any) => {
    const model = modelMap.get(row.model)
    return { ...row, ...(names.has(row.provider) ? { provider_display_name: names.get(row.provider) } : {}),
      ...(model?.provider === row.provider && model.upstream_model ? { upstream_model: model.upstream_model } : {}) }
  }
}
function inRange(value: Date | null | undefined, from?: Date, to?: Date) {
  if (!from && !to) return true
  return value != null && (!from || value >= from) && (!to || value < to)
}

function sortedPage<T extends { _id: string, created_at: Date }>(rows: T[], cursor?: string, limit = 100) {
  const [cursorAt, cursorId] = readCursor(cursor)
  return rows.sort((a, b) => b.created_at.getTime() - a.created_at.getTime() || b._id.localeCompare(a._id))
    .filter(row => {
      if (!cursorAt) return true
      const time = row.created_at.toISOString()
      return time < cursorAt || (time === cursorAt && row._id < cursorId!)
    }).slice(0, limit + 1)
}

function cursorFields(row: { _id: string, created_at: Date }) {
  return { cursor_at: row.created_at.toISOString(), cursor_id: row._id }
}

function issueTime(row: { completed_at?: Date | null, updated_at?: Date | null }) {
  return row.completed_at ?? row.updated_at
}

function costValue(value: Decimal) { return value.toFixed(12) }

const convertVnd = (rate: number) => (value: Decimal.Value | null | undefined) => value == null || value === ''
    ? null
    : new ReportDecimal(value).times(rate).toFixed(12)

function runtimeTime(value: unknown): number | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : null
}

function hasRuntimeLease(row: any, now: number) {
  const expires = runtimeTime(row.lease_expires_at)
  return typeof row.lease_token === 'string' && row.lease_token.trim().length > 0 && expires !== null && expires > now
}

function writingQueue(row: any, now: number) {
  const scheduled = runtimeTime(row.scheduled_at)
  return row.status === 'queued' || (row.status === 'scheduled' && scheduled !== null && scheduled <= now)
}

function overdueSchedule(row: any, now: number) {
  const scheduled = runtimeTime(row.scheduled_at)
  return row.status === 'scheduled' && scheduled !== null && scheduled < now
}

function deliveryQueue(row: any, now: number) {
  const next = runtimeTime(row.next_attempt_at)
  return row.status === 'pending' && next !== null && next <= now
}

function pendingCostFilter() {
  return { cost_usd: { $in: [null, ''] }, $or: [{ cost_source: 'pending' }, { cost_source: { $exists: false } }] }
}

function oldestWait(rows: any[], timestamp: (row: any) => number | null, now: number) {
  const oldest = rows.reduce<number | null>((previous, row) => {
    const value = timestamp(row)
    return value !== null && value <= now ? Math.min(previous ?? value, value) : previous
  }, null)
  return oldest === null ? null : Math.max(0, Math.floor((now - oldest) / 1000))
}

// Summaries never echo stored provider responses, which may contain credentials.
const runtimeFailureMessages: Record<string, string> = {
  AI_AUTH: 'Nhà cung cấp từ chối API key hoặc quyền dùng model.',
  AI_KEY_UNAVAILABLE: 'API key chưa được cấu hình hoặc không đọc được.',
  AI_ENDPOINT_UNAVAILABLE: 'Chưa cấu hình địa chỉ nhà cung cấp AI.',
  AI_RATE_LIMIT: 'Nhà cung cấp AI đang giới hạn lượt gọi.',
  AI_TOKEN_CAPACITY: 'Yêu cầu vượt giới hạn token đã cấu hình.',
  AI_UNAVAILABLE: 'Nhà cung cấp AI tạm thời không phản hồi.',
  AI_CONNECTION: 'Kết nối AI gián đoạn hoặc hết thời gian chờ.',
  AI_REQUEST: 'Nhà cung cấp không chấp nhận yêu cầu hoặc model.',
  AI_RESPONSE: 'Phản hồi AI không hợp lệ hoặc bị gián đoạn.',
  AI_LEASE_EXPIRED: 'Tiến trình viết bị gián đoạn trước khi hoàn tất.',
  AI_LEASE_LOST: 'Yêu cầu đã được tiến trình khác tiếp quản.',
  AI_RESEARCH_TIMEOUT: 'Bước nghiên cứu đã hết thời gian chờ.',
  AI_OUTLINE_TIMEOUT: 'Bước lập dàn ý đã hết thời gian chờ.',
  AI_SEO_REPAIR_TIMEOUT: 'Bước chỉnh SEO đã hết thời gian chờ.',
  AI_SOURCE_INVALID: 'Không đọc được bài viết nguồn.',
  QUOTA_RESERVATION_MISSING: 'Yêu cầu chưa được giữ lượt viết.',
}

function runtimeJob(row: any) {
  const knownCode = typeof row.error_code === 'string' && Object.hasOwn(runtimeFailureMessages, row.error_code) ? row.error_code : null
  return {
    ...reportJob(row),
    error_code: knownCode,
    error_message: row.status === 'failed' ? runtimeFailureMessages[knownCode ?? ''] ?? 'Yêu cầu viết chưa hoàn tất. Mở chi tiết để kiểm tra.' : null,
  }
}

export function registerReports(app: FastifyInstance, db: Database, config: Config, getRuntimeConfig: () => Promise<Config> = async () => config) {
  registerJobPdfRoute(app, db)
  const eventSources = new Map<Database, { events: DatabaseJobEvents, subscribers: number }>()
  const closingSources = new Set<Promise<void>>()
  function subscribeWorkspaceEvents(receive: Parameters<DatabaseJobEvents['subscribe']>[0], jobId?: string) {
    const current = resolveDatabase(db)
    let entry = eventSources.get(current)
    if (!entry) {
      entry = { events: new DatabaseJobEvents(current, error => app.log.warn({ err: error }, 'CRM job event stream reconnecting')), subscribers: 0 }
      eventSources.set(current, entry)
      entry.events.start()
    }
    entry.subscribers++
    const unsubscribe = entry.events.subscribe(receive, jobId)
    let released = false
    return () => {
      if (released) return
      released = true
      unsubscribe()
      if (--entry!.subscribers > 0) return
      // Switching through groups must not retain a MongoDB stream for every group visited.
      eventSources.delete(current)
      const closing = entry!.events.close().finally(() => closingSources.delete(closing))
      closingSources.add(closing)
    }
  }
  const closeStreams = new Set<() => void>()
  const streamsBySession = new Map<string, number>()
  app.addHook('preClose', async () => {
    for (const close of closeStreams) close()
    await Promise.all([...closingSources, ...[...eventSources.values()].map(entry => entry.events.close())])
  })
  app.get('/jobs/events', async (request, reply) => {
    const query = z.object({ job_id: idSchema.optional() }).parse(request.query)
    const token = request.cookies?.[crmSessionCookieName(config)]
    const sessionId = token ? digest(token) : `ip:${request.ip}`
    if (closeStreams.size >= 128 || (streamsBySession.get(sessionId) ?? 0) >= 4) {
      reply.header('Retry-After', '30')
      throw new ApiError(429, 'stream_limit', 'Đang mở quá nhiều kết nối cập nhật. Hãy đóng bớt tab và thử lại.')
    }
    streamsBySession.set(sessionId, (streamsBySession.get(sessionId) ?? 0) + 1)
    const response = reply.raw
    reply.hijack()
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) response.setHeader(name, value)
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Accel-Buffering': 'no',
    })
    response.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready' })}\n\n`)
    const send = (event: Record<string, unknown>) => {
      if (response.destroyed || response.writableEnded) return
      // Drop slow connections rather than accumulating an unbounded buffer.
      // EventSource reconnects and the ready event reconciles missed changes.
      if (!response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)) response.destroy()
    }
    const unsubscribe = subscribeWorkspaceEvents(send, query.job_id)
    const control = rootDatabase(db)
    let checkingSession = false
    const heartbeat = setInterval(async () => {
      if (response.destroyed || response.writableEnded) return
      if (checkingSession) return
      checkingSession = true
      try {
        // Revoke an already-open stream after logout/password change rather
        // than trusting the cookie only at connection establishment.
        if (token) {
          const session = await collection(control, 'sessions').findOne({ _id: sessionId, expires_at: { $gt: new Date() } }, { projection: { user_id: 1, credential_version: 1 }, maxTimeMS: 5_000 })
          if (!session) return close()
          const user = await collection(control, 'users').findOne({ _id: session.user_id }, { projection: { _id: 1, password_hash: 1, role: 1, partner_id: 1, enabled: 1 }, maxTimeMS: 5_000 })
          if (!user || (session.credential_version && (!user.password_hash || session.credential_version !== digest(user.password_hash)))) return close()
          await accountAccess(control, user)
        }
        if (!response.destroyed && !response.writableEnded && !response.write(': heartbeat\n\n')) response.destroy()
      } catch { close() }
      finally { checkingSession = false }
    }, 25_000)
    heartbeat.unref?.()
    // EventSource reconnects with a fresh session check; also bounds lifetimes
    // when a client stays connected without generating any job events.
    const lifetime = setTimeout(() => close(), 5 * 60_000)
    lifetime.unref?.()
    let cleaned = false
    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      clearInterval(heartbeat)
      clearTimeout(lifetime)
      unsubscribe()
      closeStreams.delete(close)
      const remaining = (streamsBySession.get(sessionId) ?? 1) - 1
      if (remaining > 0) streamsBySession.set(sessionId, remaining)
      else streamsBySession.delete(sessionId)
    }
    const close = () => { cleanup(); response.end() }
    closeStreams.add(close)
    // IncomingMessage.close concerns request-body completion, whereas the
    // response remains open for SSE. Track the actual outbound connection.
    response.once('close', cleanup)
    response.once('error', cleanup)
  })
  app.post('/jobs', async (request, reply) => {
    const fields = immediateFields.parse(request.body)
    const site = await collection<any>(db, 'sites').findOne({ _id: fields.website_id })
    if (!site) throw notFound()
    if (fields.customer_id && fields.customer_id !== site.customer_id) throw new ApiError(409, 'website_customer_mismatch', 'Website không thuộc khách hàng đã chọn.')
    const clientId = typeof request.headers['idempotency-key'] === 'string' && request.headers['idempotency-key'].trim()
      ? request.headers['idempotency-key'].trim()
      : randomUUID()
    const result = await createJob(db, config, {
      id: site._id,
      customer_id: site.customer_id,
      token_hash: site.token_hash ?? null,
      proof_required: site.proof_required,
      signing_public_key: site.signing_public_key,
      webhook_url: site.webhook_url ?? null,
      webhook_secret: site.webhook_secret ?? null,
    } satisfies Site, clientId, {
      model: fields.model,
      ...languageMetadata(fields),
      article_ref: fields.article_ref, translation_of_job_id: fields.translation_of_job_id,
      keyword: fields.keyword,
      tone: fields.tone,
      style: fields.style,
      length: fields.length,
      instructions: fields.instructions,
      keyAI: fields.keyAI,
      base_url: fields.base_url,
      key_mode: fields.key_mode,
      use_research: fields.use_research,
      exclude_content_ids: fields.exclude_content_ids,
    }, 'preview', undefined)
    return reply.code(202).send(result)
  })

  app.post('/schedules', async (request, reply) => {
    const fields = scheduleFields.extend({ exclude_content_ids: excludedContentIdsSchema.optional() }).parse(request.body)
    const site = await collection<any>(db, 'sites').findOne({ _id: fields.website_id })
    if (!site) throw notFound()
    if (fields.customer_id && fields.customer_id !== site.customer_id) throw new ApiError(409, 'website_customer_mismatch', 'Website không thuộc khách hàng đã chọn.')
    const clientId = typeof request.headers['idempotency-key'] === 'string' && request.headers['idempotency-key'].trim()
      ? request.headers['idempotency-key'].trim()
      : randomUUID()
    const result = await createJob(db, config, {
      id: site._id,
      customer_id: site.customer_id,
      token_hash: site.token_hash ?? null,
      proof_required: site.proof_required,
      signing_public_key: site.signing_public_key,
      webhook_url: site.webhook_url ?? null,
      webhook_secret: site.webhook_secret ?? null,
    } satisfies Site, clientId, {
      model: fields.model,
      ...languageMetadata(fields),
      article_ref: fields.article_ref, translation_of_job_id: fields.translation_of_job_id,
      keyword: fields.keyword,
      tone: fields.tone,
      style: fields.style,
      length: fields.length,
      instructions: fields.instructions,
      keyAI: fields.keyAI,
      base_url: fields.base_url,
      key_mode: fields.key_mode,
      use_research: fields.use_research,
      exclude_content_ids: fields.exclude_content_ids,
    }, 'scheduled', fields.scheduled_at)
    return reply.code(202).send(result)
  })
  app.post('/jobs/:id/rewrite', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    const additions = rewriteFields.parse(request.body ?? {})
    const article = await collection<any>(db, 'jobs').findOne({ _id: id })
    if (!article) throw notFound()
    const retryFailed = article.status === 'failed'
    if (!retryFailed && (article.status !== 'ready' || !article.result?.[0])) throw new ApiError(409, 'job_not_ready', 'Chỉ có thể viết lại bài đã hoàn tất hoặc yêu cầu viết đã lỗi.')
    const site = await collection<any>(db, 'sites').findOne({ _id: article.site_id, customer_id: article.customer_id })
    if (!site) throw notFound()
    let sourceId: string | undefined = retryFailed ? undefined : id
    if (retryFailed && article.source_article_id) {
      const source = await collection<any>(db, 'jobs').findOne({ _id: article.source_article_id, site_id: article.site_id, customer_id: article.customer_id, status: 'ready' })
      try { cleanArticle(normalizeArticleFields(source?.result?.[0])); sourceId = source._id } catch { /* Retry as a fresh article when the previous source is unusable. */ }
    }
    const instructions = [article.instructions, additions.instructions].filter(Boolean).join('\n\n').slice(-8000)
    const clientId = typeof request.headers['idempotency-key'] === 'string' && request.headers['idempotency-key'].trim()
      ? request.headers['idempotency-key'].trim()
      : randomUUID()
    const result = await createJob(db, config, {
      id: site._id,
      customer_id: site.customer_id,
      token_hash: site.token_hash ?? null,
      proof_required: site.proof_required,
      signing_public_key: site.signing_public_key,
      webhook_url: site.webhook_url ?? null,
      webhook_secret: site.webhook_secret ?? null,
    } satisfies Site, clientId, {
      model: article.model,
      ...languageMetadata({ languages: article.languages, locale: article.locale, ...(retryFailed ? { translation_source: article.translation_source } : {}) }),
      keyword: article.keyword,
      tone: article.tone,
      style: article.style,
      length: article.length,
      instructions: instructions || undefined,
      keyAI: additions.keyAI,
      base_url: additions.base_url,
      key_mode: additions.key_mode ?? (article.key_mode === 'own' ? 'own' : undefined),
      use_research: article.use_research ?? true,
      exclude_content_ids: additions.exclude_content_ids ?? article.exclude_content_ids ?? [],
    }, 'rewrite', undefined, sourceId, retryFailed ? id : undefined)
    return reply.code(202).send(result)
  })
  app.get('/dashboard/runtime', async (request, reply) => {
    const runtime = await getRuntimeConfig()
    const filters = keys.parse(request.query)
    const now = new Date()
    const time = now.getTime()
    const jobProjection = {
      _id: 1, customer_id: 1, site_id: 1, mode: 1, status: 1, writing_stage: 1, keyword: 1,
      provider: 1, model: 1, tone: 1, style: 1, length: 1, use_research: 1, key_mode: 1,
      created_at: 1, updated_at: 1, scheduled_at: 1, available_at: 1, started_at: 1, completed_at: 1,
      source_article_id: 1, retry_of_job_id: 1, client_request_id: 1,
      error_code: 1, lease_token: 1, lease_expires_at: 1,
    } as const
    const [rows, deliveryRows, unpriced, heartbeats] = await Promise.all([
      collection<any>(db, 'jobs').find({ status: { $in: ['scheduled', 'queued', 'writing', 'failed'] }, ...scopedJobs(filters) }, { projection: jobProjection }).toArray(),
      collection<any>(db, 'webhook_deliveries').find({
        status: { $in: ['pending', 'sending', 'failed'] },
        ...(filters.website_id ? { site_id: filters.website_id } : {}),
      }, { projection: {
        _id: 1, job_id: 1, site_id: 1, status: 1, event: 1, attempt_count: 1, http_status: 1,
        next_attempt_at: 1, created_at: 1, updated_at: 1, lease_token: 1, lease_expires_at: 1,
      } }).toArray(),
      collection<any>(db, 'ai_attempts').find(pendingCostFilter(), { projection: { job_id: 1 } }).toArray(),
      // Worker capacity is deployment-wide; customer/website filters apply only to work counts.
      collection<any>(db, 'worker_heartbeats').find({ expires_at: { $gt: now } }, {
        projection: { role: 1, heartbeat_at: 1, concurrency: 1, active_tasks: 1, accepting_work: 1 },
      }).toArray(),
    ])
    const jobMap = new Map(rows.map(row => [row._id, row]))
    const relatedIds = [...new Set([...deliveryRows, ...unpriced].map(row => row.job_id))].filter(id => typeof id === 'string' && !jobMap.has(id))
    if (relatedIds.length) {
      const related = await collection<any>(db, 'jobs').find({ _id: { $in: relatedIds }, ...scopedJobs(filters) }, { projection: jobProjection }).toArray()
      for (const row of related) jobMap.set(row._id, row)
    }
    const leaseActive = (row: any) => row.status === 'writing' && hasRuntimeLease(row, time)
    const queued = (row: any) => writingQueue(row, time)
    const writing = rows.filter(row => row.status === 'writing')
    const activeThreads = writing.filter(leaseActive).length
    const running = [...writing].sort((a, b) => (runtimeTime(b.started_at) ?? 0) - (runtimeTime(a.started_at) ?? 0) || (runtimeTime(b.created_at) ?? 0) - (runtimeTime(a.created_at) ?? 0) || String(a._id).localeCompare(String(b._id))).slice(0, 20)
    const failures = rows.filter(row => row.status === 'failed').sort((a, b) => (runtimeTime(issueTime(b)) ?? 0) - (runtimeTime(issueTime(a)) ?? 0) || String(a._id).localeCompare(String(b._id)))
    const deliveries = deliveryRows.filter(row => jobMap.has(row.job_id))
    const sending = deliveries.filter(row => row.status === 'sending')
    const activeDeliveries = sending.filter(row => hasRuntimeLease(row, time)).length
    const deliveryFailures = deliveries.filter(row => row.status === 'failed').sort((a, b) => (runtimeTime(b.updated_at) ?? 0) - (runtimeTime(a.updated_at) ?? 0) || String(a._id).localeCompare(String(b._id)))
    const visibleJobs = [...running, ...failures.slice(0, 10), ...deliveryFailures.slice(0, 10).map(row => jobMap.get(row.job_id)!)]
    const [customers, sites] = visibleJobs.length ? await Promise.all([
      collection<any>(db, 'customers').find({ _id: { $in: [...new Set(visibleJobs.map(row => row.customer_id))] } }, { projection: { _id: 1, name: 1 } }).toArray(),
      collection<any>(db, 'sites').find({ _id: { $in: [...new Set(visibleJobs.map(row => row.site_id))] } }, { projection: { _id: 1, name: 1 } }).toArray(),
    ]) : [[], []]
    const customerMap = new Map(customers.map(row => [row._id, row]))
    const siteMap = new Map(sites.map(row => [row._id, row]))
    const labelConnection = await connectionLabels(db, rows)
    const withNames = (row: any) => labelConnection({ ...row, customer: customerMap.get(row.customer_id), site: siteMap.get(row.site_id) })
    const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
    const workerSummary = (role: string) => {
      const live = heartbeats.filter(row => row.role === role && runtimeTime(row.heartbeat_at) !== null)
      const accepting = live.filter(row => row.accepting_work !== false)
      const latest = live.reduce<number | null>((last, row) => Math.max(last ?? 0, runtimeTime(row.heartbeat_at)!), null)
      return {
        processes: live.length, accepting_processes: accepting.length,
        concurrency: accepting.reduce((sum, row) => sum + count(row.concurrency), 0),
        active_tasks: live.reduce((sum, row) => sum + count(row.active_tasks), 0),
        last_heartbeat_at: latest === null ? null : new Date(latest).toISOString(),
      }
    }
    reply.header('Cache-Control', 'no-store')
    return {
      observed_at: now.toISOString(),
      summary: {
        writing: writing.length,
        queued: rows.filter(queued).length,
        scheduled: rows.filter(row => row.status === 'scheduled' && (runtimeTime(row.scheduled_at) ?? -Infinity) > time).length,
        active_threads: activeThreads,
        stale_writing: writing.length - activeThreads,
        overdue_schedules: rows.filter(row => overdueSchedule(row, time)).length,
        oldest_wait_seconds: oldestWait(rows.filter(queued), row => row.status === 'scheduled' ? runtimeTime(row.scheduled_at) : runtimeTime(row.available_at) ?? runtimeTime(row.created_at), time),
      },
      capacity: { writer_per_process: runtime.workerConcurrency, webhook_per_process: runtime.webhookConcurrency },
      workers: { writer: workerSummary('writer'), webhook: workerSummary('webhook') },
      deliveries: {
        pending: deliveries.filter(row => row.status === 'pending').length,
        sending: sending.length, failed: deliveryFailures.length, active_threads: activeDeliveries,
        stale_sending: sending.length - activeDeliveries,
        oldest_wait_seconds: oldestWait(deliveries.filter(row => deliveryQueue(row, time)), row => runtimeTime(row.next_attempt_at), time),
      },
      attention: {
        write_errors: failures.length, delivery_errors: deliveryFailures.length,
        stale_writing: writing.length - activeThreads, stale_sending: sending.length - activeDeliveries,
        unpriced_attempts: unpriced.filter(attempt => jobMap.get(attempt.job_id)?.key_mode === 'service').length,
      },
      providers: [...new Set<string>([...providers, ...rows.map(row => row.provider)])].map(provider => {
        const providerRows = rows.filter(row => row.provider === provider)
        const label = labelConnection({ provider }).provider_display_name
        return { provider, ...(label ? { display_name: label } : {}), writing: providerRows.filter(row => row.status === 'writing').length, queued: providerRows.filter(queued).length, active_threads: providerRows.filter(leaseActive).length }
      }),
      running: running.map(row => ({
        ...runtimeJob(withNames(row)),
        lease_active: leaseActive(row),
        elapsed_seconds: runtimeTime(row.started_at) === null ? 0 : Math.max(0, Math.floor((time - runtimeTime(row.started_at)!) / 1000)),
      })),
      write_failures: failures.slice(0, 10).map(row => runtimeJob(withNames(row))),
      delivery_failures: deliveryFailures.slice(0, 10).map(row => {
        const job = jobMap.get(row.job_id)!
        const status = Number.isInteger(row.http_status) && row.http_status >= 100 && row.http_status <= 599 ? row.http_status : null
        return {
          id: row._id, job_id: row.job_id, website_id: row.site_id,
          website_name: siteMap.get(row.site_id)?.name ?? '', customer_name: customerMap.get(job.customer_id)?.name ?? '',
          keyword: job.keyword, status: row.status, event_type: row.event,
          attempts: count(row.attempt_count), attempt_count: count(row.attempt_count), last_http_status: status,
          last_error: row.event === 'article.ready' && status !== null && status >= 200 && status < 300
            ? 'Laravel chưa trả xác nhận hợp lệ với success: true và id_post.'
            : status === null ? 'Không thể giao bài đến website. Mở chi tiết để kiểm tra.' : `Website nhận bài phản hồi HTTP ${status}.`,
          next_attempt_at: row.next_attempt_at, delivered_at: null, created_at: row.created_at, history: [],
        }
      }),
    }
  })
  app.get('/dashboard', async request => {
    const costVnd = convertVnd((await getRuntimeConfig()).usdToVnd)
    const filters = reportFilters.parse(request.query)
    const { start, end } = reportPeriod(filters.from, filters.to)
    const from = new Date(start)
    const to = new Date(end)
    const period = { $gte: from, $lt: to }
    const scope = scopedJobs(filters)
    const [rows, sites, customers, deliveries, attempts] = await Promise.all([
      collection<any>(db, 'jobs').find(scope, { projection: {
        _id: 1, customer_id: 1, site_id: 1, mode: 1, status: 1, writing_stage: 1, keyword: 1,
        provider: 1, model: 1, tone: 1, style: 1, length: 1, use_research: 1, key_mode: 1, created_at: 1,
        scheduled_at: 1, started_at: 1, completed_at: 1, updated_at: 1, source_article_id: 1,
        retry_of_job_id: 1, client_request_id: 1, error_code: 1, error_message: 1,
      } }).toArray(),
      collection<any>(db, 'sites').find({
        ...(scope.customer_id ? { customer_id: scope.customer_id } : {}),
        ...(scope.site_id ? { _id: scope.site_id } : {}),
      }, { projection: { _id: 1, name: 1, customer_id: 1 } }).toArray(),
      collection<any>(db, 'customers').find(scope.customer_id ? { _id: scope.customer_id } : {},
        { projection: { _id: 1, name: 1 } }).toArray(),
      collection<any>(db, 'webhook_deliveries').find({
        ...(scope.site_id ? { site_id: scope.site_id } : {}), event: 'article.ready', $or: [
        { status: 'delivered', delivered_at: period }, { status: 'failed', updated_at: period },
      ] }, { projection: { job_id: 1, status: 1, delivered_at: 1 } }).toArray(),
      collection<any>(db, 'ai_attempts').find({ requested_at: period },
        { projection: { job_id: 1, requested_at: 1, cost_usd: 1, cost_source: 1 } }).toArray(),
    ])
    const jobs = new Map(rows.map(row => [row._id, row]))
    const siteMap = new Map(sites.map(site => [site._id, site]))
    const customerMap = new Map(customers.map(customer => [customer._id, customer]))
    const reportRow = (row: any) => reportJob({ ...row, customer: customerMap.get(row.customer_id), site: siteMap.get(row.site_id) })
    const zero = new ReportDecimal(0)
    type Point = { date: string, articles: number, delivered: number, service: Decimal, unpriced_attempts: number }
    const days = new Map<string, Point>()
    for (let day = start; day < end; day += DAY) {
      const date = localDay(day)
      days.set(date, { date, articles: 0, delivered: 0, service: zero, unpriced_attempts: 0 })
    }
    const pointAt = (time: Date) => days.get(localDay(time.getTime()))
    for (const row of rows) {
      if (row.status !== 'ready' || !row.completed_at) continue
      const point = pointAt(row.completed_at)
      if (point) point.articles += 1
    }
    let deliveryErrors = 0
    for (const delivery of deliveries) {
      if (!jobs.has(delivery.job_id)) continue
      if (delivery.status === 'failed') deliveryErrors += 1
      else {
        const point = pointAt(delivery.delivered_at)
        if (point) point.delivered += 1
      }
    }
    for (const attempt of attempts) {
      const mode = jobs.get(attempt.job_id)?.key_mode
      if (mode !== 'service') continue
      const point = pointAt(attempt.requested_at)
      if (!point) continue
      if (attempt.cost_usd != null && attempt.cost_usd !== '') point.service = point.service.plus(attempt.cost_usd)
      if (mode === 'service' && (attempt.cost_usd == null || attempt.cost_usd === '') && (attempt.cost_source === 'pending' || attempt.cost_source === undefined)) point.unpriced_attempts += 1
    }
    let articles = 0
    let delivered = 0
    let unpriced = 0
    let serviceCost = zero
    const series = Array.from(days.values(), ({ date, articles: written, delivered: sent, service, unpriced_attempts }) => {
      articles += written
      delivered += sent
      unpriced += unpriced_attempts
      serviceCost = serviceCost.plus(service)
      return { date, articles: written, delivered: sent, service_cost_usd: costValue(service), customer_cost_usd: costValue(zero), service_cost_vnd: costVnd(service), customer_cost_vnd: costVnd(zero), unpriced_attempts }
    })
    const failures = rows.filter(row => row.status === 'failed' && inRange(issueTime(row), from, to))
      .sort((a, b) => (b.updated_at ?? issueTime(b)).getTime() - (a.updated_at ?? issueTime(a)).getTime() || b._id.localeCompare(a._id))
    const upcoming = rows.filter(row => row.status === 'scheduled' && row.scheduled_at)
      .sort((a, b) => a.scheduled_at - b.scheduled_at || a._id.localeCompare(b._id))
    const selectedOwners = new Set(sites.map(site => site.customer_id))
    return {
      metrics: {
        customers: scope.site_id ? customers.filter(customer => selectedOwners.has(customer._id)).length : customers.length,
        websites: sites.length, articles, delivered,
        pending: rows.filter(row => ['scheduled', 'queued', 'writing'].includes(row.status)).length,
        write_errors: failures.length, delivery_errors: deliveryErrors,
        service_cost_usd: costValue(serviceCost), customer_cost_usd: costValue(zero),
        service_cost_vnd: costVnd(serviceCost), customer_cost_vnd: costVnd(zero),
        total_cost_vnd: costVnd(serviceCost), unpriced_attempts: unpriced,
      },
      series, upcoming: upcoming.slice(0, 10).map(reportRow), failures: failures.slice(0, 10).map(reportRow),
    }
  })

  app.get('/article-groups', async request => {
    const filters = listSchema.extend({ article_group_id: idSchema.optional(), status: z.enum(['scheduled', 'queued', 'writing', 'ready', 'completed', 'failed', 'canceled']).optional() }).parse(request.query)
    reportFilters.parse(filters)
    const all = await articleGroupRows(db, filters)
    const search = filters.q?.toLowerCase()
    const matching = new Set(all.filter(row =>
      (!search || `${row.article_group_id ?? row._id} ${row.article_ref ?? ''} ${row.result?.[0]?.Title ?? ''} ${row.translation_source?.Title ?? ''} ${row.keyword} ${row.site?.name ?? ''} ${row.customer?.name ?? ''}`.toLowerCase().includes(search))
      && (!filters.status || row.status === (filters.status === 'completed' ? 'ready' : filters.status))
      && inRange(row.created_at, filters.from ? dateStart(filters.from) : undefined, filters.to ? dateEnd(filters.to) : undefined)
    ).map(row => `${row.customer_id}:${row.site_id}:${row.article_group_id ?? row._id}`))
    const groups = groupArticleRows(all, reportJob).filter(group => matching.has(group.group_key) && (!filters.article_group_id || group.article_group_id === filters.article_group_id))
    const [cursorAt, cursorId] = readCursor(filters.cursor)
    const page = groups.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.article_group_id.localeCompare(a.article_group_id))
      .filter(row => !cursorAt || row.created_at < cursorAt || row.created_at === cursorAt && row.article_group_id < cursorId!)
      .slice(0, filters.limit + 1)
    return pageOf(page, filters.limit)
  })
  app.get('/jobs', async request => {
    const costVnd = convertVnd((await getRuntimeConfig()).usdToVnd)
    const filters = jobsSchema.parse(request.query)
    reportFilters.parse(filters)
    const from = filters.from ? dateStart(filters.from) : undefined
    const to = filters.to ? dateEnd(filters.to) : undefined
    const status = filters.status === 'completed' ? 'ready' : filters.status
    const source = filters.source === 'widget' ? 'preview' : filters.source === 'immediate' ? 'preview' : filters.source === 'schedule' ? 'scheduled' : filters.source
    const search = filters.q?.toLowerCase()
    const byCost = filters.date_basis === 'cost'
    const now = Date.now()
    const jobDate = (row: any) => {
      if (status === 'ready') return row.completed_at
      if (status === 'failed') return issueTime(row)
      if (status === 'scheduled') return row.scheduled_at
      return row.created_at
    }
    let rows = (await joinedJobs(db, filters)).filter(row =>
      (byCost || inRange(jobDate(row), from, to)) && (!status || row.status === status) && (!filters.article_group_id || (row.article_group_id ?? row._id) === filters.article_group_id)
      && (!source || row.mode === source) && (!filters.provider || row.provider === filters.provider)
      && (!filters.key_mode || row.key_mode === filters.key_mode)
      && (!byCost || row.key_mode === 'service')
      && (!filters.issue || filters.issue === 'unpriced'
        || (filters.issue === 'queue' && writingQueue(row, now))
        || (filters.issue === 'overdue' && overdueSchedule(row, now))
        || (filters.issue === 'future' && row.status === 'scheduled' && (runtimeTime(row.scheduled_at) ?? -Infinity) > now)
        || (filters.issue === 'stale' && row.status === 'writing' && !hasRuntimeLease(row, now)))
      && (!search || `${row.keyword} ${row._id} ${row.client_request_id ?? ''}`.toLowerCase().includes(search)),
    )
    if (filters.issue === 'unpriced') {
      const ids = rows.filter(row => row.key_mode === 'service').map(row => row._id)
      const attempts = ids.length ? await collection<any>(db, 'ai_attempts').find({
        ...pendingCostFilter(), job_id: { $in: ids },
        ...(byCost && (from || to) ? { requested_at: { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) } } : {}),
      }, { projection: { job_id: 1 } }).toArray() : []
      const pendingIds = new Set(attempts.map(attempt => attempt.job_id))
      rows = rows.filter(row => pendingIds.has(row._id))
    }
    const attemptsByJob = new Map<string, Decimal | null>()
    function recordCost(attempt: any) {
      const cost = attemptsByJob.get(attempt.job_id) ?? null
      attemptsByJob.set(attempt.job_id, attempt.cost_usd == null || attempt.cost_usd === '' ? cost : (cost ?? new ReportDecimal(0)).plus(attempt.cost_usd))
    }
    if (byCost && rows.length) {
      const matchingIds = new Set(rows.map(row => row._id))
      const attempts = await collection<any>(db, 'ai_attempts').find({
        ...((from || to) ? { requested_at: { ...(from ? { $gte: from } : {}), ...(to ? { $lt: to } : {}) } } : {}),
      }, { projection: { job_id: 1, cost_usd: 1 } }).toArray()
      for (const attempt of attempts) if (matchingIds.has(attempt.job_id)) recordCost(attempt)
      rows = rows.filter(row => attemptsByJob.has(row._id))
    }
    const page = sortedPage(rows, filters.cursor, filters.limit)
    const serviceIds = page.filter(row => row.key_mode === 'service').map(row => row._id)
    if (!byCost && serviceIds.length) {
      const attempts = await collection<any>(db, 'ai_attempts').find({ job_id: { $in: serviceIds } },
        { projection: { job_id: 1, cost_usd: 1 } }).toArray()
      for (const attempt of attempts) recordCost(attempt)
    }
    const labelConnection = await connectionLabels(db, page)
    return pageOf(page.map(row => ({ ...reportJob(labelConnection(row)), ...cursorFields(row), cost_usd: attemptsByJob.get(row._id)?.toFixed(12) ?? null, cost_vnd: costVnd(attemptsByJob.get(row._id)) })), filters.limit)
  })
  app.delete('/jobs/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    await transaction(db, async client => {
      const session = sessionOf(client)
      const job = await collection<any>(client, 'jobs').findOne({ _id: id }, { session })
      if (!job) throw notFound()
      // Serialize source deletion with creation of another job for this website.
      await collection(client, 'sites').updateOne({ _id: job.site_id }, { $inc: { relation_version: 1 } }, { session })
      if (job.status === 'writing') throw new ApiError(409, 'job_in_progress', 'Không thể xóa yêu cầu đang được xử lý. Hãy chờ tiến trình kết thúc rồi thử lại.')
      if (await collection(client, 'jobs').findOne({ source_article_id: id, status: 'writing' }, { projection: { _id: 1 }, session })) throw new ApiError(409, 'job_in_progress', 'Bài viết đang được dùng làm nguồn cho một yêu cầu viết lại. Hãy chờ tiến trình kết thúc rồi thử lại.')
      if (await collection(client, 'jobs').findOne({ translation_of_job_id: id }, { projection: { _id: 1 }, session })) throw new ApiError(409, 'article_has_translations', 'Bài này đang là nguồn của các bản dịch. Hãy xử lý các bản dịch trước khi xóa bản gốc.')
      if (await collection(client, 'jobs').findOne({ original_job_id: id, translation_source: { $exists: true } }, { projection: { _id: 1 }, session })) throw new ApiError(409, 'article_has_translations', 'Bài gốc đang được các bản dịch tham chiếu. Hãy xử lý các bản dịch trước khi xóa bản gốc.')
      const deliveries = await collection<any>(client, 'webhook_deliveries').find({ job_id: id }, { projection: { _id: 1, status: 1 }, session }).toArray()
      if (deliveries.some(delivery => delivery.status === 'sending')) throw new ApiError(409, 'job_in_progress', 'Bài viết đang được gửi đến website. Hãy chờ tiến trình kết thúc rồi thử lại.')
      const deliveryIds = deliveries.map(delivery => delivery._id)
      if (deliveryIds.length) await collection(client, 'webhook_attempts').deleteMany({ delivery_id: { $in: deliveryIds } }, { session })
      await collection(client, 'ai_attempts').deleteMany({ job_id: id }, { session })
      await collection(client, 'webhook_deliveries').deleteMany({ job_id: id }, { session })
      // Deleting stored content must not refund an already consumed writing allowance.
      await collection(client, 'quota_reservations').deleteMany({ job_id: id, status: { $ne: 'used' } }, { session })
      await collection(client, 'jobs').updateMany({ source_article_id: id }, { $set: { source_article_id: null, updated_at: new Date() } }, { session })
      await collection(client, 'jobs').updateMany({ retry_of_job_id: id }, { $set: { retry_of_job_id: null, updated_at: new Date() } }, { session })
      await collection(client, 'jobs').deleteOne({ _id: id }, { session })
    })
    publishJobEvent(db, { type: 'job.deleted', job_id: id, deleted: true })
    return reply.code(204).send()
  })
  app.get('/jobs/:id', async (request, reply) => {
    const costVnd = convertVnd((await getRuntimeConfig()).usdToVnd)
    const { id } = idParams.parse(request.params)
    const row = await collection<any>(db, 'jobs').findOne({ _id: id })
    if (!row) throw notFound()
    const [customer, site, attempts, deliveries] = await Promise.all([
      collection<any>(db, 'customers').findOne({ _id: row.customer_id }),
      collection<any>(db, 'sites').findOne({ _id: row.site_id }),
      collection<any>(db, 'ai_attempts').find({ job_id: id }).sort({ requested_at: 1 }).toArray(),
      collection<any>(db, 'webhook_deliveries').find({ job_id: id }).sort({ created_at: 1 }).toArray(),
    ])
    const labelConnection = await connectionLabels(db, [row, ...attempts])
    const ready = row.status === 'ready'
    const trackCost = row.key_mode === 'service'
    const pricedAttempts = trackCost ? attempts.filter(attempt => attempt.cost_usd != null && attempt.cost_usd !== '') : []
    const cost = pricedAttempts.length ? pricedAttempts.reduce((sum, attempt) => sum.plus(String(attempt.cost_usd)), new ReportDecimal(0)) : null
    reply.header('Cache-Control', 'no-store')
    return {
      ...reportJob(labelConnection({ ...row, customer, site })),
      cost_usd: cost == null ? null : costValue(cost),
      cost_vnd: costVnd(cost),
      rewrite_key_mode: row.key_mode === 'own' ? 'own' : customer?.key_mode ?? row.key_mode,
      outline: ready ? row.outline ?? null : null,
      result: ready && Array.isArray(row.result) ? row.result.map(normalizeArticleFields) : ready ? row.result : null,
      seo_report: ready ? row.seo_report ?? null : null,
      seo_repair_status: ready ? row.seo_repair_status ?? null : null,
      internal_link_report: ready ? row.internal_link_report ?? null : null,
      instructions: row.instructions,
      translation_source: row.translation_source ?? null,
      attempts: attempts.map(attempt => ({
        id: attempt._id, provider: attempt.provider, model: attempt.model,
        ...(labelConnection(attempt).upstream_model ? { upstream_model: labelConnection(attempt).upstream_model } : {}),
        stage: attempt.stage ?? null,
        status: attempt.status, started_at: attempt.requested_at, called_at: attempt.requested_at,
        pricing_id: trackCost ? attempt.pricing_id : null, pricing_snapshot: trackCost ? attempt.pricing_snapshot : null, provider_response_id: attempt.provider_response_id,
        usage: attempt.usage, finished_at: attempt.finished_at, cost_usd: trackCost ? attempt.cost_usd : null, cost_vnd: trackCost ? costVnd(attempt.cost_usd) : null, cost_source: trackCost ? attempt.cost_source : null,
        error_code: attempt.error_code, error_message: attempt.error,
      })),
      deliveries: await Promise.all(deliveries.map(delivery => deliveryView(db, delivery))),
    }
  })
  app.get('/deliveries', async request => {
    const filters = deliveriesSchema.parse(request.query)
    reportFilters.parse(filters)
    const from = filters.from ? dateStart(filters.from) : undefined
    const to = filters.to ? dateEnd(filters.to) : undefined
    const search = filters.q?.toLowerCase()
    const now = Date.now()
    const [rows, deliveries] = await Promise.all([
      joinedJobs(db, filters),
      collection<any>(db, 'webhook_deliveries').find({
        ...(filters.website_id ? { site_id: filters.website_id } : {}),
        ...(filters.status ? { status: filters.status } : {}), ...(filters.event ? { event: filters.event } : {}),
      }).toArray(),
    ])
    const jobs = new Map(rows.map(row => [row._id, row]))
    const matched = deliveries.filter(delivery => {
      const job = jobs.get(delivery.job_id)
      const time = filters.status === 'delivered' ? delivery.delivered_at : filters.status === 'failed' ? delivery.updated_at : delivery.created_at
      return job && inRange(time, from, to)
        && (!filters.issue || (filters.issue === 'queue' && deliveryQueue(delivery, now))
          || (filters.issue === 'stale' && delivery.status === 'sending' && !hasRuntimeLease(delivery, now)))
        && (!search || `${delivery.job_id} ${delivery._id} ${job.site?.name ?? ''} ${job.keyword}`.toLowerCase().includes(search))
    })
    const page = sortedPage(matched, filters.cursor, filters.limit)
    const data = await Promise.all(page.map(async delivery => ({ ...await deliveryView(db, delivery), ...cursorFields(delivery) })))
    return pageOf(data, filters.limit)
  })
  app.get('/deliveries/:id', async request => { const { id } = idParams.parse(request.params); const delivery = await collection<any>(db, 'webhook_deliveries').findOne({ _id: id }); if (!delivery) throw notFound(); return deliveryView(db, delivery) })
  app.post('/deliveries/:id/retry', async request => {
    const { id } = idParams.parse(request.params)
    const jobId = await transaction(db, async source => {
      const session = sessionOf(source)
      const deliveries = collection(source, 'webhook_deliveries')
      const delivery = await deliveries.findOne({ _id: id }, { session })
      if (!delivery) throw notFound()
      if (!['failed', 'delivered'].includes(delivery.status)) throw new ApiError(409, 'delivery_not_retryable', 'Chỉ có thể gửi lại lần giao đã hoàn tất hoặc bị lỗi. Hãy chờ lần giao đang xử lý kết thúc.')
      // Parent deletion and retention take the same website lock. Recheck the
      // article while holding it so a resent event cannot lose its payload.
      const site = await collection(source, 'sites').updateOne({ _id: delivery.site_id }, { $inc: { relation_version: 1 } }, { session })
      if (!site.matchedCount || !await collection(source, 'jobs').findOne({ _id: delivery.job_id, site_id: delivery.site_id }, { session, projection: { _id: 1 } })) throw notFound()
      const time = new Date()
      const result = await deliveries.updateOne({ _id: id, status: delivery.status }, { $set: {
        status: 'pending', attempt_count: 0, next_attempt_at: time, error: null,
        http_status: null, delivered_at: null, id_post: null, acknowledged_at: null,
        lease_token: null, lease_expires_at: null, updated_at: time,
      } }, { session })
      if (!result.matchedCount) throw new ApiError(409, 'delivery_changed', 'Trạng thái giao bài đã thay đổi. Hãy tải lại rồi thử lại.')
      return delivery.job_id
    })
    publishJobEvent(db, { type: 'job.updated', job_id: jobId })
    return { id, status: 'pending' }
  })
  app.delete('/deliveries/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    const jobId = await transaction(db, async source => {
      const session = sessionOf(source)
      const deliveries = collection(source, 'webhook_deliveries')
      const delivery = await deliveries.findOne({ _id: id }, { session })
      if (!delivery) throw notFound()
      if (!['pending', 'delivered', 'failed'].includes(delivery.status)) throw new ApiError(409, 'delivery_in_progress', 'Không thể xóa lần giao đang được gửi. Hãy chờ tiến trình kết thúc rồi thử lại.')
      // A missing historical parent does not prevent removing an orphaned
      // delivery, but an existing website serializes with parent deletion.
      await collection(source, 'sites').updateOne({ _id: delivery.site_id }, { $inc: { relation_version: 1 } }, { session })
      const filter = { _id: id, status: delivery.status }
      const locked = await deliveries.updateOne(filter, { $inc: { action_version: 1 } }, { session })
      if (!locked.matchedCount) throw new ApiError(409, 'delivery_changed', 'Trạng thái giao bài đã thay đổi. Hãy tải lại rồi thử lại.')
      await collection(source, 'webhook_attempts').deleteMany({ delivery_id: id }, { session })
      const removed = await deliveries.deleteOne(filter, { session })
      if (!removed.deletedCount) throw new ApiError(409, 'delivery_changed', 'Trạng thái giao bài đã thay đổi. Hãy tải lại rồi thử lại.')
      return delivery.job_id
    })
    publishJobEvent(db, { type: 'job.updated', job_id: jobId })
    return reply.code(204).send()
  })
}

async function deliveryView(db: Database, delivery: any) {
  const job = await collection<any>(db, 'jobs').findOne({ _id: delivery.job_id })
  const site = await collection<any>(db, 'sites').findOne({ _id: delivery.site_id })
  const customer = job ? await collection<any>(db, 'customers').findOne({ _id: job.customer_id }) : null
  const attempts = await collection<any>(db, 'webhook_attempts').find({ delivery_id: delivery._id }).sort({ attempted_at: 1 }).toArray()
  return {
    id: delivery._id, job_id: delivery.job_id, website_id: delivery.site_id,
    website_name: site?.name ?? '', customer_name: customer?.name ?? '', keyword: job?.keyword,
    status: delivery.status, event_type: delivery.event, attempts: attempts.length, attempt_count: delivery.attempt_count,
    last_http_status: delivery.http_status ?? null, last_error: delivery.error ?? null,
    id_post: delivery.id_post ?? null, acknowledged_at: delivery.acknowledged_at ?? null,
    next_attempt_at: delivery.next_attempt_at, delivered_at: delivery.delivered_at ?? null, created_at: delivery.created_at,
    history: attempts.map(attempt => ({
      id: attempt._id, attempted_at: attempt.attempted_at, started_at: attempt.attempted_at, finished_at: attempt.finished_at,
      http_status: attempt.http_status, error: attempt.error, id_post: attempt.id_post ?? null, acknowledged_at: attempt.acknowledged_at ?? null,
    })),
  }
}
// @ts-nocheck
