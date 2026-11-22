import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Database } from '../src/db.js'
import { registerCalendar } from '../src/api/crm-calendar.js'
import { installErrorHandler } from '../src/api/errors.js'

type Row = Record<string, any>
type Read = { collection: string; filter: Row; projection: Row }

function memoryDatabase(tables: Record<string, Row[]>, reads: Read[]): Database {
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([field, expected]) => {
    if (field === '$or') return expected.some((condition: Row) => matches(row, condition))
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      if ('$in' in expected) return expected.$in.includes(row[field])
      if ('$ne' in expected) return row[field] !== expected.$ne
      if ('$gte' in expected || '$lt' in expected) return row[field] != null
        && (!('$gte' in expected) || row[field] >= expected.$gte)
        && (!('$lt' in expected) || row[field] < expected.$lt)
    }
    return row[field] === expected
  })
  return { db: { collection(name: string) {
    assert.ok(['jobs', 'webhook_deliveries'].includes(name), `unexpected collection ${name}`)
    return { find(filter: Row, options: { projection?: Row }) {
      const projection = options.projection ?? {}
      assert.ok(Object.keys(projection).length > 0, 'calendar reads use explicit field allowlists')
      assert.ok(Object.values(projection).every(value => value === 1), 'use positive projections')
      reads.push({ collection: name, filter: structuredClone(filter), projection })
      return { async toArray() { return tables[name].filter(row => matches(row, filter)).map(row =>
        structuredClone(Object.fromEntries(Object.keys(projection).filter(key => key in row).map(key => [key, row[key]])))) } }
    } }
  } } } as unknown as Database
}

async function fixture(t: test.TestContext) {
  const tables = { jobs: [] as Row[], webhook_deliveries: [] as Row[] }
  const reads: Read[] = []
  const customerId = randomUUID(), siteId = randomUUID()
  const app = Fastify()
  installErrorHandler(app)
  registerCalendar(app, memoryDatabase(tables, reads))
  await app.ready()
  t.after(() => app.close())
  const job = (patch: Row = {}) => ({
    _id: randomUUID(), customer_id: customerId, site_id: siteId, status: 'scheduled', scheduled_at: null,
    completed_at: null, key_mode: 'service', encrypted_key: 'private-key', instructions: 'private-prompt',
    result: [{ Content: 'private-article' }], ...patch,
  })
  const delivery = (job: Row, time: string, patch: Row = {}) => ({
    _id: randomUUID(), job_id: job._id, site_id: job.site_id, event: 'article.ready', status: 'delivered',
    delivered_at: new Date(time), error: 'private-provider-response', ...patch,
  })
  return { app, tables, reads, customerId, siteId, job, delivery }
}

test('calendar returns full leap months and 24 empty hours without reading sensitive data', async t => {
  const { app, reads } = await fixture(t)
  const response = await app.inject('/dashboard/calendar?month=2024-02&date=2024-02-29')
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.headers['cache-control'], 'no-store')
  const body = response.json()
  assert.equal(body.timezone, 'Asia/Ho_Chi_Minh')
  assert.deepEqual(body.totals, { scheduled: 0, written: 0, delivered: 0 })
  assert.equal(body.days.length, 29)
  assert.deepEqual(body.days.at(-1), { date: '2024-02-29', scheduled: 0, written: 0, delivered: 0 })
  assert.equal(body.hours.length, 24)
  assert.deepEqual(body.hours.map((row: Row) => row.hour), Array.from({ length: 24 }, (_, i) => i))
  assert.equal(reads.length, 2)
  assert.deepEqual(reads[0].filter.delivered_at, { $gte: new Date('2024-01-31T17:00:00Z'), $lt: new Date('2024-02-29T17:00:00Z') })
  for (const read of reads) for (const field of ['encrypted_key', 'result', 'instructions', 'error']) assert.equal(read.projection[field], undefined)
  assert.deepEqual((await app.inject('/dashboard/calendar?month=2025-02')).json().hours, [])
  assert.equal((await app.inject('/dashboard/calendar?month=2025-02')).json().days.length, 28)
})

test('calendar buckets schedules, successful writing and deliveries by Vietnam time', async t => {
  const { app, tables, job, delivery } = await fixture(t)
  const start = '2026-10-31T17:00:00.000Z', before = '2026-10-31T16:59:59.999Z'
  const end = '2026-11-30T17:00:00.000Z', last = '2026-11-30T16:59:59.999Z'
  const ready = job({ status: 'ready', scheduled_at: new Date(start), completed_at: new Date('2026-11-01T16:59:59.999Z') })
  const done = job({ status: 'completed', scheduled_at: new Date(last), completed_at: new Date(last) })
  const failed = job({ status: 'failed', scheduled_at: new Date('2026-11-01T17:00:00Z'), completed_at: new Date(start) })
  const canceled = job({ status: 'canceled', scheduled_at: new Date(start), completed_at: new Date(start) })
  const prior = job({ status: 'ready', scheduled_at: new Date(before), completed_at: new Date(before) })
  const future = job({ status: 'ready', scheduled_at: new Date(end), completed_at: new Date(end) })
  const immediate = job({ status: 'ready', completed_at: new Date(start), key_mode: 'own' })
  tables.jobs.push(ready, done, failed, canceled, prior, future, immediate)
  tables.webhook_deliveries.push(delivery(prior, start), delivery(done, last), delivery(future, end), delivery(prior, before),
    delivery(ready, start, { event: 'article.failed' }), delivery(failed, start, { status: 'failed' }))
  const response = await app.inject('/dashboard/calendar?month=2026-11&date=2026-11-01')
  assert.equal(response.statusCode, 200, response.body)
  const body = response.json()
  assert.deepEqual(body.totals, { scheduled: 3, written: 3, delivered: 2 })
  assert.deepEqual(body.days[0], { date: '2026-11-01', scheduled: 1, written: 2, delivered: 1 })
  assert.deepEqual(body.days[1], { date: '2026-11-02', scheduled: 1, written: 0, delivered: 0 })
  assert.deepEqual(body.days[29], { date: '2026-11-30', scheduled: 1, written: 1, delivered: 1 })
  assert.deepEqual(body.hours[0], { hour: 0, scheduled: 1, written: 1, delivered: 1 })
  assert.deepEqual(body.hours[23], { hour: 23, scheduled: 0, written: 1, delivered: 0 })
  assert.doesNotMatch(response.body, /private|encrypted_key|instructions|result|error/)
})

