import { createHmac } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { Config, Provider } from '../config.js'
import { transaction, type Database } from '../db.js'
import { digest, seal } from '../security.js'
import { listAvailableModels, modelIdSchema, requireAvailableModel } from './catalog.js'
import { ApiError, idSchema, notFound, periodSchema, quantitySchema, timestampSchema } from './errors.js'
import { assertPackage, reserveQuota, usage, type Package } from './quota.js'

interface Site {
  id: string
  customer_id: string
  token_hash: string
  webhook_url: string | null
  webhook_secret: string | null
}

const writingFields = z.object({
  model: modelIdSchema,
  keyword: z.string().trim().min(1).max(500),
  tone: z.string().trim().min(1).max(240),
  style: z.string().trim().min(1).max(500),
  length: quantitySchema,
  instructions: z.string().trim().max(4000).optional(),
  keyAI: z.string().trim().min(1).max(2048).optional(),
})
const createFields = writingFields.extend({
  mode: z.enum(['scheduled', 'preview']).optional(),
  scheduled_at: timestampSchema.optional(),
}).strict()
const patchFields = writingFields.partial().extend({ scheduled_at: timestampSchema.optional() }).strict()
  .refine(body => Object.keys(body).length > 0, 'Cần ít nhất một trường thay đổi.')
const rewriteFields = writingFields.pick({ instructions: true, keyAI: true }).strict()
const jobParams = z.object({ job_id: idSchema })
type Writing = z.infer<typeof writingFields>
type Mode = 'scheduled' | 'preview' | 'rewrite'

async function authenticateSite(db: Database, request: FastifyRequest) {
  const auth = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{16,256})$/i)
  if (auth) {
    const tokenHash = digest(auth[1])
    const { rows: [site] } = await db.query<Site>(`
      SELECT id,customer_id,token_hash,webhook_url,webhook_secret FROM sites WHERE token_hash=$1
    `, [tokenHash])
    if (site) {
      await db.query(`
        UPDATE sites SET last_used_at=now() WHERE id=$1 AND token_hash=$2
          AND (last_used_at IS NULL OR last_used_at<now()-interval '1 minute')
      `, [site.id, tokenHash])
      return site
    }
  }
  throw new ApiError(401, 'invalid_site_token', 'Token website không hợp lệ.')
}

async function lockedCustomer(client: PoolClient, id: string) {
  const { rows: [customer] } = await client.query<Package>('SELECT * FROM customers WHERE id=$1 FOR UPDATE', [id])
  if (!customer) throw notFound()
  return customer
}

function requestId(request: FastifyRequest) {
  return z.string().min(1).max(160).regex(/^[\x21-\x7E]+$/).parse(request.headers['idempotency-key'])
}

function requestFingerprint(input: unknown, config: Config) {
  return createHmac('sha256', config.encryptionKey).update(JSON.stringify(input)).digest('hex')
}

function encryptedKeyFor(writing: Writing, customer: Package, config: Config, provider: Provider, previousKey?: string | null) {
  if (customer.key_mode === 'service') return null
  const encrypted = writing.keyAI ? seal(writing.keyAI, config.encryptionKey) : previousKey
  if (!encrypted) throw new ApiError(400, 'key_required', 'Cần gửi keyAI cho chế độ dùng key riêng.')
  return encrypted
}

interface JobSummary {
  job_id: string
  status: string
  scheduled_at: Date | null
  version: number
  source_article_id: string | null
}

