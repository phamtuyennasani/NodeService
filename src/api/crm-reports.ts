import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { providers } from '../config.js'
import { collection, type Database } from '../db.js'
import { createJob, type Site } from './public.js'
import { modelIdSchema } from './catalog.js'
import { ApiError, idSchema, notFound, periodSchema, quantitySchema, timestampSchema } from './errors.js'
import { pageOf, readCursor } from './public.js'

const keys = z.object({ customer_id: idSchema.optional(), website_id: idSchema.optional() })
const listSchema = keys.extend({ from: periodSchema.optional(), to: periodSchema.optional(), limit: z.coerce.number().int().min(1).max(250).default(100), cursor: z.string().max(512).optional(), q: z.string().trim().max(160).optional() })
const jobsSchema = listSchema.extend({ status: z.enum(['scheduled', 'queued', 'writing', 'ready', 'completed', 'failed', 'canceled']).optional(), source: z.enum(['scheduled', 'schedule', 'preview', 'widget', 'rewrite']).optional(), provider: z.enum(providers).optional(), key_mode: z.enum(['own', 'service']).optional(), date_basis: z.literal('cost').optional() })
const deliveriesSchema = listSchema.extend({ status: z.enum(['pending', 'sending', 'delivered', 'failed']).optional(), event: z.enum(['article.ready', 'article.failed']).optional() })
const idParams = z.object({ id: idSchema })
const scheduleFields = z.object({ customer_id: idSchema.optional(), website_id: idSchema, model: modelIdSchema, keyword: z.string().trim().min(1).max(500), tone: z.string().trim().min(1).max(240), style: z.string().trim().min(1).max(500), length: quantitySchema, instructions: z.string().trim().max(4000).optional(), keyAI: z.string().trim().min(1).max(2048).optional(), scheduled_at: timestampSchema }).strict()
const dateStart = (date?: string) => date ? new Date(`${date}T00:00:00+07:00`) : undefined
const dateEnd = (date?: string) => date ? new Date(new Date(`${date}T00:00:00+07:00`).getTime() + 86_400_000) : undefined

async function joinedJobs(db: Database) {
  const jobs = await collection<any>(db, 'jobs').find({}).toArray(); const sites = await collection<any>(db, 'sites').find({}).toArray(); const customers = await collection<any>(db, 'customers').find({}).toArray(); const siteMap = new Map(sites.map(site => [site._id, site])); const customerMap = new Map(customers.map(customer => [customer._id, customer]));
  return jobs.map(job => ({ ...job, customer: customerMap.get(job.customer_id), site: siteMap.get(job.site_id) }))
}
function reportJob(row: any) { return { id: row._id, job_id: row._id, customer_id: row.customer_id, customer_name: row.customer?.name ?? '', website_id: row.site_id, website_name: row.site?.name ?? '', mode: row.mode, source: row.mode === 'preview' ? 'widget' : row.mode, status: row.status === 'ready' ? 'completed' : row.status, keyword: row.keyword, provider: row.provider, model: row.model, tone: row.tone, style: row.style, length: row.length, key_mode: row.key_mode, created_at: row.created_at, scheduled_at: row.scheduled_at, started_at: row.started_at, completed_at: row.completed_at, source_article_id: row.source_article_id, idempotency_key: row.client_request_id, error_code: row.error_code, error_message: row.error_message }
}
function inRange(value: Date | null | undefined, from?: string, to?: string) { return (!from || (value && value >= dateStart(from)!)) && (!to || (value && value < dateEnd(to)!)) }

