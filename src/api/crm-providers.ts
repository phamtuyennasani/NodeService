import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { providers, type Config, type Provider } from '../config.js'
import type { Database } from '../db.js'
import { modelIdSchema } from './catalog.js'
import { ApiError, notFound } from './errors.js'
import { seal } from '../security.js'

const providerParams = z.object({ provider: z.enum(providers) })
const modelParams = providerParams.extend({ model: modelIdSchema })
const displayName = z.string().trim().min(1).max(160)
const baseUrl = z.string().trim().url({ protocol: /^https?$/ }).max(500).refine(value => {
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash
}, 'Base URL không được chứa thông tin đăng nhập, query hoặc hash.')
const editable = z.object({
  display_name: displayName.optional(), enabled: z.boolean().optional(),
  base_url: baseUrl.optional(), api_key: z.string().trim().min(1).max(2048).optional(),
}).strict()
const patchFields = editable.refine(fields => Object.keys(fields).length > 0, 'Cần ít nhất một trường thay đổi.')
const newModel = z.object({ model: modelIdSchema, display_name: displayName.optional(), enabled: z.boolean().optional() }).strict()

export function registerProviders(app: FastifyInstance, db: Database, config: Config) {
  app.get('/providers', async () => {
    const { rows } = await db.query<{
      provider: Provider, display_name: string, enabled: boolean, base_url: string | null, encrypted_api_key: string | null,
      models: { model: string, display_name: string, enabled: boolean }[],
    }>(`
      SELECT p.provider,p.display_name,p.enabled,p.base_url,p.encrypted_api_key,
        coalesce(json_agg(json_build_object('model',m.model,'display_name',m.display_name,'enabled',m.enabled)
          ORDER BY m.display_name,m.model) FILTER (WHERE m.model IS NOT NULL),'[]'::json) AS models
      FROM ai_providers p LEFT JOIN ai_models m ON m.provider=p.provider
      GROUP BY p.provider,p.display_name,p.enabled,p.base_url,p.encrypted_api_key ORDER BY array_position($1::text[],p.provider)
    `, [providers])
    return { data: rows.map(row => ({
      provider: row.provider, display_name: row.display_name, enabled: row.enabled,
      base_url: row.provider === 'openai-compatible' ? row.base_url : null,
      service_key_configured: row.provider === 'openai-compatible' ? false : Boolean(config.serviceKeys[row.provider]),
      api_key_configured: row.provider === 'openai-compatible' ? Boolean(row.encrypted_api_key) : undefined,
      models: row.models,
    })) }
  })

  app.patch('/providers/:provider', async request => {
    const { provider } = providerParams.parse(request.params)
    const fields = patchFields.parse(request.body)
    if (provider !== 'openai-compatible' && (fields.base_url !== undefined || fields.api_key !== undefined)) {
      throw new ApiError(400, 'provider_configuration_unsupported', 'Chỉ nhà cung cấp OpenAI Compatible cần Base URL và API key riêng.')
    }
    if (provider === 'openai-compatible' && fields.base_url === undefined && fields.api_key === undefined && fields.display_name === undefined && fields.enabled === undefined) {
      throw new ApiError(400, 'empty_provider_update', 'Cần ít nhất một trường thay đổi.')
    }
    const encrypted = fields.api_key ? seal(fields.api_key, config.encryptionKey) : null
    const { rows: [updated] } = await db.query(`
      UPDATE ai_providers SET enabled=coalesce($2,enabled),display_name=coalesce($3,display_name),
        base_url=CASE WHEN $4::text IS NULL THEN base_url ELSE $4 END,
        encrypted_api_key=CASE WHEN $5::text IS NULL THEN encrypted_api_key ELSE $5 END
      WHERE provider=$1 RETURNING provider,display_name,enabled,base_url,(encrypted_api_key IS NOT NULL) AS api_key_configured
    `, [provider, fields.enabled ?? null, fields.display_name ?? null,
      fields.base_url ?? null, encrypted])
    if (!updated) throw notFound()
    return updated
  })

  app.post('/providers/:provider/models', async (request, reply) => {
    const { provider } = providerParams.parse(request.params)
    const { model, display_name, enabled } = newModel.parse(request.body)
    const { rows: [created] } = await db.query(`
      INSERT INTO ai_models(provider,model,display_name,enabled) VALUES($1,$2,$3,$4)
      RETURNING provider,model,display_name,enabled
    `, [provider, model, display_name ?? model, enabled ?? true])
    return reply.code(201).send(created)
  })

  app.patch('/providers/:provider/models/:model', async request => {
    const { provider, model } = modelParams.parse(request.params)
    const { enabled, display_name } = z.object({ display_name: displayName.optional(), enabled: z.boolean().optional() })
      .strict().refine(fields => Object.keys(fields).length > 0, 'Cần ít nhất một trường thay đổi.')
      .parse(request.body)
    const { rows: [updated] } = await db.query(`
      UPDATE ai_models SET enabled=coalesce($3,enabled),display_name=coalesce($4,display_name)
      WHERE provider=$1 AND model=$2 RETURNING provider,model,display_name,enabled
    `, [provider, model, enabled ?? null, display_name ?? null])
    if (!updated) throw notFound()
    return updated
  })
}
