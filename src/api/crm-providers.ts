import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { providers, type Config, type Provider } from '../config.js'
import { collection, type Database } from '../db.js'
import { seal } from '../security.js'
import { modelIdSchema } from './catalog.js'
import { ApiError, notFound } from './errors.js'

const providerParams = z.object({ provider: z.enum(providers) })
const modelParams = providerParams.extend({ model: modelIdSchema })
const displayName = z.string().trim().min(1).max(160)
const baseUrl = z.string().trim().url({ protocol: /^https?$/ }).max(500).refine(value => { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash }, 'Base URL không được chứa thông tin đăng nhập, query hoặc hash.')
const editable = z.object({ display_name: displayName.optional(), enabled: z.boolean().optional(), base_url: baseUrl.optional(), api_key: z.string().trim().min(1).max(2048).optional() }).strict()
const patchFields = editable.refine(fields => Object.keys(fields).length > 0, 'Cần ít nhất một trường thay đổi.')
const newModel = z.object({ model: modelIdSchema, display_name: displayName.optional(), enabled: z.boolean().optional() }).strict()

export function registerProviders(app: FastifyInstance, db: Database, config: Config) {
  app.get('/providers', async () => {
    const rows = await collection<{ _id: Provider, display_name: string, enabled: boolean, base_url?: string | null, encrypted_api_key?: string | null }>(db, 'ai_providers').find({}).toArray()
    const models = await collection<{ _id: string, provider: Provider, display_name: string, enabled: boolean }>(db, 'ai_models').find({}).toArray()
    return { data: rows.sort((a, b) => providers.indexOf(a._id) - providers.indexOf(b._id)).map(row => ({ provider: row._id, display_name: row.display_name, enabled: row.enabled, base_url: row._id === 'openai-compatible' ? row.base_url ?? null : null, service_key_configured: row._id === 'openai-compatible' ? false : Boolean(config.serviceKeys[row._id]), api_key_configured: row._id === 'openai-compatible' ? Boolean(row.encrypted_api_key) : undefined, models: models.filter(model => model.provider === row._id).sort((a, b) => a.display_name.localeCompare(b.display_name)).map(model => ({ model: model._id, display_name: model.display_name, enabled: model.enabled })) })) }
  })
  app.patch('/providers/:provider', async request => {
    const { provider } = providerParams.parse(request.params); const fields = patchFields.parse(request.body)
    if (provider !== 'openai-compatible' && (fields.base_url !== undefined || fields.api_key !== undefined)) throw new ApiError(400, 'provider_configuration_unsupported', 'Chỉ nhà cung cấp OpenAI Compatible cần Base URL và API key riêng.')
    const set: Record<string, unknown> = {}; if (fields.enabled !== undefined) set.enabled = fields.enabled; if (fields.display_name !== undefined) set.display_name = fields.display_name; if (fields.base_url !== undefined) set.base_url = fields.base_url; if (fields.api_key !== undefined) set.encrypted_api_key = seal(fields.api_key, config.encryptionKey)
    const result = await collection(db, 'ai_providers').findOneAndUpdate({ _id: provider }, { $set: set }, { returnDocument: 'after' })
    if (!result) throw notFound()
    return { provider: result._id, display_name: result.display_name, enabled: result.enabled, base_url: result._id === 'openai-compatible' ? result.base_url ?? null : null, api_key_configured: result._id === 'openai-compatible' ? Boolean(result.encrypted_api_key) : undefined }
  })
  app.post('/providers/:provider/models', async (request, reply) => {
    const { provider } = providerParams.parse(request.params); const { model, display_name, enabled } = newModel.parse(request.body)
    await collection(db, 'ai_models').insertOne({ _id: model, provider, display_name: display_name ?? model, enabled: enabled ?? true }); return reply.code(201).send({ provider, model, display_name: display_name ?? model, enabled: enabled ?? true })
  })
  app.patch('/providers/:provider/models/:model', async request => {
    const { provider, model } = modelParams.parse(request.params); const fields = z.object({ display_name: displayName.optional(), enabled: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0, 'Cần ít nhất một trường thay đổi.').parse(request.body)
    const result = await collection(db, 'ai_models').findOneAndUpdate({ _id: model, provider }, { $set: fields }, { returnDocument: 'after' }); if (!result) throw notFound(); return { provider, model: result._id, display_name: result.display_name, enabled: result.enabled }
  })
  app.delete('/providers/:provider/models/:model', async (request, reply) => {
    const { provider, model } = modelParams.parse(request.params)
    const existing = await collection<{ _id: string, provider: Provider }>(db, 'ai_models').findOne({ _id: model, provider })
    if (!existing) throw notFound()
    const [customer, job, price] = await Promise.all([
      collection(db, 'customers').findOne({ allowed_models: model }),
      collection(db, 'jobs').findOne({ model }),
      collection(db, 'model_prices').findOne({ provider, model }),
    ])
    if (customer || job || price) {
      throw new ApiError(409, 'model_in_use', 'Không thể xóa model đã được dùng trong gói khách hàng, yêu cầu viết hoặc bảng giá.')
    }
    await collection(db, 'ai_models').deleteOne({ _id: model, provider })
    return reply.code(204).send()
  })
}
// @ts-nocheck
