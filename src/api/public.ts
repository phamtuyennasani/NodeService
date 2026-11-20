import { createHmac, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Config, Provider } from '../config.js'
import { collection, transaction, type Database, type MongoSource } from '../db.js'
import { digest, seal } from '../security.js'
import { listAvailableModels, modelIdSchema, requireAvailableModel } from './catalog.js'
import { ApiError, articleLengthSchema, idSchema, notFound, periodSchema, timestampSchema } from './errors.js'
import { assertPackage, reserveQuota, usage, type Package } from './quota.js'

export interface Site { id: string; customer_id: string; token_hash: string | null; webhook_url: string | null; webhook_secret: string | null }
interface CustomerDoc extends Package { _id: string; name: string; email: string | null; phone: string | null; notes: string | null; updated_at: Date; created_at: Date }
interface JobDoc { _id: string; site_id: string; customer_id: string; client_request_id: string; request_hash: string; mode: 'scheduled' | 'preview' | 'rewrite'; source_article_id: string | null; retry_of_job_id: string | null; version: number; provider: Provider; model: string; keyword: string; tone: string; style: string; length: number; instructions: string | null; key_mode: 'own' | 'service'; encrypted_key: string | null; status: string; scheduled_at: Date | null; available_at: Date; attempt_count: number; lease_token: string | null; lease_expires_at: Date | null; started_at: Date | null; completed_at: Date | null; result: unknown[] | null; error_code: string | null; error_message: string | null; created_at: Date; updated_at: Date }

const writingFields = z.object({
  model: modelIdSchema, keyword: z.string().trim().min(1).max(500), tone: z.string().trim().min(1).max(240), style: z.string().trim().min(1).max(500),
  length: articleLengthSchema, instructions: z.string().trim().max(4000).optional(), keyAI: z.string().trim().min(1).max(2048).optional(),
})
const createFields = writingFields.extend({ mode: z.enum(['scheduled', 'preview']).optional(), scheduled_at: timestampSchema.optional() }).strict()
const patchFields = writingFields.partial().extend({ scheduled_at: timestampSchema.optional() }).strict().refine(body => Object.keys(body).length > 0, 'Cần ít nhất một trường thay đổi.')
const rewriteFields = writingFields.pick({ instructions: true, keyAI: true }).strict()
const jobParams = z.object({ job_id: idSchema })
export type Writing = z.infer<typeof writingFields>
type Mode = 'scheduled' | 'preview' | 'rewrite'

const asSite = (row: Record<string, unknown> | null): Site | null => row ? ({ id: String(row._id), customer_id: String(row.customer_id), token_hash: row.token_hash as string | null, webhook_url: row.webhook_url as string | null, webhook_secret: row.webhook_secret as string | null }) : null
const asPackage = (row: CustomerDoc): Package => ({ id: row._id, key_mode: row.key_mode, daily_limit: row.daily_limit, monthly_limit: row.monthly_limit, starts_at: row.starts_at, ends_at: row.ends_at, allowed_models: row.allowed_models ?? [], max_length: row.max_length })

async function authenticateSite(db: Database, request: FastifyRequest) {
  const auth = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{16,256})$/i)
  if (auth) {
    const tokenHash = digest(auth[1])
    const row = await collection(db, 'sites').findOne({ token_hash: tokenHash })
    if (row) {
      await collection(db, 'sites').updateOne({ _id: row._id, token_hash: tokenHash, $or: [{ last_used_at: { $exists: false } }, { last_used_at: { $lt: new Date(Date.now() - 60_000) } }] }, { $set: { last_used_at: new Date() } })
      return asSite(row as Record<string, unknown>)!
    }
  }
  throw new ApiError(401, 'invalid_site_token', 'Token website không hợp lệ.')
}

async function lockedCustomer(source: MongoSource, id: string) {
  const customer = await collection<CustomerDoc>(source, 'customers').findOne({ _id: id })
  if (!customer) throw notFound()
  return asPackage(customer)
}

