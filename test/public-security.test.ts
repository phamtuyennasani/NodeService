import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import { registerPublic } from '../src/api/public.js'
import { installErrorHandler } from '../src/api/errors.js'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { digest } from '../src/security.js'

type Row = Record<string, any>
type Tables = Record<string, Row[]>
type Session = { working?: Tables }
type Options = { session?: Session, limit?: number, maxTimeMS?: number, projection?: Row }

async function fixture(t: test.TestContext, limit = 2, keyMode: 'own' | 'service' = 'own') {
  const token = 'public-security-fixture-site-token'
  const customerId = randomUUID()
  const siteId = randomUUID()
  const secondSiteId = randomUUID()
  const calls: { table: string, action: string, filter: Row, options?: Options }[] = []
  const tables: Tables = {
    sites: [siteId, secondSiteId].map(_id => ({ _id, customer_id: customerId, token_hash: digest(token), webhook_url: 'https://example.com/webhook', webhook_secret: 'encrypted-fixture-secret' })),
    customers: [{ _id: customerId, key_mode: keyMode, daily_limit: 100, monthly_limit: 100, allowed_models: ['test-model'], max_length: 2500, starts_at: null, ends_at: null }],
    ai_models: [{ _id: 'test-model', provider: 'openai', enabled: true }],
    ai_providers: [{ _id: 'openai', enabled: true }],
    jobs: [], quota_reservations: [], webhook_deliveries: [],
  }
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([field, expected]) => {
    if (field === '$or') return expected.some((branch: Row) => matches(row, branch))
    if (field === '$and') return expected.every((branch: Row) => matches(row, branch))
    const actual = row[field]
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) return Object.entries(expected).every(([op, value]: [string, any]) => {
      if (op === '$in') return value.includes(actual)
      if (op === '$ne') return actual !== value
      if (op === '$exists') return (actual !== undefined) === value
      if (op === '$lt') return actual < value
      if (op === '$lte') return actual <= value
      if (op === '$gt') return actual > value
      if (op === '$gte') return actual >= value
      throw new Error('Unexpected fixture operator ' + op)
    })
    return actual instanceof Date && expected instanceof Date ? actual.getTime() === expected.getTime() : actual === expected
  })
  let beforeTransaction: (() => void) | undefined
  let serial = Promise.resolve()
  const db = {
    db: { collection(name: string) {
      const rows = (options?: Options) => (options?.session?.working ?? tables)[name] ??= []
      const record = (action: string, filter: Row, options?: Options) => calls.push({ table: name, action, filter: structuredClone(filter), options })
      return {
        async findOne(filter: Row, options?: Options) { record('findOne', filter, options); return structuredClone(rows(options).find(row => matches(row, filter)) ?? null) },
        async countDocuments(filter: Row, options?: Options) {
          record('countDocuments', filter, options)
          assert.ok(options?.session?.working, 'backlog check shares the transaction and customer lock')
          assert.equal(options.maxTimeMS, 5000)
          assert.equal(options.limit, limit)
          return rows(options).filter(row => matches(row, filter)).slice(0, options.limit).length
        },
        find(filter: Row, options?: Options) {
          record('find', filter, options)
          let take = Infinity
          const cursor = { sort() { return cursor }, limit(value: number) { take = value; return cursor }, async toArray() { return structuredClone(rows(options).filter(row => matches(row, filter)).slice(0, take)) } }
          return cursor
        },
        async updateOne(filter: Row, update: Row, options?: Options & { upsert?: boolean }) {
          record('updateOne', filter, options)
          let row = rows(options).find(row => matches(row, filter))
          if (!row && options?.upsert) { row = structuredClone(filter); rows(options).push(row!) }
          if (!row) return { matchedCount: 0 }
          Object.assign(row, structuredClone(update.$set ?? {}))
          for (const [field, amount] of Object.entries<number>(update.$inc ?? {})) row[field] = (row[field] ?? 0) + amount
          for (const field of Object.keys(update.$unset ?? {})) delete row[field]
          return { matchedCount: 1 }
        },
        async insertOne(row: Row, options?: Options) { record('insertOne', {}, options); rows(options).push(structuredClone(row)); return { insertedId: row._id } },
      }
    } },
    client: {
      async connect() {},
      startSession() {
        const session: Session & { withTransaction: <T>(run: () => Promise<T>) => Promise<T>, endSession: () => Promise<void> } = {
          async withTransaction<T>(run: () => Promise<T>) {
            const prior = serial
            let release!: () => void
            serial = new Promise(resolve => { release = resolve })
            await prior
            beforeTransaction?.()
            beforeTransaction = undefined
            session.working = structuredClone(tables)
            try { const result = await run(); Object.assign(tables, session.working); return result }
            finally { delete session.working; release() }
          },
          async endSession() {},
        }
        return session
      },
    },
  } as unknown as Database
  const app = Fastify()
  t.after(() => app.close())
  installErrorHandler(app)
  registerPublic(app, db, { maxPendingJobsPerCustomer: limit, encryptionKey: Buffer.alloc(32, 17), serviceKeys: { openai: 'fixture-service-key' } } as unknown as Config)
  await app.ready()
  const headers = { authorization: 'Bearer ' + token }
  const writing = { model: 'test-model', keyword: 'Thiết kế website', tone: 'Chuyên nghiệp', style: 'Hướng dẫn', length: 1500, ...(keyMode === 'own' ? { provider: 'openai', api_key: 'fixture-own-key' } : {}) }
  const create = (id: string = randomUUID(), payload: Row = writing) => app.inject({ method: 'POST', url: '/v1/article-jobs', headers: { ...headers, 'idempotency-key': id }, payload })
  return { app, tables, calls, headers, create, writing, customerId, siteId, secondSiteId, beforeTransaction(fn: () => void) { beforeTransaction = fn } }
}

