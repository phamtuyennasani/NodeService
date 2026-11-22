import assert from 'node:assert/strict'
import test from 'node:test'
import { quotaAt } from '../src/api/quota.js'
import { loadConfig } from '../src/config.js'
import type { Database } from '../src/db.js'

test('quota resets at Vietnam midnight on the first day of the next calendar month', async () => {
  const db = {
    db: { collection: () => ({ find: () => ({ toArray: async () => [] }) }) },
  } as unknown as Database
  const dates = [
    ['2026-02-28T16:59:59.999Z', '2026-02-28', '2026-02-28T17:00:00.000Z'],
    ['2026-02-28T17:00:00.000Z', '2026-03-01', '2026-03-31T17:00:00.000Z'],
    ['2028-02-29T16:59:59.999Z', '2028-02-29', '2028-02-29T17:00:00.000Z'],
    ['2026-12-31T16:59:59.999Z', '2026-12-31', '2026-12-31T17:00:00.000Z'],
    ['2026-12-31T17:00:00.000Z', '2027-01-01', '2027-01-31T17:00:00.000Z'],
  ]
  for (const [instant, day, reset] of dates) {
    const quota = await quotaAt(db, 'customer', new Date(instant))
    assert.equal(quota.quota_day, day)
    assert.equal(quota.quota_month, day.slice(0, 7))
    assert.equal(quota.next_month.toISOString(), reset)
  }
})

test('SEO repair uses the documented default and honors a configured timeout', () => {
  const originalEnv = process.env
  process.env = {
    MONGODB_URI: 'mongodb://127.0.0.1:27017',
    ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  }
  try {
    assert.equal(loadConfig().seoRepairTimeoutMs, 90_000)
    process.env.AI_SEO_REPAIR_TIMEOUT_MS = '60000'
    assert.equal(loadConfig().seoRepairTimeoutMs, 60_000)
  } finally {
    process.env = originalEnv
  }
})
