import { z } from 'zod'
import type { Provider } from '../config.js'
import { collection, type MongoSource } from '../db.js'
import { ApiError } from './errors.js'

export const modelIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._/-]+$/)

export interface AvailableModel {
  provider: Provider
  model: string
  display_name: string
}

export async function listAvailableModels(db: MongoSource, allowed?: string[]): Promise<AvailableModel[]> {
  const models = await collection<{ _id: string, provider: Provider, display_name: string, enabled: boolean }>(db, 'ai_models')
    .find({ enabled: true, ...(allowed ? { _id: { $in: allowed } } : {}) }).toArray()
  const providers = await collection<{ _id: Provider, enabled: boolean }>(db, 'ai_providers').find({ enabled: true }).toArray()
  const enabled = new Set(providers.map(row => row._id))
  return models.filter(row => enabled.has(row.provider))
    .map(row => ({ provider: row.provider, model: row._id, display_name: row.display_name }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name) || a.model.localeCompare(b.model))
}

function unavailable(model: string) {
  return new ApiError(400, 'model_unavailable', 'Model hiện không được cung cấp.', { model })
}

export async function requireAvailableModel(source: MongoSource, model: string): Promise<Provider> {
  const row = await collection<{ _id: string, provider: Provider, enabled: boolean }>(source, 'ai_models').findOne({ _id: model, enabled: true })
  if (!row) throw unavailable(model)
  const provider = await collection<{ _id: Provider, enabled: boolean }>(source, 'ai_providers').findOne({ _id: row.provider, enabled: true })
  if (!provider) throw unavailable(model)
  return row.provider
}

export async function assertAvailableModels(source: MongoSource, models: string[]): Promise<void> {
  if (!models.length) return
  const available = new Set((await listAvailableModels(source)).map(row => row.model))
  for (const model of models) if (!available.has(model)) throw unavailable(model)
}
// @ts-nocheck
