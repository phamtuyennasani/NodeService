import test from 'node:test'
import assert from 'node:assert/strict'
import type { Database } from '../src/db.js'
import { jobEvents, type JobEvent } from '../src/job-events.js'
import { runRetentionOnce } from '../src/worker/retention.js'

type Row = Record<string, any>
type Tables = Record<string, Row[]>
const now = new Date('2026-11-22T08:00:00Z')
const old = new Date('2026-01-01T00:00:00Z')
const recent = new Date('2026-11-21T00:00:00Z')

function database(tables: Tables, hooks: {
  failDelete?: string
  beforeTransaction?: (tables: Tables) => void
  loseLease?: boolean
} = {}): Database {
  let active: Tables | undefined
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((branch: Row) => matches(row, branch))
    const actual = key.split('.').reduce<any>((value, part) => value?.[part], row)
    if (expected === null) return actual == null
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime()
    if (expected && typeof expected === 'object') return Object.entries(expected).every(([operator, value]) => {
      if (operator === '$in') return (value as any[]).includes(actual)
      if (operator === '$ne') return actual !== value
      if (operator === '$lt') return actual < value!
      if (operator === '$lte') return actual <= value!
      if (operator === '$gt') return actual > value!
      if (operator === '$type') return value === 'date' && actual instanceof Date
      throw new Error('Unsupported filter ' + operator)
    })
    return actual === expected
  })
  const session = {
    async withTransaction<T>(callback: () => Promise<T>) {
      hooks.beforeTransaction?.(tables)
      active = structuredClone(tables)
      try {
        const result = await callback()
        Object.keys(tables).forEach(key => delete tables[key])
        Object.assign(tables, active)
        return result
      } finally { active = undefined }
    },
    async endSession() {},
  }
  const db = {
    collection(name: string) {
      const rows = (options?: Row) => ((options?.session === session && active ? active : tables)[name] ??= [])
      const checkTransaction = (options?: Row) => {
        if (name !== 'runtime_maintenance') assert.ok(active && options?.session === session, 'retention mutation must carry the transaction session')
      }
      function update(row: Row, changes: Row) {
        Object.assign(row, structuredClone(changes.$set ?? {}))
        for (const [key, value] of Object.entries(changes.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(value)
      }
      return {
        async findOne(filter: Row, options?: Row) { return structuredClone(rows(options).find(row => matches(row, filter)) ?? null) },
        find(filter: Row, options?: Row) {
          let maximum = Infinity
          let order: Row = {}
          const cursor = {
            sort(value: Row) { order = value; return cursor },
            limit(value: number) { maximum = value; return cursor },
            async toArray() {
              const selected = rows(options).filter(row => matches(row, filter))
              selected.sort((a, b) => {
                for (const [key, direction] of Object.entries(order)) {
                  const left = a[key] instanceof Date ? a[key].getTime() : a[key] ?? ''
                  const right = b[key] instanceof Date ? b[key].getTime() : b[key] ?? ''
                  if (left !== right) return (left < right ? -1 : 1) * Number(direction)
                }
                return 0
              })
              return structuredClone(selected.slice(0, maximum))
            },
          }
          return cursor
        },
        async updateOne(filter: Row, changes: Row, options?: Row) {
          checkTransaction(options)
          if (name === 'runtime_maintenance' && options?.session && hooks.loseLease) return { matchedCount: 0 }
          let row = rows(options).find(row => matches(row, filter))
          if (!row && options?.upsert) {
            const inserted: Row = { _id: filter._id, ...structuredClone(changes.$setOnInsert ?? {}) }
            rows(options).push(inserted)
            row = inserted
          }
          if (row) update(row, changes)
          return { matchedCount: row ? 1 : 0 }
        },
        async findOneAndUpdate(filter: Row, changes: Row, options?: Row) {
          const row = rows(options).find(row => matches(row, filter))
          if (row) update(row, changes)
          return structuredClone(row ?? null)
        },
        async updateMany(filter: Row, changes: Row, options?: Row) {
          checkTransaction(options)
          rows(options).filter(row => matches(row, filter)).forEach(row => update(row, changes))
        },
        async deleteOne(filter: Row, options?: Row) {
          checkTransaction(options)
          const target = rows(options)
          const index = target.findIndex(row => matches(row, filter))
          if (index >= 0) target.splice(index, 1)
          return { deletedCount: index >= 0 ? 1 : 0 }
        },
        async deleteMany(filter: Row, options?: Row) {
          checkTransaction(options)
          if (name === hooks.failDelete) throw new Error('Injected cleanup failure')
          const target = rows(options)
          const kept = target.filter(row => !matches(row, filter))
          const count = target.length - kept.length
          target.splice(0, target.length, ...kept)
          return { deletedCount: count }
        },
      }
    },
  }
  return { db, client: { async connect() {}, startSession: () => session } } as unknown as Database
}

function fixture(): Tables {
  return {
    sites: [{ _id: 'site' }],
    jobs: [{ _id: 'job', site_id: 'site', status: 'ready', completed_at: old, updated_at: old }],
    ai_attempts: [{ _id: 'ai', job_id: 'job', cost_usd: '0.01' }],
    webhook_deliveries: [{ _id: 'delivery', job_id: 'job', status: 'delivered', updated_at: old }],
    webhook_attempts: [{ _id: 'attempt', delivery_id: 'delivery' }],
    quota_reservations: [
      { _id: 'used', job_id: 'job', status: 'used' },
      { _id: 'released', job_id: 'job', status: 'released' },
      { _id: 'reserved', job_id: 'job', status: 'reserved' },
    ],
    runtime_maintenance: [],
  }
}

function events(t: test.TestContext) {
  const received: JobEvent[] = []
  const unsubscribe = jobEvents.subscribe(event => received.push(event))
  t.after(unsubscribe)
  return received
}

test('disabled and invalid retention policies do not touch data or acquire a lease', async () => {
  const tables = fixture()
  const before = structuredClone(tables)
  for (const days of [0, -1, NaN, Infinity, 0.5, 3651]) {
    assert.deepEqual(await runRetentionOnce(database(tables), { job_retention_days: days, delivery_retention_days: days }, now), { jobs: 0, deliveries: 0 })
    assert.deepEqual(tables, before)
  }
})

test('job retention atomically removes old finished content and history while preserving used quota', async t => {
  const tables = fixture()
  tables.jobs.push({ _id: 'child', status: 'ready', source_article_id: 'job', retry_of_job_id: 'job', completed_at: recent, updated_at: recent })
  const received = events(t)
  assert.deepEqual(await runRetentionOnce(database(tables), { job_retention_days: 30, delivery_retention_days: 0 }, now), { jobs: 1, deliveries: 1 })
  assert.deepEqual(tables.jobs.map(row => row._id), ['child'])
  assert.equal(tables.jobs[0].source_article_id, null)
  assert.equal(tables.jobs[0].retry_of_job_id, null)
  for (const name of ['ai_attempts', 'webhook_deliveries', 'webhook_attempts']) assert.deepEqual(tables[name], [], name)
  assert.deepEqual(tables.quota_reservations, [{ _id: 'used', job_id: 'job', status: 'used' }])
  assert.equal(tables.sites[0].relation_version, 1)
  assert.deepEqual(received, [{ type: 'job.deleted', job_id: 'job', deleted: true }])
  assert.equal(tables.runtime_maintenance[0].lease_token, null)
})

test('retention skips scheduled/queued/writing jobs and terminal jobs awaiting delivery or an active rewrite', async t => {
  const tables = fixture()
  const received = events(t)
  tables.jobs = []
  tables.webhook_deliveries = []
  for (const status of ['scheduled', 'queued', 'writing']) tables.jobs.push({ _id: status, site_id: 'site', status, updated_at: old, created_at: old })
  for (const status of ['pending', 'sending']) {
    tables.jobs.push({ _id: status, site_id: 'site', status: 'ready', completed_at: old })
    tables.webhook_deliveries.push({ _id: status, job_id: status, status, updated_at: old })
  }
  for (const status of ['scheduled', 'queued', 'writing']) {
    tables.jobs.push({ _id: 'source-' + status, site_id: 'site', status: 'ready', completed_at: old })
    tables.jobs.push({ _id: 'rewrite-' + status, site_id: 'site', status, source_article_id: 'source-' + status, updated_at: old })
  }
  const ids = tables.jobs.map(row => row._id)
  assert.deepEqual(await runRetentionOnce(database(tables), { job_retention_days: 30, delivery_retention_days: 30 }, now), { jobs: 0, deliveries: 0 })
  assert.deepEqual(tables.jobs.map(row => row._id), ids)
  assert.deepEqual(received, [])
})

test('delivery retention cleans only finished old delivery history and keeps articles', async t => {
  const tables = fixture()
  const received = events(t)
  tables.webhook_deliveries.push(
    { _id: 'failed', job_id: 'job', status: 'failed', updated_at: old },
    { _id: 'pending', job_id: 'job', status: 'pending', updated_at: old },
    { _id: 'sending', job_id: 'job', status: 'sending', updated_at: old },
    { _id: 'recent', job_id: 'job', status: 'delivered', updated_at: recent, delivered_at: old },
    { _id: 'fallback', job_id: 'job', status: 'delivered', delivered_at: old },
  )
  tables.webhook_attempts.push({ _id: 'failed-attempt', delivery_id: 'failed' }, { _id: 'pending-attempt', delivery_id: 'pending' })
  assert.deepEqual(await runRetentionOnce(database(tables), { job_retention_days: 0, delivery_retention_days: 30 }, now), { jobs: 0, deliveries: 3 })
  assert.deepEqual(tables.webhook_deliveries.map(row => row._id), ['pending', 'sending', 'recent'])
  assert.deepEqual(tables.webhook_attempts, [{ _id: 'pending-attempt', delivery_id: 'pending' }])
  assert.equal(tables.jobs.length, 1)
  assert.equal(tables.ai_attempts.length, 1)
  assert.equal(tables.quota_reservations.length, 3)
  assert.equal(received.length, 3)
  assert.ok(received.every(event => event.type === 'job.updated' && event.job_id === 'job'))
})

test('missing completion timestamp falls back to updated_at without using created_at', async () => {
  const tables = fixture()
  tables.webhook_deliveries = []
  tables.jobs = [
    { _id: 'fallback', site_id: 'site', status: 'failed', completed_at: null, updated_at: old },
    { _id: 'recent-completion', site_id: 'site', status: 'failed', completed_at: recent, updated_at: old, created_at: old },
    { _id: 'no-finished-date', site_id: 'site', status: 'canceled', created_at: old },
  ]
  assert.deepEqual(await runRetentionOnce(database(tables), { job_retention_days: 30, delivery_retention_days: 0 }, now), { jobs: 1, deliveries: 0 })
  assert.deepEqual(tables.jobs.map(row => row._id), ['recent-completion', 'no-finished-date'])
})

test('a failed cascade rolls back content, quota and references and publishes no event', async t => {
  const tables = fixture()
  const before = structuredClone(tables)
  const received = events(t)
  await assert.rejects(runRetentionOnce(database(tables, { failDelete: 'quota_reservations' }), { job_retention_days: 30, delivery_retention_days: 0 }, now), /Injected cleanup failure/)
  for (const name of Object.keys(before).filter(name => name !== 'runtime_maintenance')) assert.deepEqual(tables[name], before[name], name)
  assert.deepEqual(received, [])
  assert.equal(tables.runtime_maintenance[0].lease_token, null)
})

test('concurrent maintenance lease ownership prevents cleanup and is not released by a nonowner', async () => {
  const tables = fixture()
  tables.runtime_maintenance = [{ _id: 'retention-lock', lease_token: 'other', lease_expires_at: new Date(now.getTime() + 60_000) }]
  assert.deepEqual(await runRetentionOnce(database(tables), { job_retention_days: 30, delivery_retention_days: 30 }, now), { jobs: 0, deliveries: 0 })
  assert.equal(tables.runtime_maintenance[0].lease_token, 'other')
  assert.equal(tables.jobs.length, 1)
})

test('lost housekeeping lease stops further deletion', async t => {
  const tables = fixture()
  const received = events(t)
  assert.deepEqual(await runRetentionOnce(database(tables, { loseLease: true }), { job_retention_days: 30, delivery_retention_days: 30 }, now), { jobs: 0, deliveries: 0 })
  assert.equal(tables.jobs.length, 1)
  assert.equal(tables.webhook_deliveries.length, 1)
  assert.deepEqual(received, [])
})

test('candidate status is checked again transactionally before deleting', async () => {
  const tables = fixture()
  const db = database(tables, { beforeTransaction(tables) { tables.webhook_deliveries[0].status = 'pending' } })
  assert.deepEqual(await runRetentionOnce(db, { job_retention_days: 0, delivery_retention_days: 30 }, now), { jobs: 0, deliveries: 0 })
  assert.equal(tables.webhook_deliveries[0].status, 'pending')
  assert.equal(tables.webhook_attempts.length, 1)
})

test('each cleanup invocation limits deleted jobs and standalone deliveries', async () => {
  const tables = fixture()
  tables.jobs = Array.from({ length: 60 }, (_, index) => ({ _id: 'job-' + index, site_id: 'site', status: 'canceled', updated_at: old }))
  tables.webhook_deliveries = Array.from({ length: 110 }, (_, index) => ({ _id: 'delivery-' + index, job_id: 'missing', status: 'failed', updated_at: old }))
  assert.deepEqual(await runRetentionOnce(database(tables), { job_retention_days: 30, delivery_retention_days: 30 }, now), { jobs: 50, deliveries: 100 })
  assert.equal(tables.jobs.length, 10)
  assert.equal(tables.webhook_deliveries.length, 10)
})

test('blocked oldest articles rotate out of the next bounded cleanup batch', async () => {
  const tables = fixture()
  tables.jobs = Array.from({ length: 55 }, (_, index) => ({ _id: 'job-' + index.toString().padStart(2, '0'), site_id: 'site', status: 'ready', completed_at: old }))
  tables.webhook_deliveries = Array.from({ length: 50 }, (_, index) => ({ _id: 'delivery-' + index, job_id: tables.jobs[index]._id, status: 'pending' }))
  const db = database(tables)
  const settings = { job_retention_days: 30, delivery_retention_days: 0 }
  assert.deepEqual(await runRetentionOnce(db, settings, now), { jobs: 0, deliveries: 0 })
  assert.equal(tables.jobs.filter(row => row.retention_checked_at).length, 50)
  assert.deepEqual(await runRetentionOnce(db, settings, new Date(now.getTime() + 60_000)), { jobs: 5, deliveries: 0 })
  assert.equal(tables.jobs.length, 50)
})

test('saved retention policy is locked inside each deletion transaction', async () => {
  const tables = fixture()
  tables.runtime_settings = [{ _id: 'crm', revision: 4, values: { job_retention_days: 30, delivery_retention_days: 0 } }]
  assert.deepEqual(await runRetentionOnce(database(tables), { job_retention_days: 30, delivery_retention_days: 0 }, now), { jobs: 1, deliveries: 1 })
  assert.equal(tables.runtime_settings[0].cleanup_version, 1)
  assert.equal(tables.runtime_settings[0].revision, 4)
})

test('disabling or lengthening persisted retention cancels a stale batch without deleting data', async t => {
  const received = events(t)
  for (const days of [0, 90]) {
    const tables = fixture()
    tables.runtime_settings = [{ _id: 'crm', revision: 5, values: { job_retention_days: days, delivery_retention_days: 30 } }]
    assert.deepEqual(await runRetentionOnce(database(tables), { job_retention_days: 30, delivery_retention_days: 30 }, now), { jobs: 0, deliveries: 0 })
    assert.equal(tables.jobs.length, 1)
    assert.equal(tables.webhook_deliveries.length, 1)
    assert.equal(tables.runtime_settings[0].cleanup_version, undefined)
  }
  assert.deepEqual(received, [])
})

test('a policy changed midbatch stops the next transaction and delivery cleanup', async t => {
  const tables = fixture()
  const received = events(t)
  tables.jobs.push({ _id: 'job-2', site_id: 'site', status: 'ready', completed_at: old, updated_at: old })
  tables.runtime_settings = [{ _id: 'crm', revision: 1, values: { job_retention_days: 30, delivery_retention_days: 30 } }]
  tables.webhook_deliveries.push({ _id: 'standalone', job_id: 'other', status: 'failed', updated_at: old })
  let transactions = 0
  const db = database(tables, { beforeTransaction(rows) {
    transactions += 1
    if (transactions === 2) {
      rows.runtime_settings[0].values.job_retention_days = 0
      rows.runtime_settings[0].revision += 1
    }
  } })
  assert.deepEqual(await runRetentionOnce(db, { job_retention_days: 30, delivery_retention_days: 30 }, now), { jobs: 1, deliveries: 1 })
  assert.deepEqual(tables.jobs.map(row => row._id), ['job-2'])
  assert.deepEqual(tables.webhook_deliveries.map(row => row._id), ['standalone'])
  assert.equal(transactions, 2)
  assert.equal(received.length, 1)
})

test('delivery-only cleanup also stops if its saved policy changes', async () => {
  const tables = fixture()
  tables.runtime_settings = [{ _id: 'crm', revision: 2, values: { job_retention_days: 0, delivery_retention_days: 0 } }]
  assert.deepEqual(await runRetentionOnce(database(tables), { job_retention_days: 0, delivery_retention_days: 30 }, now), { jobs: 0, deliveries: 0 })
  assert.equal(tables.webhook_deliveries.length, 1)
  assert.equal(tables.webhook_attempts.length, 1)
})
