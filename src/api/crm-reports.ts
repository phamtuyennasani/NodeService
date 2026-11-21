import { randomUUID } from 'node:crypto'
import { Decimal } from 'decimal.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { providers } from '../config.js'
import { collection, sessionOf, transaction, type Database } from '../db.js'
import { createJob, type Site } from './public.js'
import { modelIdSchema } from './catalog.js'
import { ApiError, articleLengthSchema, idSchema, notFound, periodSchema, timestampSchema } from './errors.js'
import { pageOf, readCursor } from './public.js'
import { cleanArticle, normalizeArticleFields } from '../worker/provider.js'
import { DatabaseJobEvents, jobEvents } from '../job-events.js'

const keys = z.object({ customer_id: idSchema.optional(), website_id: idSchema.optional() })
const listSchema = keys.extend({ from: periodSchema.optional(), to: periodSchema.optional(), limit: z.coerce.number().int().min(1).max(250).default(100), cursor: z.string().max(512).optional(), q: z.string().trim().max(160).optional() })
const jobsSchema = listSchema.extend({ status: z.enum(['scheduled', 'queued', 'writing', 'ready', 'completed', 'failed', 'canceled']).optional(), source: z.enum(['scheduled', 'schedule', 'preview', 'widget', 'rewrite']).optional(), provider: z.enum(providers).optional(), key_mode: z.enum(['own', 'service']).optional(), date_basis: z.literal('cost').optional() })
const deliveriesSchema = listSchema.extend({ status: z.enum(['pending', 'sending', 'delivered', 'failed']).optional(), event: z.enum(['article.ready', 'article.failed']).optional() })
const idParams = z.object({ id: idSchema })
const scheduleFields = z.object({ customer_id: idSchema.optional(), website_id: idSchema, model: modelIdSchema, keyword: z.string().trim().min(1).max(500), tone: z.string().trim().min(1).max(240), style: z.string().trim().min(1).max(500), length: articleLengthSchema, instructions: z.string().trim().max(4000).optional(), keyAI: z.string().trim().min(1).max(2048).optional(), use_research: z.boolean().default(true), scheduled_at: timestampSchema }).strict()
const rewriteFields = z.object({ instructions: z.string().trim().max(4000).optional(), keyAI: z.string().trim().min(1).max(2048).optional() }).strict()
const dateStart = (date?: string) => date ? new Date(`${date}T00:00:00+07:00`) : undefined
const dateEnd = (date?: string) => date ? new Date(new Date(`${date}T00:00:00+07:00`).getTime() + 86_400_000) : undefined

async function joinedJobs(db: Database) {
  const jobs = await collection<any>(db, 'jobs').find({}).toArray(); const sites = await collection<any>(db, 'sites').find({}).toArray(); const customers = await collection<any>(db, 'customers').find({}).toArray(); const siteMap = new Map(sites.map(site => [site._id, site])); const customerMap = new Map(customers.map(customer => [customer._id, customer]));
  return jobs.map(job => ({ ...job, customer: customerMap.get(job.customer_id), site: siteMap.get(job.site_id) }))
}
function reportJob(row: any) {
  return {
    id: row._id, job_id: row._id, customer_id: row.customer_id, customer_name: row.customer?.name ?? '',
    website_id: row.site_id, website_name: row.site?.name ?? '', mode: row.mode, source: row.mode === 'preview' ? 'widget' : row.mode,
    status: row.status === 'ready' ? 'completed' : row.status,
    writing_stage: row.status === 'writing' ? row.writing_stage ?? null : null,
    can_rewrite: row.status === 'failed' || (row.status === 'ready' && Boolean(row.result?.[0])),
    keyword: row.keyword, provider: row.provider, model: row.model, tone: row.tone, style: row.style, length: row.length,
    use_research: row.use_research ?? true,
    key_mode: row.key_mode, created_at: row.created_at, updated_at: row.updated_at, scheduled_at: row.scheduled_at, started_at: row.started_at, completed_at: row.completed_at,
    source_article_id: row.source_article_id, retry_of_job_id: row.retry_of_job_id ?? null, idempotency_key: row.client_request_id,
    error_code: row.error_code, error_message: row.error_message,
  }
}
function inRange(value: Date | null | undefined, from?: string, to?: string) { return (!from || (value && value >= dateStart(from)!)) && (!to || (value && value < dateEnd(to)!)) }

