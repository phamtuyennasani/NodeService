import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { providers } from '../config.js'
import type { Database } from '../db.js'
import { ApiError, idSchema, notFound, periodSchema } from './errors.js'
import { pageOf, readCursor } from './public.js'

const date = periodSchema.optional()
const keys = z.object({ customer_id: idSchema.optional(), website_id: idSchema.optional() })
const filtersSchema = keys.extend({ from: date, to: date }).refine(
  ({ from, to }) => !from || !to || from <= to,
  'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.',
)
const listSchema = keys.extend({
  from: date,
  to: date,
  limit: z.coerce.number().int().min(1).max(250).default(100),
  cursor: z.string().max(512).optional(),
  q: z.string().trim().max(160).optional(),
})
const jobsSchema = listSchema.extend({
  status: z.enum(['scheduled', 'queued', 'writing', 'ready', 'completed', 'failed', 'canceled']).optional(),
  source: z.enum(['scheduled', 'schedule', 'preview', 'widget', 'rewrite']).optional(),
  provider: z.enum(providers).optional(),
  key_mode: z.enum(['own', 'service']).optional(),
  date_basis: z.literal('cost').optional(),
})
const deliveriesSchema = listSchema.extend({
  status: z.enum(['pending', 'sending', 'delivered', 'failed']).optional(),
  event: z.enum(['article.ready', 'article.failed']).optional(),
})
const idParams = z.object({ id: idSchema })

const reportJob = `j.id,j.id AS job_id,j.customer_id,c.name AS customer_name,
  j.site_id AS website_id,s.name AS website_name,j.mode,
  CASE j.mode WHEN 'preview' THEN 'widget' ELSE j.mode END AS source,
  CASE j.status WHEN 'ready' THEN 'completed' ELSE j.status END AS status,
  j.keyword,j.provider,j.model,j.tone,j.style,j.length,j.key_mode,
  j.created_at,j.scheduled_at,j.started_at,j.completed_at,j.source_article_id,
  j.client_request_id AS idempotency_key,j.error_code,j.error_message`
const jobTables = `jobs j JOIN sites s ON s.id=j.site_id JOIN customers c ON c.id=j.customer_id`
const scope = `($1::uuid IS NULL OR j.customer_id=$1) AND ($2::uuid IS NULL OR j.site_id=$2)`

const reportDelivery = `w.id,w.job_id,w.site_id AS website_id,s.name AS website_name,
  j.customer_id,c.name AS customer_name,j.keyword,w.status,w.event AS event_type,
  (SELECT count(*)::int FROM webhook_attempts h WHERE h.delivery_id=w.id) AS attempts,
  w.attempt_count,w.http_status AS last_http_status,w.error AS last_error,w.next_attempt_at,
  w.delivered_at,w.created_at`
const deliveryTables = `webhook_deliveries w JOIN jobs j ON j.id=w.job_id
  JOIN sites s ON s.id=w.site_id JOIN customers c ON c.id=j.customer_id`

function dateRange(expression: string, start: number, end: number) {
  return `($${start}::date IS NULL OR (${expression}) >= $${start}::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
    AND ($${end}::date IS NULL OR (${expression}) < ($${end}::date+1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')`
}

function defaultPeriod(from?: string, to?: string) {
  const day = new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const end = to ?? day
  const start = from ?? new Date(Date.parse(end) - 13 * 86_400_000).toISOString().slice(0, 10)
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000
  if (days < 0 || days > 365) {
    throw new ApiError(400, 'invalid_report_period', 'Chọn khoảng báo cáo tối đa 366 ngày.')
  }
  return [start, end]
}

