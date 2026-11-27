import { createHmac, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { isCompatibleProvider, type Config, type Provider } from '../config.js'
import { collection, sessionOf, transaction, type Database, type TransactionContext, type MongoSource } from '../db.js'
import { digest } from '../security.js'
import { decodeOwnConnection, encodeOwnConnection, ownApiKeySchema, ownBaseUrlSchema, ownModelSchema } from '../own-connection.js'
import { serviceKeyState } from '../provider-key.js'
import { listModelsForCustomer, modelIdSchema, providerIdSchema, requireAvailableModel } from './catalog.js'
import { ApiError, articleLengthSchema, idSchema, notFound, periodSchema, timestampSchema } from './errors.js'
import { assertPackage, reserveQuota, usage, type Package } from './quota.js'
import { normalizeArticleFields } from '../worker/provider.js'
import { publishJobEvent } from '../job-events.js'
import { registerSiteContent } from './site-content.js'
import { excludedContentIdsSchema } from '../site-content.js'
import type { SeoReport } from '../worker/seo.js'
import type { WritingStage } from '../writing-stage.js'
import { clientAddress } from '../request-security.js'
import { sameWidgetToken, widgetGrantSeconds, widgetOrigin, widgetReadToken, widgetSignature } from '../widget-access.js'
import { admitSiteProof, installSiteProofParser, siteProofRequired, siteSecurityFilter, verifySiteRequest, type SiteSecurity } from '../site-proof.js'
import { languageConfigSchema, languageMetadata, languageSummary, localeSchema, translationSourceSchema, validateWritingLanguage, type LanguageWriting } from '../article-language.js'
import { articleIdentity, articleIdentityFields, resolveArticleIdentity, type ArticleIdentity } from '../article-group.js'

export interface Site extends SiteSecurity { customer_id: string; webhook_url: string | null; webhook_secret: string | null; widget_origin?: string; widget_domain?: string }
interface CustomerDoc extends Package { _id: string; name: string; email: string | null; phone: string | null; notes: string | null; updated_at: Date; created_at: Date }
interface JobDoc extends LanguageWriting, ArticleIdentity { _id: string; site_id: string; customer_id: string; client_request_id: string; request_hash: string; mode: 'scheduled' | 'preview' | 'rewrite'; widget_origin?: string; source_article_id: string | null; retry_of_job_id: string | null; version: number; provider: Provider; model: string; keyword: string; tone: string; style: string; length: number; instructions: string | null; use_research?: boolean; exclude_content_ids?: string[]; key_mode: 'own' | 'service'; encrypted_key: string | null; status: string; writing_stage?: WritingStage | null; scheduled_at: Date | null; available_at: Date; attempt_count: number; lease_token: string | null; lease_expires_at: Date | null; started_at: Date | null; completed_at: Date | null; result: unknown[] | null; seo_report?: SeoReport | null; seo_repair_status?: 'not_needed' | 'applied' | 'kept_draft' | 'skipped' | null; error_code: string | null; error_message: string | null; created_at: Date; updated_at: Date }

export const writingFields = z.object({
  model: ownModelSchema, keyword: z.string().trim().min(1).max(500), tone: z.string().trim().min(1).max(240), style: z.string().trim().min(1).max(500),
  length: articleLengthSchema, instructions: z.string().trim().max(4000).optional(),
  provider: providerIdSchema.optional(), base_url: ownBaseUrlSchema.optional(), api_key: ownApiKeySchema.optional(),
  keyAI: ownApiKeySchema.optional(), key_mode: z.enum(['own', 'service']).optional(), use_research: z.boolean().default(true),
  exclude_content_ids: excludedContentIdsSchema.optional(),
  languages: languageConfigSchema.optional(), locale: localeSchema.optional(), translation_source: translationSourceSchema.optional(),
  ...articleIdentityFields,
})
const createFields = writingFields.extend({ mode: z.enum(['scheduled', 'preview']).optional(), scheduled_at: timestampSchema.optional() }).strict()
// Zod defaults still run under partial(); a schedule edit must preserve opt-out.
const patchFields = writingFields.omit({ use_research: true, article_ref: true, translation_of_job_id: true }).partial().extend({ use_research: z.boolean().optional(), scheduled_at: timestampSchema.optional() }).strict().refine(body => Object.keys(body).length > 0, 'Cần ít nhất một trường thay đổi.')
const rewriteFields = writingFields.pick({ instructions: true, provider: true, base_url: true, api_key: true, keyAI: true, key_mode: true, exclude_content_ids: true }).strict()
const jobParams = z.object({ job_id: idSchema })
export type Writing = z.infer<typeof writingFields>
type Mode = 'scheduled' | 'preview' | 'rewrite'

const asSite = (row: Record<string, unknown> | null): Site | null => row ? ({
  id: String(row._id),
  customer_id: String(row.customer_id),
  token_hash: row.token_hash as string | null,
  webhook_url: row.webhook_url as string | null,
  webhook_secret: row.webhook_secret as string | null,
  proof_required: row.proof_required as boolean | undefined,
  signing_public_key: row.signing_public_key as string | null | undefined,
}) : null
const asPackage = (row: CustomerDoc): Package => ({ id: row._id, key_mode: row.key_mode, daily_limit: row.daily_limit, monthly_limit: row.monthly_limit, starts_at: row.starts_at, ends_at: row.ends_at, allowed_models: row.allowed_models ?? [], max_length: row.max_length })

export async function authenticateSite(db: Database, request: FastifyRequest) {
  const auth = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{16,256})$/i)
  if (auth) {
    const tokenHash = digest(auth[1])
    const row = await collection(db, 'sites').findOne({ token_hash: tokenHash })
    if (row) {
      const site = asSite(row as Record<string, unknown>)!
      site.proof = verifySiteRequest(site, request)
      if (request.method === 'GET' || request.method === 'HEAD') {
        await admitSiteProof(db, site)
        delete site.proof
      }
      await collection(db, 'sites').updateOne({ _id: row._id, token_hash: tokenHash, $or: [{ last_used_at: { $exists: false } }, { last_used_at: { $lt: new Date(Date.now() - 60_000) } }] }, { $set: { last_used_at: new Date() } })
      return site
    }
  }
  throw new ApiError(401, 'invalid_site_token', 'Token website không hợp lệ.')
}

