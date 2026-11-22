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
    if (field === '$or') return expected.some((condition: Row) => matches(row, condition))
    if (expected && typeof expected === 'object') {
      if ('$exists' in expected) return Object.hasOwn(row, field) === expected.$exists
      if ('$in' in expected) return expected.$in.includes(row[field]) || (row[field] === undefined && expected.$in.includes(null))
      if ('$gte' in expected || '$lt' in expected || '$gt' in expected) {
        return row[field] != null && (!('$gte' in expected) || row[field] >= expected.$gte)
          && (!('$lt' in expected) || row[field] < expected.$lt)
          && (!('$gt' in expected) || row[field] > expected.$gt)
      }
    }
    return row[field] === expected
  })
  const db = {
    collection(name: string) {
      assert.ok(['jobs', 'customers', 'sites', 'webhook_deliveries', 'webhook_attempts', 'ai_attempts', 'worker_heartbeats'].includes(name), `unexpected collection ${name}`)
      return {
        async findOne(filter: Row) {
          return structuredClone((tables[name] ?? []).find(row => matches(row, filter)) ?? null)
        },
        find(filter: Row, options: { projection?: Row } = {}) {
          const projection = options.projection ?? {}
          reads.push({ collection: name, filter: structuredClone(filter), projection })
          const runtimeProjection = name === 'jobs' && '$in' in (filter.status ?? {})
          if (runtimeProjection) {
            assert.ok(Object.values(projection).every(value => value === 1), 'use a positive field allowlist')
            assert.ok(Object.keys(projection).length > 0, 'every runtime read must project only needed fields')
          }
          return {
            sort() { return this },
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
    sites: [{ _id: siteId, name: 'Website kiểm thử', customer_id: customerId, webhook_secret: 'site-secret' }],
    webhook_deliveries: [] as Row[],
    webhook_attempts: [] as Row[],
    ai_attempts: [] as Row[],
    worker_heartbeats: [] as Row[],
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
  assert.deepEqual(body.summary, { writing: 5, queued: 3, scheduled: 1, active_threads: 1, stale_writing: 4, overdue_schedules: 1, oldest_wait_seconds: 300 })
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
  assert.equal(reads.length, 6)
  const jobRead = reads.find(read => read.collection === 'jobs')!
  assert.deepEqual(jobRead.filter, { status: { $in: ['scheduled', 'queued', 'writing', 'failed'] } })
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
  assert.deepEqual(body.summary, { writing: 1, queued: 0, scheduled: 0, active_threads: 1, stale_writing: 0, overdue_schedules: 0, oldest_wait_seconds: null })
  assert.deepEqual(body.running.map((row: Row) => row.id), [own._id])
  assert.deepEqual(reads[0].filter, { status: { $in: ['scheduled', 'queued', 'writing', 'failed'] }, customer_id: customerId, site_id: siteId })
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
  assert.deepEqual(response.json().summary, { writing: 0, queued: 0, scheduled: 0, active_threads: 0, stale_writing: 0, overdue_schedules: 0, oldest_wait_seconds: null })
  assert.deepEqual(response.json().running, [])
  assert.equal(reads.length, 4)
  const invalid = await app.inject({ method: 'GET', url: '/dashboard/runtime?customer_id=not-an-id' })
  assert.equal(invalid.statusCode, 400)
  assert.equal(invalid.json().error.code, 'invalid_request')
  assert.equal(reads.length, 4)
})

test('CRM runtime shows current delivery queues, unresolved failures and unpriced service usage across report dates', async t => {
  const { app, rows, job, now, tables, customerId, siteId, reads } = await fixture(t)
  const old = new Date('2020-01-01T00:00:00Z')
  const failed = job({ status: 'failed', completed_at: old, updated_at: old, error_code: 'AI_AUTH', error_message: 'Bearer private-key-from-provider' })
  const unknown = job({ status: 'failed', completed_at: old, error_code: 'private-key-from-provider', error_message: 'private response' })
  const ready = job({ status: 'ready' })
  const own = job({ status: 'ready', key_mode: 'own' })
  const outside = job({ status: 'failed', customer_id: randomUUID(), site_id: randomUUID() })
  rows.push(failed, unknown, ready, own, outside)
  const delivery = (patch: Row = {}) => ({
    _id: randomUUID(), job_id: ready._id, site_id: siteId, status: 'pending', event: 'article.ready', attempt_count: 2,
    created_at: old, updated_at: old, next_attempt_at: new Date(now.getTime() - 120_000),
    error: 'private-key-from-webhook', webhook_secret: 'private-secret',
    ...patch,
  })
  const overdue = delivery()
  const future = delivery({ next_attempt_at: new Date(now.getTime() + 60_000) })
  const sending = delivery({ status: 'sending', lease_token: 'private-token', lease_expires_at: new Date(now.getTime() + 10_000) })
  const stale = delivery({ status: 'sending', lease_token: 'private-token', lease_expires_at: now })
  const missing = delivery({ status: 'sending' })
  const deliveryFailure = delivery({ status: 'failed', http_status: 401 })
  tables.webhook_deliveries.push(overdue, future, sending, stale, missing, deliveryFailure,
    delivery({ job_id: outside._id, site_id: outside.site_id, status: 'failed' }),
    delivery({ job_id: randomUUID(), status: 'failed' }))
  const attempt = (job_id: string, patch: Row = {}) => ({ job_id, cost_usd: null, cost_source: 'pending', requested_at: old, encrypted_key: 'private-key', ...patch })
  tables.ai_attempts.push(attempt(ready._id), attempt(failed._id, { cost_usd: '' }),
    { job_id: ready._id, cost_usd: null }, attempt(own._id), attempt(outside._id), attempt(randomUUID()),
    attempt(ready._id, { cost_source: null }), attempt(ready._id, { cost_source: 'not_applicable' }), attempt(ready._id, { cost_usd: '0' }))
  const response = await app.inject(`/dashboard/runtime?customer_id=${customerId}&website_id=${siteId}&from=2030-01-01&to=2030-01-01`)
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json()
  assert.deepEqual(body.deliveries, { pending: 2, sending: 3, failed: 1, active_threads: 1, stale_sending: 2, oldest_wait_seconds: 120 })
  assert.deepEqual(body.attention, { write_errors: 2, delivery_errors: 1, stale_writing: 0, stale_sending: 2, unpriced_attempts: 3 })
  assert.deepEqual(new Set(body.write_failures.map((row: Row) => row.id)), new Set([failed._id, unknown._id]))
  assert.equal(body.write_failures.find((row: Row) => row.id === failed._id).error_message, 'Nhà cung cấp từ chối API key hoặc quyền dùng model.')
  assert.equal(body.write_failures.find((row: Row) => row.id === unknown._id).error_code, null)
  assert.equal(body.delivery_failures[0].id, deliveryFailure._id)
  assert.equal(body.delivery_failures[0].job_id, ready._id)
  assert.equal(body.delivery_failures[0].last_http_status, 401)
  assert.equal(body.delivery_failures[0].last_error, 'Website nhận bài phản hồi HTTP 401.')
  assert.equal(body.delivery_failures[0].customer_name, 'Khách kiểm thử')
  assert.doesNotMatch(response.body, /private|lease_token|lease_expires_at|encrypted_key|webhook_secret/)
  for (const read of reads) {
    assert.ok(Object.keys(read.projection).length, `positive projection for ${read.collection}`)
    assert.ok(Object.values(read.projection).every(value => value === 1))
  }
})

test('CRM runtime reports deployment worker liveness, accepting capacity and safe empty date values', async t => {
  const { app, rows, job, tables, now, customerId, siteId, reads } = await fixture(t)
  rows.push(job({ status: 'queued', created_at: null, available_at: null }),
    job({ status: 'scheduled', scheduled_at: null }), job({ status: 'scheduled', scheduled_at: new Date('invalid') }),
    job({ status: 'writing', started_at: new Date('invalid') }))
  const heartbeat = (patch: Row = {}) => ({
    _id: randomUUID(), role: 'writer', heartbeat_at: now, expires_at: new Date(now.getTime() + 15_000),
    concurrency: 5, active_tasks: 2, hostname: 'private-host', pid: 1234, secret: 'private-key',
    ...patch,
  })
  tables.worker_heartbeats.push(heartbeat(), heartbeat({ concurrency: 8, accepting_work: false, active_tasks: 1 }),
    heartbeat({ expires_at: now }), heartbeat({ expires_at: new Date(now.getTime() - 1) }),
    heartbeat({ role: 'webhook', concurrency: 3, active_tasks: 0, heartbeat_at: new Date(now.getTime() - 2_000) }),
    heartbeat({ role: 'unknown' }))
  const response = await app.inject(`/dashboard/runtime?customer_id=${customerId}&website_id=${siteId}`)
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json()
  assert.equal(body.summary.queued, 1)
  assert.equal(body.summary.scheduled, 0)
  assert.equal(body.summary.oldest_wait_seconds, null)
  assert.equal(body.summary.overdue_schedules, 0)
  assert.equal(body.running[0].elapsed_seconds, 0)
  assert.deepEqual(body.workers, {
    writer: { processes: 2, accepting_processes: 1, concurrency: 5, active_tasks: 3, last_heartbeat_at: now.toISOString() },
    webhook: { processes: 1, accepting_processes: 1, concurrency: 3, active_tasks: 0, last_heartbeat_at: new Date(now.getTime() - 2_000).toISOString() },
  })
  assert.deepEqual(reads.find(read => read.collection === 'worker_heartbeats')?.filter, { expires_at: { $gt: now } })
  assert.doesNotMatch(response.body, /private|hostname|pid|secret/)
})

test('CRM runtime explains invalid Laravel acknowledgements without exposing response content', async t => {
  const { app, rows, job, now, tables } = await fixture(t)
  const ready = job({ status: 'ready' })
  rows.push(ready)
  tables.webhook_deliveries.push({
    _id: randomUUID(), job_id: ready._id, site_id: ready.site_id, status: 'failed', event: 'article.ready',
    attempt_count: 4, created_at: now, updated_at: now, http_status: 200, error: 'private response content',
  })
  const response = await app.inject('/dashboard/runtime')
  assert.equal(response.statusCode, 200, response.body)
  const failure = response.json().delivery_failures[0]
  assert.equal(failure.last_http_status, 200)
  assert.equal(failure.last_error, 'Laravel chưa trả xác nhận hợp lệ với success: true và id_post.')
  assert.doesNotMatch(response.body, /private response content/)
})

test('CRM runtime limits failure previews without truncating counts and measures the actual ready-to-write wait', async t => {
  const { app, rows, job, now, tables } = await fixture(t)
  rows.push(job({ status: 'queued', created_at: new Date(now.getTime() - 90_000), available_at: new Date(now.getTime() - 30_000) }))
  for (let index = 0; index < 12; index += 1) {
    const failed = job({ status: 'failed', updated_at: new Date(now.getTime() - index * 1_000) })
    rows.push(failed)
    tables.webhook_deliveries.push({
      _id: randomUUID(), job_id: failed._id, site_id: failed.site_id, status: 'failed', event: 'article.failed',
      created_at: now, updated_at: new Date(now.getTime() - index * 1_000), http_status: 9_999,
    })
  }
  const response = await app.inject('/dashboard/runtime')
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json()
  assert.equal(body.summary.oldest_wait_seconds, 30)
  assert.equal(body.attention.write_errors, 12)
  assert.equal(body.attention.delivery_errors, 12)
  assert.equal(body.write_failures.length, 10)
  assert.equal(body.delivery_failures.length, 10)
  assert.deepEqual(body.write_failures.map((row: Row) => row.id), rows.slice(1, 11).map(row => row._id))
  assert.deepEqual(body.delivery_failures.map((row: Row) => row.id), tables.webhook_deliveries.slice(0, 10).map(row => row._id))
  assert.equal(body.delivery_failures[0].last_http_status, null)
})

test('CRM runtime drilldowns return the exact writing and delivery issue subsets', async t => {
  const { app, rows, job, tables, now } = await fixture(t)
  const queued = job({ status: 'queued' })
  const due = job({ status: 'scheduled', scheduled_at: now })
  const overdue = job({ status: 'scheduled', scheduled_at: new Date(now.getTime() - 1) })
  const future = job({ status: 'scheduled', scheduled_at: new Date(now.getTime() + 1) })
  const active = job()
  const stale = job({ lease_expires_at: now })
  const priced = job({ status: 'ready' })
  const unpriced = job({ status: 'ready' })
  const own = job({ status: 'ready', key_mode: 'own' })
  rows.push(queued, due, overdue, future, active, stale, priced, unpriced, own)
  tables.ai_attempts.push({ job_id: priced._id, cost_usd: '0' }, { job_id: unpriced._id, cost_usd: null },
    { job_id: own._id, cost_usd: null, cost_source: 'pending' })
  const ids = async (path: string) => {
    const response = await app.inject(path)
    assert.equal(response.statusCode, 200, response.body)
    return new Set(response.json().data.map((row: Row) => row.id))
  }
  assert.deepEqual(await ids('/jobs?issue=queue'), new Set([queued._id, due._id, overdue._id]))
  assert.deepEqual(await ids('/jobs?issue=overdue'), new Set([overdue._id]))
  assert.deepEqual(await ids('/jobs?issue=future&status=scheduled'), new Set([future._id]))
  assert.deepEqual(await ids('/jobs?issue=stale'), new Set([stale._id]))
  assert.deepEqual(await ids('/jobs?issue=unpriced'), new Set([unpriced._id]))
  const delivery = (patch: Row) => ({ _id: randomUUID(), job_id: priced._id, site_id: priced.site_id, created_at: now, ...patch })
  const pending = delivery({ status: 'pending', next_attempt_at: now })
  const waiting = delivery({ status: 'pending', next_attempt_at: new Date(now.getTime() + 1) })
  const sending = delivery({ status: 'sending', lease_token: 'valid', lease_expires_at: new Date(now.getTime() + 1) })
  const staleSending = delivery({ status: 'sending', lease_token: 'valid', lease_expires_at: now })
  tables.webhook_deliveries.push(pending, waiting, sending, staleSending)
  assert.deepEqual(await ids('/deliveries?issue=queue'), new Set([pending._id]))
  assert.deepEqual(await ids('/deliveries?issue=stale'), new Set([staleSending._id]))
  assert.equal((await app.inject('/jobs?issue=unknown')).statusCode, 400)
  assert.equal((await app.inject('/deliveries?issue=unknown')).statusCode, 400)
})

test('CRM historical dashboard scopes finished articles, article deliveries and precise costs by Vietnam date', async t => {
  const { app, rows, job, tables, customerId, siteId } = await fixture(t)
  const lower = new Date('2026-11-19T17:00:00.000Z')
  const upper = new Date('2026-11-20T17:00:00.000Z')
  const yesterday = new Date(lower.getTime() - 1)
  const ready = job({ status: 'ready', created_at: yesterday, completed_at: lower })
  const failed = job({ status: 'failed', completed_at: null, updated_at: lower })
  const own = job({ status: 'queued', key_mode: 'own', started_at: yesterday })
  const nextDay = job({ status: 'ready', completed_at: upper })
  const older = job({ status: 'ready', completed_at: yesterday })
  const olderWithLaterFailure = job({ status: 'ready', completed_at: yesterday })
  const outsideSite = job({ status: 'ready', customer_id: randomUUID(), site_id: randomUUID(), completed_at: lower })
  const future = job({ status: 'scheduled', scheduled_at: new Date('2026-12-01T08:00:00Z') })
  rows.push(ready, failed, own, nextDay, older, olderWithLaterFailure, outsideSite, future)
  tables.customers.push({ _id: randomUUID(), name: 'Khách chưa có website', encrypted_secret: '' })
  tables.sites.push({ _id: randomUUID(), name: 'Website chưa có bài', customer_id: customerId, webhook_secret: '' })
  const delivery = (row: Row, status: string, event: string, time = lower) => ({
    _id: randomUUID(), job_id: row._id, site_id: row.site_id, status, event,
    created_at: yesterday, updated_at: time, delivered_at: status === 'delivered' ? time : null,
  })
  tables.webhook_deliveries.push(
    delivery(ready, 'delivered', 'article.ready'), delivery(older, 'failed', 'article.ready'),
    delivery(failed, 'delivered', 'article.failed'), delivery(nextDay, 'delivered', 'article.ready', upper),
    delivery(outsideSite, 'delivered', 'article.ready'), delivery(olderWithLaterFailure, 'failed', 'article.ready', upper),
  )
  const attempt = (row: Row, cost_usd: string | null, requested_at = lower, cost_source = 'estimated') => ({
    job_id: row._id, requested_at, cost_usd, cost_source,
  })
  tables.ai_attempts.push(
    attempt(ready, '999999999.123456789012'), attempt(ready, '0.000000000001'),
    attempt(own, '0.25'), attempt(own, null, lower, 'pending'), attempt(ready, null, lower, 'not_applicable'),
    attempt(ready, null, lower, 'pending'),
    attempt(outsideSite, '9.99'), attempt(outsideSite, null, lower, 'pending'),
    attempt(ready, '1', yesterday), attempt(own, '1', upper),
  )
  const report = `from=2026-11-20&to=2026-11-20&customer_id=${customerId}&website_id=${siteId}`
  const response = await app.inject({ method: 'GET', url: `/dashboard?${report}` })
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json()
  assert.deepEqual(body.metrics, {
    customers: 1, websites: 1, articles: 1, delivered: 1, pending: 2, write_errors: 1, delivery_errors: 1,
    service_cost_usd: '999999999.123456789013', customer_cost_usd: '0.000000000000',
    service_cost_vnd: '24999999978086.419725325000', customer_cost_vnd: '0.000000000000', total_cost_vnd: '24999999978086.419725325000', unpriced_attempts: 1,
  })
  assert.deepEqual(body.series, [{
    date: '2026-11-20', articles: 1, delivered: 1,
    service_cost_usd: '999999999.123456789013', customer_cost_usd: '0.000000000000',
    service_cost_vnd: '24999999978086.419725325000', customer_cost_vnd: '0.000000000000', unpriced_attempts: 1,
  }])
  assert.deepEqual(body.upcoming.map((row: Row) => row.id), [future._id])
  assert.deepEqual(body.failures.map((row: Row) => row.id), [failed._id])
  const all = (await app.inject('/dashboard')).json()
  assert.equal(all.metrics.customers, 2)
  assert.equal(all.metrics.websites, 2)
  assert.equal(all.series.length, 14)
  assert.equal(all.series.at(-1).date, '2026-11-20')

  const costs = (await app.inject(`/jobs?${report}&date_basis=cost&key_mode=service`)).json()
  assert.deepEqual(costs.data.map((row: Row) => [row.id, row.cost_usd]), [[ready._id, '999999999.123456789013']])
  const written = (await app.inject(`/jobs?${report}&status=ready`)).json()
  assert.deepEqual(written.data.map((row: Row) => row.id), [ready._id])
})

test('CRM webhook pagination advances across tied timestamps and keeps delivered-date and search filters', async t => {
  const { app, rows, job, tables, siteId } = await fixture(t)
  const matching = job({ status: 'ready', keyword: 'Thiết kế kiểm thử' })
  const matchingAgain = job({ status: 'ready', keyword: 'Thiết kế chuyên nghiệp' })
  const other = job({ status: 'ready', keyword: 'Nội dung khác' })
  rows.push(matching, matchingAgain, other)
  const created = new Date('2026-11-18T03:00:00Z')
  const delivered = new Date('2026-11-19T17:00:00Z')
  const fixtures = [matching, matchingAgain, other].map(row => ({
    _id: randomUUID(), job_id: row._id, site_id: row.site_id, status: 'delivered', event: 'article.ready',
    created_at: created, updated_at: delivered, delivered_at: delivered,
  }))
  tables.webhook_deliveries.push(...fixtures)
  const expected = fixtures.slice(0, 2).map(row => row._id).sort().reverse()
  const firstPath = `/deliveries?website_id=${siteId}&from=2026-11-20&to=2026-11-20&status=delivered&event=article.ready&limit=1&q=${encodeURIComponent('thiết kế')}`
  const first = await app.inject(firstPath)
  assert.equal(first.statusCode, 200, first.body)
  const firstPage = first.json()
  assert.deepEqual(firstPage.data.map((row: Row) => row.id), [expected[0]])
  assert.ok(firstPage.next_cursor)
  const second = await app.inject(`${firstPath}&cursor=${encodeURIComponent(firstPage.next_cursor)}`)
  assert.equal(second.statusCode, 200, second.body)
  const secondPage = second.json()
  assert.deepEqual(secondPage.data.map((row: Row) => row.id), [expected[1]])
  assert.equal(secondPage.next_cursor, null)
})

test('CRM historical dashboard accounts for service costs and ignores legacy personal-key costs', async t => {
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
  assert.equal(body.metrics.customer_cost_usd, '0.000000000000')
  assert.equal(body.metrics.service_cost_vnd, '3375.125000000000')
  assert.equal(body.metrics.customer_cost_vnd, '0.000000000000')
  assert.equal(body.metrics.total_cost_vnd, '3375.125000000000')
  assert.equal(body.metrics.unpriced_attempts, 1)
  assert.deepEqual(body.series, [{
    date: '2026-11-20', articles: 2, delivered: 0,
    service_cost_usd: '0.125000000000', customer_cost_usd: '0.000000000000',
    service_cost_vnd: '3375.125000000000', customer_cost_vnd: '0.000000000000', unpriced_attempts: 1,
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

test('CRM period cost attention and drilldown agree on pending service attempts inside the selected Vietnam day', async t => {
  const { app, rows, job, tables } = await fixture(t)
  const lower = new Date('2026-11-19T17:00:00.000Z')
  const upper = new Date('2026-11-20T17:00:00.000Z')
  const before = new Date(lower.getTime() - 1)
  const oldPending = job({ status: 'ready' })
  const pending = job({ status: 'ready', created_at: new Date('2020-01-01T00:00:00Z') })
  const nextDayPending = job({ status: 'ready' })
  const own = job({ status: 'ready', key_mode: 'own' })
  rows.push(oldPending, pending, nextDayPending, own)
  tables.ai_attempts.push(
    { job_id: oldPending._id, cost_usd: null, cost_source: 'pending', requested_at: before },
    { job_id: oldPending._id, cost_usd: '0.25', cost_source: 'estimated', requested_at: lower },
    { job_id: pending._id, cost_usd: null, cost_source: 'pending', requested_at: lower },
    { job_id: nextDayPending._id, cost_usd: '0', requested_at: lower },
    { job_id: nextDayPending._id, cost_usd: null, cost_source: 'pending', requested_at: upper },
    { job_id: own._id, cost_usd: null, cost_source: 'pending', requested_at: lower },
    { job_id: own._id, cost_usd: null, requested_at: lower },
  )
  const report = await app.inject('/dashboard?from=2026-11-20&to=2026-11-20')
  assert.equal(report.statusCode, 200, report.body)
  assert.equal(report.json().metrics.unpriced_attempts, 1)
  assert.equal(report.json().series[0].unpriced_attempts, 1)
  const inPeriod = await app.inject('/jobs?date_basis=cost&issue=unpriced&from=2026-11-20&to=2026-11-20')
  assert.equal(inPeriod.statusCode, 200, inPeriod.body)
  assert.deepEqual(inPeriod.json().data.map((row: Row) => row.id), [pending._id])
  const current = await app.inject('/jobs?issue=unpriced')
  assert.equal(current.statusCode, 200, current.body)
  assert.deepEqual(new Set(current.json().data.map((row: Row) => row.id)), new Set([oldPending._id, pending._id, nextDayPending._id]))
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

test('CRM personal-key jobs keep operational usage while excluding legacy costs from lists and details', async t => {
  const { app, rows, job, tables, now } = await fixture(t)
  const own = job({ key_mode: 'own', status: 'ready', completed_at: now })
  const service = job({ key_mode: 'service', status: 'ready', completed_at: now })
  rows.push(own, service)
  const usage = { input: 1200, output: 300 }
  const pricing = { total: '250' }
  const attempt = (row: Row) => ({
    _id: randomUUID(), job_id: row._id, provider: row.provider, model: row.model,
    requested_at: now, status: 'succeeded', usage, cost_usd: '0.375', cost_source: 'estimated',
    pricing_id: 'historical-price', pricing_snapshot: pricing, provider_response_id: 'response-test',
  })
  tables.ai_attempts.push(attempt(own), attempt(service))

  const list = await app.inject('/jobs')
  assert.equal(list.statusCode, 200, list.body)
  const ownRow = list.json().data.find((row: Row) => row.id === own._id)
  assert.equal(ownRow.cost_usd, null)
  assert.equal(ownRow.cost_vnd, null)
  const personal = await app.inject('/jobs?key_mode=own')
  assert.deepEqual(personal.json().data.map((row: Row) => row.id), [own._id])
  const costs = await app.inject('/jobs?date_basis=cost&from=2026-11-20&to=2026-11-20')
  assert.equal(costs.statusCode, 200, costs.body)
  assert.deepEqual(costs.json().data.map((row: Row) => row.id), [service._id])
  const personalCosts = await app.inject('/jobs?date_basis=cost&key_mode=own')
  assert.deepEqual(personalCosts.json().data, [])

  const details = await app.inject(`/jobs/${own._id}`)
  assert.equal(details.statusCode, 200, details.body)
  const body = details.json()
  assert.equal(body.cost_usd, null)
  assert.equal(body.cost_vnd, null)
  assert.equal(body.attempts.length, 1)
  assert.deepEqual(body.attempts[0].usage, usage)
  assert.equal(body.attempts[0].provider_response_id, 'response-test')
  for (const field of ['cost_usd', 'cost_vnd', 'cost_source', 'pricing_id', 'pricing_snapshot']) assert.equal(body.attempts[0][field], null)
  const serviceDetails = await app.inject(`/jobs/${service._id}`)
  assert.equal(serviceDetails.statusCode, 200, serviceDetails.body)
  assert.equal(serviceDetails.json().cost_usd, '0.375000000000')
  assert.equal(serviceDetails.json().attempts[0].cost_vnd, '9375.000000000000')
  assert.deepEqual(serviceDetails.json().attempts[0].pricing_snapshot, pricing)
  assert.equal(tables.ai_attempts[0].cost_usd, '0.375', 'reporting must not mutate stored historical data')
})

test('CRM report cursors reject invalid date prefixes instead of passing invalid dates to MongoDB', async t => {
  const { app } = await fixture(t)
  const cursor = Buffer.from(JSON.stringify(['2026-11-20garbage', randomUUID()])).toString('base64url')
  const response = await app.inject({ method: 'GET', url: `/jobs?cursor=${cursor}` })
  assert.equal(response.statusCode, 400, response.body)
  assert.equal(response.json().error.code, 'invalid_cursor')
})
