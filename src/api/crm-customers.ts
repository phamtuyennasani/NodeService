import type { FastifyInstance } from 'fastify'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { Config } from '../config.js'
import { transaction, type Database } from '../db.js'
import { digest, issueToken, seal } from '../security.js'
import { validateWebhookUrl } from '../worker/webhook.js'
import { assertAvailableModels, modelIdSchema } from './catalog.js'
import { ApiError, idSchema, notFound, periodSchema, quantitySchema, timestampSchema } from './errors.js'
import { pageOf, readCursor } from './public.js'
import { usage, type Package } from './quota.js'

const nullableString = (max: number) => z.string().trim().max(max).nullable().optional()
const customerFields = z.object({
  name: z.string().trim().min(1).max(160),
  email: nullableString(320),
  phone: nullableString(80),
  notes: nullableString(4000),
  key_mode: z.enum(['own', 'service']).optional(),
  daily_limit: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  monthly_limit: z.number().int().nonnegative().max(1_000_000).nullable().optional(),
  allowed_models: z.array(modelIdSchema).max(100).nullable().optional(),
  max_length: quantitySchema.nullable().optional(),
  active_from: timestampSchema.nullable().optional(),
  active_until: timestampSchema.nullable().optional(),
}).strict()
const websiteFields = z.object({
  customer_id: idSchema,
  name: z.string().trim().min(1).max(160),
  domain: z.string().trim().min(1).max(253),
  webhook_url: z.string().trim().min(1).max(2048),
}).strict()
const listQuery = z.object({
  q: z.string().trim().max(160).optional(),
  cursor: z.string().max(2048).optional(),
  id: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(250),
  customer_id: idSchema.optional(),
})
const idParams = z.object({ id: idSchema })
const nameCursor = z.string().min(1).max(160)
const customerColumns = `id,name,email,phone,notes,key_mode,daily_limit,monthly_limit,
  allowed_models,max_length,starts_at AS active_from,ends_at AS active_until,created_at`
const siteColumns = `s.id,s.name,s.customer_id,c.name AS customer_name,s.domain,s.webhook_url,
  s.token_prefix AS token_hint,s.last_used_at AS last_seen_at,
  (s.webhook_secret IS NOT NULL) AS webhook_secret_configured,s.created_at`

async function customerArguments(client: PoolClient, fields: z.infer<typeof customerFields>, previousModels: string[] = []) {
  const from = fields.active_from ? new Date(fields.active_from) : null
  const until = fields.active_until ? new Date(fields.active_until) : null
  if (from && until && from >= until) {
    throw new ApiError(400, 'invalid_package_period', 'Ngày hết hạn phải sau ngày bắt đầu gói.')
  }
  const models = [...new Set(fields.allowed_models ?? [])]
  if (fields.key_mode === 'service' && (fields.daily_limit == null || fields.monthly_limit == null || models.length === 0)) {
    throw new ApiError(400, 'package_incomplete', 'Gói dịch vụ cần hạn mức ngày, hạn mức tháng và ít nhất một model.')
  }
  await assertAvailableModels(client, models.filter(model => !previousModels.includes(model)))
  return [
    fields.name, fields.email || null, fields.phone || null, fields.notes || null, fields.key_mode ?? 'own',
    fields.daily_limit ?? null, fields.monthly_limit ?? null, models, fields.max_length ?? null, from, until,
  ]
}

function normalizeDomain(domain: string) {
  try {
    const parsed = new URL(domain.includes('://') ? domain : 'https://' + domain)
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname) {
      throw new Error('Expected website domain')
    }
    return parsed.host
  } catch {
    throw new ApiError(400, 'invalid_domain', 'Vui lòng nhập tên miền hoặc địa chỉ gốc của website.')
  }
}

async function websiteArguments(fields: z.infer<typeof websiteFields>, config: Config) {
  const domain = normalizeDomain(fields.domain)
  try {
    await validateWebhookUrl(fields.webhook_url, config.allowLocalWebhooks)
  } catch {
    throw new ApiError(400, 'invalid_webhook_url', 'URL nhận bài không hợp lệ hoặc không thể truy cập.')
  }
  return [fields.customer_id, fields.name, domain, fields.webhook_url]
}

