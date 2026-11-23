import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { isCompatibleProvider, providerKind, providers, type Config, type Provider } from '../config.js'
import { collection, type Database } from '../db.js'
import { seal, unseal } from '../security.js'
import { modelIdSchema, providerIdSchema } from './catalog.js'
import { ApiError, notFound } from './errors.js'
import { validateWebhookUrl } from '../worker/webhook.js'
import { publicFetch } from '../public-fetch.js'

const providerParams = z.object({ provider: providerIdSchema })
const modelParams = providerParams.extend({ model: modelIdSchema })
const displayName = z.string().trim().min(1).max(160)
const baseUrl = z.string().trim().url({ protocol: /^https?$/ }).max(500).refine(value => {
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) return false
  try {
    validateWebhookUrl(value, false)
    return true
  } catch {
    return false
  }
}, 'Base URL phải là địa chỉ HTTPS công khai, không chứa thông tin đăng nhập, query hoặc hash.')
const editable = z.object({ display_name: displayName.optional(), enabled: z.boolean().optional(), base_url: baseUrl.optional(), api_key: z.string().trim().min(1).max(2048).optional() }).strict()
const patchFields = editable.refine(fields => Object.keys(fields).length > 0, 'Cần ít nhất một trường thay đổi.')
const newProvider = z.object({ display_name: displayName, base_url: baseUrl, api_key: z.string().trim().min(1).max(2048), enabled: z.boolean().optional() }).strict()
const newModel = z.object({ model: modelIdSchema, display_name: displayName.optional(), enabled: z.boolean().optional() }).strict()

interface ProviderRow {
  _id: Provider
  display_name: string
  enabled: boolean
  base_url?: string | null
  encrypted_api_key?: string | null
}
interface ModelRow {
  _id: string
  provider: Provider
  upstream_model?: string
  display_name: string
  enabled: boolean
}

function providerView(row: ProviderRow, config: Config) {
  const keyConfigured = Boolean(config.serviceKeys[row._id]) || Boolean(row.encrypted_api_key)
  return {
    provider: row._id, kind: providerKind(row._id), display_name: row.display_name, enabled: row.enabled,
    base_url: isCompatibleProvider(row._id) ? row.base_url ?? null : null,
    service_key_configured: keyConfigured, api_key_configured: keyConfigured,
  }
}

function modelView(row: ModelRow) {
  return { model: row._id, upstream_model: row.upstream_model ?? row._id, display_name: row.display_name, enabled: row.enabled }
}

function compatibleEndpoint(baseUrl: string, path: string): URL {
  const endpoint = new URL(baseUrl)
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') throw new Error('Unsupported provider protocol')
  validateWebhookUrl(baseUrl, false)
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + path
  return endpoint
}

function normalizedBaseUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    // Endpoint construction strips trailing slashes before appending API paths.
    url.pathname = url.pathname.replace(/\/+$/, '')
    return url.href
  } catch {
    return null
  }
}