test('calendar counts one delivered article per day at its earliest successful hour', async t => {
  const { app, tables, job, delivery } = await fixture(t)
  const article = job({ status: 'ready', completed_at: new Date('2020-01-01T00:00:00Z') })
  tables.jobs.push(article)
  tables.webhook_deliveries.push(delivery(article, '2026-11-01T04:00:00Z'), delivery(article, '2026-11-01T02:00:00Z'),
    delivery(article, '2026-11-01T02:00:00Z'), delivery(article, '2026-11-02T04:00:00Z'),
    delivery(article, '2026-11-01T00:00:00Z', { site_id: randomUUID() }),
    delivery(article, '2026-11-01T00:00:00Z', { job_id: randomUUID() }))
  const body = (await app.inject('/dashboard/calendar?month=2026-11&date=2026-11-01')).json()
  assert.equal(body.totals.delivered, 2)
  assert.equal(body.days[0].delivered, 1)
  assert.equal(body.days[1].delivered, 1)
  assert.equal(body.hours[9].delivered, 1)
  assert.equal(body.hours[11].delivered, 0)
  assert.equal(body.hours.reduce((sum: number, row: Row) => sum + row.delivered, 0), body.days[0].delivered)
})

test('calendar applies customer and website scopes to all metrics including old delivered jobs', async t => {
  const { app, tables, reads, job, delivery, customerId, siteId } = await fixture(t)
  const otherCustomer = randomUUID(), otherSite = randomUUID()
  const own = job({ scheduled_at: new Date('2026-11-20T01:00:00Z'), status: 'ready', completed_at: new Date('2026-11-20T01:00:00Z') })
  const old = job({ status: 'ready', completed_at: new Date('2020-01-01T00:00:00Z') })
  const elsewhere = job({ site_id: otherSite, scheduled_at: own.scheduled_at, completed_at: own.completed_at, status: 'ready' })
  const stranger = job({ customer_id: otherCustomer, site_id: randomUUID(), scheduled_at: own.scheduled_at, completed_at: own.completed_at, status: 'ready' })
  tables.jobs.push(own, old, elsewhere, stranger)
  tables.webhook_deliveries.push(...[own, old, elsewhere, stranger].map(row => delivery(row, '2026-11-20T02:00:00Z')))
  const selected = (await app.inject(`/dashboard/calendar?month=2026-11&customer_id=${customerId}&website_id=${siteId}`)).json()
  assert.deepEqual(selected.totals, { scheduled: 1, written: 1, delivered: 2 })
  assert.equal(reads[0].filter.site_id, siteId)
  assert.equal(reads[1].filter.customer_id, customerId)
  assert.equal(reads[1].filter.site_id, siteId)
  const customer = (await app.inject(`/dashboard/calendar?month=2026-11&customer_id=${customerId}`)).json()
  assert.deepEqual(customer.totals, { scheduled: 2, written: 2, delivered: 3 })
  const mismatch = (await app.inject(`/dashboard/calendar?month=2026-11&customer_id=${otherCustomer}&website_id=${siteId}`)).json()
  assert.deepEqual(mismatch.totals, { scheduled: 0, written: 0, delivered: 0 })
})

test('calendar aggregation is not capped by CRM list pagination', async t => {
  const { app, tables, job, delivery } = await fixture(t)
  const rows = Array.from({ length: 301 }, () => job({
    scheduled_at: new Date('2026-11-20T01:00:00Z'), status: 'ready', completed_at: new Date('2026-11-20T02:00:00Z'),
  }))
  tables.jobs.push(...rows)
  tables.webhook_deliveries.push(...rows.map(row => delivery(row, '2026-11-20T03:00:00Z')))
  const body = (await app.inject('/dashboard/calendar?month=2026-11&date=2026-11-20')).json()
  assert.deepEqual(body.totals, { scheduled: 301, written: 301, delivered: 301 })
  assert.equal(body.hours[8].scheduled, 301)
  assert.equal(body.hours[9].written, 301)
  assert.equal(body.hours[10].delivered, 301)
})

test('calendar rejects invalid months, impossible dates, mismatched days and invalid scopes', async t => {
  const { app, reads } = await fixture(t)
  for (const query of ['', 'month=2026-13', 'month=2026-00', 'month=0000-01', 'month=26-11', 'month=2026-11&date=2026-11-31',
    'month=2025-02&date=2025-02-29', 'month=2026-11&date=2026-12-01', 'month=2026-11&customer_id=invalid', 'month=2026-11&website_id=invalid']) {
    const response = await app.inject(`/dashboard/calendar?${query}`)
    assert.equal(response.statusCode, 400, `${query}: ${response.body}`)
  }
  assert.equal(reads.length, 0, 'validation happens before database reads')
})
