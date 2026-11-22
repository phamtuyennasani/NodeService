import type { MongoSource } from '../db.js'
import { collection, sessionOf } from '../db.js'
import { ApiError } from './errors.js'

export interface Package {
  id: string
  key_mode: 'own' | 'service'
  daily_limit: number | null
  monthly_limit: number | null
  starts_at: Date | null
  ends_at: Date | null
  allowed_models: string[]
  max_length: number | null
}

interface QuotaDay {
  quota_day: string
  quota_month: string
  next_day: Date
  next_month: Date
  day_used: number
  day_reserved: number
  month_used: number
  month_reserved: number
}

const vietnamDate = (value: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(value)
const addDays = (date: string, days: number) => {
  const value = new Date(`${date}T00:00:00+07:00`)
  value.setUTCDate(value.getUTCDate() + days)
  return value
}
const addMonth = (month: string) => {
  const value = new Date(`${month}-01T00:00:00Z`)
  value.setUTCMonth(value.getUTCMonth() + 1)
  return new Date(`${value.toISOString().slice(0, 10)}T00:00:00+07:00`)
}

export function assertPackage(pkg: Package, when: Date, model: string, length: number) {
  if (pkg.key_mode === 'own') return
  if ((pkg.starts_at && when < pkg.starts_at) || (pkg.ends_at && when >= pkg.ends_at)) {
    throw new ApiError(403, 'package_inactive', 'Ngày viết nằm ngoài thời hạn gói.')
  }
  if (!pkg.allowed_models.includes(model)) throw new ApiError(403, 'model_not_allowed', 'Gói hiện tại chưa cấp quyền dùng model này.')
  if (pkg.max_length !== null && length > pkg.max_length) throw new ApiError(400, 'length_limit', 'Độ dài bài vượt giới hạn của gói.', { max_length: pkg.max_length })
}

export async function quotaAt(source: MongoSource, customerId: string, when: Date, skipJobId?: string): Promise<QuotaDay> {
  const day = vietnamDate(when)
  const month = day.slice(0, 7)
  const filter = { customer_id: customerId, quota_month: month, status: { $in: ['used', 'reserved'] }, ...(skipJobId ? { job_id: { $ne: skipJobId } } : {}) }
  const rows = await collection<{ quota_day: string, status: string }>(source, 'quota_reservations').find(filter, { session: sessionOf(source) }).toArray()
  return {
    quota_day: day,
    quota_month: month,
    next_day: addDays(day, 1),
    next_month: addMonth(month),
    day_used: rows.filter(row => row.quota_day === day && row.status === 'used').length,
    day_reserved: rows.filter(row => row.quota_day === day && row.status === 'reserved').length,
    month_used: rows.filter(row => row.status === 'used').length,
    month_reserved: rows.filter(row => row.status === 'reserved').length,
  }
}

export async function usage(source: MongoSource, customer: Package, when: Date) {
  const result = {
    key_mode: customer.key_mode, allowed_models: customer.allowed_models, max_length: customer.max_length,
    active_from: customer.starts_at, active_until: customer.ends_at,
    active: customer.key_mode === 'own' || ((!customer.starts_at || when >= customer.starts_at) && (!customer.ends_at || when < customer.ends_at)),
  }
  if (customer.key_mode === 'own') return { ...result, day: null, month: null }
  const quota = await quotaAt(source, customer.id, when)
  const period = (limit: number | null, used: number, reserved: number, resets_at: Date) => ({ limit, used, reserved, remaining: Math.max(0, (limit ?? 0) - used - reserved), resets_at })
  return { ...result, day: period(customer.daily_limit, quota.day_used, quota.day_reserved, quota.next_day), month: period(customer.monthly_limit, quota.month_used, quota.month_reserved, quota.next_month) }
}

export async function reserveQuota(source: MongoSource, customer: Package, jobId: string, when: Date, current?: { quota_day: string, quota_month: string }) {
  if (customer.key_mode === 'own') return
  const quota = await quotaAt(source, customer.id, when, current ? jobId : undefined)
  const full: string[] = []
  if (current?.quota_day !== quota.quota_day && quota.day_used + quota.day_reserved >= (customer.daily_limit ?? 0)) full.push('day')
  if (current?.quota_month !== quota.quota_month && quota.month_used + quota.month_reserved >= (customer.monthly_limit ?? 0)) full.push('month')
  if (full.length) throw new ApiError(429, 'quota_exhausted', 'Đã hết lượt viết trong kỳ đã chọn.', { periods: full, date: quota.quota_day, day_resets_at: quota.next_day, month_resets_at: quota.next_month })
  await collection(source, 'quota_reservations').updateOne({ job_id: jobId }, { $set: { job_id: jobId, customer_id: customer.id, quota_day: quota.quota_day, quota_month: quota.quota_month, status: 'reserved' } }, { upsert: true, session: sessionOf(source) })
}
// @ts-nocheck