export function registerReports(app: FastifyInstance, db: Database) {
  app.get('/dashboard', async request => {
    const { customer_id, website_id, from, to } = filtersSchema.parse(request.query)
    const [start, end] = defaultPeriod(from, to)
    const values = [customer_id ?? null, website_id ?? null, start, end]
    const { rows: [summary] } = await db.query(`
      WITH days AS (
        SELECT d::date AS date FROM generate_series($3::date::timestamp,$4::date::timestamp,interval '1 day') d
      ), written AS (
        SELECT (j.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS date,count(*)::int AS articles
        FROM jobs j WHERE ${scope} AND j.status='ready' AND ${dateRange('j.completed_at',3,4)}
        GROUP BY 1
      ), delivered AS (
        SELECT (w.delivered_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS date,count(*)::int AS delivered
        FROM webhook_deliveries w JOIN jobs j ON j.id=w.job_id
        WHERE ${scope} AND w.status='delivered' AND w.event='article.ready' AND ${dateRange('w.delivered_at',3,4)}
        GROUP BY 1
      ), costs AS (
        SELECT (a.requested_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS date,
          sum(a.cost_usd) FILTER (WHERE j.key_mode='service') AS service_cost_usd,
          sum(a.cost_usd) FILTER (WHERE j.key_mode='own') AS customer_cost_usd,
          count(*) FILTER (WHERE a.cost_source='pending')::int AS unpriced_attempts
        FROM ai_attempts a JOIN jobs j ON j.id=a.job_id
        WHERE ${scope} AND ${dateRange('a.requested_at',3,4)}
        GROUP BY 1
      ), points AS (
        SELECT d.date::text,coalesce(w.articles,0) AS articles,coalesce(l.delivered,0) AS delivered,
          coalesce(c.service_cost_usd,0)::text AS service_cost_usd,
          coalesce(c.customer_cost_usd,0)::text AS customer_cost_usd,
          coalesce(c.unpriced_attempts,0) AS unpriced_attempts
        FROM days d LEFT JOIN written w USING(date) LEFT JOIN delivered l USING(date) LEFT JOIN costs c USING(date)
      )
      SELECT
        (SELECT count(*)::int FROM customers c WHERE ($1::uuid IS NULL OR c.id=$1)
          AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM sites s WHERE s.id=$2 AND s.customer_id=c.id))) AS customers,
        (SELECT count(*)::int FROM sites s WHERE ($1::uuid IS NULL OR s.customer_id=$1)
          AND ($2::uuid IS NULL OR s.id=$2)) AS websites,
        (SELECT count(*)::int FROM jobs j WHERE ${scope} AND j.status IN ('scheduled','queued','writing')) AS pending,
        (SELECT count(*)::int FROM jobs j WHERE ${scope} AND j.status='failed'
          AND ${dateRange('coalesce(j.completed_at,j.updated_at)',3,4)}) AS write_errors,
        (SELECT count(*)::int FROM webhook_deliveries w JOIN jobs j ON j.id=w.job_id WHERE ${scope}
          AND w.event='article.ready' AND w.status='failed' AND ${dateRange('w.updated_at',3,4)}) AS delivery_errors,
        coalesce(sum(articles),0)::int AS articles,coalesce(sum(delivered),0)::int AS delivered,
        coalesce(sum(service_cost_usd::numeric),0)::text AS service_cost_usd,
        coalesce(sum(customer_cost_usd::numeric),0)::text AS customer_cost_usd,
        coalesce(sum(unpriced_attempts),0)::int AS unpriced_attempts,
        json_agg(p ORDER BY date) AS series
      FROM points p
    `, values)
    const { series, ...metrics } = summary
    const [upcoming, failures] = await Promise.all([
      db.query(`
        SELECT ${reportJob} FROM ${jobTables}
        WHERE ${scope} AND j.status='scheduled'
        ORDER BY j.scheduled_at,j.id LIMIT 6
      `, values.slice(0, 2)),
      db.query(`
        SELECT ${reportJob} FROM ${jobTables}
        WHERE ${scope} AND j.status='failed' AND ${dateRange('coalesce(j.completed_at,j.updated_at)',3,4)}
        ORDER BY j.updated_at DESC,j.id DESC LIMIT 6
      `, values),
    ])
    return { metrics, series, upcoming: upcoming.rows, failures: failures.rows }
  })

  app.get('/jobs', async request => {
    const query = jobsSchema.parse(request.query)
    filtersSchema.parse(query)
    const [timestamp, cursorId] = readCursor(query.cursor)
    const status = query.status === 'completed' ? 'ready' : query.status ?? null
    const source = query.source === 'widget' ? 'preview' : query.source === 'schedule' ? 'scheduled' : query.source ?? null
    const time = `CASE WHEN $5='ready' THEN j.completed_at WHEN $5='failed' THEN coalesce(j.completed_at,j.updated_at)
      WHEN $5='scheduled' THEN j.scheduled_at ELSE j.created_at END`
    const costScope = query.date_basis === 'cost' ? `AND ${dateRange('a.requested_at',3,4)}` : ''
    const reportScope = query.date_basis === 'cost'
      ? `EXISTS (SELECT 1 FROM ai_attempts a WHERE a.job_id=j.id ${costScope})`
      : dateRange(time,3,4)
    const { rows } = await db.query(`
      SELECT ${reportJob},j.created_at::text AS cursor_at,j.id AS cursor_id,
        (SELECT sum(a.cost_usd)::text FROM ai_attempts a WHERE a.job_id=j.id ${costScope}) AS cost_usd
      FROM ${jobTables} WHERE ${scope} AND ${reportScope}
        AND ($5::text IS NULL OR j.status=$5) AND ($6::text IS NULL OR j.mode=$6)
        AND ($7::text IS NULL OR j.provider=$7) AND ($8::text IS NULL OR j.key_mode=$8)
        AND ($9::text IS NULL OR strpos(lower(j.keyword || ' ' || j.id::text || ' ' || j.client_request_id),lower($9))>0)
        AND ($10::timestamptz IS NULL OR (j.created_at,j.id)<($10,$11::uuid))
      ORDER BY j.created_at DESC,j.id DESC LIMIT $12
    `, [query.customer_id ?? null, query.website_id ?? null, query.from ?? null, query.to ?? null,
      status, source, query.provider ?? null, query.key_mode ?? null, query.q || null, timestamp, cursorId, query.limit + 1])
    return pageOf(rows, query.limit)
  })

  app.get('/jobs/:id', async request => {
    const { id } = idParams.parse(request.params)
    const { rows: [job] } = await db.query(`
      SELECT ${reportJob}, j.result,j.instructions FROM ${jobTables} WHERE j.id=$1
    `, [id])
    if (!job) throw notFound()
    const [attempts, deliveries] = await Promise.all([
      db.query(`
        SELECT id,provider,model,status,requested_at AS started_at,requested_at AS called_at,finished_at,provider_response_id,
          (usage->>'input')::bigint AS input_tokens,(usage->>'output')::bigint AS output_tokens,
          usage,pricing_id,pricing_snapshot,cost_usd::text,cost_source,error_code,error AS error_message
        FROM ai_attempts WHERE job_id=$1 ORDER BY requested_at,id
      `, [id]),
      db.query(`SELECT ${reportDelivery} FROM ${deliveryTables} WHERE w.job_id=$1 ORDER BY w.created_at,w.id`, [id]),
    ])
    return { ...job, attempts: attempts.rows, deliveries: deliveries.rows }
  })

  app.get('/deliveries', async request => {
    const query = deliveriesSchema.parse(request.query)
    filtersSchema.parse(query)
    const [timestamp, cursorId] = readCursor(query.cursor)
    const time = `CASE WHEN $5='delivered' THEN w.delivered_at WHEN $5='failed' THEN w.updated_at ELSE w.created_at END`
    const { rows } = await db.query(`
      SELECT ${reportDelivery},w.created_at::text AS cursor_at,w.id AS cursor_id
      FROM ${deliveryTables} WHERE ${scope} AND ${dateRange(time,3,4)}
        AND ($5::text IS NULL OR w.status=$5) AND ($6::text IS NULL OR w.event=$6)
        AND ($7::text IS NULL OR strpos(lower(w.job_id::text || ' ' || w.id::text || ' ' || s.name || ' ' || j.keyword),lower($7))>0)
        AND ($8::timestamptz IS NULL OR (w.created_at,w.id)<($8,$9::uuid))
      ORDER BY w.created_at DESC,w.id DESC LIMIT $10
    `, [query.customer_id ?? null, query.website_id ?? null, query.from ?? null, query.to ?? null,
      query.status ?? null, query.event ?? null, query.q || null, timestamp, cursorId, query.limit + 1])
    return pageOf(rows, query.limit)
  })

  app.get('/deliveries/:id', async request => {
    const { id } = idParams.parse(request.params)
    const { rows: [delivery] } = await db.query(`
      SELECT ${reportDelivery} FROM ${deliveryTables} WHERE w.id=$1
    `, [id])
    if (!delivery) throw notFound()
    const { rows } = await db.query(`
      SELECT id,attempted_at,finished_at,http_status,error FROM webhook_attempts WHERE delivery_id=$1
      ORDER BY attempted_at DESC,id DESC
    `, [id])
    return { ...delivery, history: rows }
  })

  app.post('/deliveries/:id/retry', async (request, reply) => {
    const { id } = idParams.parse(request.params)
    const { rows: [delivery] } = await db.query(`
      UPDATE webhook_deliveries SET status='pending',attempt_count=0,next_attempt_at=now(),updated_at=now()
      WHERE id=$1 AND status='failed' RETURNING id,status
    `, [id])
    if (delivery) return reply.code(202).send(delivery)
    const { rows: [current] } = await db.query('SELECT status FROM webhook_deliveries WHERE id=$1', [id])
    if (!current) throw notFound()
    throw new ApiError(409, 'delivery_not_retryable', 'Chỉ có thể yêu cầu gửi lại webhook đã báo lỗi.', current)
  })
}
