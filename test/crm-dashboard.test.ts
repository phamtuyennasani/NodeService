import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerReports } from '../src/api/crm-reports.js'
import { installErrorHandler } from '../src/api/errors.js'

type Row = Record<string, any>
type Read = { collection: string; filter: Row; projection: Row }

function memoryDatabase(tables: Record<string, Row[]>, reads: Read[]): Database {
  const matches = (row: Row, filter: Row) => Object.entries(filter).every(([field, expected]) => {
    if (expected && typeof expected === 'object' && '$in' in expected) return expected.$in.includes(row[field])
    return row[field] === expected
  })
  const db = {
    collection(name: string) {
      assert.ok(['jobs', 'customers', 'sites', 'webhook_deliveries', 'ai_attempts'].includes(name), `runtime must not read ${name}`)
      return {
        find(filter: Row, options: { projection?: Row } = {}) {
          const projection = options.projection ?? {}
          reads.push({ collection: name, filter: structuredClone(filter), projection })
          const runtimeProjection = name === 'jobs' && '$in' in (filter.status ?? {})
          if (runtimeProjection) {
            assert.ok(Object.values(projection).every(value => value === 1), 'use a positive field allowlist')
            assert.ok(Object.keys(projection).length > 0, 'every runtime read must project only needed fields')
          }
          return {
            async toArray() {
              return (tables[name] ?? []).filter(row => matches(row, filter)).map(row => Object.keys(projection).length
                ? structuredClone(Object.fromEntries(Object.keys(projection).filter(key => key in row).map(key => [key, row[key]])))
                : structuredClone(row))
            },
          }
        },
      }
    },
  }
  return { db } as unknown as Database
}

async function fixture(t: test.TestContext, jobs: Row[] = [], usdToVnd = 25_000) {
  const now = new Date('2026-11-20T07:00:00.000Z')
  t.mock.timers.enable({ apis: ['Date'], now })
  const customerId = randomUUID()
  const siteId = randomUUID()
  const rows: Row[] = jobs
  const tables = {
    jobs: rows,
    customers: [{ _id: customerId, name: 'Khách kiểm thử', encrypted_secret: 'customer-secret' }],
    sites: [{ _id: siteId, name: 'Website kiểm thử', webhook_secret: 'site-secret' }],
    webhook_deliveries: [],
    ai_attempts: [] as Row[],
  }
  const reads: Read[] = []
  const app = Fastify()
  installErrorHandler(app)
  registerReports(app, memoryDatabase(tables, reads), { workerConcurrency: 5, webhookConcurrency: 3, usdToVnd } as Config)
  await app.ready()
  t.after(() => app.close())
  const job = (patch: Row = {}) => ({
    _id: randomUUID(), customer_id: customerId, site_id: siteId, provider: 'openai', model: 'gpt-test',
    keyword: 'từ khóa kiểm thử', mode: 'scheduled', status: 'writing', tone: 'Chuyên nghiệp', style: 'SEO', length: 1500,
    key_mode: 'service', created_at: new Date(now.getTime() - 300_000), scheduled_at: new Date(now.getTime() - 120_000),
    started_at: new Date(now.getTime() - 90_000), completed_at: null,
    lease_token: 'valid-private-lease', lease_expires_at: new Date(now.getTime() + 60_000),
    result: [{ Content: 'private article content' }], encrypted_key: 'private-ai-key', instructions: 'private instructions',
    ...patch,
  })
  return { app, rows, job, now, customerId, siteId, reads, tables }
}

