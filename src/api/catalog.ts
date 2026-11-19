import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { Provider } from '../config.js'
import type { Database } from '../db.js'
import { ApiError } from './errors.js'

export const modelIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._-]+$/)

interface AvailableModel {
  provider: Provider
  model: string
  display_name: string
}

const availableModels = `
  SELECT m.provider,m.model,m.display_name FROM ai_models m
  JOIN ai_providers p ON p.provider=m.provider
  WHERE m.enabled AND p.enabled`

export async function listAvailableModels(db: Database | PoolClient, allowed?: string[]): Promise<AvailableModel[]> {
  const { rows } = await db.query<AvailableModel>(`
    ${availableModels} AND ($1::text[] IS NULL OR m.model=ANY($1))
    ORDER BY p.display_name,m.display_name,m.model
  `, [allowed ?? null])
  return rows
}

function unavailable(model: string) {
  return new ApiError(400, 'model_unavailable', 'Model hiện không được cung cấp.', { model })
}

// Keep both catalog rows stable through the transaction that grants or accepts a model.
async function lockAvailableModels(client: PoolClient, models: string[]) {
  const { rows } = await client.query<AvailableModel>(`
    ${availableModels} AND m.model=ANY($1::text[])
    ORDER BY m.provider,m.model FOR SHARE OF p,m
  `, [models])
  return rows
}

export async function requireAvailableModel(client: PoolClient, model: string): Promise<Provider> {
  const [row] = await lockAvailableModels(client, [model])
  if (!row) throw unavailable(model)
  return row.provider
}

export async function assertAvailableModels(client: PoolClient, models: string[]): Promise<void> {
  if (!models.length) return
  const allowed = new Set((await lockAvailableModels(client, models)).map(row => row.model))
  for (const model of models) if (!allowed.has(model)) throw unavailable(model)
}