async function createJob(
  db: Database, config: Config, site: Site, clientId: string, writing: Writing,
  mode: Mode, scheduled: string | undefined, sourceId?: string,
) {
  const scheduledAt = scheduled ? new Date(scheduled) : null
  const fingerprint = requestFingerprint({ writing, mode, scheduledAt, sourceId }, config)
  return transaction(db, async client => {
    const { rows: [currentSite] } = await client.query<Site>(`
      SELECT id,customer_id,token_hash,webhook_url,webhook_secret FROM sites
      WHERE id=$1 AND customer_id=$2 AND token_hash=$3 FOR SHARE
    `, [site.id, site.customer_id, site.token_hash])
    if (!currentSite) {
      throw new ApiError(401, 'invalid_site_token', 'Token hoặc chủ sở hữu website đã thay đổi. Vui lòng kết nối lại.')
    }
    const customer = await lockedCustomer(client, site.customer_id)
    const { rows: [existing] } = await client.query<JobSummary & { request_hash: string }>(`
      SELECT id AS job_id,status,scheduled_at,version,source_article_id,request_hash
      FROM jobs WHERE site_id=$1 AND client_request_id=$2
    `, [site.id, clientId])
    if (existing) {
      if (existing.request_hash !== fingerprint) {
        throw new ApiError(409, 'idempotency_conflict', 'Mã yêu cầu này đã được dùng với nội dung khác.')
      }
      const { request_hash: _fingerprint, ...summary } = existing
      return summary
    }
    const { rows: [{ now }] } = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    if (scheduledAt && scheduledAt <= now) {
      throw new ApiError(400, 'invalid_schedule_time', 'Giờ hẹn phải ở tương lai.')
    }
    if (mode === 'scheduled' && (!currentSite.webhook_url || !currentSite.webhook_secret)) {
      throw new ApiError(422, 'webhook_not_configured', 'Website cần URL và khóa ký webhook để nhận bài theo lịch.')
    }
    const availableAt = scheduledAt ?? now
    assertPackage(customer, availableAt, writing.model, writing.length)
    const provider = await requireAvailableModel(client, writing.model)
    const { rows: [providerSettings] } = await client.query<{ base_url: string | null, encrypted_api_key: string | null }>(
      'SELECT base_url,encrypted_api_key FROM ai_providers WHERE provider=$1', [provider],
    )
    if (provider === 'openai-compatible' && !providerSettings?.base_url) {
      throw new ApiError(422, 'provider_not_configured', 'OpenAI Compatible chưa được cấu hình Base URL trong CRM.')
    }
    const serviceConfigured = provider === 'openai-compatible'
      ? Boolean(providerSettings?.encrypted_api_key && providerSettings?.base_url)
      : Boolean(config.serviceKeys[provider])
    if (customer.key_mode === 'service' && !serviceConfigured) {
      throw new ApiError(422, 'service_key_unavailable', 'Nhà cung cấp này chưa được cấu hình key dịch vụ.')
    }
    const encrypted = encryptedKeyFor(writing, customer, config, provider)
    const { rows: [job] } = await client.query<JobSummary>(`
      INSERT INTO jobs(site_id,customer_id,client_request_id,request_hash,mode,source_article_id,
        provider,model,keyword,tone,style,length,instructions,key_mode,encrypted_key,status,scheduled_at,available_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
      RETURNING id AS job_id,status,scheduled_at,version,source_article_id
    `, [
      site.id, customer.id, clientId, fingerprint, mode, sourceId ?? null, provider, writing.model,
      writing.keyword, writing.tone, writing.style, writing.length, writing.instructions ?? null,
      customer.key_mode, encrypted, mode === 'scheduled' ? 'scheduled' : 'queued', scheduledAt, availableAt,
    ])
    await reserveQuota(client, customer, job.job_id, availableAt)
    return job
  })
}

const scheduleStatuses = ['scheduled','queued','writing','ready','failed','canceled'] as const
const listFields = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(160).optional(),
  from: periodSchema.optional(),
  to: periodSchema.optional(),
  status: z.enum([...scheduleStatuses, 'all']).optional(),
}).refine(query => !query.from || !query.to || query.from <= query.to, 'Ngày bắt đầu phải trước ngày kết thúc.')

export function readCursor(cursor?: string, sortField = z.string().regex(
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?$/,
)) {
  if (!cursor) return [null, null]
  try {
    return z.tuple([
      sortField,
      idSchema,
    ]).parse(JSON.parse(Buffer.from(cursor, 'base64url').toString()))
  } catch {
    throw new ApiError(400, 'invalid_cursor', 'Mã phân trang không hợp lệ.')
  }
}

