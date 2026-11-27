import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerCustomers } from '../src/api/crm-customers.js'
import { registerReports } from '../src/api/crm-reports.js'
import { installErrorHandler } from '../src/api/errors.js'
import { quotaAt } from '../src/api/quota.js'

type Row = Record<string, any>
type Tables = Record<string, Row[]>

// Only operations carrying the real session participate in the transaction.
// This catches accidental partial deletion that a global snapshot mock hides.
function database(tables: Tables, failDelete?: string): Database {
  let active: { tables: Tables } | undefined
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((part: Row) => matches(row, part))
    if (value && typeof value === 'object' && '$in' in value) return value.$in.includes(row[key])
    if (value && typeof value === 'object' && '$ne' in value) return row[key] !== value.$ne
    return row[key] === value
  })
  const session = {
    async withTransaction<T>(callback: () => Promise<T>) {
      active = { tables: structuredClone(tables) }
      try {
        const result = await callback()
        Object.keys(tables).forEach(key => delete tables[key])
        Object.assign(tables, active.tables)
        return result
      } finally { active = undefined }
    },
    async endSession() {},
  }
  const db = {
    collection(name: string) {
      const rows = (options?: Row) => ((options?.session === session && active ? active.tables : tables)[name] ??= [])
      return {
        async findOne(filter: Row, options?: Row) { return structuredClone(rows(options).find(row => matches(row, filter)) ?? null) },
        find(filter: Row, options?: Row) {
          const cursor = {
            sort() { return cursor },
            async toArray() { return structuredClone(rows(options).filter(row => matches(row, filter))) },
          }
          return cursor
        },
        async insertOne(row: Row, options?: Row) {
          if (name === 'sites' && 'token_hash' in row && rows(options).some(existing => 'token_hash' in existing && existing.token_hash === row.token_hash)) throw Object.assign(new Error('Duplicate sparse token hash'), { code: 11000 })
          rows(options).push(structuredClone(row))
          return { insertedId: row._id }
        },
        async updateOne(filter: Row, update: Row, options?: Row) {
          const row = rows(options).find(row => matches(row, filter))
          if (row) {
            Object.assign(row, structuredClone(update.$set ?? {}))
            for (const [key, amount] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(amount)
            for (const key of Object.keys(update.$unset ?? {})) delete row[key]
          }
          return { matchedCount: row ? 1 : 0 }
        },
        async updateMany(filter: Row, update: Row, options?: Row) {
          rows(options).filter(row => matches(row, filter)).forEach(row => Object.assign(row, structuredClone(update.$set ?? {})))
        },
        async deleteOne(filter: Row, options?: Row) {
          const target = rows(options)
          const index = target.findIndex(row => matches(row, filter))
          if (index >= 0) target.splice(index, 1)
          return { deletedCount: index >= 0 ? 1 : 0 }
        },
        async deleteMany(filter: Row, options?: Row) {
          if (name === failDelete) throw new Error('Injected deletion failure')
          const target = rows(options)
          const kept = target.filter(row => !matches(row, filter))
          target.splice(0, target.length, ...kept)
        },
      }
    },
  }
  return { db, client: { async connect() {}, startSession: () => session } } as unknown as Database
}

async function fixture(t: test.TestContext, failDelete?: string) {
  const customerId = randomUUID()
  const siteId = randomUUID()
  const jobId = randomUUID()
  const tables: Tables = {
    customers: [{ _id: customerId, name: 'Khách hàng', key_mode: 'own' }],
    sites: [{ _id: siteId, customer_id: customerId, name: 'Website', domain: 'example.com', webhook_url: 'https://example.com/webhook' }],
    jobs: [{ _id: jobId, customer_id: customerId, site_id: siteId, status: 'ready' }],
    ai_attempts: [{ _id: randomUUID(), job_id: jobId }],
    webhook_deliveries: [{ _id: 'delivery', job_id: jobId, status: 'pending' }],
    webhook_attempts: [{ _id: randomUUID(), delivery_id: 'delivery' }],
    quota_reservations: [{ _id: randomUUID(), job_id: jobId, customer_id: customerId }],
  }
  const app = Fastify()
  const config = { encryptionKey: Buffer.alloc(32, 23), allowLocalWebhooks: false } as Config
  installErrorHandler(app)
  const db = database(tables, failDelete)
  registerCustomers(app, db, config)
  registerReports(app, db, config)
  await app.ready()
  t.after(() => app.close())
  return { app, db, tables, customerId, siteId, jobId }
}

test('CRM job deletion rolls every related change back when a later cleanup fails', async t => {
  const { app, tables, jobId } = await fixture(t, 'ai_attempts')
  const before = structuredClone(tables)
  const response = await app.inject({ method: 'DELETE', url: `/jobs/${jobId}` })
  assert.equal(response.statusCode, 500)
  assert.deepEqual(tables, before)
})

test('CRM removes a job, website and customer in order and blocks remaining history', async t => {
  const { app, tables, customerId, siteId, jobId } = await fixture(t)
  const customerBlocked = await app.inject({ method: 'DELETE', url: `/customers/${customerId}` })
  assert.equal(customerBlocked.statusCode, 409)
  const siteBlocked = await app.inject({ method: 'DELETE', url: `/websites/${siteId}` })
  assert.equal(siteBlocked.statusCode, 409)
  assert.equal((await app.inject({ method: 'DELETE', url: `/jobs/${jobId}` })).statusCode, 204)
  assert.equal((await app.inject({ method: 'DELETE', url: `/websites/${siteId}` })).statusCode, 204)
  assert.equal((await app.inject({ method: 'DELETE', url: `/customers/${customerId}` })).statusCode, 204)
  for (const name of ['customers', 'sites', 'jobs', 'ai_attempts', 'webhook_deliveries', 'webhook_attempts', 'quota_reservations']) assert.deepEqual(tables[name], [], name)
})

