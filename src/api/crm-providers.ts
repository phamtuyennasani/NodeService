import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { providers, type Config, type Provider } from '../config.js'
import type { Database } from '../db.js'
import { modelIdSchema } from './catalog.js'
import { notFound } from './errors.js'

const providerParams = z.object({ provider: z.enum(providers) })
const modelParams = providerParams.extend({ model: modelIdSchema })
const displayName = z.string().trim().min(1).max(160)
const editable = z.object({ display_name: displayName.optional(), enabled: z.boolean().optional() }).strict()
const patchFields = editable.refine(fields => Object.keys(fields).length > 0, 'Cần ít nhất một trường thay đổi.')
const newModel = editable.extend({ model: modelIdSchema })

export function registerProviders(app: FastifyInstance, db: Database, config: Config) {
  app.get('/providers', async () => {
    const { rows } = await db.query<{
      provider: Provider, display_name: string, enabled: boolean,
      models: { model: string, display_name: string, enabled: boolean }[],
    }>(`
      SELECT p.provider,p.display_name,p.enabled,
        coalesce(json_agg(json_build_object('model',m.model,'display_name',m.display_name,'enabled',m.enabled)
          ORDER BY m.display_name,m.model) FILTER (WHERE m.model IS NOT NULL),'[]'::json) AS models
      FROM ai_providers p LEFT JOIN ai_models m ON m.provider=p.provider
      GROUP BY p.provider ORDER BY array_position($1::text[],p.provider)
    `, [providers])
    return { data: rows.map(row => ({ ...row, service_key_configured: Boolean(config.serviceKeys[row.provider]) })) }
  })

  app.patch('/providers/:provider', async request => {
    const { provider } = providerParams.parse(request.params)
    const { enabled, display_name } = patchFields.parse(request.body)
    const { rows: [updated] } = await db.query(`
      UPDATE ai_providers SET enabled=coalesce($2,enabled),display_name=coalesce($3,display_name)
      WHERE provider=$1 RETURNING provider,display_name,enabled
    `, [provider, enabled ?? null, display_name ?? null])
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
    const { enabled, display_name } = patchFields.parse(request.body)
    const { rows: [updated] } = await db.query(`
      UPDATE ai_models SET enabled=coalesce($3,enabled),display_name=coalesce($4,display_name)
      WHERE provider=$1 AND model=$2 RETURNING provider,model,display_name,enabled
    `, [provider, model, enabled ?? null, display_name ?? null])
    if (!updated) throw notFound()
    return updated
  })
}