export function registerReports(app: FastifyInstance, db: Database, config: Config) {
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
    }, 'scheduled', fields.scheduled_at)
    return reply.code(202).send(result)
  })
  app.get('/dashboard', async request => {
    const filters = keys.extend({ from: periodSchema.optional(), to: periodSchema.optional() }).parse(request.query); const rows = (await joinedJobs(db)).filter(row => (!filters.customer_id || row.customer_id === filters.customer_id) && (!filters.website_id || row.site_id === filters.website_id) && inRange(row.completed_at ?? row.created_at, filters.from, filters.to)); const deliveries = await collection<any>(db, 'webhook_deliveries').find({}).toArray(); const attempts = await collection<any>(db, 'ai_attempts').find({}).toArray(); const from = dateStart(filters.from) ?? new Date(Date.now() - 13 * 86_400_000); const to = dateEnd(filters.to) ?? new Date(); const series: any[] = []; for (let cursor = new Date(from); cursor < to; cursor.setUTCDate(cursor.getUTCDate() + 1)) { const next = new Date(cursor.getTime() + 86_400_000); const day = cursor.toISOString().slice(0, 10); const dayJobs = rows.filter(row => row.completed_at && row.completed_at >= cursor && row.completed_at < next); const dayDeliveries = deliveries.filter(delivery => delivery.delivered_at && delivery.delivered_at >= cursor && delivery.delivered_at < next); series.push({ date: day, articles: dayJobs.length, delivered: dayDeliveries.length, service_cost_usd: 0, customer_cost_usd: 0, unpriced_attempts: attempts.filter(attempt => !attempt.cost_usd && attempt.requested_at >= cursor && attempt.requested_at < next).length }) } const ready = rows.filter(row => row.status === 'completed'); return { metrics: { customers: new Set(rows.map(row => row.customer_id)).size, websites: new Set(rows.map(row => row.site_id)).size, articles: ready.length, delivered: deliveries.filter(delivery => delivery.status === 'delivered').length, pending: rows.filter(row => ['scheduled', 'queued', 'writing'].includes(row.status)).length, write_errors: rows.filter(row => row.status === 'failed').length, delivery_errors: deliveries.filter(delivery => delivery.status === 'failed').length, service_cost_usd: 0, customer_cost_usd: 0, unpriced_attempts: attempts.filter(attempt => !attempt.cost_usd).length }, series, upcoming: rows.filter(row => row.status === 'scheduled').sort((a, b) => a.scheduled_at - b.scheduled_at).slice(0, 10).map(reportJob), failures: rows.filter(row => row.status === 'failed').sort((a, b) => b.created_at - a.created_at).slice(0, 10).map(reportJob) } })
  app.get('/jobs', async request => { const filters = jobsSchema.parse(request.query); const [cursorAt, cursorId] = readCursor(filters.cursor); let rows = (await joinedJobs(db)).filter(row => (!filters.customer_id || row.customer_id === filters.customer_id) && (!filters.website_id || row.site_id === filters.website_id) && inRange(filters.date_basis === 'cost' ? row.started_at : row.created_at, filters.from, filters.to) && (!filters.status || filters.status === 'completed' ? (!filters.status || (filters.status === 'completed' ? row.status === 'ready' : true)) : row.status === filters.status) && (!filters.source || filters.source === row.mode || (filters.source === 'widget' && row.mode === 'preview')) && (!filters.provider || row.provider === filters.provider) && (!filters.key_mode || row.key_mode === filters.key_mode) && (!filters.q || `${row.keyword} ${row._id}`.toLowerCase().includes(filters.q.toLowerCase()))); rows.sort((a, b) => b.created_at - a.created_at || b._id.localeCompare(a._id)); rows = rows.filter(row => !cursorAt || row.created_at.toISOString() < cursorAt || (row.created_at.toISOString() === cursorAt && row._id < cursorId!)); const mapped: any[] = rows.slice(0, filters.limit + 1).map(row => ({ ...reportJob(row), cursor_at: row.created_at.toISOString(), cursor_id: row._id })); const attempts = await collection<any>(db, 'ai_attempts').find({}).toArray(); for (const row of mapped) { const cost = attempts.filter(attempt => attempt.job_id === row.id).reduce((sum, attempt) => sum + Number(attempt.cost_usd ?? 0), 0); row.cost_usd = cost ? cost.toFixed(12) : null } return pageOf(mapped, filters.limit) })
  app.get('/jobs/:id', async request => { const { id } = idParams.parse(request.params); const rows = await joinedJobs(db); const row = rows.find(item => item._id === id); if (!row) throw notFound(); const attempts = await collection<any>(db, 'ai_attempts').find({ job_id: id }).sort({ requested_at: 1 }).toArray(); const deliveries = await collection<any>(db, 'webhook_deliveries').find({ job_id: id }).sort({ created_at: 1 }).toArray(); return { ...reportJob(row), result: row.result, instructions: row.instructions, attempts: attempts.map(attempt => ({ id: attempt._id, provider: attempt.provider, model: attempt.model, status: attempt.status, started_at: attempt.requested_at, called_at: attempt.requested_at, pricing_id: attempt.pricing_id, pricing_snapshot: attempt.pricing_snapshot, provider_response_id: attempt.provider_response_id, usage: attempt.usage, finished_at: attempt.finished_at, cost_usd: attempt.cost_usd, cost_source: attempt.cost_source, error_code: attempt.error_code, error_message: attempt.error })), deliveries: await Promise.all(deliveries.map(delivery => deliveryView(db, delivery))) } })
  app.get('/deliveries', async request => { const filters = deliveriesSchema.parse(request.query); const rows = await joinedJobs(db); const deliveries = await collection<any>(db, 'webhook_deliveries').find({}).sort({ created_at: -1, _id: -1 }).toArray(); const mapped = deliveries.filter(delivery => { const job = rows.find(row => row._id === delivery.job_id); return job && (!filters.customer_id || job.customer_id === filters.customer_id) && (!filters.website_id || job.site_id === filters.website_id) && inRange(delivery.created_at, filters.from, filters.to) && (!filters.status || delivery.status === filters.status) && (!filters.event || delivery.event === filters.event) }).slice(0, filters.limit + 1); const result = await Promise.all(mapped.map(delivery => deliveryView(db, delivery))); return pageOf(result.map(row => ({ ...row, cursor_at: new Date(row.created_at).toISOString(), cursor_id: row.id })), filters.limit) })
  app.get('/deliveries/:id', async request => { const { id } = idParams.parse(request.params); const delivery = await collection<any>(db, 'webhook_deliveries').findOne({ _id: id }); if (!delivery) throw notFound(); return deliveryView(db, delivery) })
  app.post('/deliveries/:id/retry', async request => { const { id } = idParams.parse(request.params); const result = await collection(db, 'webhook_deliveries').updateOne({ _id: id, status: 'failed' }, { $set: { status: 'pending', attempt_count: 0, next_attempt_at: new Date(), error: null, updated_at: new Date() } }); if (!result.matchedCount) { const current = await collection(db, 'webhook_deliveries').findOne({ _id: id }); if (!current) throw notFound(); throw new ApiError(409, 'delivery_not_failed', 'Chỉ có thể gửi lại webhook đã lỗi.') } return { id, status: 'pending' } })
}

async function deliveryView(db: Database, delivery: any) { const job = await collection<any>(db, 'jobs').findOne({ _id: delivery.job_id }); const site = await collection<any>(db, 'sites').findOne({ _id: delivery.site_id }); const customer = job ? await collection<any>(db, 'customers').findOne({ _id: job.customer_id }) : null; const attempts = await collection<any>(db, 'webhook_attempts').find({ delivery_id: delivery._id }).sort({ attempted_at: 1 }).toArray(); return { id: delivery._id, job_id: delivery.job_id, website_id: delivery.site_id, website_name: site?.name ?? '', customer_name: customer?.name ?? '', keyword: job?.keyword, status: delivery.status, event_type: delivery.event, attempts: attempts.length, attempt_count: delivery.attempt_count, last_http_status: delivery.http_status ?? null, last_error: delivery.error ?? null, next_attempt_at: delivery.next_attempt_at, delivered_at: delivery.delivered_at ?? null, created_at: delivery.created_at, history: attempts.map(attempt => ({ id: attempt._id, attempted_at: attempt.attempted_at, started_at: attempt.attempted_at, finished_at: attempt.finished_at, http_status: attempt.http_status, error: attempt.error })) } }
// @ts-nocheck
