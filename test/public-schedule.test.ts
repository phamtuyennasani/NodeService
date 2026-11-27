import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerPublic } from '../src/api/public.js'
import { installErrorHandler } from '../src/api/errors.js'
import { digest } from '../src/security.js'

type Row = Record<string, any>
type Tables = Record<string, Row[]>

// Assert the actual Mongo session is forwarded, rather than rolling back every
// write indiscriminately and hiding operations performed outside a transaction.
function database(tables: Tables, failReservation: boolean): Database {
  let active = false
  const session = {
    async withTransaction<T>(callback: () => Promise<T>) {
      const before = structuredClone(tables)
      active = true
      try { return await callback() }
      catch (error) {
        Object.keys(tables).forEach(key => delete tables[key])
        Object.assign(tables, before)
        throw error
      } finally { active = false }
    },
    async endSession() {},
  }
  const check = (options?: Row) => {
    if (active) assert.equal(options?.session, session, 'Every transaction operation must receive the session')
  }
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((branch: Row) => matches(row, branch))
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$in' in value) return value.$in.includes(row[key])
      if ('$ne' in value) return row[key] !== value.$ne
      if ('$exists' in value) return (row[key] !== undefined) === value.$exists
      if ('$lt' in value) return row[key] < value.$lt
    }
    return row[key] === value
  })
  const db = {
    collection(name: string) {
      const rows = () => tables[name] ??= []
      return {
        async findOne(filter: Row, options?: Row) {
          check(options)
          return structuredClone(rows().find(row => matches(row, filter)) ?? null)
        },
        async countDocuments(filter: Row, options?: Row) {
          check(options)
          return rows().filter(row => matches(row, filter)).slice(0, options?.limit).length
        },
        find(filter: Row, options?: Row) {
          check(options)
          return { async toArray() { return structuredClone(rows().filter(row => matches(row, filter))) } }
        },
        async insertOne(row: Row, options?: Row) {
          check(options)
          rows().push(structuredClone(row))
          return { insertedId: row._id }
        },
        async updateOne(filter: Row, update: Row, options?: Row) {
          check(options)
          if (failReservation && active && name === 'quota_reservations') throw new Error('Reservation storage unavailable')
          let row = rows().find(row => matches(row, filter))
          if (!row && options?.upsert) { row = { ...filter }; rows().push(row) }
          if (row) {
            Object.assign(row, structuredClone(update.$set ?? {}))
            for (const [key, amount] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(amount)
          }
          return { matchedCount: row ? 1 : 0 }
        },
      }
    },
  }
  return { db, client: { async connect() {}, startSession: () => session } } as unknown as Database
}

async function fixture(t: test.TestContext, failReservation = false) {
  const customerId = randomUUID()
  const siteId = randomUUID()
  const jobId = randomUUID()
  const token = 'test_site_token_0123456789'
  const scheduledAt = new Date('2030-01-01T02:00:00Z')
  const tables: Tables = {
    customers: [{ _id: customerId, key_mode: 'service', allowed_models: ['test-model'], daily_limit: 2, monthly_limit: 10, starts_at: null, ends_at: null, max_length: 2500 }],
    sites: [{ _id: siteId, customer_id: customerId, token_hash: digest(token), last_used_at: new Date(), webhook_url: 'https://example.com/webhook', webhook_secret: 'configured' }],
    jobs: [{ _id: jobId, site_id: siteId, customer_id: customerId, mode: 'scheduled', model: 'test-model', provider: 'openai', status: 'scheduled', version: 1, scheduled_at: scheduledAt, available_at: scheduledAt, keyword: 'cà phê', tone: 'thân thiện', style: 'hướng dẫn', length: 800, key_mode: 'service', use_research: false }],
    ai_models: [{ _id: 'test-model', provider: 'openai', enabled: true }],
    ai_providers: [{ _id: 'openai', enabled: true }],
    quota_reservations: [{ job_id: jobId, customer_id: customerId, quota_day: '2030-01-01', quota_month: '2030-01', status: 'reserved' }],
  }
  const app = Fastify()
  installErrorHandler(app)
  registerPublic(app, database(tables, failReservation), { encryptionKey: Buffer.alloc(32, 7), serviceKeys: { openai: 'fixture-key' } } as unknown as Config)
  await app.ready()
  t.after(() => app.close())
  return { app, tables, jobId, headers: { authorization: `Bearer ${token}`, 'if-match': '1' } }
}