export function pageOf<T extends { cursor_at: string, cursor_id: string }>(rows: T[], limit: number) {
  const displayed = rows.slice(0, limit)
  const last = displayed.at(-1)
  return {
    data: displayed.map(({ cursor_at: _at, cursor_id: _id, ...item }) => item),
    next_cursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.cursor_at, last.cursor_id])).toString('base64url')
      : null,
  }
}

interface ScheduleRow extends Writing {
  id: string
  provider: Provider
  status: string
  key_mode: 'own' | 'service'
  version: number
  scheduled_at: Date
  encrypted_key: string | null
  quota_day: string | null
  quota_month: string | null
}

const scheduleFields = `id AS job_id, status, version, scheduled_at, model, keyword, tone, style, length, instructions`

async function siteCatalog(db: Database, config: Config, request: FastifyRequest) {
  const site = await authenticateSite(db, request)
  const { rows: [customer] } = await db.query<Package>('SELECT * FROM customers WHERE id=$1', [site.customer_id])
  if (!customer) throw notFound()
  const service = customer.key_mode === 'service'
  const models = await listAvailableModels(db, service ? customer.allowed_models : undefined)
  const { rows: configured } = await db.query<{ provider: Provider, base_url: string | null, encrypted_api_key: string | null }>(
    'SELECT provider,base_url,encrypted_api_key FROM ai_providers WHERE enabled',
  )
  const ready = new Set(configured.filter(row => {
    if (row.provider === 'openai-compatible') return Boolean(row.base_url) && (!service || Boolean(row.encrypted_api_key))
    return !service || Boolean(config.serviceKeys[row.provider])
  }).map(row => row.provider))
  return { customer, models: models.filter(model => ready.has(model.provider)) }
}