async function lockedCustomer(source: MongoSource, id: string) {
  const session = sessionOf(source)
  // A real write serializes quota reservations and conflicts with deletion.
  const locked = await collection(source, 'customers').updateOne({ _id: id }, { $inc: { relation_version: 1 } }, { session })
  if (!locked.matchedCount) throw notFound()
  const customer = await collection<CustomerDoc>(source, 'customers').findOne({ _id: id }, { session })
  if (!customer) throw notFound()
  return asPackage(customer)
}

async function lockedSite(source: TransactionContext, site: Site) {
  const filter = { _id: site.id, customer_id: site.customer_id, token_hash: site.token_hash, ...siteSecurityFilter(site), ...(site.widget_domain ? { domain: site.widget_domain } : {}) }
  // Token rotation and ownership changes must conflict with in-flight writes.
  const locked = await collection(source, 'sites').updateOne(filter, { $inc: { relation_version: 1 } }, { session: source.session })
  if (!locked.matchedCount) throw new ApiError(401, 'invalid_site_token', 'Token hoặc chủ sở hữu website đã thay đổi. Vui lòng kết nối lại.')
  const row = await collection(source, 'sites').findOne(filter, { session: source.session })
  if (!row) throw new ApiError(401, 'invalid_site_token', 'Token hoặc chủ sở hữu website đã thay đổi. Vui lòng kết nối lại.')
  return row
}

function requestId(request: FastifyRequest) { return z.string().min(1).max(160).regex(/^[\x21-\x7E]+$/).parse(request.headers['idempotency-key']) }
function requestFingerprint(input: unknown, config: Config) { return createHmac('sha256', config.encryptionKey).update(JSON.stringify(input)).digest('hex') }
function writingPackage(customer: Package, requestedMode: Writing['key_mode']): Package {
  if (customer.key_mode === 'own' && requestedMode === 'service') {
    throw new ApiError(403, 'service_not_allowed', 'Khách hàng chưa được cấp quyền dùng số lượng bài viết của CRM.')
  }
  return { ...customer, key_mode: requestedMode ?? customer.key_mode }
}
function encryptedKeyFor(writing: Writing, customer: Package, config: Config, previousKey?: string | null) {
  if (customer.key_mode === 'service') return null
  if (writing.api_key && writing.keyAI && writing.api_key !== writing.keyAI) throw new ApiError(400, 'conflicting_keys', 'Chỉ gửi một API key cho chế độ key riêng.')
  const submittedKey = writing.api_key ?? writing.keyAI
  if (submittedKey && writing.base_url) return encodeOwnConnection(submittedKey, writing.base_url, config.encryptionKey)
  let previous: ReturnType<typeof decodeOwnConnection> | undefined
  if (previousKey) try { previous = decodeOwnConnection(previousKey, config.encryptionKey) }
  catch { throw new ApiError(422, 'own_connection_unreadable', 'Không đọc được kết nối AI của yêu cầu. Hãy gửi lại Base URL và API key.') }
  if (writing.base_url && previous && writing.base_url !== previous.baseUrl && !submittedKey) {
    throw new ApiError(400, 'key_required_for_endpoint_change', 'Nhập lại API key khi thay đổi Base URL.')
  }
  const key = submittedKey ?? previous?.apiKey
  if (!key) throw new ApiError(400, 'key_required', 'Cần gửi api_key cho chế độ dùng key riêng.')
  const baseUrl = writing.base_url ?? previous?.baseUrl
  if (!baseUrl) throw new ApiError(400, 'base_url_required', 'Cần gửi Base URL của API OpenAI Compatible khi dùng key riêng.')
  return encodeOwnConnection(key, baseUrl, config.encryptionKey)
}

