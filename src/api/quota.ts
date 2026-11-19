import type { Pool, PoolClient } from 'pg'
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

export function assertPackage(pkg: Package, when: Date, model: string, length: number) {
  if (pkg.key_mode === 'own') return
  if ((pkg.starts_at && when < pkg.starts_at) || (pkg.ends_at && when >= pkg.ends_at)) {
    throw new ApiError(403, 'package_inactive', 'Ngày viết nằm ngoài thời hạn gói.')
  }
  if (!pkg.allowed_models.includes(model)) {
    throw new ApiError(403, 'model_not_allowed', 'Gói hiện tại chưa cấp quyền dùng model này.')
  }
  if (pkg.max_length !== null && length > pkg.max_length) {
    throw new ApiError(400, 'length_limit', 'Độ dài bài vượt giới hạn của gói.', { max_length: pkg.max_length })
  }
}

export async function quotaAt(db: Pool | PoolClient, customerId: string, when: Date, skipJobId?: string) {
  const { rows: [quota] } = await db.query<QuotaDay>(`
    WITH period AS (
      SELECT ($2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS quota_day,
             date_trunc('month', $2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS quota_month
    )
    SELECT quota_day::text, quota_month::text,
           (quota_day + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh' AS next_day,
           (quota_month + interval '1 month') AT TIME ZONE 'Asia/Ho_Chi_Minh' AS next_month,
           counts.*
    FROM period
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE q.quota_day = period.quota_day AND q.status = 'used')::int AS day_used,
             count(*) FILTER (WHERE q.quota_day = period.quota_day AND q.status = 'reserved')::int AS day_reserved,
             count(*) FILTER (WHERE q.status = 'used')::int AS month_used,
             count(*) FILTER (WHERE q.status = 'reserved')::int AS month_reserved
      FROM quota_reservations q
      WHERE q.customer_id = $1 AND q.quota_month = period.quota_month
        AND q.status IN ('used', 'reserved') AND ($3::uuid IS NULL OR q.job_id <> $3)
    ) counts
  `, [customerId, when, skipJobId ?? null])
  return quota
}

export async function usage(db: Pool | PoolClient, customer: Package, when: Date) {
  const result = {
    key_mode: customer.key_mode,
    allowed_models: customer.allowed_models,
    max_length: customer.max_length,
    active_from: customer.starts_at,
    active_until: customer.ends_at,
    active: customer.key_mode === 'own' ||
      ((!customer.starts_at || when >= customer.starts_at) && (!customer.ends_at || when < customer.ends_at)),
  }
  if (customer.key_mode === 'own') return { ...result, day: null, month: null }
  const quota = await quotaAt(db, customer.id, when)
  const period = (limit: number | null, used: number, reserved: number, resets_at: Date) => ({
    limit, used, reserved, remaining: Math.max(0, (limit ?? 0) - used - reserved), resets_at,
  })
  return {
    ...result,
    day: period(customer.daily_limit, quota.day_used, quota.day_reserved, quota.next_day),
    month: period(customer.monthly_limit, quota.month_used, quota.month_reserved, quota.next_month),
  }
}

/** Call while holding the customer row lock. Quota and job changes share a transaction. */
export async function reserveQuota(
  db: PoolClient, customer: Package, jobId: string, when: Date, current?: { quota_day: string, quota_month: string },
) {
  if (customer.key_mode === 'own') return
  const next = await quotaAt(db, customer.id, when, current ? jobId : undefined)
  const full: string[] = []
  if (current?.quota_day !== next.quota_day && next.day_used + next.day_reserved >= (customer.daily_limit ?? 0)) {
    full.push('day')
  }
  if (current?.quota_month !== next.quota_month && next.month_used + next.month_reserved >= (customer.monthly_limit ?? 0)) {
    full.push('month')
  }
  if (full.length) {
    throw new ApiError(429, 'quota_exhausted', 'Đã hết lượt viết trong kỳ đã chọn.', {
      periods: full, date: next.quota_day, day_resets_at: next.next_day, month_resets_at: next.next_month,
    })
  }
  await db.query(`
    INSERT INTO quota_reservations(job_id,customer_id,quota_day,quota_month,status)
    VALUES($1,$2,$3,$4,'reserved')
    ON CONFLICT(job_id) DO UPDATE SET quota_day=excluded.quota_day,quota_month=excluded.quota_month
  `, [jobId, customer.id, next.quota_day, next.quota_month])
}
