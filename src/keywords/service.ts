import { createHash, randomUUID } from 'node:crypto'
import { Decimal } from 'decimal.js'
import { collection, resolveDatabase, rootDatabase, transaction, type Database } from '../db.js'
import { ApiError, notFound } from '../api/errors.js'
import { serviceKeyState } from '../provider-key.js'
import type { Config } from '../config.js'
import { readKeywordSettings, type KeywordSettings } from './settings.js'
import { type KeywordInput, type KeywordAnalysisView, type KeywordSourceResult, type KeywordSuggestion } from './contracts.js'

export interface KeywordAnalysis {
  _id: string; customer_id: string; site_id: string; input: KeywordInput; request_hash: string; cache_key: string
  status: KeywordAnalysisView['status']; stage: KeywordAnalysisView['stage']; created_at: Date; completed_at: Date | null
  available_at: Date; lease_token: string | null; lease_expires_at: Date | null
  result: KeywordSourceResult | null; suggestions: KeywordSuggestion[]; error: string | null; ai_note: string | null
  source_mode: 'guest' | 'paid'; settings: KeywordSettings; ai_called: boolean
}
export function keywordHash(input: KeywordInput, mode: string) {
  const { client_request_id: _, ...fields } = input
  return createHash('sha256').update(JSON.stringify({ ...fields, source_mode: mode, version: 1 })).digest('hex')
}
export async function requireKeywordSite(db: Database, id: string) {
  const site = await collection(db, 'sites').findOne({ _id: id })
  if (!site) throw notFound()
  const customer = await collection(db, 'customers').findOne({ _id: site.customer_id })
  if (!customer || customer.enabled === false) throw new ApiError(403, 'customer_disabled', 'Khách hàng đã bị khóa hoặc không còn tồn tại.')
  if (site.enabled === false) throw new ApiError(403, 'site_disabled', 'Website đã bị khóa.')
  return { site, customer }
}
export async function keywordView(db: Database, row: KeywordAnalysis, reused = false): Promise<KeywordAnalysisView> {
  const attempts = await collection(db, 'keyword_attempts').find({ analysis_id: row._id }, {
    projection: { cost_usd: 1, status: 1 },
  }).toArray()
  const total = attempts.length && attempts.every(a => a.cost_usd != null)
    ? attempts.reduce((sum, a) => sum.plus(a.cost_usd), new Decimal(0)).toFixed(12) : null
  return { id: row._id, website_id: row.site_id, customer_id: row.customer_id, input: row.input,
    status: row.status, stage: row.stage, created_at: row.created_at.toISOString(), completed_at: row.completed_at?.toISOString() ?? null,
    result: row.result, suggestions: row.suggestions, error: row.error, ai_note: row.ai_note, reused,
    source_cost: row.source_mode === 'guest' ? 'free' : 'subscription', ai_cost_usd: total, ai_called: row.ai_called }
}
export async function createKeywordAnalysis(db: Database, config: Config, input: KeywordInput) {
  db = resolveDatabase(db)
  const settings = (await readKeywordSettings(db)).values
  if (!settings.enabled) throw new ApiError(403, 'keywords_disabled', 'Tính năng từ khóa đang tắt trong nhóm quản lý này.')
  const { customer } = await requireKeywordSite(db, input.website_id)
  const requestHash = keywordHash(input, settings.mode)
  const old = await collection<KeywordAnalysis>(db, 'keyword_analyses').findOne({ site_id: input.website_id, 'input.client_request_id': input.client_request_id })
  if (old) {
    // Compare the original payload independent of later source-setting changes.
    if (keywordHash(input, old.source_mode) !== old.request_hash) throw new ApiError(409, 'keyword_request_conflict', 'Mã yêu cầu này đã được dùng với nội dung khác.')
    return keywordView(db, old, true)
  }
  const cached = await collection<KeywordAnalysis>(db, 'keyword_analyses').findOne({ site_id: input.website_id,
    customer_id: customer._id, cache_key: requestHash, status: { $in: ['queued', 'running', 'ready', 'partial'] },
    created_at: { $gt: new Date(Date.now() - settings.cache_hours * 3_600_000) },
  }, { sort: { created_at: -1 } })
  if (cached) return keywordView(db, cached, true)
  if (input.ai_model) {
    const model = await collection(db, 'ai_models').findOne({ _id: input.ai_model, enabled: true })
    const provider = model ? await collection(db, 'ai_providers').findOne({ _id: model.provider, enabled: true }) : null
    if (!provider || serviceKeyState(provider._id, provider.encrypted_api_key, config) !== 'ready') {
      throw new ApiError(422, 'keyword_ai_configuration', 'Model chưa có kết nối AI dịch vụ hợp lệ trong nhóm quản lý này.')
    }
  }
  const now = new Date(), id = randomUUID()
  const row: KeywordAnalysis = { _id: id, customer_id: customer._id, site_id: input.website_id,
    input, request_hash: requestHash, cache_key: requestHash, status: 'queued', stage: 'source', created_at: now,
    completed_at: null, available_at: now, lease_token: null, lease_expires_at: null,
    result: null, suggestions: [], error: null, ai_note: null, source_mode: settings.mode, settings, ai_called: false }
  try { await transaction(db, async source => {
    // Parent locks serialize quota checks and conflict with concurrent deletion/ownership changes.
    const parent = await collection(source, 'customers').updateOne({ _id: customer._id }, { $inc: { relation_version: 1 } }, { session: source.session })
    const site = await collection(source, 'sites').updateOne({ _id: input.website_id, customer_id: customer._id }, { $inc: { relation_version: 1 } }, { session: source.session })
    if (!parent.matchedCount || !site.matchedCount) throw notFound()
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now)
    const active = { customer_id: customer._id, status: { $in: ['reserved', 'used'] } }
    const daily = await collection(source, 'keyword_quota_reservations').countDocuments({ ...active, day }, { session: source.session })
    const monthly = await collection(source, 'keyword_quota_reservations').countDocuments({ ...active, month: day.slice(0, 7) }, { session: source.session })
    if (daily >= settings.daily_limit || monthly >= settings.monthly_limit) throw new ApiError(429, 'keyword_quota', 'Khách hàng đã hết lượt phân tích từ khóa trong ngày hoặc tháng.')
    await collection(source, 'keyword_analyses').insertOne(row, { session: source.session })
    await collection(source, 'keyword_quota_reservations').insertOne({ _id: id, customer_id: customer._id, day, month: day.slice(0, 7), status: 'reserved' }, { session: source.session })
  }) } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error
    const concurrent = await collection<KeywordAnalysis>(db, 'keyword_analyses').findOne({ site_id: input.website_id, customer_id: customer._id,
      $or: [{ 'input.client_request_id': input.client_request_id }, { cache_key: requestHash, status: { $in: ['queued', 'running'] } }] })
    if (!concurrent) throw error
    if (concurrent.request_hash !== requestHash) throw new ApiError(409, 'keyword_request_conflict', 'Mã yêu cầu đã được dùng với nội dung khác.')
    return keywordView(db, concurrent, true)
  }
  return keywordView(db, row)
}