export function registerCustomers(app: FastifyInstance, db: Database, config: Config) {
  app.get('/customers', async request => {
    const { q, limit, cursor, id } = listQuery.parse(request.query)
    const [name, cursorId] = readCursor(cursor, nameCursor)
    const { rows } = await db.query(`
      WITH matched AS (
        SELECT ${customerColumns} FROM customers
        WHERE ($1::text IS NULL OR strpos(lower(name || ' ' || coalesce(email,'') || ' ' || coalesce(phone,'') || ' ' || id::text),lower($1))>0)
          AND ($2::text IS NULL OR (name,id)>($2,$3::uuid))
          AND ($4::uuid IS NULL OR id=$4)
        ORDER BY name,id LIMIT $5
      )
      SELECT m.*,m.name AS cursor_at,m.id AS cursor_id,
        (SELECT count(*)::int FROM sites WHERE customer_id=m.id) AS website_count,
        (SELECT count(*)::int FROM jobs WHERE customer_id=m.id AND status='ready') AS article_count
      FROM matched m ORDER BY m.name,m.id
    `, [q || null, name, cursorId, id ?? null, limit + 1])
    return pageOf(rows, limit)
  })

  app.post('/customers', async (request, reply) => {
    const fields = customerFields.parse(request.body)
    const customer = await transaction(db, async client => {
      const args = await customerArguments(client, fields)
      const { rows: [created] } = await client.query(`
        INSERT INTO customers(name,email,phone,notes,key_mode,daily_limit,monthly_limit,allowed_models,max_length,starts_at,ends_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING ${customerColumns},0 AS website_count,0 AS article_count
      `, args)
      return created
    })
    return reply.code(201).send(customer)
  })

  app.patch('/customers/:id', async request => {
    const { id } = idParams.parse(request.params)
    const patch = customerFields.partial().parse(request.body)
    return transaction(db, async client => {
      const { rows: [existing] } = await client.query(`SELECT ${customerColumns} FROM customers WHERE id=$1 FOR UPDATE`, [id])
      if (!existing) throw notFound()
      const values = {
        ...existing,
        active_from: existing.active_from?.toISOString(),
        active_until: existing.active_until?.toISOString(),
        ...patch,
      } as z.infer<typeof customerFields>
      const activatingPackage = existing.key_mode !== 'service' && values.key_mode === 'service'
      const args = await customerArguments(client, values, activatingPackage ? [] : existing.allowed_models)
      const { rows: [updated] } = await client.query(`
        UPDATE customers SET name=$1,email=$2,phone=$3,notes=$4,key_mode=$5,daily_limit=$6,monthly_limit=$7,
          allowed_models=$8,max_length=$9,starts_at=$10,ends_at=$11,updated_at=now()
        WHERE id=$12 RETURNING ${customerColumns},
          (SELECT count(*)::int FROM sites WHERE customer_id=$12) AS website_count,
          (SELECT count(*)::int FROM jobs WHERE customer_id=$12 AND status='ready') AS article_count
      `, [...args, id])
      return updated
    })
  })

  app.get('/customers/:id/usage', async request => {
    const { id } = idParams.parse(request.params)
    const { date } = z.object({ date: periodSchema.optional() }).parse(request.query)
    const { rows: [customer] } = await db.query<Package>('SELECT * FROM customers WHERE id=$1', [id])
    if (!customer) throw notFound()
    const when = date ? new Date(date + 'T00:00:00+07:00') : new Date()
    const result = await usage(db, customer, when)
    const { rows: reservations } = await db.query(`
      SELECT q.job_id,q.quota_day::text,q.status,j.keyword,j.scheduled_at,s.name AS website_name
      FROM quota_reservations q JOIN jobs j ON j.id=q.job_id JOIN sites s ON s.id=j.site_id
      WHERE q.customer_id=$1 AND q.status IN ('used','reserved')
        AND q.quota_month=date_trunc('month',$2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
      ORDER BY q.quota_day DESC,q.job_id DESC LIMIT 100
    `, [id, when])
    return { ...result, reservations }
  })

  app.get('/websites', async request => {
    const { q, limit, customer_id, cursor, id } = listQuery.parse(request.query)
    const [name, cursorId] = readCursor(cursor, nameCursor)
    const { rows } = await db.query(`
      SELECT ${siteColumns},s.name AS cursor_at,s.id AS cursor_id,
        (SELECT count(*)::int FROM jobs WHERE site_id=s.id AND status='ready') AS article_count
      FROM sites s JOIN customers c ON c.id=s.customer_id
      WHERE ($1::uuid IS NULL OR s.customer_id=$1)
        AND ($2::text IS NULL OR strpos(lower(s.name || ' ' || s.domain || ' ' || c.name),lower($2))>0)
        AND ($3::text IS NULL OR (s.name,s.id)>($3,$4::uuid))
        AND ($5::uuid IS NULL OR s.id=$5)
      ORDER BY s.name,s.id LIMIT $6
    `, [customer_id ?? null, q || null, name, cursorId, id ?? null, limit + 1])
    return pageOf(rows, limit)
  })

  app.post('/websites', async (request, reply) => {
    const fields = websiteFields.parse(request.body)
    const args = await websiteArguments(fields, config)
    const { rows: [site] } = await db.query(`
      INSERT INTO sites(customer_id,name,domain,webhook_url,webhook_secret)
      VALUES($1,$2,$3,$4,$5) RETURNING id
    `, [...args, seal(issueToken(), config.encryptionKey)])
    return reply.code(201).send(site)
  })

  app.patch('/websites/:id', async request => {
    const { id } = idParams.parse(request.params)
    const patch = websiteFields.partial().parse(request.body)
    return transaction(db, async client => {
      const { rows: [existing] } = await client.query('SELECT customer_id,name,domain,webhook_url FROM sites WHERE id=$1 FOR UPDATE', [id])
      if (!existing) throw notFound()
      const fields: z.infer<typeof websiteFields> = { ...existing, ...patch }
      if (fields.customer_id !== existing.customer_id) {
        const { rows: [{ has_jobs }] } = await client.query('SELECT EXISTS(SELECT 1 FROM jobs WHERE site_id=$1) AS has_jobs', [id])
        if (has_jobs) throw new ApiError(409, 'website_has_history', 'Website đã có lịch sử viết. Hãy tạo website mới cho khách hàng khác.')
      }
      const args = await websiteArguments(fields, config)
      const { rows: [site] } = await client.query(`
        UPDATE sites SET customer_id=$1,name=$2,domain=$3,webhook_url=$4,updated_at=now()
        WHERE id=$5 RETURNING id
      `, [...args, id])
      return site
    })
  })

  app.post('/websites/:id/token', async request => {
    const { id } = idParams.parse(request.params)
    const token = issueToken()
    const result = await db.query(`
      UPDATE sites SET token_hash=$2,token_prefix=$3,last_used_at=NULL,updated_at=now() WHERE id=$1
    `, [id, digest(token), token.slice(0, 9)])
    if (!result.rowCount) throw notFound()
    return { token }
  })

  app.delete('/websites/:id/token', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    const result = await db.query('UPDATE sites SET token_hash=NULL,token_prefix=NULL,updated_at=now() WHERE id=$1', [id])
    if (!result.rowCount) throw notFound()
    return reply.code(204).send()
  })

  app.post('/websites/:id/webhook-secret', async request => {
    const { id } = idParams.parse(request.params)
    const secret = issueToken()
    const result = await db.query('UPDATE sites SET webhook_secret=$2,updated_at=now() WHERE id=$1', [id, seal(secret, config.encryptionKey)])
    if (!result.rowCount) throw notFound()
    return { secret }
  })
}