function costSummary(rows: any[], attempts: any[], from: Date, to: Date) {
  const jobs = new Map(rows.map(row => [row._id, row]))
  const totals = { service: new Decimal(0), customer: new Decimal(0), unpriced: 0 }
  const daily = new Map<string, { service: Decimal, customer: Decimal, unpriced: number }>()
  for (const attempt of attempts) {
    const job = jobs.get(attempt.job_id)
    if (!job) continue
    const requestedAt = attempt.requested_at instanceof Date ? attempt.requested_at : new Date(attempt.requested_at)
    if (!Number.isFinite(requestedAt.getTime()) || requestedAt < from || requestedAt >= to) continue
    const key = new Date(requestedAt.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const point = daily.get(key) ?? { service: new Decimal(0), customer: new Decimal(0), unpriced: 0 }
    if (attempt.cost_usd == null || attempt.cost_usd === '') {
      totals.unpriced += 1
      point.unpriced += 1
    } else {
      const amount = new Decimal(String(attempt.cost_usd))
      const bucket = job.key_mode === 'service' ? 'service' : 'customer'
      totals[bucket] = totals[bucket].plus(amount)
      point[bucket] = point[bucket].plus(amount)
    }
    daily.set(key, point)
  }
  return { totals, daily }
}

function costValue(value: Decimal) { return value.toFixed(12) }

export function registerReports(app: FastifyInstance, db: Database, config: Config) {
  const costVnd = (value: Decimal.Value | null | undefined) => value == null || value === ''
    ? null
    : new Decimal(value).times(config.usdToVnd).toFixed(12)
  const liveJobs = new DatabaseJobEvents(db, error => app.log.warn({ err: error }, 'CRM job event stream reconnecting'))
  const closeStreams = new Set<() => void>()
  app.addHook('onReady', async () => { liveJobs.start() })
  app.addHook('preClose', async () => {
    for (const close of closeStreams) close()
    await liveJobs.close()
  })
  app.get('/jobs/events', async (request, reply) => {
    const query = z.object({ job_id: idSchema.optional() }).parse(request.query)
    const response = reply.raw
    reply.hijack()
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready' })}\n\n`)
    const send = (event: Record<string, unknown>) => {
      if (response.destroyed || response.writableEnded) return
      // Drop slow connections rather than accumulating an unbounded buffer.
      // EventSource reconnects and the ready event reconciles missed changes.
      if (!response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)) response.destroy()
    }
    const unsubscribe = liveJobs.subscribe(send, query.job_id)
    const heartbeat = setInterval(() => {
      if (response.destroyed || response.writableEnded) return
      response.write(': heartbeat\n\n')
    }, 25_000)
    heartbeat.unref?.()
    const cleanup = () => {
      clearInterval(heartbeat)
      unsubscribe()
      closeStreams.delete(close)
    }
    const close = () => { cleanup(); response.end() }
    closeStreams.add(close)
    // IncomingMessage.close concerns request-body completion, whereas the
    // response remains open for SSE. Track the actual outbound connection.
    response.once('close', cleanup)
    response.once('error', cleanup)
  })
  app.post('/schedules', async (request, reply) => {
    const fields = scheduleFields.parse(request.body)
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
      webhook_url: site.webhook_url ?? null,
      webhook_secret: site.webhook_secret ?? null,
    } satisfies Site, clientId, {
      model: fields.model,
      keyword: fields.keyword,
      tone: fields.tone,
      style: fields.style,
      length: fields.length,
      instructions: fields.instructions,
      keyAI: fields.keyAI,
      use_research: fields.use_research,
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
      webhook_url: site.webhook_url ?? null,
      webhook_secret: site.webhook_secret ?? null,
    } satisfies Site, clientId, {
      model: article.model,
      keyword: article.keyword,
      tone: article.tone,
      style: article.style,
      length: article.length,
      instructions: instructions || undefined,
      keyAI: additions.keyAI,
      use_research: article.use_research ?? true,
    }, 'rewrite', undefined, sourceId, retryFailed ? id : undefined)
    return reply.code(202).send(result)
  })
  app.get('/dashboard/runtime', async (request, reply) => {
    const filters = keys.parse(request.query)
    const now = new Date()
    const rows = await collection<any>(db, 'jobs').find({
      status: { $in: ['scheduled', 'queued', 'writing'] },
      ...(filters.customer_id ? { customer_id: filters.customer_id } : {}),
      ...(filters.website_id ? { site_id: filters.website_id } : {}),
    }, { projection: {
      _id: 1, customer_id: 1, site_id: 1, mode: 1, status: 1, writing_stage: 1, keyword: 1,
      provider: 1, model: 1, tone: 1, style: 1, length: 1, use_research: 1, key_mode: 1,
      created_at: 1, scheduled_at: 1, started_at: 1, completed_at: 1,
      source_article_id: 1, retry_of_job_id: 1, client_request_id: 1,
      error_code: 1, error_message: 1, lease_token: 1, lease_expires_at: 1,
    } }).toArray()
    const timeOf = (value: unknown) => value instanceof Date && Number.isFinite(value.getTime()) ? value.getTime() : 0
    const leaseActive = (row: any) => row.status === 'writing' && typeof row.lease_token === 'string' && row.lease_token.trim().length > 0 && timeOf(row.lease_expires_at) > now.getTime()
    const queued = (row: any) => row.status === 'queued' || (row.status === 'scheduled' && timeOf(row.scheduled_at) <= now.getTime())
    const writing = rows.filter(row => row.status === 'writing')
    const activeThreads = writing.filter(leaseActive).length
    const running = [...writing].sort((a, b) => timeOf(b.started_at) - timeOf(a.started_at) || timeOf(b.created_at) - timeOf(a.created_at) || String(a._id).localeCompare(String(b._id))).slice(0, 20)
    const [customers, sites] = running.length ? await Promise.all([
      collection<any>(db, 'customers').find({ _id: { $in: [...new Set(running.map(row => row.customer_id))] } }, { projection: { _id: 1, name: 1 } }).toArray(),
      collection<any>(db, 'sites').find({ _id: { $in: [...new Set(running.map(row => row.site_id))] } }, { projection: { _id: 1, name: 1 } }).toArray(),
    ]) : [[], []]
    const customerMap = new Map(customers.map(row => [row._id, row]))
    const siteMap = new Map(sites.map(row => [row._id, row]))
    reply.header('Cache-Control', 'no-store')
    return {
      observed_at: now.toISOString(),
      summary: {
        writing: writing.length,
        queued: rows.filter(queued).length,
        scheduled: rows.filter(row => row.status === 'scheduled' && !queued(row)).length,
        active_threads: activeThreads,
        stale_writing: writing.length - activeThreads,
      },
      capacity: { writer_per_process: config.workerConcurrency, webhook_per_process: config.webhookConcurrency },
      providers: providers.map(provider => {
        const providerRows = rows.filter(row => row.provider === provider)
        return { provider, writing: providerRows.filter(row => row.status === 'writing').length, queued: providerRows.filter(queued).length, active_threads: providerRows.filter(leaseActive).length }
      }),
      running: running.map(row => ({
        ...reportJob({ ...row, customer: customerMap.get(row.customer_id), site: siteMap.get(row.site_id) }),
        lease_active: leaseActive(row),
        elapsed_seconds: row.started_at ? Math.max(0, Math.floor((now.getTime() - timeOf(row.started_at)) / 1000)) : 0,
      })),
    }
  })
  app.get('/dashboard', async request => {
    const filters = keys.extend({ from: periodSchema.optional(), to: periodSchema.optional() }).parse(request.query)
    const scopedRows = (await joinedJobs(db)).filter(row => (!filters.customer_id || row.customer_id === filters.customer_id) && (!filters.website_id || row.site_id === filters.website_id))
    const rows = scopedRows.filter(row => inRange(row.completed_at ?? row.created_at, filters.from, filters.to))
    const jobIds = rows.map(row => row._id)
    const [deliveries, attempts] = await Promise.all([
      collection<any>(db, 'webhook_deliveries').find({ job_id: { $in: jobIds } }).toArray(),
      collection<any>(db, 'ai_attempts').find({ job_id: { $in: scopedRows.map(row => row._id) } }).toArray(),
    ])
    const from = dateStart(filters.from ?? new Date(Date.now() + 7 * 60 * 60 * 1000 - 13 * 86_400_000).toISOString().slice(0, 10))!
    const to = dateEnd(filters.to) ?? new Date()
    // Usage belongs to the day the AI request began, even when the job finishes later.
    const costs = costSummary(scopedRows, attempts, from, to)
    const series: any[] = []
    for (let cursor = new Date(from); cursor < to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const next = new Date(cursor.getTime() + 86_400_000)
      const day = new Date(cursor.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
      const dayJobs = rows.filter(row => row.completed_at && row.completed_at >= cursor && row.completed_at < next)
      const dayDeliveries = deliveries.filter(delivery => delivery.delivered_at && delivery.delivered_at >= cursor && delivery.delivered_at < next)
      const point = costs.daily.get(day)
      series.push({
        date: day,
        articles: dayJobs.length,
        delivered: dayDeliveries.length,
        service_cost_usd: costValue(point?.service ?? new Decimal(0)),
        customer_cost_usd: costValue(point?.customer ?? new Decimal(0)),
        service_cost_vnd: costVnd(point?.service ?? new Decimal(0)),
        customer_cost_vnd: costVnd(point?.customer ?? new Decimal(0)),
        unpriced_attempts: point?.unpriced ?? 0,
      })
    }
    const ready = rows.filter(row => row.status === 'ready')
    return {
      metrics: {
        customers: new Set(rows.map(row => row.customer_id)).size,
        websites: new Set(rows.map(row => row.site_id)).size,
        articles: ready.length,
        delivered: deliveries.filter(delivery => delivery.status === 'delivered').length,
        pending: rows.filter(row => ['scheduled', 'queued', 'writing'].includes(row.status)).length,
        write_errors: rows.filter(row => row.status === 'failed').length,
        delivery_errors: deliveries.filter(delivery => delivery.status === 'failed').length,
        service_cost_usd: costValue(costs.totals.service),
        customer_cost_usd: costValue(costs.totals.customer),
        service_cost_vnd: costVnd(costs.totals.service),
        customer_cost_vnd: costVnd(costs.totals.customer),
        total_cost_vnd: costVnd(costs.totals.service.plus(costs.totals.customer)),
        unpriced_attempts: costs.totals.unpriced,
      },
      series,
      upcoming: rows.filter(row => row.status === 'scheduled').sort((a, b) => a.scheduled_at - b.scheduled_at).slice(0, 10).map(reportJob),
      failures: rows.filter(row => row.status === 'failed').sort((a, b) => b.created_at - a.created_at).slice(0, 10).map(reportJob),
    }
  })
  app.get('/jobs', async request => {
    const filters = jobsSchema.parse(request.query)
    const [cursorAt, cursorId] = readCursor(filters.cursor)
    const source = filters.source === 'schedule' ? 'scheduled' : filters.source === 'widget' ? 'preview' : filters.source
    let rows = (await joinedJobs(db)).filter(row =>
      (!filters.customer_id || row.customer_id === filters.customer_id) &&
      (!filters.website_id || row.site_id === filters.website_id) &&
      (filters.date_basis === 'cost' || inRange(row.created_at, filters.from, filters.to)) &&
      (!filters.status || row.status === (filters.status === 'completed' ? 'ready' : filters.status)) &&
      (!source || source === row.mode) &&
      (!filters.provider || row.provider === filters.provider) && (!filters.key_mode || row.key_mode === filters.key_mode) &&
      (!filters.q || `${row.keyword} ${row._id}`.toLowerCase().includes(filters.q.toLowerCase())))
    rows.sort((a, b) => b.created_at - a.created_at || b._id.localeCompare(a._id))
    rows = rows.filter(row => !cursorAt || row.created_at.toISOString() < cursorAt || (row.created_at.toISOString() === cursorAt && row._id < cursorId!))
    let attempts: any[] | undefined
    if (filters.date_basis === 'cost') {
      attempts = (await collection<any>(db, 'ai_attempts').find({ job_id: { $in: rows.map(row => row._id) } }).toArray())
        .filter(attempt => inRange(attempt.requested_at, filters.from, filters.to))
      const costJobs = new Set(attempts.map(attempt => attempt.job_id))
      rows = rows.filter(row => costJobs.has(row._id))
    }
    const mapped: any[] = rows.slice(0, filters.limit + 1).map(row => ({ ...reportJob(row), cursor_at: row.created_at.toISOString(), cursor_id: row._id }))
    attempts ??= await collection<any>(db, 'ai_attempts').find({ job_id: { $in: mapped.map(row => row.id) } }).toArray()
    for (const row of mapped) {
      const priced = attempts.filter(attempt => attempt.job_id === row.id && attempt.cost_usd != null && attempt.cost_usd !== '')
      const cost = priced.length ? priced.reduce((sum, attempt) => sum.plus(String(attempt.cost_usd)), new Decimal(0)) : null
      row.cost_usd = cost == null ? null : costValue(cost)
      row.cost_vnd = costVnd(cost)
    }
    return pageOf(mapped, filters.limit)
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
    jobEvents.publish({ type: 'job.deleted', job_id: id, deleted: true })
    return reply.code(204).send()
  })
  app.get('/jobs/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    const row = await collection<any>(db, 'jobs').findOne({ _id: id })
    if (!row) throw notFound()
    const [customer, site, attempts, deliveries] = await Promise.all([
      collection<any>(db, 'customers').findOne({ _id: row.customer_id }),
      collection<any>(db, 'sites').findOne({ _id: row.site_id }),
      collection<any>(db, 'ai_attempts').find({ job_id: id }).sort({ requested_at: 1 }).toArray(),
      collection<any>(db, 'webhook_deliveries').find({ job_id: id }).sort({ created_at: 1 }).toArray(),
    ])
    const ready = row.status === 'ready'
    const pricedAttempts = attempts.filter(attempt => attempt.cost_usd != null && attempt.cost_usd !== '')
    const cost = pricedAttempts.length ? pricedAttempts.reduce((sum, attempt) => sum.plus(String(attempt.cost_usd)), new Decimal(0)) : null
    reply.header('Cache-Control', 'no-store')
    return {
      ...reportJob({ ...row, customer, site }),
      cost_usd: cost == null ? null : costValue(cost),
      cost_vnd: costVnd(cost),
      rewrite_key_mode: customer?.key_mode ?? row.key_mode,
      outline: ready ? row.outline ?? null : null,
      result: ready && Array.isArray(row.result) ? row.result.map(normalizeArticleFields) : ready ? row.result : null,
      seo_report: ready ? row.seo_report ?? null : null,
      seo_repair_status: ready ? row.seo_repair_status ?? null : null,
      instructions: row.instructions,
      attempts: attempts.map(attempt => ({
        id: attempt._id, provider: attempt.provider, model: attempt.model, stage: attempt.stage ?? null,
        status: attempt.status, started_at: attempt.requested_at, called_at: attempt.requested_at,
        pricing_id: attempt.pricing_id, pricing_snapshot: attempt.pricing_snapshot, provider_response_id: attempt.provider_response_id,
        usage: attempt.usage, finished_at: attempt.finished_at, cost_usd: attempt.cost_usd, cost_vnd: costVnd(attempt.cost_usd), cost_source: attempt.cost_source,
        error_code: attempt.error_code, error_message: attempt.error,
      })),
      deliveries: await Promise.all(deliveries.map(delivery => deliveryView(db, delivery))),
    }
  })
  app.get('/deliveries', async request => {
    const filters = deliveriesSchema.parse(request.query)
    const [cursorAt, cursorId] = readCursor(filters.cursor)
    const rows = await joinedJobs(db)
    const deliveries = await collection<any>(db, 'webhook_deliveries').find({}).sort({ created_at: -1, _id: -1 }).toArray()
    const mapped = deliveries.filter(delivery => {
      const job = rows.find(row => row._id === delivery.job_id)
      const createdAt = delivery.created_at.toISOString()
      return job && (!filters.customer_id || job.customer_id === filters.customer_id) &&
        (!filters.website_id || job.site_id === filters.website_id) && inRange(delivery.created_at, filters.from, filters.to) &&
        (!filters.status || delivery.status === filters.status) && (!filters.event || delivery.event === filters.event) &&
        (!cursorAt || createdAt < cursorAt || (createdAt === cursorAt && delivery._id < cursorId!))
    }).slice(0, filters.limit + 1)
    const result = await Promise.all(mapped.map(delivery => deliveryView(db, delivery)))
    return pageOf(result.map(row => ({ ...row, cursor_at: new Date(row.created_at).toISOString(), cursor_id: row.id })), filters.limit)
  })
  app.get('/deliveries/:id', async request => { const { id } = idParams.parse(request.params); const delivery = await collection<any>(db, 'webhook_deliveries').findOne({ _id: id }); if (!delivery) throw notFound(); return deliveryView(db, delivery) })
  app.post('/deliveries/:id/retry', async request => { const { id } = idParams.parse(request.params); const result = await collection(db, 'webhook_deliveries').updateOne({ _id: id, status: 'failed' }, { $set: { status: 'pending', attempt_count: 0, next_attempt_at: new Date(), error: null, updated_at: new Date() } }); if (!result.matchedCount) { const current = await collection(db, 'webhook_deliveries').findOne({ _id: id }); if (!current) throw notFound(); throw new ApiError(409, 'delivery_not_failed', 'Chỉ có thể gửi lại webhook đã lỗi.') } return { id, status: 'pending' } })
}

async function deliveryView(db: Database, delivery: any) { const job = await collection<any>(db, 'jobs').findOne({ _id: delivery.job_id }); const site = await collection<any>(db, 'sites').findOne({ _id: delivery.site_id }); const customer = job ? await collection<any>(db, 'customers').findOne({ _id: job.customer_id }) : null; const attempts = await collection<any>(db, 'webhook_attempts').find({ delivery_id: delivery._id }).sort({ attempted_at: 1 }).toArray(); return { id: delivery._id, job_id: delivery.job_id, website_id: delivery.site_id, website_name: site?.name ?? '', customer_name: customer?.name ?? '', keyword: job?.keyword, status: delivery.status, event_type: delivery.event, attempts: attempts.length, attempt_count: delivery.attempt_count, last_http_status: delivery.http_status ?? null, last_error: delivery.error ?? null, next_attempt_at: delivery.next_attempt_at, delivered_at: delivery.delivered_at ?? null, created_at: delivery.created_at, history: attempts.map(attempt => ({ id: attempt._id, attempted_at: attempt.attempted_at, started_at: attempt.attempted_at, finished_at: attempt.finished_at, http_status: attempt.http_status, error: attempt.error })) } }
// @ts-nocheck