/** Rolling local guard shared by every workspace for the anonymous Guest upstream. */
export async function reserveKeywordSource(db: Database, mode: 'guest' | 'paid', key: string | undefined, dailyLimit: number, now = Date.now()) {
  const root = rootDatabase(db)
  const windows = collection(root, 'keyword_source_limits')
  const id = mode === 'guest' ? 'keywordtool-guest' : `keywordtool-paid:${createHash('sha256').update(key ?? '').digest('hex')}`
  for (let retry = 0; retry < 20; retry++) {
    const current = await windows.findOne({ _id: id })
    if (!current) {
      try { await windows.insertOne({ _id: id, revision: 0, times: [] }) }
      catch (error) { if ((error as { code?: number }).code !== 11000) throw error }
      continue
    }
    const times: number[] = current.times.filter((time: number) => time > now - 86_400_000)
    const shortWindow = mode === 'guest' ? 3_600_000 : 60_000
    if (times.length >= (mode === 'guest' ? 120 : dailyLimit) || times.filter(time => time > now - shortWindow).length >= (mode === 'guest' ? 60 : 15)) {
      throw new ApiError(429, 'keyword_source_quota', 'Nguồn từ khóa đã đạt hạn mức dùng chung. Hãy xem lại kết quả đã lưu hoặc thử sau.')
    }
    const result = await windows.updateOne({ _id: id, revision: current.revision }, { $set: { times: [...times, now] }, $inc: { revision: 1 } })
    if (result.matchedCount) return
  }
  throw new ApiError(429, 'keyword_source_busy', 'Nguồn từ khóa đang bận. Vui lòng thử lại sau.')
}