export function registerPublic(app: FastifyInstance, db: Database, config: Config) {
  app.post('/v1/article-jobs', async (request, reply) => {
    const site = await authenticateSite(db, request)
    const { mode, scheduled_at, ...writing } = createFields.parse(request.body)
    const chosenMode = mode ?? (scheduled_at ? 'scheduled' : 'preview')
    if ((chosenMode === 'scheduled') !== Boolean(scheduled_at)) {
      throw new ApiError(400, 'invalid_schedule_time', 'Giờ hẹn bắt buộc với lịch viết và dành riêng cho lịch viết.')
    }
    const job = await createJob(db, config, site, requestId(request), writing, chosenMode, scheduled_at)
    return reply.code(202).send(job)
  })

  app.get('/v1/models', async request => {
    const { models } = await siteCatalog(db, config, request)
    return { data: models }
  })

  app.get('/v1/usage', async request => {
    const { customer, models } = await siteCatalog(db, config, request)
    const { date } = z.object({ date: periodSchema.optional() }).parse(request.query)
    const current = await usage(db, customer, date ? new Date(`${date}T00:00:00+07:00`) : new Date())
    return { ...current, allowed_models: models.map(model => model.model) }
  })

  app.get('/v1/article-jobs/:job_id', async request => {
    const site = await authenticateSite(db, request)
    const { job_id } = jobParams.parse(request.params)
    const { rows: [job] } = await db.query(`
      SELECT j.id AS job_id,j.status,j.mode,j.source_article_id,j.scheduled_at,j.version,j.started_at,
             j.completed_at,j.error_code,j.error_message,j.created_at,
             (SELECT status FROM webhook_deliveries WHERE job_id=j.id ORDER BY created_at DESC LIMIT 1) AS delivery_status
      FROM jobs j WHERE j.id=$1 AND j.site_id=$2
    `, [job_id, site.id])
    if (!job) throw notFound()
    return job
  })

  app.get('/v1/article-jobs/:job_id/result', async (request, reply) => {
    const site = await authenticateSite(db, request)
    const { job_id } = jobParams.parse(request.params)
    const { rows: [job] } = await db.query('SELECT status,result,error_code,error_message FROM jobs WHERE id=$1 AND site_id=$2', [job_id, site.id])
    if (!job) throw notFound()
    if (job.status === 'ready') return job.result
    if (job.status === 'failed' || job.status === 'canceled') {
      throw new ApiError(409, job.error_code ?? job.status, job.error_message ?? 'Yêu cầu đã dừng.')
    }
    return reply.code(202).send({ status: job.status })
  })

  app.get('/v1/articles', async request => {
    const site = await authenticateSite(db, request)
    const { from, to, q, cursor, limit } = listFields.parse(request.query)
    const [timestamp, id] = readCursor(cursor)
    const { rows } = await db.query(`
      SELECT id AS article_id, source_article_id, result->0->>'Title' AS "Title", keyword, model, mode,
             completed_at, completed_at::text AS cursor_at, id AS cursor_id
      FROM jobs WHERE site_id=$1 AND status='ready'
        AND ($2::date IS NULL OR completed_at >= $2::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
        AND ($3::date IS NULL OR completed_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
        AND ($4::text IS NULL OR strpos(lower(result->0->>'Title'),lower($4))>0 OR strpos(lower(keyword),lower($4))>0)
        AND ($5::timestamptz IS NULL OR (completed_at,id)<($5,$6::uuid))
      ORDER BY completed_at DESC,id DESC LIMIT $7
    `, [site.id, from ?? null, to ?? null, q || null, timestamp, id, limit + 1])
    return pageOf(rows, limit)
  })

  app.get('/v1/schedules', async request => {
    const site = await authenticateSite(db, request)
    const { from, to, cursor, limit, status = 'scheduled' } = listFields.parse(request.query)
    const [timestamp, id] = readCursor(cursor)
    const { rows } = await db.query(`
      SELECT ${scheduleFields}, scheduled_at::text AS cursor_at, id AS cursor_id
      FROM jobs WHERE site_id=$1 AND mode='scheduled'
        AND ($2::date IS NULL OR scheduled_at >= $2::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
        AND ($3::date IS NULL OR scheduled_at < ($3::date+1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
        AND ($4::timestamptz IS NULL OR (scheduled_at,id)>($4,$5::uuid))
        AND ($6::text='all' OR status=$6)
      ORDER BY scheduled_at,id LIMIT $7
    `, [site.id, from ?? null, to ?? null, timestamp, id, status, limit + 1])
    return pageOf(rows, limit)
  })

  app.patch('/v1/schedules/:job_id', async (request, reply) => {
    const site = await authenticateSite(db, request)
    const { job_id } = jobParams.parse(request.params)
    const patch = patchFields.parse(request.body)
    const ifMatch = request.headers['if-match']
    const version = typeof ifMatch === 'string' ? /^"?(\d+)"?$/.exec(ifMatch)?.[1] : undefined
    if (!version) throw new ApiError(428, 'version_required', 'Gửi version hiện tại trong header If-Match.')
    const updated = await transaction(db, async client => {
      const account = await lockedCustomer(client, site.customer_id)
      const job = await lockSchedule(client, site.id, job_id)
      if (job.status !== 'scheduled') throw scheduleConflict(job.status)
      if (job.version !== Number(version)) throw new ApiError(412, 'version_conflict', 'Lịch đã thay đổi. Hãy tải lại.', { version: job.version })
      const when = patch.scheduled_at ? new Date(patch.scheduled_at) : job.scheduled_at
      if (patch.scheduled_at) {
        const { rows: [{ now }] } = await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
        if (when <= now) throw new ApiError(400, 'invalid_schedule_time', 'Giờ hẹn phải ở tương lai.')
      }
      const customer = { ...account, key_mode: job.key_mode }
      const writing = { ...job, ...patch }
      assertPackage(customer, when, writing.model, writing.length)
      const provider = writing.model === job.model ? job.provider : await requireAvailableModel(client, writing.model)
      const { rows: [providerSettings] } = await client.query<{ base_url: string | null, encrypted_api_key: string | null }>(
        'SELECT base_url,encrypted_api_key FROM ai_providers WHERE provider=$1', [provider],
      )
      if (provider === 'openai-compatible' && !providerSettings?.base_url) {
        throw new ApiError(422, 'provider_not_configured', 'OpenAI Compatible chưa được cấu hình Base URL trong CRM.')
      }
      if (customer.key_mode === 'service') {
        const ready = provider === 'openai-compatible'
          ? Boolean(providerSettings?.encrypted_api_key && providerSettings?.base_url)
          : Boolean(config.serviceKeys[provider])
        if (!ready) throw new ApiError(422, 'service_key_unavailable', 'Nhà cung cấp này chưa được cấu hình key dịch vụ.')
      }
      const oldKey = provider === job.provider ? job.encrypted_key : null
      const encrypted = encryptedKeyFor(writing, customer, config, provider, oldKey)
      const quota = job.quota_day && job.quota_month ? { quota_day: job.quota_day, quota_month: job.quota_month } : undefined
      await reserveQuota(client, customer, job_id, when, quota)
      const { rows: [result] } = await client.query(`
        UPDATE jobs SET scheduled_at=$2,available_at=$2,model=$3,provider=$4,keyword=$5,tone=$6,style=$7,
          length=$8,instructions=$9,encrypted_key=$10,version=version+1,updated_at=now()
        WHERE id=$1 RETURNING ${scheduleFields}
      `, [job_id, when, writing.model, provider, writing.keyword, writing.tone, writing.style,
        writing.length, writing.instructions, encrypted])
      return result
    })
    return reply.header('ETag', `"${updated.version}"`).send(updated)
  })

  app.delete('/v1/schedules/:job_id', async (request, reply) => {
    const site = await authenticateSite(db, request)
    const { job_id } = jobParams.parse(request.params)
    await transaction(db, async client => {
      await lockedCustomer(client, site.customer_id)
      const job = await lockSchedule(client, site.id, job_id)
      if (job.status === 'canceled') return
      if (job.status !== 'scheduled') throw scheduleConflict(job.status)
      await client.query(`UPDATE jobs SET status='canceled',encrypted_key=NULL,version=version+1,updated_at=now() WHERE id=$1`, [job_id])
      await client.query(`UPDATE quota_reservations SET status='released' WHERE job_id=$1 AND status='reserved'`, [job_id])
    })
    return reply.code(204).send()
  })

  app.post('/v1/articles/:article_id/rewrites', async (request, reply) => {
    const site = await authenticateSite(db, request)
    const { article_id } = z.object({ article_id: idSchema }).parse(request.params)
    const additions = rewriteFields.parse(request.body ?? {})
    const { rows: [article] } = await db.query<Writing>(`
      SELECT model,keyword,tone,style,length,instructions FROM jobs WHERE id=$1 AND site_id=$2 AND status='ready'
    `, [article_id, site.id])
    if (!article) throw notFound()
    const instructions = [article.instructions, additions.instructions].filter(Boolean).join('\n\n').slice(-8000)
    const writing = { ...article, ...additions, instructions: instructions || undefined }
    const job = await createJob(db, config, site, requestId(request), writing, 'rewrite', undefined, article_id)
    return reply.code(202).send(job)
  })
}

async function lockSchedule(client: PoolClient, siteId: string, jobId: string) {
  const { rows: [job] } = await client.query<ScheduleRow>(`
    SELECT j.*,q.quota_day::text,q.quota_month::text FROM jobs j
    LEFT JOIN quota_reservations q ON q.job_id=j.id AND q.status='reserved'
    WHERE j.id=$1 AND j.site_id=$2 AND j.mode='scheduled' FOR UPDATE OF j
  `, [jobId, siteId])
  if (!job) throw notFound()
  return job
}

function scheduleConflict(status: string) {
  return new ApiError(409, 'schedule_not_editable', 'Chỉ có thể thay đổi lịch còn chờ.', { status })
}
