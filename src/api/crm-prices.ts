import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { providers, type Config } from '../config.js'
import type { Database } from '../db.js'
import { syncXaiPrices } from '../worker/pricing.js'
import { modelIdSchema } from './catalog.js'
import { ApiError, moneySchema, timestampSchema } from './errors.js'
import { pageOf, readCursor } from './public.js'

const providerSchema = z.enum(providers)
const optionalPrice = moneySchema.nullable().optional()
const fieldsSchema = z.object({
  provider: providerSchema,
  model: modelIdSchema,
  source_url: z.url({ protocol: /^https?$/ }).max(2048),
  effective_at: timestampSchema,
  input_usd: moneySchema,
  output_usd: moneySchema,
  cached_input_usd: optionalPrice,
  cache_write_5m_usd: optionalPrice,
  cache_write_1h_usd: optionalPrice,
  long_context_threshold: z.number().int().positive().max(10_000_000).nullable().optional(),
  long_context_input_usd: optionalPrice,
  long_context_cached_input_usd: optionalPrice,
  long_context_output_usd: optionalPrice,
  request_usd: optionalPrice,
}).strict()
const columns = `id,provider,model,source_url,effective_at,
  rates->>'input' AS input_usd,rates->>'output' AS output_usd,
  rates->>'cachedInput' AS cached_input_usd,
  rates->>'cacheWrite5m' AS cache_write_5m_usd,rates->>'cacheWrite1h' AS cache_write_1h_usd,
  (rates->'longContext'->>'threshold')::int AS long_context_threshold,
  rates->'longContext'->>'input' AS long_context_input_usd,
  rates->'longContext'->>'cachedInput' AS long_context_cached_input_usd,
  rates->'longContext'->>'output' AS long_context_output_usd,
  rates->>'request' AS request_usd,created_at`

export function registerPrices(app: FastifyInstance, db: Database, config: Config) {
  app.get('/prices', async request => {
    const { provider, q, limit, cursor } = z.object({
      provider: providerSchema.optional(),
      q: z.string().trim().max(160).optional(),
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(250),
    }).parse(request.query)
    const [timestamp, cursorId] = readCursor(cursor)
    const { rows } = await db.query(`
      SELECT ${columns},effective_at::text AS cursor_at,id AS cursor_id FROM model_prices
      WHERE ($1::text IS NULL OR provider=$1) AND ($2::text IS NULL OR strpos(lower(model),lower($2))>0)
        AND ($3::timestamptz IS NULL OR (effective_at,id)<($3,$4::uuid))
      ORDER BY effective_at DESC,id DESC LIMIT $5
    `, [provider ?? null, q || null, timestamp, cursorId, limit + 1])
    return pageOf(rows, limit)
  })

  app.post('/prices', async (request, reply) => {
    const fields = fieldsSchema.parse(request.body)
    const { rows: [known] } = await db.query(`
      SELECT 1 FROM ai_models WHERE provider=$1 AND model=$2
      UNION ALL SELECT 1 FROM model_prices WHERE provider=$1 AND model=$2 LIMIT 1
    `, [fields.provider, fields.model])
    if (!known) {
      throw new ApiError(400, 'model_provider_mismatch', 'Thêm model vào danh mục của nhà cung cấp trước khi nhập giá.')
    }
    const longContext = [
      fields.long_context_threshold, fields.long_context_input_usd,
      fields.long_context_cached_input_usd, fields.long_context_output_usd,
    ].some(value => value != null)
    if (longContext && (!fields.long_context_threshold || fields.long_context_input_usd == null || fields.long_context_output_usd == null)) {
      throw new ApiError(400, 'incomplete_context_price', 'Cần ngưỡng token, giá input và giá output cho bậc ngữ cảnh dài.')
    }
    const rates = {
      input: fields.input_usd,
      output: fields.output_usd,
      cachedInput: fields.cached_input_usd ?? undefined,
      cacheWrite5m: fields.cache_write_5m_usd ?? undefined,
      cacheWrite1h: fields.cache_write_1h_usd ?? undefined,
      request: fields.request_usd ?? undefined,
      longContext: longContext ? {
        threshold: fields.long_context_threshold,
        input: fields.long_context_input_usd,
        output: fields.long_context_output_usd,
        cachedInput: fields.long_context_cached_input_usd ?? undefined,
      } : undefined,
    }
    const { rows: [price] } = await db.query(`
      INSERT INTO model_prices(provider,model,source_url,effective_at,rates)
      VALUES($1,$2,$3,$4,$5) RETURNING ${columns}
    `, [fields.provider, fields.model, fields.source_url, fields.effective_at, rates])
    return reply.code(201).send(price)
  })

  app.post('/prices/sync-xai', async () => {
    if (!config.serviceKeys.xai) {
      throw new ApiError(422, 'service_key_unavailable', 'Cần cấu hình key dịch vụ xAI để đồng bộ giá.')
    }
    try {
      const { inserted, models } = await syncXaiPrices(db, config.serviceKeys.xai)
      return { count: inserted, models }
    } catch {
      throw new ApiError(502, 'price_sync_failed', 'Không thể đồng bộ bảng giá từ xAI.')
    }
  })
}