function requestId(request: FastifyRequest) { return z.string().min(1).max(160).regex(/^[\x21-\x7E]+$/).parse(request.headers['idempotency-key']) }
function requestFingerprint(input: unknown, config: Config) { return createHmac('sha256', config.encryptionKey).update(JSON.stringify(input)).digest('hex') }
function encryptedKeyFor(writing: Writing, customer: Package, config: Config, previousKey?: string | null) {
  if (customer.key_mode === 'service') return null
  const encrypted = writing.keyAI ? seal(writing.keyAI, config.encryptionKey) : previousKey
  if (!encrypted) throw new ApiError(400, 'key_required', 'Cần gửi keyAI cho chế độ dùng key riêng.')
  return encrypted
}

function summary(job: JobDoc) { return { job_id: job._id, status: job.status, scheduled_at: job.scheduled_at, version: job.version, source_article_id: job.source_article_id, retry_of_job_id: job.retry_of_job_id ?? null } }

export async function createJob(db: Database, config: Config, site: Site, clientId: string, writing: Writing, mode: Mode, scheduled: string | undefined, sourceId?: string, retryOfJobId?: string) {
  const scheduledAt = scheduled ? new Date(scheduled) : null
  const fingerprint = requestFingerprint({ writing, mode, scheduledAt, sourceId, retryOfJobId }, config)
  return transaction(db, async client => {
    const currentSite = await collection(client, 'sites').findOne({ _id: site.id, customer_id: site.customer_id, token_hash: site.token_hash })
    if (!currentSite) throw new ApiError(401, 'invalid_site_token', 'Token hoặc chủ sở hữu website đã thay đổi. Vui lòng kết nối lại.')
    const customer = await lockedCustomer(client, site.customer_id)
    const existing = await collection<JobDoc>(client, 'jobs').findOne({ site_id: site.id, client_request_id: clientId })
    if (existing) {
      if (existing.request_hash !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'Mã yêu cầu này đã được dùng với nội dung khác.')
      return summary(existing)
    }
    const now = new Date()
    if (scheduledAt && scheduledAt <= now) throw new ApiError(400, 'invalid_schedule_time', 'Giờ hẹn phải ở tương lai.')
    if (mode === 'scheduled' && (!currentSite.webhook_url || !currentSite.webhook_secret)) throw new ApiError(422, 'webhook_not_configured', 'Website cần URL và khóa ký webhook để nhận bài theo lịch viết.')
    const availableAt = scheduledAt ?? now
    assertPackage(customer, availableAt, writing.model, writing.length)
    const provider = await requireAvailableModel(client, writing.model)
    const settings = await collection<{ _id: Provider, base_url?: string | null, encrypted_api_key?: string | null }>(client, 'ai_providers').findOne({ _id: provider })
    if (provider === 'openai-compatible' && !settings?.base_url) throw new ApiError(422, 'provider_not_configured', 'OpenAI Compatible chưa được cấu hình Base URL trong CRM.')
    const serviceConfigured = provider === 'openai-compatible' ? Boolean(settings?.encrypted_api_key && settings.base_url) : Boolean(config.serviceKeys[provider])
    if (customer.key_mode === 'service' && !serviceConfigured) throw new ApiError(422, 'service_key_unavailable', 'Nhà cung cấp này chưa được cấu hình key dịch vụ.')
    const job: JobDoc = {
      _id: randomUUID(), site_id: site.id, customer_id: customer.id, client_request_id: clientId, request_hash: fingerprint, mode, source_article_id: sourceId ?? null, retry_of_job_id: retryOfJobId ?? null,
      version: 1, provider, model: writing.model, keyword: writing.keyword, tone: writing.tone, style: writing.style, length: writing.length, instructions: writing.instructions ?? null,
      key_mode: customer.key_mode, encrypted_key: encryptedKeyFor(writing, customer, config), status: mode === 'scheduled' ? 'scheduled' : 'queued', scheduled_at: scheduledAt, available_at: availableAt,
      attempt_count: 0, lease_token: null, lease_expires_at: null, started_at: null, completed_at: null, result: null, error_code: null, error_message: null, created_at: now, updated_at: now,
    }
    await collection(client, 'jobs').insertOne(job)
    await reserveQuota(client, customer, job._id, availableAt)
    return summary(job)
  })
}