test('CRM runtime reports valid processing leases and separates queue from future schedules', async t => {
  const { app, rows, job, now, reads } = await fixture(t)
  const active = job({ writing_stage: 'outline' })
  const expired = job({ provider: 'anthropic', lease_expires_at: new Date(now.getTime() - 1) })
  const missing = job({ provider: 'xai', lease_token: null, lease_expires_at: null, started_at: null })
  const empty = job({ provider: 'openai-compatible', lease_token: '  ', lease_expires_at: new Date(now.getTime() + 60_000) })
  const exactLease = job({ lease_expires_at: now })
  rows.push(active, expired, missing, empty, exactLease,
    job({ status: 'queued', provider: 'anthropic' }),
    job({ status: 'scheduled', scheduled_at: now }),
    job({ status: 'scheduled', scheduled_at: new Date(now.getTime() - 1) }),
    job({ status: 'scheduled', scheduled_at: new Date(now.getTime() + 1) }),
    job({ status: 'ready' }), job({ status: 'failed' }))
  const response = await app.inject({ method: 'GET', url: '/dashboard/runtime' })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.headers['cache-control'], 'no-store')
  const body = response.json()
  assert.equal(body.observed_at, now.toISOString())
  assert.deepEqual(body.summary, { writing: 5, queued: 3, scheduled: 1, active_threads: 1, stale_writing: 4 })
  assert.deepEqual(body.capacity, { writer_per_process: 5, webhook_per_process: 3 })
  assert.deepEqual(body.providers, [
    { provider: 'openai', writing: 2, queued: 2, active_threads: 1 },
    { provider: 'anthropic', writing: 1, queued: 1, active_threads: 0 },
    { provider: 'xai', writing: 1, queued: 0, active_threads: 0 },
    { provider: 'openai-compatible', writing: 1, queued: 0, active_threads: 0 },
  ])
  assert.equal(body.running.find((row: Row) => row.id === active._id).elapsed_seconds, 90)
  assert.equal(body.running.find((row: Row) => row.id === active._id).lease_active, true)
  assert.equal(body.running.find((row: Row) => row.id === active._id).writing_stage, 'outline')
  assert.equal(body.running.find((row: Row) => row.id === missing._id).elapsed_seconds, 0)
  assert.equal(body.running.find((row: Row) => row.id === expired._id).lease_active, false)
  assert.equal(body.running[0].customer_name, 'Khách kiểm thử')
  assert.equal(body.running[0].website_name, 'Website kiểm thử')
  assert.doesNotMatch(response.body, /private|customer-secret|site-secret|lease_token|lease_expires_at|result|instructions|encrypted_key|webhook_secret/)
  assert.equal(reads.length, 3)
  const jobRead = reads.find(read => read.collection === 'jobs')!
  assert.deepEqual(jobRead.filter, { status: { $in: ['scheduled', 'queued', 'writing'] } })
  for (const field of ['result', 'Content', 'encrypted_key', 'instructions']) assert.equal(jobRead.projection[field], undefined)
  assert.deepEqual(reads.find(read => read.collection === 'customers')?.projection, { _id: 1, name: 1 })
  assert.deepEqual(reads.find(read => read.collection === 'sites')?.projection, { _id: 1, name: 1 })
})

test('CRM runtime scopes current activity by customer and website independent of report dates', async t => {
  const { app, rows, job, customerId, siteId, reads } = await fixture(t)
  const own = job({ created_at: new Date('2020-01-01T00:00:00Z') })
  rows.push(own, job({ site_id: randomUUID() }), job({ customer_id: randomUUID() }))
  const response = await app.inject({ method: 'GET', url: `/dashboard/runtime?customer_id=${customerId}&website_id=${siteId}&from=2030-01-01&to=2030-01-01` })
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json()
  assert.deepEqual(body.summary, { writing: 1, queued: 0, scheduled: 0, active_threads: 1, stale_writing: 0 })
  assert.deepEqual(body.running.map((row: Row) => row.id), [own._id])
  assert.deepEqual(reads[0].filter, { status: { $in: ['scheduled', 'queued', 'writing'] }, customer_id: customerId, site_id: siteId })
})

test('CRM runtime caps running list while retaining complete counts and newest start order', async t => {
  const { app, rows, job, now } = await fixture(t)
  for (let index = 0; index < 25; index += 1) rows.push(job({ started_at: new Date(now.getTime() - index * 1_000) }))
  const response = await app.inject({ method: 'GET', url: '/dashboard/runtime' })
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json()
  assert.equal(body.summary.writing, 25)
  assert.equal(body.summary.active_threads, 25)
  assert.equal(body.running.length, 20)
  assert.deepEqual(body.running.map((row: Row) => row.id), rows.slice(0, 20).map(row => row._id))
  assert.equal(body.running[0].elapsed_seconds, 0)
  assert.equal(body.running[19].elapsed_seconds, 19)
})

test('CRM runtime returns empty activity without catalog reads and validates scope ids', async t => {
  const { app, reads } = await fixture(t)
  const response = await app.inject({ method: 'GET', url: '/dashboard/runtime' })
  assert.equal(response.statusCode, 200, response.body)
  assert.deepEqual(response.json().summary, { writing: 0, queued: 0, scheduled: 0, active_threads: 0, stale_writing: 0 })
  assert.deepEqual(response.json().running, [])
  assert.equal(reads.length, 1)
  const invalid = await app.inject({ method: 'GET', url: '/dashboard/runtime?customer_id=not-an-id' })
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json().error.code, 'invalid_request')
  assert.equal(reads.length, 1)
})

test('CRM historical dashboard counts ready jobs as written articles', async t => {
  const { app, rows, job } = await fixture(t)
  rows.push(job({ status: 'ready', result: [{ Content: '<p>Đã viết</p>' }], completed_at: new Date('2026-11-20T06:30:00.000Z') }))
  rows.push(job({ status: 'failed', result: null, completed_at: new Date('2026-11-20T06:20:00.000Z') }))
  const response = await app.inject({ method: 'GET', url: '/dashboard?from=2026-11-20&to=2026-11-20' })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().metrics.articles, 1)
  assert.equal(response.json().metrics.write_errors, 1)
})

