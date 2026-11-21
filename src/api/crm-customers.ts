import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { collection, sessionOf, transaction, type Database } from '../db.js'
import { digest, issueToken, seal } from '../security.js'
import { validateWebhookUrl } from '../worker/webhook.js'
import { assertAvailableModels, modelIdSchema } from './catalog.js'
import { ApiError, idSchema, notFound, periodSchema, quantitySchema, timestampSchema } from './errors.js'
import { pageOf, readCursor } from './public.js'
import { usage, type Package } from './quota.js'

const nullableString = (max: number) => z.string().trim().max(max).nullable().optional()
const customerFields = z.object({ name: z.string().trim().min(1).max(160), email: nullableString(320), phone: nullableString(80), notes: nullableString(4000), key_mode: z.enum(['own', 'service']).optional(), daily_limit: z.number().int().nonnegative().max(1_000_000).nullable().optional(), monthly_limit: z.number().int().nonnegative().max(1_000_000).nullable().optional(), allowed_models: z.array(modelIdSchema).max(100).nullable().optional(), max_length: quantitySchema.nullable().optional(), active_from: timestampSchema.nullable().optional(), active_until: timestampSchema.nullable().optional() }).strict()
const websiteFields = z.object({ customer_id: idSchema, name: z.string().trim().min(1).max(160), domain: z.string().trim().min(1).max(253), webhook_url: z.string().trim().min(1).max(2048) }).strict()
const listQuery = z.object({ q: z.string().trim().max(160).optional(), cursor: z.string().max(2048).optional(), id: idSchema.optional(), limit: z.coerce.number().int().min(1).max(500).default(250), customer_id: idSchema.optional() })
const idParams = z.object({ id: idSchema }); const nameCursor = z.string().min(1).max(160)
type CustomerDoc = Package & { _id: string, name: string, email: string | null, phone: string | null, notes: string | null, starts_at: Date | null, ends_at: Date | null, created_at: Date, updated_at: Date }
type SiteDoc = { _id: string, customer_id: string, name: string, domain: string, webhook_url: string, webhook_secret: string | null, token_hash?: string | null, token_prefix?: string | null, last_used_at?: Date | null, created_at: Date, updated_at: Date }
const toPackage = (row: CustomerDoc): Package => ({ id: row._id, key_mode: row.key_mode, daily_limit: row.daily_limit, monthly_limit: row.monthly_limit, allowed_models: row.allowed_models ?? [], max_length: row.max_length, starts_at: row.starts_at, ends_at: row.ends_at })
function normalizeDomain(domain: string) { try { const parsed = new URL(domain.includes('://') ? domain : 'https://' + domain); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) throw new Error(); return parsed.host } catch { throw new ApiError(400, 'invalid_domain', 'Vui lòng nhập tên miền hoặc địa chỉ gốc của website.') } }
async function customerArguments(source: Database, fields: z.infer<typeof customerFields>, previousModels: string[] = []) { const from = fields.active_from ? new Date(fields.active_from) : null; const until = fields.active_until ? new Date(fields.active_until) : null; if (from && until && from >= until) throw new ApiError(400, 'invalid_package_period', 'Ngày hết hạn phải sau ngày bắt đầu gói.'); const models = [...new Set(fields.allowed_models ?? [])]; if (fields.key_mode === 'service' && (fields.daily_limit == null || fields.monthly_limit == null || models.length === 0)) throw new ApiError(400, 'package_incomplete', 'Gói dịch vụ cần hạn mức ngày, hạn mức tháng và ít nhất một model.'); await assertAvailableModels(source, models.filter(model => !previousModels.includes(model))); return { name: fields.name, email: fields.email ?? null, phone: fields.phone ?? null, notes: fields.notes ?? null, key_mode: fields.key_mode ?? 'own', daily_limit: fields.daily_limit ?? null, monthly_limit: fields.monthly_limit ?? null, allowed_models: models, max_length: fields.max_length ?? null, starts_at: from, ends_at: until } }
async function websiteArguments(fields: z.infer<typeof websiteFields>, config: Config) { const domain = normalizeDomain(fields.domain); try { await validateWebhookUrl(fields.webhook_url, config.allowLocalWebhooks) } catch { throw new ApiError(400, 'invalid_webhook_url', 'URL nhận bài không hợp lệ hoặc không thể truy cập.') } return { customer_id: fields.customer_id, name: fields.name, domain, webhook_url: fields.webhook_url } }