const scheduleStatuses = ['scheduled', 'queued', 'writing', 'ready', 'failed', 'canceled'] as const
const listFields = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), q: z.string().trim().max(160).optional(), from: periodSchema.optional(), to: periodSchema.optional(), status: z.enum([...scheduleStatuses, 'all']).optional() }).refine(query => !query.from || !query.to || query.from <= query.to, 'Ngày bắt đầu phải trước ngày kết thúc.')

export function readCursor(cursor?: string, sortField = z.string().regex(/^\d{4}-\d{2}-\d{2}/)) {
  if (!cursor) return [null, null] as [string | null, string | null]
  try { return z.tuple([sortField, idSchema]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString())) }
  catch { throw new ApiError(400, 'invalid_cursor', 'Mã phân trang không hợp lệ.') }
}
export function pageOf<T extends { cursor_at: string, cursor_id: string }>(rows: T[], limit: number) {
  const displayed = rows.slice(0, limit)
  const last = displayed.at(-1)
  return { data: displayed.map(({ cursor_at: _at, cursor_id: _id, ...item }) => item), next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.cursor_at, last.cursor_id])).toString('base64url') : null }
}

function dayStart(date: string) { return new Date(`${date}T00:00:00+07:00`) }
function dayEnd(date: string) { return new Date(`${date}T00:00:00+07:00`).getTime() + 86_400_000 }
function toIso(value: Date | null | undefined) { return value?.toISOString() ?? null }

async function siteCatalog(db: Database, config: Config, request: FastifyRequest) {
  const site = await authenticateSite(db, request)
  const customerDoc = await collection<CustomerDoc>(db, 'customers').findOne({ _id: site.customer_id })
  if (!customerDoc) throw notFound()
  const customer = asPackage(customerDoc)
  const service = customer.key_mode === 'service'
  const models = await listAvailableModels(db, service ? customer.allowed_models : undefined)
  const configured = await collection<{ _id: Provider, base_url?: string | null, encrypted_api_key?: string | null }>(db, 'ai_providers').find({ enabled: true }).toArray()
  const ready = new Set(configured.filter(row => row._id === 'openai-compatible' ? Boolean(row.base_url) && (!service || Boolean(row.encrypted_api_key)) : !service || Boolean(config.serviceKeys[row._id])).map(row => row._id))
  return { site, customer, models: models.filter(model => ready.has(model.provider)) }
}