async function providerFor(source: TransactionContext, writing: Writing, customer: Package) {
  if (customer.key_mode === 'service' && (writing.provider || writing.base_url || writing.api_key || writing.keyAI)) {
    throw new ApiError(400, 'personal_key_not_allowed', 'Khách hàng dùng quota không được gửi key AI cá nhân.')
  }
  if (customer.key_mode === 'own') return 'openai-compatible' as const
  modelIdSchema.parse(writing.model)
  return requireAvailableModel(source, writing.model)
}

function summary(job: JobDoc) { return { ...languageSummary(job), ...articleIdentity(job), job_id: job._id, status: job.status, scheduled_at: job.scheduled_at, version: job.version, source_article_id: job.source_article_id, retry_of_job_id: job.retry_of_job_id ?? null, use_research: job.use_research ?? true } }

export async function createJob(db: Database, config: Config, site: Site, clientId: string, writing: Writing, mode: Mode, scheduled: string | undefined, sourceId?: string, retryOfJobId?: string) {
  try { validateWritingLanguage(writing, Boolean(sourceId)) }
  catch (error) { throw new ApiError(400, 'invalid_language_config', (error as Error).message) }
  const scheduledAt = scheduled ? new Date(scheduled) : null
  const fingerprint = requestFingerprint({ writing, mode, scheduledAt, sourceId, retryOfJobId }, config)
  const created = await transaction(db, async client => {
    const session = sessionOf(client)
    const currentSite = await lockedSite(client, site)
    const customer = await lockedCustomer(client, site.customer_id)
    const pkg = writingPackage(customer, writing.key_mode)
    const existing = await collection<JobDoc>(client, 'jobs').findOne({ site_id: site.id, customer_id: customer.id, client_request_id: clientId }, { session })
    if (existing) {
      if (existing.request_hash !== fingerprint || (site.widget_origin && existing.widget_origin !== site.widget_origin)) throw new ApiError(409, 'idempotency_conflict', 'Mã yêu cầu này đã được dùng với nội dung khác.')
      return { result: summary(existing), created: false }
    }
    await admitSiteProof(client, site)
    // A valid token must not be able to fill the writer queue indefinitely,
    // including customers using their own AI key. The customer write above
    // serializes this bounded check across all websites and API processes.
    const pendingLimit = config.maxPendingJobsPerCustomer ?? 100
    const pending = await collection(client, 'jobs').countDocuments({
      customer_id: customer.id, status: { $in: ['scheduled', 'queued', 'writing'] },
    }, { session, limit: pendingLimit, maxTimeMS: 5_000 })
    if (pending >= pendingLimit) throw new ApiError(429, 'job_queue_full', 'Khách hàng có quá nhiều yêu cầu đang chờ. Hãy chờ các bài hiện tại hoàn tất.', { limit: pendingLimit, retry_after_seconds: 60 })
    // Recheck references after taking the site lock, which deletion also holds.
    if (sourceId && !await collection(client, 'jobs').findOne({ _id: sourceId, site_id: site.id, customer_id: customer.id, status: 'ready' }, { session })) throw notFound()
    if (retryOfJobId && !await collection(client, 'jobs').findOne({ _id: retryOfJobId, site_id: site.id, customer_id: customer.id }, { session })) throw notFound()
    const now = new Date()
    if (scheduledAt && scheduledAt <= now) throw new ApiError(400, 'invalid_schedule_time', 'Giờ hẹn phải ở tương lai.')
    if (mode === 'scheduled' && (!currentSite.webhook_url || !currentSite.webhook_secret)) throw new ApiError(422, 'webhook_not_configured', 'Website cần URL và khóa ký webhook để nhận bài theo lịch viết.')
    const availableAt = scheduledAt ?? now
    assertPackage(pkg, availableAt, writing.model, writing.length)
    const provider = await providerFor(client, writing, pkg)
    if (pkg.key_mode === 'service') {
      const settings = await collection<{ _id: Provider, base_url?: string | null, encrypted_api_key?: string | null }>(client, 'ai_providers').findOne({ _id: provider }, { session })
      if (isCompatibleProvider(provider) && !settings?.base_url) throw new ApiError(422, 'provider_not_configured', 'OpenAI Compatible chưa được cấu hình Base URL trong CRM.')
      const keyState = serviceKeyState(provider, settings?.encrypted_api_key, config)
      if (keyState === 'unreadable') throw new ApiError(422, 'service_key_unreadable', 'Máy chủ không giải mã được API key đã lưu. Quản trị viên cần kiểm tra ENCRYPTION_KEY giữa API và worker hoặc lưu lại key tại Nhà cung cấp AI.')
      if (keyState === 'missing') throw new ApiError(422, 'service_key_unavailable', 'Nhà cung cấp này chưa được cấu hình key dịch vụ.')
    }
    const jobId = randomUUID()
    const identity = await resolveArticleIdentity(client, site, jobId, writing, sourceId, retryOfJobId)
    const job: JobDoc = {
      _id: jobId, ...identity, site_id: site.id, customer_id: customer.id, client_request_id: clientId, request_hash: fingerprint, mode, source_article_id: sourceId ?? null, retry_of_job_id: retryOfJobId ?? null,
      ...(site.widget_origin ? { widget_origin: site.widget_origin } : {}),
      version: 1, provider, model: writing.model, keyword: writing.keyword, tone: writing.tone, style: writing.style, length: writing.length, instructions: writing.instructions ?? null, use_research: writing.use_research,
      ...languageMetadata(writing),
      exclude_content_ids: [...new Set(writing.exclude_content_ids ?? [])],
      key_mode: pkg.key_mode, encrypted_key: encryptedKeyFor(writing, pkg, config), status: mode === 'scheduled' ? 'scheduled' : 'queued', scheduled_at: scheduledAt, available_at: availableAt,
      attempt_count: 0, lease_token: null, lease_expires_at: null, started_at: null, completed_at: null, result: null, error_code: null, error_message: null, created_at: now, updated_at: now,
    }
    await reserveQuota(client, pkg, job._id, availableAt)
    await collection(client, 'jobs').insertOne(job, { session })
    return { result: summary(job), created: true, job }
  })
  const createdJob = created.job
  if (created.created && createdJob) {
    publishJobEvent(db, {
      type: 'job.created', job_id: createdJob._id, status: createdJob.status,
      writing_stage: null, updated_at: createdJob.updated_at.toISOString(),
      created_at: createdJob.created_at.toISOString(),
    })
  }
  return created.result
}