export function registerProviders(app: FastifyInstance, db: Database, config: Config, fetcher: typeof fetch = publicFetch) {
  app.get('/providers', async () => {
    const rows = await collection<ProviderRow>(db, 'ai_providers').find({}).toArray()
    const models = await collection<ModelRow>(db, 'ai_models').find({}).toArray()
    const order = (provider: Provider) => {
      const index = providers.findIndex(item => item === provider)
      return index < 0 ? providers.length : index
    }
    return { data: rows.sort((a, b) => order(a._id) - order(b._id) || a.display_name.localeCompare(b.display_name) || a._id.localeCompare(b._id)).map(row => ({
      ...providerView(row, config),
      models: models.filter(model => model.provider === row._id).sort((a, b) => a.display_name.localeCompare(b.display_name))
        .map(modelView),
    })) }
  })
  app.post('/providers', async (request, reply) => {
    const fields = newProvider.parse(request.body)
    const row: ProviderRow = {
      _id: `openai-compatible-${randomUUID()}`, display_name: fields.display_name, enabled: fields.enabled ?? true,
      base_url: fields.base_url, encrypted_api_key: seal(fields.api_key, config.encryptionKey),
    }
    await collection<ProviderRow>(db, 'ai_providers').insertOne(row)
    return reply.code(201).send({ ...providerView(row, config), models: [] })
  })
  app.patch('/providers/:provider', async request => {
    const { provider } = providerParams.parse(request.params); const fields = patchFields.parse(request.body)
    const current = await collection<ProviderRow>(db, 'ai_providers').findOne({ _id: provider })
    if (!current) throw notFound()
    if (!isCompatibleProvider(provider) && fields.base_url !== undefined) throw new ApiError(400, 'provider_configuration_unsupported', 'Chỉ nhà cung cấp OpenAI Compatible cần Base URL.')
    if (fields.base_url !== undefined && fields.api_key === undefined && normalizedBaseUrl(fields.base_url) !== normalizedBaseUrl(current.base_url)) {
      throw new ApiError(400, 'provider_key_required', 'Khi đổi Base URL, cần nhập lại API key cho địa chỉ mới.')
    }
    if (fields.enabled === false) {
      const configuredModels = await collection<{ _id: string }>(db, 'ai_models').find({ provider }).toArray()
      const modelIds = configuredModels.map(model => model._id)
      if (modelIds.length && await collection(db, 'customers').findOne({ key_mode: 'service', allowed_models: { $in: modelIds } })) {
        throw new ApiError(409, 'provider_in_use', 'Không thể tắt nhà cung cấp đang được cấp cho khách hàng.')
      }
    }
    const set: Record<string, unknown> = {}
    if (fields.enabled !== undefined) set.enabled = fields.enabled
    if (fields.display_name !== undefined) set.display_name = fields.display_name
    // Without a supplied key, an equivalent URL is a no-op. In particular, a
    // concurrent edit must not write an old endpoint back beside another key.
    if (fields.base_url !== undefined && fields.api_key !== undefined) set.base_url = fields.base_url
    if (fields.api_key !== undefined) set.encrypted_api_key = seal(fields.api_key, config.encryptionKey)
    if (!Object.keys(set).length) return providerView(current, config)
    const result = await collection(db, 'ai_providers').findOneAndUpdate({ _id: provider }, { $set: set }, { returnDocument: 'after' })
    if (!result) throw notFound()
    return providerView(result, config)
  })
  app.post('/providers/:provider/check', async request => {
    const { provider } = providerParams.parse(request.params)
    if (!isCompatibleProvider(provider)) throw new ApiError(400, 'provider_configuration_unsupported', 'Chỉ nhà cung cấp OpenAI Compatible hỗ trợ kiểm tra kết nối này.')
    const settings = await collection<ProviderRow>(db, 'ai_providers').findOne({ _id: provider })
    if (!settings) throw notFound()
    if (!settings.base_url || !settings.encrypted_api_key) {
      throw new ApiError(422, 'provider_not_configured', 'OpenAI Compatible chưa có Base URL hoặc API key.')
    }

    let key: string
    try {
      key = unseal(settings.encrypted_api_key, config.encryptionKey)
    } catch {
      throw new ApiError(422, 'provider_key_unavailable', 'API key OpenAI Compatible không đọc được.')
    }

    let endpoint: URL
    try {
      endpoint = compatibleEndpoint(settings.base_url, '/models')
    } catch {
      throw new ApiError(422, 'provider_connection_failed', 'Base URL OpenAI Compatible không hợp lệ.')
    }
    let response: Response
    try {
      response = await fetcher(endpoint, {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      })
    } catch {
      throw new ApiError(422, 'provider_connection_failed', 'Không thể kết nối đến OpenAI Compatible.')
    }

    await response.body?.cancel().catch(() => undefined)
    if (response.ok) return { ok: true, message: 'Kết nối OpenAI Compatible thành công.' }
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(422, 'provider_auth_failed', 'API key OpenAI Compatible không hợp lệ hoặc không có quyền truy cập.')
    }
    throw new ApiError(422, 'provider_request_failed', `OpenAI Compatible trả về HTTP ${response.status}.`)
  })
  app.post('/providers/:provider/models/:model/ping', async request => {
    const { provider, model } = modelParams.parse(request.params)
    if (!isCompatibleProvider(provider)) throw new ApiError(400, 'provider_configuration_unsupported', 'Chỉ model OpenAI Compatible hỗ trợ kiểm tra kết nối này.')
    const settings = await collection<ProviderRow>(db, 'ai_providers').findOne({ _id: provider })
    const modelRow = await collection<ModelRow>(db, 'ai_models').findOne({ _id: model, provider })
    if (!settings || !modelRow) throw notFound()
    const upstreamModel = modelRow.upstream_model ?? modelRow._id
    if (!settings.base_url || !settings.encrypted_api_key) {
      throw new ApiError(422, 'provider_not_configured', 'OpenAI Compatible chưa có Base URL hoặc API key.')
    }

    let key: string
    try {
      key = unseal(settings.encrypted_api_key, config.encryptionKey)
    } catch {
      throw new ApiError(422, 'provider_key_unavailable', 'API key OpenAI Compatible không đọc được.')
    }

    let endpoint: URL
    try {
      endpoint = compatibleEndpoint(settings.base_url, '/chat/completions')
    } catch {
      throw new ApiError(422, 'provider_connection_failed', 'Base URL OpenAI Compatible không hợp lệ.')
    }

    let response: Response
    try {
      response = await fetcher(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: upstreamModel, messages: [{ role: 'user', content: 'Ping' }], max_tokens: 1, stream: true }),
        signal: AbortSignal.timeout(15_000),
        redirect: 'error',
      })
    } catch {
      throw new ApiError(422, 'model_connection_failed', `Không thể kết nối model ${model}.`)
    }

    if (response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return { ok: true, model, upstream_model: upstreamModel, message: `Model ${upstreamModel} đang hoạt động.` }
    }
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 401 || response.status === 403) {
      throw new ApiError(422, 'provider_auth_failed', 'API key OpenAI Compatible không hợp lệ hoặc không có quyền truy cập.')
    }
    if (response.status === 404) throw new ApiError(422, 'model_not_found', `Không tìm thấy model ${upstreamModel} ở OpenAI Compatible.`)
    throw new ApiError(422, 'model_request_failed', `Model ${upstreamModel} trả về HTTP ${response.status}.`)
  })
  app.post('/providers/:provider/models', async (request, reply) => {
    const { provider } = providerParams.parse(request.params); const { model, display_name, enabled } = newModel.parse(request.body)
    if (!await collection(db, 'ai_providers').findOne({ _id: provider })) throw notFound()
    if (await collection(db, 'ai_models').findOne({ provider, $or: [{ upstream_model: model }, { _id: model }] })) {
      throw new ApiError(409, 'model_exists', 'Model đã có trong nhà cung cấp này.')
    }
    const row: ModelRow = {
      _id: provider === providerKind(provider) ? model : `model-${randomUUID()}`,
      upstream_model: model, provider, display_name: display_name ?? model, enabled: enabled ?? true,
    }
    await collection<ModelRow>(db, 'ai_models').insertOne(row)
    return reply.code(201).send({ provider, ...modelView(row) })
  })
  app.patch('/providers/:provider/models/:model', async request => {
    const { provider, model } = modelParams.parse(request.params); const fields = z.object({ display_name: displayName.optional(), enabled: z.boolean().optional() }).strict().refine(value => Object.keys(value).length > 0, 'Cần ít nhất một trường thay đổi.').parse(request.body)
    if (!await collection(db, 'ai_models').findOne({ _id: model, provider })) throw notFound()
    if (fields.enabled === false && await collection(db, 'customers').findOne({ key_mode: 'service', allowed_models: model })) {
      throw new ApiError(409, 'model_in_use', 'Không thể tắt model đang được cấp cho khách hàng.')
    }
    const result = await collection(db, 'ai_models').findOneAndUpdate({ _id: model, provider }, { $set: fields }, { returnDocument: 'after' }); if (!result) throw notFound(); return { provider, ...modelView(result) }
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
