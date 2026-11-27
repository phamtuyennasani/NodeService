import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { collection, type Database } from '../db.js'
import { seal } from '../security.js'
import { keywordInputSchema, keywordLanguages, keywordMarkets } from '../keywords/contracts.js'
import { keywordSettingsSchema, readKeywordSettings } from '../keywords/settings.js'
import { createKeywordAnalysis, keywordView, requireKeywordSite, type KeywordAnalysis } from '../keywords/service.js'
import { ApiError, idSchema, notFound } from './errors.js'

export function registerKeywords(app: FastifyInstance, db: Database, config: Config) {
  app.get('/settings/keywords', async () => readKeywordSettings(db))
  app.put('/settings/keywords', async request => {
    const fields = z.object({ revision: z.number().int().nonnegative(), values: keywordSettingsSchema,
      api_key: z.string().trim().min(1).max(2048).optional(), clear_api_key: z.boolean().optional(),
    }).strict().parse(request.body)
    const current = await readKeywordSettings(db)
    if (current.revision !== fields.revision) throw new ApiError(409, 'settings_conflict', 'Cài đặt từ khóa đã đổi. Tải lại trước khi lưu.')
    const hasKey = Boolean(fields.api_key || current.api_key_configured && !fields.clear_api_key)
    if (fields.values.mode === 'paid' && !hasKey) throw new ApiError(422, 'keyword_key_required', 'Chỉ chuyển sang Pro khi đã có API key Keyword Tool.')
    const encrypted = fields.api_key ? seal(fields.api_key, config.encryptionKey) : fields.clear_api_key ? null : undefined
    const set = { values: fields.values, updated_at: new Date(), ...(encrypted !== undefined ? { encrypted_api_key: encrypted } : {}) }
    if (!fields.revision) {
      try { await collection(db, 'keyword_settings').insertOne({ _id: 'crm', revision: 1, ...set }) }
      catch (error) {
        if ((error as { code?: number }).code === 11000) throw new ApiError(409, 'settings_conflict', 'Cài đặt đã đổi. Tải lại trước khi lưu.')
        throw error
      }
    } else {
      const saved = await collection(db, 'keyword_settings').updateOne({ _id: 'crm', revision: fields.revision }, { $set: set, $inc: { revision: 1 } })
      if (!saved.matchedCount) throw new ApiError(409, 'settings_conflict', 'Cài đặt đã đổi. Tải lại trước khi lưu.')
    }
    return readKeywordSettings(db)
  })
  app.get('/keywords/options', async () => ({ markets: keywordMarkets, languages: keywordLanguages }))
  app.post('/keyword-analyses', { bodyLimit: 16_384, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const result = await createKeywordAnalysis(db, config, keywordInputSchema.parse(request.body))
    return reply.code(result.reused ? 200 : 202).send(result)
  })
  app.get('/keyword-analyses', async request => {
    const fields = z.object({ website_id: idSchema.optional(), limit: z.coerce.number().int().min(1).max(30).default(15) }).parse(request.query)
    if (fields.website_id) await requireKeywordSite(db, fields.website_id)
    const rows = await collection<KeywordAnalysis>(db, 'keyword_analyses').find(fields.website_id ? { site_id: fields.website_id } : {}, {
      projection: { _id: 1, site_id: 1, 'input.seed': 1, status: 1, created_at: 1, source_mode: 1 },
    }).sort({ created_at: -1 }).limit(fields.limit).toArray()
    return { data: rows.map(row => ({ id: row._id, website_id: row.site_id, seed: row.input.seed,
      status: row.status, created_at: row.created_at, source_mode: row.source_mode })) }
  })
  app.get('/keyword-analyses/:id', async request => {
    const { id } = z.object({ id: idSchema }).parse(request.params)
    const row = await collection<KeywordAnalysis>(db, 'keyword_analyses').findOne({ _id: id })
    if (!row) throw notFound()
    const { site } = await requireKeywordSite(db, row.site_id)
    if (site.customer_id !== row.customer_id) throw notFound()
    return keywordView(db, row)
  })
  app.post('/keyword-analyses/:id/cancel', async request => {
    const { id } = z.object({ id: idSchema }).parse(request.params)
    const current = await collection<KeywordAnalysis>(db, 'keyword_analyses').findOne({ _id: id })
    if (!current) throw notFound()
    const { site } = await requireKeywordSite(db, current.site_id)
    if (site.customer_id !== current.customer_id) throw notFound()
    const row = await collection<KeywordAnalysis>(db, 'keyword_analyses').findOneAndUpdate({ _id: id, status: { $in: ['queued', 'running'] } }, {
      $set: { status: 'canceled', completed_at: new Date(), lease_token: null, lease_expires_at: null },
    }, { returnDocument: 'after' })
    if (row) await collection(db, 'keyword_quota_reservations').updateOne({ _id: id, status: 'reserved' }, { $set: { status: row.result?.candidates.length ? 'used' : 'released' } })
    return keywordView(db, row ?? current)
  })
}