const scheduleStatuses = ['scheduled', 'queued', 'writing', 'ready', 'failed', 'canceled'] as const
const listFields = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(25), q: z.string().trim().max(160).optional(), from: periodSchema.optional(), to: periodSchema.optional(), status: z.enum([...scheduleStatuses, 'all']).optional() }).refine(query => !query.from || !query.to || query.from <= query.to, 'Ngày bắt đầu phải trước ngày kết thúc.')

export function readCursor(cursor?: string, sortField: z.ZodType<string> = timestampSchema) {
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
function escapedRegex(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

async function siteCatalog(db: Database, config: Config, request: FastifyRequest) {
  const site = await authenticateSite(db, request)
  const customerDoc = await collection<CustomerDoc>(db, 'customers').findOne({ _id: site.customer_id })
  if (!customerDoc) throw notFound()
  const customer = asPackage(customerDoc)
  return { site, customer, models: await listModelsForCustomer(db, config, customer) }
}

function registerDirectWidget(app: FastifyInstance, db: Database, config: Config) {
  const sites = new WeakMap<FastifyRequest, Site>()
  const rateKey = (request: FastifyRequest) => `${String((request.params as Record<string, unknown>)?.site_id ?? '').slice(0, 36)}:${clientAddress(request.ip)}`
  const cors = async (request: FastifyRequest, reply: FastifyReply) => {
    const { site_id } = z.object({ site_id: idSchema }).parse(request.params)
    const row = await collection(db, 'sites').findOne({ _id: site_id }, { maxTimeMS: 5_000 })
    if (!row || typeof row.token_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.token_hash)) {
      throw new ApiError(401, 'invalid_widget_grant', 'Widget chưa được cấp quyền hoặc quyền đã bị thu hồi.')
    }
    const origin = typeof request.headers.origin === 'string' && typeof row.domain === 'string'
      ? widgetOrigin(request.headers.origin, row.domain, !config.production) : null
    if (!origin) throw new ApiError(403, 'invalid_widget_origin', 'Website không được phép sử dụng widget này.')
    reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
      .header('Cache-Control', 'no-store').header('Cross-Origin-Resource-Policy', 'cross-origin')
    sites.set(request, { ...asSite(row as Record<string, unknown>)!, widget_origin: origin, widget_domain: String(row.domain) })
  }
  const siteFor = (request: FastifyRequest) => {
    const site = sites.get(request)
    if (!site) throw new ApiError(401, 'invalid_widget_grant', 'Quyền sử dụng widget không hợp lệ.')
    return site
  }
  const grantFor = (request: FastifyRequest) => {
    const site = siteFor(request)
    const expires = request.headers['x-widget-expires']
    const signature = request.headers['x-widget-signature']
    if (typeof expires !== 'string' || !/^[1-9]\d{0,12}$/.test(expires)
      || !sameWidgetToken(signature, widgetSignature(site.token_hash!, site.id, site.widget_origin!, expires))) {
      throw new ApiError(401, 'invalid_widget_grant', 'Quyền sử dụng widget không hợp lệ. Hãy tải lại trang.')
    }
    const expiry = Number(expires)
    const now = Math.floor(Date.now() / 1000)
    if (expiry <= now) throw new ApiError(401, 'widget_grant_expired', 'Phiên sử dụng widget đã hết hạn. Hãy tải lại trang trước khi viết bài mới.')
    if (expiry > now + widgetGrantSeconds) throw new ApiError(401, 'invalid_widget_grant', 'Thời hạn widget không hợp lệ.')
    return { site, expiry }
  }
  const readJob = async (request: FastifyRequest) => {
    const site = siteFor(request)
    const { job_id } = jobParams.parse(request.params)
    if (!sameWidgetToken(request.headers['x-widget-read-token'], widgetReadToken(site.token_hash!, site.id, site.customer_id, site.widget_origin!, job_id))) {
      throw new ApiError(401, 'invalid_widget_grant', 'Quyền xem kết quả widget không hợp lệ.')
    }
    const job = await collection<JobDoc>(db, 'jobs').findOne({
      _id: job_id, site_id: site.id, customer_id: site.customer_id, mode: 'preview', widget_origin: site.widget_origin,
    }, { maxTimeMS: 5_000 })
    if (!job) throw notFound()
    return job
  }
  const readOptions = { onRequest: cors, config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: rateKey } } }
  for (const path of ['models', 'previews', 'previews/:job_id', 'previews/:job_id/result']) {
    app.options(`/v1/widget/:site_id/${path}`, { onRequest: cors }, async (request, reply) => {
      const method = request.headers['access-control-request-method']
      const expected = path === 'previews' ? 'POST' : 'GET'
      const headers = String(request.headers['access-control-request-headers'] ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
      const allowed = ['content-type', 'idempotency-key', 'x-widget-expires', 'x-widget-signature', 'x-widget-read-token', 'x-site-proof']
      if (method !== expected || headers.some(header => !allowed.includes(header))) throw new ApiError(403, 'invalid_widget_preflight', 'Yêu cầu widget không được phép.')
      return reply.header('Access-Control-Allow-Methods', expected)
        .header('Access-Control-Allow-Headers', allowed.join(', ')).header('Access-Control-Max-Age', '600').code(204).send()
    })
  }
  app.get('/v1/widget/:site_id/models', readOptions, async request => {
    const { site, expiry } = grantFor(request)
    const row = await collection<CustomerDoc>(db, 'customers').findOne({ _id: site.customer_id })
    if (!row) throw notFound()
    const customer = asPackage(row)
    return { key_mode: customer.key_mode, data: await listModelsForCustomer(db, config, customer), grant_expires_at: expiry, ...(siteProofRequired(site) ? { proof_required: true } : {}) }
  })
  app.post('/v1/widget/:site_id/previews', {
    onRequest: cors, bodyLimit: 16 * 1024,
    config: { rateLimit: { max: 12, timeWindow: '1 minute', keyGenerator: rateKey } },
  }, async (request, reply) => {
    const site = siteFor(request)
    if (siteProofRequired(site)) site.proof = verifySiteRequest(site, request)
    else grantFor(request)
    const writing = writingFields.strict().parse(request.body)
    const result = await createJob(db, config, site, requestId(request), writing, 'preview', undefined)
    return reply.code(202).send({ ...result, read_token: widgetReadToken(site.token_hash!, site.id, site.customer_id, site.widget_origin!, result.job_id) })
  })
  app.get('/v1/widget/:site_id/previews/:job_id', readOptions, async request => {
    const job = await readJob(request)
    return {
      job_id: job._id, status: job.status, mode: job.mode, source_article_id: job.source_article_id,
      writing_stage: job.status === 'writing' ? job.writing_stage ?? null : null,
      ...languageSummary(job), ...articleIdentity(job), keyword: job.keyword, length: job.length, use_research: job.use_research ?? true, scheduled_at: null,
      version: job.version, started_at: toIso(job.started_at), completed_at: toIso(job.completed_at),
      seo_report: job.status === 'ready' ? job.seo_report ?? null : null,
      seo_repair_status: job.status === 'ready' ? job.seo_repair_status ?? null : null,
      error_code: job.error_code, error_message: job.error_message, created_at: job.created_at.toISOString(), delivery_status: null,
    }
  })
  app.get('/v1/widget/:site_id/previews/:job_id/result', readOptions, async (request, reply) => {
    const job = await readJob(request)
    if (job.status === 'ready') return Array.isArray(job.result) ? job.result.map(normalizeArticleFields) : job.result
    if (job.status === 'failed' || job.status === 'canceled') throw new ApiError(409, job.error_code ?? job.status, job.error_message ?? 'Yêu cầu đã dừng.')
    return reply.code(202).send({ status: job.status })
  })
}

