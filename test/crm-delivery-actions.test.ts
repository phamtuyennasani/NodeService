import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerReports } from '../src/api/crm-reports.js'
import { installErrorHandler } from '../src/api/errors.js'
import { jobEvents, type JobEvent } from '../src/job-events.js'

type Row = Record<string, any>
type Tables = Record<string, Row[]>
interface Hooks {
  failDelete?: string
  beforeDeliveryWrite?: (tables: Tables) => void
  beforeDeliveryDelete?: (tables: Tables) => void
  beforeCommit?: () => void
}

function database(tables: Tables, hooks: Hooks = {}): Database {
  let active: Tables | undefined
  const matches = (row: Row, filter: Row) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(row[key])
    if (value && typeof value === 'object' && '$ne' in value) return row[key] !== value.$ne
    return row[key] === value
  })
  const session = {
    async withTransaction<T>(callback: () => Promise<T>) {
      active = structuredClone(tables)
      try {
        const result = await callback()
        hooks.beforeCommit?.()
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
      const checkTransaction = (options?: Row) => assert.ok(active && options?.session === session, 'delivery action must forward its transaction session')
      return {
        async findOne(filter: Row, options?: Row) { return structuredClone(rows(options).find(row => matches(row, filter)) ?? null) },
        find(filter: Row, options?: Row) {
          const cursor = {
            sort() { return cursor },
            async toArray() { return structuredClone(rows(options).filter(row => matches(row, filter))) },
          }
          return cursor
        },
        async updateOne(filter: Row, changes: Row, options?: Row) {
          checkTransaction(options)
          if (name === 'webhook_deliveries') hooks.beforeDeliveryWrite?.(active!)
          const row = rows(options).find(row => matches(row, filter))
          if (row) {
            Object.assign(row, structuredClone(changes.$set ?? {}))
            for (const [key, amount] of Object.entries(changes.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(amount)
          }
          return { matchedCount: row ? 1 : 0 }
        },
        async deleteOne(filter: Row, options?: Row) {
          checkTransaction(options)
          if (name === 'webhook_deliveries') hooks.beforeDeliveryDelete?.(active!)
          const target = rows(options)
          const index = target.findIndex(row => matches(row, filter))
          if (index >= 0) target.splice(index, 1)
          return { deletedCount: index >= 0 ? 1 : 0 }
        },
        async deleteMany(filter: Row, options?: Row) {
          checkTransaction(options)
          if (name === hooks.failDelete) throw new Error('Injected delivery history deletion failure')
          const target = rows(options)
          const kept = target.filter(row => !matches(row, filter))
          target.splice(0, target.length, ...kept)
          return { deletedCount: target.length - kept.length }
        },
      }
    },
  }
  return { db, client: { async connect() {}, startSession: () => session } } as unknown as Database
}

async function fixture(t: test.TestContext, status = 'failed', hooks: Hooks = {}) {
  const siteId = randomUUID()
  const jobId = randomUUID()
  const deliveryId = randomUUID()
  const tables: Tables = {
    sites: [{ _id: siteId, relation_version: 7 }],
    jobs: [{ _id: jobId, site_id: siteId, status: 'ready', result: [{ Title: 'Bài đã viết' }] }],
    ai_attempts: [{ _id: randomUUID(), job_id: jobId, cost_usd: '1.23' }],
    quota_reservations: [{ _id: randomUUID(), job_id: jobId, status: 'used' }],
    webhook_deliveries: [{
      _id: deliveryId, job_id: jobId, site_id: siteId, status, event: 'article.ready', attempt_count: 4,
      next_attempt_at: new Date(0), error: 'Previous error', http_status: 503,
      delivered_at: new Date('2026-11-21T00:00:00Z'), lease_token: 'old-lease', lease_expires_at: new Date(0),
      id_post: 'post:123', acknowledged_at: new Date('2026-11-21T00:00:00Z'),
    }],
    webhook_attempts: [{ _id: randomUUID(), delivery_id: deliveryId, http_status: 503 }, { _id: randomUUID(), delivery_id: randomUUID(), http_status: 200 }],
  }
  const received: JobEvent[] = []
  const unsubscribe = jobEvents.subscribe(event => received.push(event))
  t.after(unsubscribe)
  const app = Fastify()
  installErrorHandler(app)
  registerReports(app, database(tables, hooks), { encryptionKey: Buffer.alloc(32, 1) } as Config)
  await app.ready()
  t.after(() => app.close())
  return { app, tables, siteId, jobId, deliveryId, received }
}

for (const status of ['failed', 'delivered']) {
  test(`CRM can send a ${status} delivery again while retaining its history and article`, async t => {
    const { app, tables, deliveryId, jobId, received } = await fixture(t, status)
    const before = structuredClone(tables)
    const started = Date.now()
    const response = await app.inject({ method: 'POST', url: `/deliveries/${deliveryId}/retry` })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json(), { id: deliveryId, status: 'pending' })
    const delivery = tables.webhook_deliveries[0]
    assert.equal(delivery.status, 'pending')
    assert.equal(delivery.attempt_count, 0)
    assert.ok(delivery.next_attempt_at.getTime() >= started)
    assert.ok(delivery.updated_at.getTime() >= started)
    for (const key of ['error', 'http_status', 'delivered_at', 'id_post', 'acknowledged_at', 'lease_token', 'lease_expires_at']) assert.equal(delivery[key], null, key)
    for (const name of ['jobs', 'ai_attempts', 'quota_reservations', 'webhook_attempts']) assert.deepEqual(tables[name], before[name], name)
    assert.equal(tables.sites[0].relation_version, 8)
    assert.deepEqual(received, [{ type: 'job.updated', job_id: jobId }])
  })
}

test('CRM delivery details return acknowledged Laravel post IDs and preserve per-attempt receipts', async t => {
  const { app, tables, deliveryId } = await fixture(t, 'delivered')
  const acknowledgedAt = new Date('2026-11-23T01:00:00Z')
  Object.assign(tables.webhook_attempts[0], { http_status: 200, id_post: 123, acknowledged_at: acknowledgedAt, response_body: 'should not be exposed' })
  const response = await app.inject({ url: `/deliveries/${deliveryId}` })
  assert.equal(response.statusCode, 200, response.body)
  const details = response.json()
  assert.equal(details.id_post, 'post:123')
  assert.equal(details.acknowledged_at, '2026-11-21T00:00:00.000Z')
  assert.equal(details.history[0].id_post, 123)
  assert.equal(details.history[0].acknowledged_at, acknowledgedAt.toISOString())
  assert.doesNotMatch(response.body, /should not be exposed|response_body/)
  delete tables.webhook_deliveries[0].id_post
  delete tables.webhook_deliveries[0].acknowledged_at
  const legacy = (await app.inject({ url: `/deliveries/${deliveryId}` })).json()
  assert.equal(legacy.id_post, null)
  assert.equal(legacy.acknowledged_at, null)
})

for (const status of ['pending', 'sending']) {
  test(`CRM blocks sending a ${status} delivery again`, async t => {
    const { app, tables, deliveryId, received } = await fixture(t, status)
    const before = structuredClone(tables)
    const response = await app.inject({ method: 'POST', url: `/deliveries/${deliveryId}/retry` })
    assert.equal(response.statusCode, 409, response.body)
    assert.deepEqual(tables, before)
    assert.deepEqual(received, [])
  })
}

for (const status of ['pending', 'delivered', 'failed']) {
  test(`CRM deletes a ${status} delivery and its attempts, preserving article, costs and quota`, async t => {
    const { app, tables, deliveryId, jobId, received } = await fixture(t, status)
    const before = structuredClone(tables)
    const response = await app.inject({ method: 'DELETE', url: `/deliveries/${deliveryId}` })
    assert.equal(response.statusCode, 204, response.body)
    assert.deepEqual(tables.webhook_deliveries, [])
    assert.deepEqual(tables.webhook_attempts, [before.webhook_attempts[1]])
    for (const name of ['jobs', 'ai_attempts', 'quota_reservations']) assert.deepEqual(tables[name], before[name], name)
    assert.equal(tables.sites[0].relation_version, 8)
    assert.deepEqual(received, [{ type: 'job.updated', job_id: jobId }])
  })
}

test('CRM cannot delete a sending delivery', async t => {
  const { app, tables, deliveryId, received } = await fixture(t, 'sending')
  const before = structuredClone(tables)
  const response = await app.inject({ method: 'DELETE', url: `/deliveries/${deliveryId}` })
  assert.equal(response.statusCode, 409, response.body)
  assert.deepEqual(tables, before)
  assert.deepEqual(received, [])
})

test('delivery actions return 400 for malformed IDs and 404 for missing deliveries', async t => {
  const { app } = await fixture(t)
  for (const [method, suffix] of [['POST', '/retry'], ['DELETE', '']] as const) {
    assert.equal((await app.inject({ method, url: '/deliveries/not-a-uuid' + suffix })).statusCode, 400)
    assert.equal((await app.inject({ method, url: '/deliveries/' + randomUUID() + suffix })).statusCode, 404)
  }
})

test('resending an orphan delivery is blocked but orphan history can be deleted', async t => {
  const { app, tables, deliveryId, received } = await fixture(t)
  tables.jobs = []
  assert.equal((await app.inject({ method: 'POST', url: `/deliveries/${deliveryId}/retry` })).statusCode, 404)
  assert.equal(tables.webhook_deliveries.length, 1)
  assert.deepEqual(received, [])
  tables.sites = []
  assert.equal((await app.inject({ method: 'DELETE', url: `/deliveries/${deliveryId}` })).statusCode, 204)
  assert.equal(tables.webhook_deliveries.length, 0)
})

test('failed history cascade rolls back the delivery lock, parent lock and every deletion', async t => {
  const { app, tables, deliveryId, received } = await fixture(t, 'delivered', { failDelete: 'webhook_attempts' })
  const before = structuredClone(tables)
  const response = await app.inject({ method: 'DELETE', url: `/deliveries/${deliveryId}` })
  assert.equal(response.statusCode, 500, response.body)
  assert.deepEqual(tables, before)
  assert.deepEqual(received, [])
})

test('resend publishes no event before a successful commit', async t => {
  const { app, tables, deliveryId, received } = await fixture(t, 'failed', { beforeCommit() { throw new Error('Commit failed') } })
  const before = structuredClone(tables)
  const response = await app.inject({ method: 'POST', url: `/deliveries/${deliveryId}/retry` })
  assert.equal(response.statusCode, 500, response.body)
  assert.deepEqual(tables, before)
  assert.deepEqual(received, [])
})

for (const [method, suffix] of [['POST', '/retry'], ['DELETE', '']] as const) {
  test(`${method} rejects a delivery whose status changed before the conditional write`, async t => {
    const { app, tables, deliveryId, received } = await fixture(t, 'failed', {
      beforeDeliveryWrite(rows) { rows.webhook_deliveries[0].status = 'sending' },
    })
    const before = structuredClone(tables)
    const response = await app.inject({ method, url: `/deliveries/${deliveryId}${suffix}` })
    assert.equal(response.statusCode, 409, response.body)
    assert.deepEqual(tables, before)
    assert.deepEqual(received, [])
  })
}

test('delivery delete rolls back removed history if the final ownership condition no longer matches', async t => {
  const { app, tables, deliveryId, received } = await fixture(t, 'pending', {
    beforeDeliveryDelete(rows) { rows.webhook_deliveries[0].status = 'sending' },
  })
  const before = structuredClone(tables)
  const response = await app.inject({ method: 'DELETE', url: `/deliveries/${deliveryId}` })
  assert.equal(response.statusCode, 409, response.body)
  assert.deepEqual(tables, before)
  assert.deepEqual(received, [])
})