test('CRM website creation and reassignment reject a missing customer', async t => {
  const { app, tables, siteId } = await fixture(t)
  const before = structuredClone(tables)
  const missingCustomer = randomUUID()
  const create = await app.inject({ method: 'POST', url: '/websites', payload: { customer_id: missingCustomer, name: 'Website mới', domain: 'example.org', webhook_url: 'https://example.org/webhook' } })
  assert.equal(create.statusCode, 404, create.body)
  tables.jobs.length = 0
  const reassign = await app.inject({ method: 'PATCH', url: `/websites/${siteId}`, payload: { customer_id: missingCustomer } })
  assert.equal(reassign.statusCode, 404, reassign.body)
  assert.deepEqual(tables.sites, before.sites)
  assert.deepEqual(tables.customers, before.customers)
})

test('CRM supports multiple websites without tokens under the sparse unique token index', async t => {
  const { app, tables, customerId, siteId } = await fixture(t)
  tables.sites[0].token_hash = null // A legacy unissued website may still contain null.
  for (const name of ['Website thứ hai', 'Website thứ ba']) {
    const response = await app.inject({ method: 'POST', url: '/websites', payload: { customer_id: customerId, name, domain: 'example.org', webhook_url: 'https://example.org/webhook' } })
    assert.equal(response.statusCode, 201, response.body)
    assert.equal('token_hash' in tables.sites.find(row => row._id === response.json().id)!, false)
  }
  const revoke = await app.inject({ method: 'DELETE', url: `/websites/${siteId}/token` })
  assert.equal(revoke.statusCode, 204, revoke.body)
  assert.equal('token_hash' in tables.sites[0], false)
})

test('CRM creates websites with an omitted, null or blank webhook URL', async t => {
  const { app, tables, customerId } = await fixture(t)
  for (const webhook_url of [undefined, null, '', '   ']) {
    const response = await app.inject({ method: 'POST', url: '/websites', payload: {
      customer_id: customerId, name: 'Website xem trước', domain: 'example.org',
      ...(webhook_url === undefined ? {} : { webhook_url }),
    } })
    assert.equal(response.statusCode, 201, response.body)
    assert.equal(tables.sites.find(row => row._id === response.json().id)!.webhook_url, null)
  }
})

test('CRM preserves an omitted webhook URL on edit and clears an explicitly blank value', async t => {
  const { app, tables, siteId } = await fixture(t)
  const url = `/websites/${siteId}`
  const renamed = await app.inject({ method: 'PATCH', url, payload: { name: 'Tên mới' } })
  assert.equal(renamed.statusCode, 200, renamed.body)
  assert.equal(tables.sites[0].webhook_url, 'https://example.com/webhook')
  for (const webhook_url of [null, '', '   ']) {
    const configured = await app.inject({ method: 'PATCH', url, payload: { webhook_url: '  https://example.com/new-webhook  ' } })
    assert.equal(configured.statusCode, 200, configured.body)
    assert.equal(tables.sites[0].webhook_url, 'https://example.com/new-webhook')
    const cleared = await app.inject({ method: 'PATCH', url, payload: { webhook_url } })
    assert.equal(cleared.statusCode, 200, cleared.body)
    assert.equal(tables.sites[0].webhook_url, null)
  }
  const edited = await app.inject({ method: 'PATCH', url, payload: { name: 'Chưa cấu hình webhook' } })
  assert.equal(edited.statusCode, 200, edited.body)
  assert.equal(tables.sites[0].webhook_url, null)
})

test('CRM still validates nonempty webhook URLs on create and edit', async t => {
  const { app, tables, customerId, siteId } = await fixture(t)
  const before = structuredClone(tables)
  for (const webhook_url of ['not-a-url', 'file:///etc/passwd', 'https://127.0.0.1/hook', 123]) {
    const created = await app.inject({ method: 'POST', url: '/websites', payload: { customer_id: customerId, name: 'URL sai', domain: 'example.org', webhook_url } })
    assert.equal(created.statusCode, 400, created.body)
    const edited = await app.inject({ method: 'PATCH', url: `/websites/${siteId}`, payload: { webhook_url } })
    assert.equal(edited.statusCode, 400, edited.body)
    assert.deepEqual(tables, before)
  }
})

test('CRM article deletion retains consumed allowance and releases unused reservations', async t => {
  const { app, db, tables, customerId, jobId } = await fixture(t)
  const when = new Date('2026-11-21T03:00:00Z')
  tables.quota_reservations = [
    { _id: randomUUID(), job_id: jobId, customer_id: customerId, quota_day: '2026-11-21', quota_month: '2026-11', status: 'used' },
    { _id: randomUUID(), job_id: jobId, customer_id: customerId, quota_day: '2026-11-21', quota_month: '2026-11', status: 'reserved' },
  ]
  const before = await quotaAt(db, customerId, when)
  assert.equal(before.day_used, 1)
  assert.equal(before.day_reserved, 1)
  const response = await app.inject({ method: 'DELETE', url: `/jobs/${jobId}` })
  assert.equal(response.statusCode, 204, response.body)
  assert.equal(tables.jobs.length, 0)
  const after = await quotaAt(db, customerId, when)
  assert.equal(after.day_used, 1)
  assert.equal(after.month_used, 1)
  assert.equal(after.day_reserved, 0)
  assert.equal(tables.quota_reservations.length, 1)
  assert.equal(tables.quota_reservations[0].status, 'used')
})
