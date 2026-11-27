import { z } from 'zod'
import { collection, type Database } from '../db.js'
import { unseal } from '../security.js'
import type { Config } from '../config.js'

export const keywordSettingsSchema = z.object({
  enabled: z.boolean().default(true), mode: z.enum(['guest', 'paid']).default('guest'),
  daily_limit: z.number().int().min(1).max(1000).default(10),
  monthly_limit: z.number().int().min(1).max(25000).default(100),
  cache_hours: z.number().int().min(1).max(168).default(24),
  paid_daily_limit: z.number().int().min(1).max(10000).default(50),
  max_ai_cost_usd: z.string().regex(/^0\.\d{1,4}$|^[1-9]\d?(?:\.\d{1,4})?$/).default('0.10'),
}).strict()
export type KeywordSettings = z.infer<typeof keywordSettingsSchema>
export async function readKeywordSettings(db: Database) {
  const row = await collection(db, 'keyword_settings').findOne({ _id: 'crm' })
  return { values: keywordSettingsSchema.parse(row?.values ?? {}), revision: row?.revision ?? 0,
    api_key_configured: Boolean(row?.encrypted_api_key), updated_at: row?.updated_at ?? null }
}
export async function keywordApiKey(db: Database, config: Config) {
  const row = await collection(db, 'keyword_settings').findOne({ _id: 'crm' })
  if (!row?.encrypted_api_key) return undefined
  try { return unseal(row.encrypted_api_key, config.encryptionKey) }
  catch { throw new Error('Không giải mã được API key Keyword Tool. Hãy lưu lại khóa trong Cài đặt.') }
}