export function registerPublic(app: FastifyInstance, db: Database, config: Config) {
  installSiteProofParser(app)
  registerDirectWidget(app, db, config)
  registerSiteContent(app, db)
  app.post('/v1/article-jobs', async (request, reply) => {
    const site = await authenticateSite(db, request)
    const { mode, scheduled_at, ...writing } = createFields.parse(request.body)
    const chosenMode = mode ?? (scheduled_at ? 'scheduled' : 'preview')
    if ((chosenMode === 'scheduled') !== Boolean(scheduled_at)) throw new ApiError(400, 'invalid_schedule_time', 'Giờ hẹn buộc với lịch viết và dành riêng cho lịch viết.')
    return reply.code(202).send(await createJob(db, config, site, requestId(request), writing, chosenMode, scheduled_at))
  })

  app.get('/v1/models', async (request, reply) => {
    const { customer, models } = await siteCatalog(db, config, request)
    return reply.header('Cache-Control', 'no-store').send({ key_mode: customer.key_mode, data: models })
  })
  app.get('/v1/usage', async request => {
    const { customer, models } = await siteCatalog(db, config, request)
    const { date } = z.object({ date: periodSchema.optional() }).parse(request.query)
    return { ...(await usage(db, customer, date ? dayStart(date) : new Date())), allowed_models: models.map(model => model.model) }
  })

  app.get('/v1/article-jobs/:job_id', async request => {
    const site = await authenticateSite(db, request)
    const { job_id } = jobParams.parse(request.params)
    const job = await collection<JobDoc>(db, 'jobs').findOne({ _id: job_id, site_id: site.id, customer_id: site.customer_id })
    if (!job) throw notFound()
    const delivery = await collection<{ status: string }>(db, 'webhook_deliveries').findOne({ job_id, site_id: site.id }, { sort: { created_at: -1 } })
    return {
      job_id: job._id, status: job.status, mode: job.mode, source_article_id: job.source_article_id,
      writing_stage: job.status === 'writing' ? job.writing_stage ?? null : null,
      ...languageSummary(job), ...articleIdentity(job), keyword: job.keyword, length: job.length, use_research: job.use_research ?? true, scheduled_at: toIso(job.scheduled_at),
      version: job.version, started_at: toIso(job.started_at), completed_at: toIso(job.completed_at),
      seo_report: job.status === 'ready' ? job.seo_report ?? null : null,
      seo_repair_status: job.status === 'ready' ? job.seo_repair_status ?? null : null,
      error_code: job.error_code, error_message: job.error_message,
      created_at: job.created_at.toISOString(), delivery_status: delivery?.status ?? null,
    }
  })
  app.get('/v1/article-jobs/:job_id/result', async (request, reply) => {
    const site = await authenticateSite(db, request); const { job_id } = jobParams.parse(request.params)
    const job = await collection<JobDoc>(db, 'jobs').findOne({ _id: job_id, site_id: site.id, customer_id: site.customer_id }); if (!job) throw notFound()
    if (job.status === 'ready') return Array.isArray(job.result) ? job.result.map(normalizeArticleFields) : job.result
    if (job.status === 'failed' || job.status === 'canceled') throw new ApiError(409, job.error_code ?? job.status, job.error_message ?? 'Yêu cầu đã dừng.')
    return reply.code(202).send({ status: job.status })
  })

  app.get('/v1/articles', async request => {
    const site = await authenticateSite(db, request); const { from, to, q, cursor, limit } = listFields.parse(request.query); const [cursorAt, cursorId] = readCursor(cursor)
    const filter: Record<string, unknown> = { site_id: site.id, customer_id: site.customer_id, status: 'ready', completed_at: { $exists: true, $ne: null } }
    if (from || to) filter.completed_at = { $exists: true, $ne: null, ...(from ? { $gte: dayStart(from) } : {}), ...(to ? { $lt: new Date(dayEnd(to)) } : {}) }
    const conditions: Record<string, unknown>[] = []
    if (q) {
      const pattern = escapedRegex(q)
      conditions.push({ $or: [{ keyword: { $regex: pattern, $options: 'i' } }, { 'result.0.Title': { $regex: pattern, $options: 'i' } }] })
    }
    if (cursorAt) {
      const cursorDate = new Date(cursorAt)
      conditions.push({ $or: [{ completed_at: { $lt: cursorDate } }, { completed_at: cursorDate, _id: { $lt: cursorId! } }] })
    }
    if (conditions.length) filter.$and = conditions
    const jobs = await collection<JobDoc>(db, 'jobs').find(filter, { projection: { _id: 1, source_article_id: 1, article_group_id: 1, article_ref: 1, original_locale: 1, original_job_id: 1, translation_of_job_id: 1, languages: 1, locale: 1, 'result.Title': 1, keyword: 1, model: 1, mode: 1, completed_at: 1 }, maxTimeMS: 5_000 }).sort({ completed_at: -1, _id: -1 }).limit(limit + 1).toArray()
    const rows = jobs.map(job => ({ ...articleIdentity(job), ...languageSummary(job), article_id: job._id, source_article_id: job.source_article_id, Title: (job.result?.[0] as Record<string, unknown> | undefined)?.Title, keyword: job.keyword, model: job.model, mode: job.mode, completed_at: toIso(job.completed_at), cursor_at: job.completed_at!.toISOString(), cursor_id: job._id }))
    return pageOf(rows, limit)
  })

  app.get('/v1/schedules', async request => {
    const site = await authenticateSite(db, request); const { from, to, cursor, limit, status = 'scheduled' } = listFields.parse(request.query); const [cursorAt, cursorId] = readCursor(cursor)
    const filter: Record<string, unknown> = { site_id: site.id, customer_id: site.customer_id, mode: 'scheduled', scheduled_at: { $exists: true, $ne: null } }
    if (from || to) filter.scheduled_at = { $exists: true, $ne: null, ...(from ? { $gte: dayStart(from) } : {}), ...(to ? { $lt: new Date(dayEnd(to)) } : {}) }
    if (status !== 'all') filter.status = status
    if (cursorAt) {
      const cursorDate = new Date(cursorAt)
      filter.$and = [{ $or: [{ scheduled_at: { $gt: cursorDate } }, { scheduled_at: cursorDate, _id: { $gt: cursorId! } }] }]
    }
    const jobs = await collection<JobDoc>(db, 'jobs').find(filter, { projection: { encrypted_key: 0, result: 0, request_hash: 0 }, maxTimeMS: 5_000 }).sort({ scheduled_at: 1, _id: 1 }).limit(limit + 1).toArray()
    const rows = jobs.map(job => ({ ...languageSummary(job), ...articleIdentity(job), job_id: job._id, status: job.status, version: job.version, scheduled_at: job.scheduled_at, model: job.model, keyword: job.keyword, tone: job.tone, style: job.style, length: job.length, instructions: job.instructions, use_research: job.use_research ?? true, exclude_content_ids: job.exclude_content_ids ?? [], cursor_at: job.scheduled_at!.toISOString(), cursor_id: job._id }))
    return pageOf(rows, limit)
  })

  app.patch('/v1/schedules/:job_id', async (request, reply) => {
    const site = await authenticateSite(db, request); const { job_id } = jobParams.parse(request.params); const patch = patchFields.parse(request.body)
    const match = typeof request.headers['if-match'] === 'string' ? /^"?(\d+)"?$/.exec(request.headers['if-match'])?.[1] : undefined; if (!match) throw new ApiError(428, 'version_required', 'Gửi version hiện tại trong header If-Match.')
    const updated = await transaction(db, async client => {
      await lockedSite(client, site)
      await admitSiteProof(client, site)
      const customer = await lockedCustomer(client, site.customer_id)
      const session = sessionOf(client)
      const version = Number(match)
      const job = await readSchedule(client, site, job_id)
      if (job.status !== 'scheduled') throw scheduleConflict(job.status)
      if (job.version !== version) throw versionConflict(job.version)
      if (patch.key_mode && patch.key_mode !== job.key_mode) {
        throw new ApiError(409, 'key_mode_not_editable', 'Không thể đổi nguồn AI của lịch đã tạo. Hãy tạo lịch mới để chọn nguồn AI khác.')
      }

      const when = patch.scheduled_at ? new Date(patch.scheduled_at) : job.scheduled_at!
      if (patch.scheduled_at && when <= new Date()) {
        throw new ApiError(400, 'invalid_schedule_time', 'Giờ hẹn phải ở tương lai.')
      }
      const writing = {
        model: patch.model ?? job.model, keyword: patch.keyword ?? job.keyword,
        tone: patch.tone ?? job.tone, style: patch.style ?? job.style, length: patch.length ?? job.length,
        instructions: patch.instructions ?? job.instructions ?? undefined, use_research: patch.use_research ?? job.use_research ?? true, provider: patch.provider, base_url: patch.base_url, api_key: patch.api_key, keyAI: patch.keyAI,
        exclude_content_ids: patch.exclude_content_ids ?? job.exclude_content_ids ?? [],
        languages: patch.languages ?? job.languages, locale: patch.locale ?? job.locale,
        translation_source: patch.translation_source ?? job.translation_source,
      }
      try { validateWritingLanguage(writing) }
      catch (error) { throw new ApiError(400, 'invalid_language_config', (error as Error).message) }
      if (job.original_locale && writing.languages && writing.languages.source !== job.original_locale) throw new ApiError(409, 'article_language_conflict', 'Không thể đổi ngôn ngữ gốc của nhóm bài đã tạo.')
      const pkg = { ...customer, key_mode: job.key_mode }
      assertPackage(pkg, when, writing.model, writing.length)
      const reuseConnection = job.key_mode === 'own' && writing.model === job.model
        && !writing.provider && !writing.base_url && !writing.api_key && !writing.keyAI
      const provider = reuseConnection ? job.provider : await providerFor(client, writing, pkg)
      const encryptedKey = reuseConnection ? job.encrypted_key : encryptedKeyFor(writing, pkg, config, job.encrypted_key)
      const next = {
        scheduled_at: when, model: writing.model, keyword: writing.keyword, tone: writing.tone,
        style: writing.style, length: writing.length, instructions: writing.instructions ?? null, use_research: writing.use_research,
        ...languageMetadata(writing), exclude_content_ids: [...new Set(writing.exclude_content_ids)],
        provider, encrypted_key: encryptedKey, available_at: when,
        version: job.version + 1, updated_at: new Date(),
      }
      const saved = await collection(client, 'jobs').updateOne(
        { _id: job_id, site_id: site.id, customer_id: site.customer_id, mode: 'scheduled', status: 'scheduled', version },
        { $set: next, $unset: { keyAI: '', api_key: '' } }, { session },
      )
      if (!saved.matchedCount) {
        const current = await readSchedule(client, site, job_id)
        if (current.status !== 'scheduled') throw scheduleConflict(current.status)
        throw versionConflict(current.version)
      }

      const reservation = await collection<{ quota_day: string, quota_month: string }>(client, 'quota_reservations')
        .findOne({ job_id, status: 'reserved' }, { session })
      await reserveQuota(client, pkg, job_id, when, reservation ?? undefined)
      return { ...languageSummary(next), job_id, status: job.status, version: next.version, scheduled_at: when, model: next.model, keyword: next.keyword, tone: next.tone, style: next.style, length: next.length, instructions: next.instructions, use_research: next.use_research, exclude_content_ids: next.exclude_content_ids }
    })
    publishJobEvent(db, { type: 'job.updated', job_id: updated.job_id, status: updated.status, writing_stage: null, scheduled_at: updated.scheduled_at?.toISOString?.() ?? updated.scheduled_at, updated_at: new Date().toISOString() })
    return reply.header('ETag', `"${updated.version}"`).send(updated)
  })
  app.delete('/v1/schedules/:job_id', async (request, reply) => {
    const site = await authenticateSite(db, request); const { job_id } = jobParams.parse(request.params)
    await transaction(db, async client => {
      await lockedSite(client, site)
      await admitSiteProof(client, site)
      await lockedCustomer(client, site.customer_id)
      const session = sessionOf(client)
      const job = await readSchedule(client, site, job_id)
      if (job.status === 'canceled') return
      if (job.status !== 'scheduled') throw scheduleConflict(job.status)

      const saved = await collection(client, 'jobs').updateOne(
        { _id: job_id, site_id: site.id, customer_id: site.customer_id, mode: 'scheduled', status: 'scheduled', version: job.version },
        { $set: { status: 'canceled', encrypted_key: null, updated_at: new Date() }, $unset: { keyAI: '', api_key: '' }, $inc: { version: 1 } },
        { session },
      )
      if (!saved.matchedCount) {
        const current = await readSchedule(client, site, job_id)
        if (current.status === 'canceled') return
        throw scheduleConflict(current.status)
      }
      await collection(client, 'quota_reservations').updateOne({ job_id, status: 'reserved' }, { $set: { status: 'released' } }, { session })
    })
    publishJobEvent(db, { type: 'job.updated', job_id, status: 'canceled', writing_stage: null, updated_at: new Date().toISOString() })
    return reply.code(204).send()
  })
  app.post('/v1/articles/:article_id/rewrites', async (request, reply) => {
    const site = await authenticateSite(db, request); const { article_id } = z.object({ article_id: idSchema }).parse(request.params); const additions = rewriteFields.parse(request.body ?? {})
    const article = await collection<JobDoc>(db, 'jobs').findOne({ _id: article_id, site_id: site.id, customer_id: site.customer_id, status: 'ready' }); if (!article) throw notFound()
    const instructions = [article.instructions, additions.instructions].filter(Boolean).join('\n\n').slice(-8000)
    const keyMode = additions.key_mode ?? (article.key_mode === 'own' ? 'own' : undefined)
    return reply.code(202).send(await createJob(db, config, site, requestId(request), { ...languageMetadata({ languages: article.languages, locale: article.locale }), model: article.model, keyword: article.keyword, tone: article.tone, style: article.style, length: article.length, instructions: instructions || undefined, provider: additions.provider, base_url: additions.base_url, api_key: additions.api_key, keyAI: additions.keyAI, key_mode: keyMode, use_research: article.use_research ?? true, exclude_content_ids: additions.exclude_content_ids ?? article.exclude_content_ids ?? [] }, 'rewrite', undefined, article_id))
  })
}

async function readSchedule(source: TransactionContext, site: Site, jobId: string) {
  const job = await collection<JobDoc>(source, 'jobs').findOne({ _id: jobId, site_id: site.id, customer_id: site.customer_id, mode: 'scheduled' }, { session: source.session })
  if (!job) throw notFound()
  return job
}
function versionConflict(version: number) { return new ApiError(412, 'version_conflict', 'Lịch đã thay đổi. Hãy tải lại.', { version }) }
function scheduleConflict(status: string) { return new ApiError(409, 'schedule_not_editable', 'Chỉ có thể thay đổi lịch còn chờ.', { status }) }
// @ts-nocheck
