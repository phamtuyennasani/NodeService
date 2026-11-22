import { z } from 'zod'
import { isCompatibleProvider, providers, type Provider } from '../config.js'
import { collection, sessionOf, type MongoSource } from '../db.js'
import { ApiError } from './errors.js'

export const modelIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._/-]+$/)
export const providerIdSchema = z.union([
  z.enum(providers),
  z.string().regex(/^openai-compatible-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
]).transform(value => value as Provider)

export interface AvailableModel {
  provider: Provider
  model: string
  display_name: string
  upstream_model?: string
  provider_display_name?: string
}

export async function listAvailableModels(db: MongoSource, allowed?: string[]): Promise<AvailableModel[]> {
  const session = sessionOf(db)
  const models = await collection<{ _id: string, provider: Provider, display_name: string, enabled: boolean, upstream_model?: string }>(db, 'ai_models')
    .find({ enabled: true, ...(allowed ? { _id: { $in: allowed } } : {}) }, { session }).toArray()
  const providers = await collection<{ _id: Provider, enabled: boolean, display_name?: string }>(db, 'ai_providers').find({ enabled: true }, { session }).toArray()
  const enabled = new Set(providers.map(row => row._id))
  const names = new Map(providers.map(row => [row._id, row.display_name]))
  return models.filter(row => enabled.has(row.provider))
    .map(row => ({ provider: row.provider, model: row._id, display_name: row.display_name,
      ...(isCompatibleProvider(row.provider) && row.provider !== 'openai-compatible' ? {
        upstream_model: row.upstream_model ?? row._id, provider_display_name: names.get(row.provider) ?? row.provider,
      } : {}),
    }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.model.localeCompare(b.model))
}

function unavailable(model: string) {
  return new ApiError(400, 'model_unavailable', 'Model hiện không được cung cấp.', { model })
}

export async function requireAvailableModel(source: MongoSource, model: string): Promise<Provider> {
  const session = sessionOf(source)
  const row = await collection<{ _id: string, provider: Provider, enabled: boolean }>(source, 'ai_models').findOne({ _id: model, enabled: true }, { session })
  if (!row) throw unavailable(model)
  const provider = await collection<{ _id: Provider, enabled: boolean }>(source, 'ai_providers').findOne({ _id: row.provider, enabled: true }, { session })
  if (!provider) throw unavailable(model)
  return row.provider
}

export async function assertAvailableModels(source: MongoSource, models: string[]): Promise<void> {
  if (!models.length) return
  const available = new Set((await listAvailableModels(source)).map(row => row.model))
  for (const model of models) if (!available.has(model)) throw unavailable(model)
}
// @ts-nocheck