test('pending job capacity protects both quota and own-key customers while preserving idempotent replay', async t => {
  for (const mode of ['own', 'service'] as const) await t.test(mode, async t => {
    const f = await fixture(t, 2, mode)
    f.tables.jobs.push({ _id: randomUUID(), site_id: f.secondSiteId, customer_id: f.customerId, status: 'scheduled' })
    const accepted = await f.create('same-request')
    assert.equal(accepted.statusCode, 202, accepted.body)
    const countBeforeReplay = f.calls.filter(call => call.action === 'countDocuments').length
    const replay = await f.create('same-request')
    assert.equal(replay.statusCode, 202, replay.body)
    assert.equal(replay.json().job_id, accepted.json().job_id)
    assert.equal(f.calls.filter(call => call.action === 'countDocuments').length, countBeforeReplay)
    const before = structuredClone(f.tables)
    const full = await f.create()
    assert.equal(full.statusCode, 429, full.body)
    assert.equal(full.json().error.code, 'job_queue_full')
    assert.deepEqual(full.json().error.details, { limit: 2, retry_after_seconds: 60 })
    assert.deepEqual(f.tables, before, 'rejection leaves no job, quota reservation or lock version change')
    const conflict = await f.create('same-request', { ...f.writing, keyword: 'Changed request' })
    assert.equal(conflict.statusCode, 409, conflict.body)
    assert.equal(conflict.json().error.code, 'idempotency_conflict')
    f.tables.jobs[0].status = 'ready'
    assert.equal((await f.create()).statusCode, 202, 'completed jobs free queue capacity')
  })
})

test('concurrent unique job requests cannot overfill customer capacity', async t => {
  const f = await fixture(t, 1)
  const responses = await Promise.all([f.create(), f.create(), f.create()])
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [202, 429, 429])
  assert.equal(f.tables.jobs.length, 1)
  assert.equal(f.tables.jobs[0].status, 'queued')
})

test('schedule writes reject token rotation and ownership changes between authentication and transaction', async t => {
  for (const method of ['PATCH', 'DELETE'] as const) for (const change of ['token', 'customer'] as const) await t.test(`${method} after ${change} change`, async t => {
    const f = await fixture(t)
    const jobId = randomUUID()
    f.tables.jobs.push({ _id: jobId, site_id: f.siteId, customer_id: f.customerId, mode: 'scheduled', status: 'scheduled', version: 1, scheduled_at: new Date('2099-01-01T00:00:00Z') })
    const jobsBefore = structuredClone(f.tables.jobs)
    f.beforeTransaction(() => {
      if (change === 'token') f.tables.sites[0].token_hash = digest('replacement-fixture-token')
      else f.tables.sites[0].customer_id = randomUUID()
    })
    const response = await f.app.inject({ method, url: `/v1/schedules/${jobId}`, headers: { ...f.headers, 'if-match': '1' }, ...(method === 'PATCH' ? { payload: { tone: 'Thân thiện' } } : {}) })
    assert.equal(response.statusCode, 401, response.body)
    assert.equal(response.json().error.code, 'invalid_site_token')
    assert.deepEqual(f.tables.jobs, jobsBefore)
    assert.equal(f.calls.some(call => call.table === 'quota_reservations'), false)
  })
})

test('public job reads, listings and rewrites require both current site and customer scope', async t => {
  const f = await fixture(t)
  const foreignJob = { _id: randomUUID(), site_id: f.siteId, customer_id: randomUUID(), status: 'ready', mode: 'scheduled', completed_at: new Date(), scheduled_at: new Date('2099-01-01T00:00:00Z'), result: [{ Title: 'Foreign article', Content: '<p>Private content</p>' }] }
  f.tables.jobs.push(foreignJob)
  for (const suffix of ['', '/result']) {
    const response = await f.app.inject({ url: `/v1/article-jobs/${foreignJob._id}${suffix}`, headers: f.headers })
    assert.equal(response.statusCode, 404, response.body)
    assert.doesNotMatch(response.body, /Foreign article|Private content/)
  }
  for (const url of ['/v1/articles', '/v1/schedules?status=all']) {
    const response = await f.app.inject({ url, headers: f.headers })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().data, [])
  }
  const rewrite = await f.app.inject({ method: 'POST', url: `/v1/articles/${foreignJob._id}/rewrites`, headers: { ...f.headers, 'idempotency-key': 'foreign-rewrite' }, payload: {} })
  assert.equal(rewrite.statusCode, 404, rewrite.body)
  assert.equal(f.tables.jobs.length, 1)
  const listings = f.calls.filter(call => call.table === 'jobs' && call.action === 'find')
  assert.equal(listings.length, 2)
  assert.ok(listings.every(call => call.filter.site_id === f.siteId && call.filter.customer_id === f.customerId && call.options?.maxTimeMS === 5000))
})

test('malformed or oversized bearer tokens are rejected before database lookup', async t => {
  const f = await fixture(t)
  for (const value of ['Bearer ' + 'a'.repeat(257), 'Bearer site.token.with.dots', 'Basic public-security-fixture-site-token']) {
    const before = f.calls.length
    const response = await f.app.inject({ url: '/v1/models', headers: { authorization: value } })
    assert.equal(response.statusCode, 401, response.body)
    assert.equal(f.calls.length, before)
  }
})