export function registerCustomers(app: FastifyInstance, db: Database, config: Config) {
  app.get('/customers', async request => { const { q, limit, cursor, id } = listQuery.parse(request.query); const [name, cursorId] = readCursor(cursor, nameCursor); const customers = await collection<CustomerDoc>(db, 'customers').find(id ? { _id: id } : {}).sort({ name: 1, _id: 1 }).toArray(); const rows: any[] = []; for (const customer of customers) { if (q && !`${customer.name} ${customer.email ?? ''} ${customer.phone ?? ''} ${customer._id}`.toLowerCase().includes(q.toLowerCase())) continue; if (name && (customer.name < name || (customer.name === name && customer._id <= cursorId!))) continue; const websiteCount = await collection(db, 'sites').countDocuments({ customer_id: customer._id }); const articleCount = await collection(db, 'jobs').countDocuments({ customer_id: customer._id, status: 'ready' }); rows.push({ id: customer._id, name: customer.name, email: customer.email, phone: customer.phone, notes: customer.notes, key_mode: customer.key_mode, daily_limit: customer.daily_limit, monthly_limit: customer.monthly_limit, allowed_models: customer.allowed_models, max_length: customer.max_length, active_from: customer.starts_at, active_until: customer.ends_at, created_at: customer.created_at, website_count: websiteCount, article_count: articleCount, cursor_at: customer.name, cursor_id: customer._id }); if (rows.length >= limit + 1) break } return pageOf(rows, limit) })
  app.post('/customers', async (request, reply) => { const fields = customerFields.parse(request.body); const values = await customerArguments(db, fields); const now = new Date(); const doc = { _id: randomUUID(), ...values, created_at: now, updated_at: now }; await collection(db, 'customers').insertOne(doc); return reply.code(201).send({ id: doc._id, ...values, active_from: values.starts_at, active_until: values.ends_at, created_at: now, website_count: 0, article_count: 0 }) })
  app.patch('/customers/:id', async request => { const { id } = idParams.parse(request.params); const patch = customerFields.partial().parse(request.body); return transaction(db, async client => { const existing = await collection<CustomerDoc>(client, 'customers').findOne({ _id: id }); if (!existing) throw notFound(); const values = { name: existing.name, email: existing.email, phone: existing.phone, notes: existing.notes, key_mode: existing.key_mode, daily_limit: existing.daily_limit, monthly_limit: existing.monthly_limit, allowed_models: existing.allowed_models, max_length: existing.max_length, active_from: existing.starts_at?.toISOString() ?? null, active_until: existing.ends_at?.toISOString() ?? null, ...patch }; const args = await customerArguments(client as unknown as Database, values, existing.allowed_models); await collection(client, 'customers').updateOne({ _id: id }, { $set: { ...args, updated_at: new Date() } }); const websiteCount = await collection(client, 'sites').countDocuments({ customer_id: id }); const articleCount = await collection(client, 'jobs').countDocuments({ customer_id: id, status: 'ready' }); return { id, ...args, active_from: args.starts_at, active_until: args.ends_at, created_at: existing.created_at, website_count: websiteCount, article_count: articleCount } }) })
  app.delete('/customers/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    await transaction(db, async client => {
      const session = sessionOf(client)
      const existing = await collection<CustomerDoc>(client, 'customers').findOne({ _id: id }, { session })
      if (!existing) throw notFound()
      const website = await collection(client, 'sites').findOne({ customer_id: id }, { projection: { _id: 1 }, session })
      const job = await collection(client, 'jobs').findOne({ customer_id: id }, { projection: { _id: 1 }, session })
      if (website || job) throw new ApiError(409, 'customer_has_history', 'Không thể xóa khách hàng còn website hoặc lịch sử viết bài. Hãy xóa các website và bài viết trước.')
      await collection(client, 'quota_reservations').deleteMany({ customer_id: id }, { session })
      await collection(client, 'customers').deleteOne({ _id: id }, { session })
    })
    return reply.code(204).send()
  })
  app.get('/customers/:id/usage', async request => { const { id } = idParams.parse(request.params); const { date } = z.object({ date: periodSchema.optional() }).parse(request.query); const customer = await collection<CustomerDoc>(db, 'customers').findOne({ _id: id }); if (!customer) throw notFound(); const when = date ? new Date(`${date}T00:00:00+07:00`) : new Date(); const result = await usage(db, toPackage(customer), when); const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(when).slice(0, 7); const reservations = await collection(db, 'quota_reservations').find({ customer_id: id, quota_month: month, status: { $in: ['used', 'reserved'] } }).sort({ quota_day: -1, job_id: -1 }).limit(100).toArray(); const enriched = await Promise.all(reservations.map(async reservation => { const job = await collection<any>(db, 'jobs').findOne({ _id: reservation.job_id }); const site = job ? await collection<any>(db, 'sites').findOne({ _id: job.site_id }) : null; return { job_id: reservation.job_id, quota_day: reservation.quota_day, status: reservation.status, keyword: job?.keyword, scheduled_at: job?.scheduled_at ?? null, website_name: site?.name ?? '' } })); return { ...result, reservations: enriched } })
  app.get('/websites', async request => { const { q, limit, customer_id, cursor, id } = listQuery.parse(request.query); const [name, cursorId] = readCursor(cursor, nameCursor); const sites = await collection<SiteDoc>(db, 'sites').find(id ? { _id: id } : customer_id ? { customer_id } : {}).sort({ name: 1, _id: 1 }).toArray(); const rows: any[] = []; for (const site of sites) { const customer = await collection<CustomerDoc>(db, 'customers').findOne({ _id: site.customer_id }); if (!customer || (q && !`${site.name} ${site.domain} ${customer.name}`.toLowerCase().includes(q.toLowerCase())) || (name && (site.name < name || (site.name === name && site._id <= cursorId!)))) continue; rows.push({ id: site._id, name: site.name, customer_id: site.customer_id, customer_name: customer.name, domain: site.domain, webhook_url: site.webhook_url, token_hint: site.token_prefix ?? null, last_seen_at: site.last_used_at ?? null, webhook_secret_configured: Boolean(site.webhook_secret), created_at: site.created_at, article_count: await collection(db, 'jobs').countDocuments({ site_id: site._id, status: 'ready' }), cursor_at: site.name, cursor_id: site._id }); if (rows.length >= limit + 1) break } return pageOf(rows, limit) })
  app.post('/websites', async (request, reply) => {
    const fields = websiteFields.parse(request.body)
    const values = await websiteArguments(fields, config)
    const now = new Date()
    const doc = { _id: randomUUID(), ...values, webhook_secret: seal(issueToken(), config.encryptionKey), token_prefix: null, last_used_at: null, created_at: now, updated_at: now }
    await transaction(db, async client => {
      const session = sessionOf(client)
      // Lock the parent so customer deletion cannot commit alongside a new site.
      const customer = await collection(client, 'customers').updateOne({ _id: fields.customer_id }, { $inc: { relation_version: 1 } }, { session })
      if (!customer.matchedCount) throw notFound()
      await collection(client, 'sites').insertOne(doc, { session })
    })
    return reply.code(201).send({ id: doc._id })
  })
  app.patch('/websites/:id', async request => {
    const { id } = idParams.parse(request.params)
    const patch = websiteFields.partial().parse(request.body)
    return transaction(db, async client => {
      const session = sessionOf(client)
      const existing = await collection<SiteDoc>(client, 'sites').findOne({ _id: id }, { session })
      if (!existing) throw notFound()
      const fields = { customer_id: existing.customer_id, name: existing.name, domain: existing.domain, webhook_url: existing.webhook_url, ...patch }
      if (fields.customer_id !== existing.customer_id && await collection(client, 'jobs').findOne({ site_id: id }, { session })) throw new ApiError(409, 'website_has_history', 'Website đã có lịch sử viết. Hãy tạo website mới cho khách hàng khác.')
      const values = await websiteArguments(fields, config)
      const customer = await collection(client, 'customers').updateOne({ _id: fields.customer_id }, { $inc: { relation_version: 1 } }, { session })
      if (!customer.matchedCount) throw notFound()
      await collection(client, 'sites').updateOne({ _id: id }, { $set: { ...values, updated_at: new Date() } }, { session })
      return { id }
    })
  })
  app.delete('/websites/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    await transaction(db, async client => {
      const session = sessionOf(client)
      const existing = await collection<SiteDoc>(client, 'sites').findOne({ _id: id }, { session })
      if (!existing) throw notFound()
      if (await collection(client, 'jobs').findOne({ site_id: id }, { projection: { _id: 1 }, session })) {
        throw new ApiError(409, 'website_has_history', 'Không thể xóa website còn lịch sử viết bài. Hãy xóa các bài viết và yêu cầu trước.')
      }
      await collection(client, 'sites').deleteOne({ _id: id }, { session })
    })
    return reply.code(204).send()
  })
  app.post('/websites/:id/token', async request => { const { id } = idParams.parse(request.params); const token = issueToken(); const result = await collection(db, 'sites').updateOne({ _id: id }, { $set: { token_hash: digest(token), token_prefix: token.slice(0, 9), last_used_at: null, updated_at: new Date() } }); if (!result.matchedCount) throw notFound(); return { token } })
  app.delete('/websites/:id/token', async (request, reply) => { const { id } = idParams.parse(request.params); const result = await collection(db, 'sites').updateOne({ _id: id }, { $unset: { token_hash: '' }, $set: { token_prefix: null, updated_at: new Date() } }); if (!result.matchedCount) throw notFound(); return reply.code(204).send() })
  app.post('/websites/:id/webhook-secret', async request => { const { id } = idParams.parse(request.params); const secret = issueToken(); const result = await collection(db, 'sites').updateOne({ _id: id }, { $set: { webhook_secret: seal(secret, config.encryptionKey), updated_at: new Date() } }); if (!result.matchedCount) throw notFound(); return { secret } })
}
// @ts-nocheck