test('editing an unrelated schedule field preserves disabled research and rejects an empty patch', async t => {
  const { app, tables, jobId, headers } = await fixture(t)
  const empty = await app.inject({ method: 'PATCH', url: `/v1/schedules/${jobId}`, headers, payload: {} })
  assert.equal(empty.statusCode, 400, empty.body)
  const edited = await app.inject({ method: 'PATCH', url: `/v1/schedules/${jobId}`, headers, payload: { tone: 'chuyên nghiệp' } })
  assert.equal(edited.statusCode, 200, edited.body)
  assert.equal(edited.json().use_research, false)
  assert.equal(tables.jobs[0].use_research, false)
  assert.equal(tables.jobs[0].version, 2)
  const enabled = await app.inject({ method: 'PATCH', url: `/v1/schedules/${jobId}`, headers: { ...headers, 'if-match': '2' }, payload: { use_research: true } })
  assert.equal(enabled.statusCode, 200, enabled.body)
  assert.equal(tables.jobs[0].use_research, true)
})

test('a website without a webhook can create previews and needs a webhook before scheduling', async t => {
  const { app, tables, headers } = await fixture(t)
  tables.sites[0].webhook_url = null
  const payload = { model: 'test-model', keyword: 'cà phê', tone: 'thân thiện', style: 'hướng dẫn', length: 800, use_research: false }
  const preview = await app.inject({ method: 'POST', url: '/v1/article-jobs', headers: { ...headers, 'idempotency-key': 'preview-without-webhook' }, payload })
  assert.equal(preview.statusCode, 202, preview.body)
  const jobs = structuredClone(tables.jobs)
  const quota = structuredClone(tables.quota_reservations)
  const schedule = await app.inject({ method: 'POST', url: '/v1/article-jobs', headers: { ...headers, 'idempotency-key': 'schedule-without-webhook' },
    payload: { ...payload, scheduled_at: new Date(Date.now() + 3_600_000).toISOString() } })
  assert.equal(schedule.statusCode, 422, schedule.body)
  assert.equal(schedule.json().error.code, 'webhook_not_configured')
  assert.deepEqual(tables.jobs, jobs)
  assert.deepEqual(tables.quota_reservations, quota)
})

test('schedule cancellation updates the job and its reservation in one session', async t => {
  const { app, tables, jobId, headers } = await fixture(t)
  const canceled = await app.inject({ method: 'DELETE', url: `/v1/schedules/${jobId}`, headers })
  assert.equal(canceled.statusCode, 204, canceled.body)
  assert.equal(tables.jobs[0].status, 'canceled')
  assert.equal(tables.quota_reservations[0].status, 'released')
})

test('job creation rolls back when quota reservation fails and preserves explicit research opt-out', async t => {
  for (const failReservation of [true, false]) {
    await t.test(failReservation ? 'failed reservation leaves no job' : 'research opt-out is stored', async t => {
      const { app, tables, headers } = await fixture(t, failReservation)
      const before = structuredClone(tables)
      const response = await app.inject({ method: 'POST', url: '/v1/article-jobs', headers: { ...headers, 'idempotency-key': 'new-article-test' }, payload: { model: 'test-model', keyword: 'cà phê', tone: 'thân thiện', style: 'hướng dẫn', length: 800, use_research: false } })
      assert.equal(response.statusCode, failReservation ? 500 : 202, response.body)
      if (failReservation) assert.deepEqual(tables, before)
      else {
        const created = tables.jobs.find(row => row._id === response.json().job_id)!
        assert.equal(created.use_research, false)
        assert.equal(tables.quota_reservations.filter(row => row.job_id === created._id).length, 1)
        const replay = await app.inject({ method: 'POST', url: '/v1/article-jobs', headers: { ...headers, 'idempotency-key': 'new-article-test' }, payload: { model: 'test-model', keyword: 'cà phê', tone: 'thân thiện', style: 'hướng dẫn', length: 800, use_research: false } })
        assert.equal(replay.statusCode, 202, replay.body)
        assert.equal(replay.json().job_id, created._id)
        assert.equal(tables.quota_reservations.filter(row => row.job_id === created._id).length, 1)
      }
    })
  }
})