export function registerPublic(app: FastifyInstance, db: Database, config: Config) {
  app.post('/v1/article-jobs', async (request, reply) => {
    const site = await authenticateSite(db, request)
    const { mode, scheduled_at, ...writing } = createFields.parse(request.body)
    const chosenMode = mode ?? (scheduled_at ? 'scheduled' : 'preview')
    if ((chosenMode === 'scheduled') !== Boolean(scheduled_at)) throw new ApiError(400, 'invalid_schedule_time', 'Giờ hẹn buộc với lịch viết và dành riêng cho lịch viết.')
    return reply.code(202).send(await createJob(db, config, site, requestId(request), writing, chosenMode, scheduled_at))
  })

  app.get('/v1/models', async request => ({ data: (await siteCatalog(db, config, request)).models }))
  app.get('/v1/usage', async request => {
    const { customer, models } = await siteCatalog(db, config, request)
    const { date } = z.object({ date: periodSchema.optional() }).parse(request.query)
    return { ...(await usage(db, customer, date ? dayStart(date) : new Date())), allowed_models: models.map(model => model.model) }
  })

  app.get('/v1/article-jobs/:job_id', async request => {
    const site = await authenticateSite(db, request)
    const { job_id } = jobParams.parse(request.params)
    const job = await collection<JobDoc>(db, 'jobs').findOne({ _id: job_id, site_id: site.id })
    if (!job) throw notFound()
    const delivery = await collection<{ status: string }>(db, 'webhook_deliveries').findOne({ job_id }, { sort: { created_at: -1 } })
    return { job_id: job._id, status: job.status, mode: job.mode, source_article_id: job.source_article_id, scheduled_at: toIso(job.scheduled_at), version: job.version, started_at: toIso(job.started_at), completed_at: toIso(job.completed_at), error_code: job.error_code, error_message: job.error_message, created_at: job.created_at.toISOString(), delivery_status: delivery?.status ?? null }
  })
  app.get('/v1/article-jobs/:job_id/result', async (request, reply) => {
    const site = await authenticateSite(db, request); const { job_id } = jobParams.parse(request.params)
    const job = await collection<JobDoc>(db, 'jobs').findOne({ _id: job_id, site_id: site.id }); if (!job) throw notFound()
    if (job.status === 'ready') return job.result
    if (job.status === 'failed' || job.status === 'canceled') throw new ApiError(409, job.error_code ?? job.status, job.error_message ?? 'Yêu cầu đã dừng.')
    return reply.code(202).send({ status: job.status })
  })

  app.get('/v1/articles', async request => {
    const site = await authenticateSite(db, request); const { from, to, q, cursor, limit } = listFields.parse(request.query); const [cursorAt, cursorId] = readCursor(cursor)
    const filter: Record<string, unknown> = { site_id: site.id, status: 'ready' }
    if (from || to) filter.completed_at = { ...(from ? { $gte: dayStart(from) } : {}), ...(to ? { $lt: new Date(dayEnd(to)) } : {}) }
    const jobs = await collection<JobDoc>(db, 'jobs').find(filter).sort({ completed_at: -1, _id: -1 }).toArray()
    const rows = jobs.filter(job => !q || job.keyword.toLowerCase().includes(q.toLowerCase()) || String((job.result?.[0] as Record<string, unknown> | undefined)?.Title ?? '').toLowerCase().includes(q.toLowerCase()))
      .filter(job => !cursorAt || job.completed_at && (job.completed_at.toISOString() < cursorAt || (job.completed_at.toISOString() === cursorAt && job._id < cursorId!)))
      .slice(0, limit + 1).map(job => ({ article_id: job._id, source_article_id: job.source_article_id, Title: (job.result?.[0] as Record<string, unknown> | undefined)?.Title, keyword: job.keyword, model: job.model, mode: job.mode, completed_at: toIso(job.completed_at), cursor_at: job.completed_at!.toISOString(), cursor_id: job._id }))
    return pageOf(rows, limit)
  })

  app.get('/v1/schedules', async request => {
    const site = await authenticateSite(db, request); const { from, to, cursor, limit, status = 'scheduled' } = listFields.parse(request.query); const [cursorAt, cursorId] = readCursor(cursor)
    const jobs = await collection<JobDoc>(db, 'jobs').find({ site_id: site.id, mode: 'scheduled' }).sort({ scheduled_at: 1, _id: 1 }).toArray()
    const rows = jobs.filter(job => (!from || (job.scheduled_at && job.scheduled_at >= dayStart(from))) && (!to || (job.scheduled_at && job.scheduled_at < new Date(dayEnd(to)))) && (status === 'all' || job.status === status) && (!cursorAt || job.scheduled_at && (job.scheduled_at.toISOString() > cursorAt || (job.scheduled_at.toISOString() === cursorAt && job._id > cursorId!))))
      .slice(0, limit + 1).map(job => ({ job_id: job._id, status: job.status, version: job.version, scheduled_at: job.scheduled_at, model: job.model, keyword: job.keyword, tone: job.tone, style: job.style, length: job.length, instructions: job.instructions, cursor_at: job.scheduled_at!.toISOString(), cursor_id: job._id }))
    return pageOf(rows, limit)
  })

  app.patch('/v1/schedules/:job_id', async (request, reply) => {
    const site = await authenticateSite(db, request); const { job_id } = jobParams.parse(request.params); const patch = patchFields.parse(request.body)
    const match = typeof request.headers['if-match'] === 'string' ? /^"?(\d+)"?$/.exec(request.headers['if-match'])?.[1] : undefined; if (!match) throw new ApiError(428, 'version_required', 'Gửi version hiện tại trong header If-Match.')
    const updated = await transaction(db, async client => {
      const job = await collection<JobDoc>(client, 'jobs').findOne({ _id: job_id, site_id: site.id, mode: 'scheduled' }); if (!job) throw notFound(); if (job.status !== 'scheduled') throw scheduleConflict(job.status); if (job.version !== Number(match)) throw new ApiError(412, 'version_conflict', 'Lịch đã thay đổi. Hãy tải lại.', { version: job.version })
      const customer = await lockedCustomer(client, site.customer_id); const when = patch.scheduled_at ? new Date(patch.scheduled_at) : job.scheduled_at!; if (patch.scheduled_at && when <= new Date()) throw new ApiError(400, 'invalid_schedule_time', 'Giờ hẹn phải ở tương lai.')
      const writing = { model: job.model, keyword: job.keyword, tone: job.tone, style: job.style, length: job.length, instructions: job.instructions ?? undefined, ...patch }; assertPackage({ ...customer, key_mode: job.key_mode }, when, writing.model, writing.length)
      const provider = writing.model === job.model ? job.provider : await requireAvailableModel(client, writing.model); const oldKey = provider === job.provider ? job.encrypted_key : null; const encrypted = encryptedKeyFor(writing, { ...customer, key_mode: job.key_mode }, config, oldKey)
      await reserveQuota(client, { ...customer, key_mode: job.key_mode }, job_id, when, await collection<{ quota_day: string, quota_month: string }>(client, 'quota_reservations').findOne({ job_id, status: 'reserved' }) ?? undefined)
      const next = { ...patch, scheduled_at: when, model: writing.model, keyword: writing.keyword, tone: writing.tone, style: writing.style, length: writing.length, instructions: writing.instructions ?? null, provider, encrypted_key: encrypted, available_at: when, version: job.version + 1, updated_at: new Date() }
      await collection(client, 'jobs').updateOne({ _id: job_id }, { $set: next })
      return { job_id, status: job.status, version: next.version, scheduled_at: when, model: next.model, keyword: next.keyword, tone: next.tone, style: next.style, length: next.length, instructions: next.instructions }
    })
    return reply.header('ETag', `"${updated.version}"`).send(updated)
  })
  app.delete('/v1/schedules/:job_id', async (request, reply) => {
    const site = await authenticateSite(db, request); const { job_id } = jobParams.parse(request.params)
    await transaction(db, async client => { const job = await collection<JobDoc>(client, 'jobs').findOne({ _id: job_id, site_id: site.id, mode: 'scheduled' }); if (!job) throw notFound(); if (job.status === 'canceled') return; if (job.status !== 'scheduled') throw scheduleConflict(job.status); await collection(client, 'jobs').updateOne({ _id: job_id }, { $set: { status: 'canceled', encrypted_key: null, updated_at: new Date() }, $inc: { version: 1 } }); await collection(client, 'quota_reservations').updateOne({ job_id, status: 'reserved' }, { $set: { status: 'released' } }) })
    return reply.code(204).send()
  })
  app.post('/v1/articles/:article_id/rewrites', async (request, reply) => {
    const site = await authenticateSite(db, request); const { article_id } = z.object({ article_id: idSchema }).parse(request.params); const additions = rewriteFields.parse(request.body ?? {})
    const article = await collection<JobDoc>(db, 'jobs').findOne({ _id: article_id, site_id: site.id, status: 'ready' }); if (!article) throw notFound()
    const instructions = [article.instructions, additions.instructions].filter(Boolean).join('\n\n').slice(-8000)
    return reply.code(202).send(await createJob(db, config, site, requestId(request), { model: article.model, keyword: article.keyword, tone: article.tone, style: article.style, length: article.length, instructions: instructions || undefined, keyAI: additions.keyAI }, 'rewrite', undefined, article_id))
  })
}

async function lockSchedule(source: MongoSource, siteId: string, jobId: string) { const job = await collection<JobDoc>(source, 'jobs').findOne({ _id: jobId, site_id: siteId, mode: 'scheduled' }); if (!job) throw notFound(); return job }
function scheduleConflict(status: string) { return new ApiError(409, 'schedule_not_editable', 'Chỉ có thể thay đổi lịch còn chờ.', { status }) }
// @ts-nocheck
