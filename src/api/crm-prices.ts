// @ts-nocheck
import { randomUUID } from 'node:crypto'
import Decimal from 'decimal.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { type Config, type Provider } from '../config.js'
import { collection, type Database } from '../db.js'
import { unseal } from '../security.js'
import { syncXaiPrices } from '../worker/pricing.js'
import { modelIdSchema, providerIdSchema } from './catalog.js'
import { ApiError, moneySchema, timestampSchema } from './errors.js'
import { pageOf, readCursor } from './public.js'

const providerSchema = providerIdSchema
const fieldsSchema = z.object({
  provider: providerSchema,
  model: modelIdSchema,
  source_url: z.url({ protocol: /^https?$/ }).max(2048),
  effective_at: timestampSchema,
  total_vnd: moneySchema,
}).strict()

function display(row: any, usdToVnd: number) {
  const rates = row.rates ?? {}
  const totalUsd = rates.total ?? rates.input
  const totalVnd = rates.totalVnd == null
    ? (totalUsd == null ? null : new Decimal(totalUsd).times(rates.exchange_rate ?? usdToVnd).toFixed())
    : String(rates.totalVnd)
  return {
    id: row._id,
    provider: row.provider,
    model: row.model,
    source_url: row.source_url,
    effective_at: row.effective_at,
    total_vnd: totalVnd,
    created_at: row.created_at,
  }
}

export function registerPrices(app: FastifyInstance, db: Database, config: Config, getRuntimeConfig: () => Promise<Config> = async () => config) {
  app.get('/prices', async request => {
    const runtime = await getRuntimeConfig()
    const { provider, q, limit, cursor } = z.object({
      provider: providerSchema.optional(),
      q: z.string().trim().max(160).optional(),
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(250),
    }).parse(request.query)
    const [timestamp, cursorId] = readCursor(cursor)
    const rows = await collection<any>(db, 'model_prices').find(provider ? { provider } : {}).sort({ effective_at: -1, _id: -1 }).toArray()
    const customIds = [...new Set(rows.filter(row => row.provider.startsWith('openai-compatible-')).map(row => row.model))]
    const models = customIds.length ? await collection<any>(db, 'ai_models').find({ _id: { $in: customIds } }, { projection: { _id: 1, provider: 1, upstream_model: 1, display_name: 1 } }).toArray() : []
    const modelMap = new Map(models.map(row => [row._id, row]))
    const filtered = rows
      .filter(row => {
        const model = modelMap.get(row.model)
        const modelText = model?.provider === row.provider ? `${row.model} ${model.upstream_model ?? ''} ${model.display_name ?? ''}` : row.model
        return (!q || modelText.toLowerCase().includes(q.toLowerCase())) && (!timestamp || row.effective_at.toISOString() < timestamp || (row.effective_at.toISOString() === timestamp && row._id < cursorId!))
      })
      .slice(0, limit + 1)
      .map(row => ({ ...display(row, runtime.usdToVnd), cursor_at: row.effective_at.toISOString(), cursor_id: row._id }))
    return pageOf(filtered, limit)
  })

  app.post('/prices', async (request, reply) => {
    const runtime = await getRuntimeConfig()
    const fields = fieldsSchema.parse(request.body)
    const known = await collection(db, 'ai_models').findOne({ _id: fields.model, provider: fields.provider }) || await collection(db, 'model_prices').findOne({ model: fields.model, provider: fields.provider })
    if (!known) throw new ApiError(400, 'model_provider_mismatch', 'Thêm model vào danh mục của nhà cung cấp trước khi nhập giá.')
    const total = new Decimal(fields.total_vnd).div(runtime.usdToVnd).toFixed(12)
    if (new Decimal(fields.total_vnd).gt(0) && new Decimal(total).isZero()) {
      throw new ApiError(400, 'price_below_precision', 'Đơn giá quá nhỏ để tính chi phí chính xác. Vui lòng nhập giá lớn hơn hoặc bằng độ chính xác USD hỗ trợ.')
    }
    const rates = {
      total,
      totalVnd: fields.total_vnd,
      currency: 'USD',
      exchange_rate: runtime.usdToVnd,
    }
    const row = {
      _id: randomUUID(), provider: fields.provider, model: fields.model, source_url: fields.source_url,
      effective_at: new Date(fields.effective_at), rates, created_at: new Date(),
    }
    await collection(db, 'model_prices').insertOne(row)
    return reply.code(201).send(display(row, runtime.usdToVnd))
  })

  app.post('/prices/sync-xai', async () => {
    const settings = await collection<{ encrypted_api_key?: string | null }>(db, 'ai_providers').findOne({ _id: 'xai' })
    let key = config.serviceKeys.xai
    if (settings?.encrypted_api_key) {
      try { key = unseal(settings.encrypted_api_key, config.encryptionKey) } catch { key = undefined }
    }
    if (!key) throw new ApiError(422, 'service_key_unavailable', 'Cần cấu hình key dịch vụ xAI trong CRM hoặc .env.')
    try {
      const { inserted, models } = await syncXaiPrices(db, key)
      return { count: inserted, models }
    } catch {
      throw new ApiError(502, 'price_sync_failed', 'Không thể đồng bộ bảng giá từ xAI.')
    }
  })
}