test('CRM historical dashboard reports priced service and customer costs by day', async t => {
  const { app, rows, job, tables } = await fixture(t, [], 27_001)
  const serviceJob = job({ status: 'ready', completed_at: new Date('2026-11-20T01:00:00.000Z'), key_mode: 'service' })
  const customerJob = job({ status: 'ready', completed_at: new Date('2026-11-20T02:00:00.000Z'), key_mode: 'own' })
  rows.push(serviceJob, customerJob)
  tables.ai_attempts.push(
    { _id: randomUUID(), job_id: serviceJob._id, requested_at: new Date('2026-11-19T18:10:00.000Z'), cost_usd: '0.125' },
    { _id: randomUUID(), job_id: customerJob._id, requested_at: new Date('2026-11-19T19:10:00.000Z'), cost_usd: '0.375' },
    { _id: randomUUID(), job_id: serviceJob._id, requested_at: new Date('2026-11-19T20:10:00.000Z'), cost_usd: null },
  )
  const response = await app.inject({ method: 'GET', url: '/dashboard?from=2026-11-20&to=2026-11-20' })
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json()
  assert.equal(body.metrics.service_cost_usd, '0.125000000000')
  assert.equal(body.metrics.customer_cost_usd, '0.375000000000')
  assert.equal(body.metrics.service_cost_vnd, '3375.125000000000')
  assert.equal(body.metrics.customer_cost_vnd, '10125.375000000000')
  assert.equal(body.metrics.total_cost_vnd, '13500.500000000000')
  assert.equal(body.metrics.unpriced_attempts, 1)
  assert.deepEqual(body.series, [{
    date: '2026-11-20', articles: 2, delivered: 0,
    service_cost_usd: '0.125000000000', customer_cost_usd: '0.375000000000',
    service_cost_vnd: '3375.125000000000', customer_cost_vnd: '10125.375000000000', unpriced_attempts: 1,
  }])
})

test('CRM costs follow attempt dates even when creation and completion are outside the report', async t => {
  const { app, rows, job, tables } = await fixture(t)
  const crossing = job({ status: 'ready', key_mode: 'service', created_at: new Date('2026-11-18T01:00:00Z'), started_at: new Date('2026-11-18T01:01:00Z'), completed_at: new Date('2026-11-21T01:00:00Z') })
  rows.push(crossing)
  tables.ai_attempts.push(
    { _id: randomUUID(), job_id: crossing._id, requested_at: new Date('2026-11-19T18:00:00Z'), cost_usd: '0.125' },
    { _id: randomUUID(), job_id: crossing._id, requested_at: new Date('2026-11-20T18:00:00Z'), cost_usd: '0.5' },
  )
  const report = await app.inject({ method: 'GET', url: '/dashboard?from=2026-11-20&to=2026-11-20' })
  assert.equal(report.statusCode, 200, report.body)
  assert.equal(report.json().metrics.articles, 0)
  assert.equal(report.json().metrics.service_cost_usd, '0.125000000000')
  assert.equal(report.json().metrics.service_cost_vnd, '3125.000000000000')
  assert.equal(report.json().metrics.total_cost_vnd, '3125.000000000000')
  assert.equal(report.json().series[0].service_cost_usd, '0.125000000000')
  assert.equal(report.json().series[0].service_cost_vnd, '3125.000000000000')
  const drilldown = await app.inject({ method: 'GET', url: '/jobs?date_basis=cost&from=2026-11-20&to=2026-11-20' })
  assert.equal(drilldown.statusCode, 200, drilldown.body)
  assert.deepEqual(drilldown.json().data.map((row: Row) => [row.id, row.cost_usd, row.cost_vnd]), [[crossing._id, '0.125000000000', '3125.000000000000']])
})

test('CRM job list converts precise aggregate costs and distinguishes zero from unpriced usage', async t => {
  const { app, rows, job, tables } = await fixture(t, [], 27_123)
  const priced = job()
  const zero = job()
  const unpriced = job()
  rows.push(priced, zero, unpriced)
  tables.ai_attempts.push(
    { _id: randomUUID(), job_id: priced._id, cost_usd: '0.100000000001' },
    { _id: randomUUID(), job_id: priced._id, cost_usd: '0.2' },
    { _id: randomUUID(), job_id: priced._id, cost_usd: null },
    { _id: randomUUID(), job_id: zero._id, cost_usd: '0' },
    { _id: randomUUID(), job_id: unpriced._id, cost_usd: null },
    { _id: randomUUID(), job_id: unpriced._id, cost_usd: '' },
  )
  const response = await app.inject({ method: 'GET', url: '/jobs' })
  assert.equal(response.statusCode, 200, response.body)
  const data = response.json().data
  assert.equal(data.find((row: Row) => row.id === priced._id).cost_usd, '0.300000000001')
  assert.equal(data.find((row: Row) => row.id === priced._id).cost_vnd, '8136.900000027123')
  assert.equal(data.find((row: Row) => row.id === zero._id).cost_vnd, '0.000000000000')
  assert.equal(data.find((row: Row) => row.id === unpriced._id).cost_vnd, null)
})

test('CRM report cursors reject invalid date prefixes instead of passing invalid dates to MongoDB', async t => {
  const { app } = await fixture(t)
  const cursor = Buffer.from(JSON.stringify(['2026-11-20garbage', randomUUID()])).toString('base64url')
  const response = await app.inject({ method: 'GET', url: `/jobs?cursor=${cursor}` })
  assert.equal(response.statusCode, 400, response.body)
  assert.equal(response.json().error.code, 'invalid_cursor')
})
