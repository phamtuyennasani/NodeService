import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerPublic } from '../src/api/public.js'
import { registerPrices } from '../src/api/crm-prices.js'
import { registerReports } from '../src/api/crm-reports.js'
import { installErrorHandler } from '../src/api/errors.js'
import { digest, seal, unseal } from '../src/security.js'

type Row = Record<string, any>
type Tables = Record<string, Row[]>
type Session = { working?: Tables }
type Options = { session?: Session, upsert?: boolean, projection?: Row }
type Read = { collection: string, filter: Row, projection?: Row }

function memoryDatabase(tables: Tables, reads: Read[]): Database {
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([field, expected]) => {
    if (field === '$or') return expected.some((branch: Row) => matches(row, branch))
    const actual = row[field]
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]: [string, any]) => {
        if (operator === '$in') return Array.isArray(actual) ? actual.some(item => value.includes(item)) : value.includes(actual)
        if (operator === '$ne') return actual !== value
        if (operator === '$exists') return Object.hasOwn(row, field) === value
        if (operator === '$gte') return actual != null && actual >= value
        if (operator === '$gt') return actual != null && actual > value
        if (operator === '$lte') return actual != null && actual <= value
        if (operator === '$lt') return actual != null && actual < value
        throw new Error('Unexpected query operator ' + operator)
      })
    }
    return Array.isArray(actual) ? actual.includes(expected) : actual === expected
  })
  const db = { collection(name: string) {
    const rows = (options?: Options) => (options?.session?.working ?? tables)[name] ??= []
    const update = (row: Row, changes: Row) => {
      Object.assign(row, structuredClone(changes.$set ?? {}))
      for (const [key, value] of Object.entries<number>(changes.$inc ?? {})) row[key] = (row[key] ?? 0) + value
    }
    return {
      async findOne(filter: Row, options?: Options) { return structuredClone(rows(options).find(row => matches(row, filter)) ?? null) },
      async countDocuments(filter: Row, options?: Options & { limit?: number }) {
        assert.ok(options?.session?.working)
        return rows(options).filter(row => matches(row, filter)).slice(0, options.limit).length
      },
      find(filter: Row, options?: Options) {
        reads.push({ collection: name, filter: structuredClone(filter), projection: structuredClone(options?.projection) })
        let order: Record<string, number> | undefined
        const cursor = {
          sort(fields: Record<string, number>) { order = fields; return cursor },
          async toArray() { return rows(options).filter(row => matches(row, filter)).sort((a, b) => {
            for (const [field, direction] of Object.entries(order ?? {})) {
              if (a[field] < b[field]) return -direction
              if (a[field] > b[field]) return direction
            }
            return 0
          }).map(row => options?.projection
            ? structuredClone(Object.fromEntries(Object.entries(options.projection).filter(([key, include]) => include && key in row).map(([key]) => [key, row[key]])))
            : structuredClone(row)) },
        }
        return cursor
      },
      async insertOne(row: Row, options?: Options) {
        if (rows(options).some(existing => existing._id === row._id)) throw Object.assign(new Error('Duplicate fixture'), { code: 11000 })
        rows(options).push(structuredClone(row)); return { insertedId: row._id }
      },
      async updateOne(filter: Row, changes: Row, options?: Options) {
        let row = rows(options).find(item => matches(item, filter))
        if (!row && options?.upsert) { row = structuredClone(filter); rows(options).push(row) }
        if (row) update(row, changes)
        return { matchedCount: row ? 1 : 0 }
      },
    }
  } }
  let serial = Promise.resolve()
  const client = {
    async connect() {},
    startSession() {
      const session: Session & { withTransaction: <T>(callback: () => Promise<T>) => Promise<T>, endSession: () => Promise<void> } = {
        async withTransaction<T>(callback: () => Promise<T>) {
          const previous = serial
          let release!: () => void
          serial = new Promise(resolve => { release = resolve })
          await previous
          session.working = structuredClone(tables)
          try {
            const result = await callback()
            Object.assign(tables, session.working)
            return result
          } finally { delete session.working; release() }
        },
        async endSession() {},
      }
      return session
    },
  }
  return { db, client } as unknown as Database
}

async function fixture(t: test.TestContext) {
  const encryptionKey = Buffer.alloc(32, 19)
  const providers = [0, 1].map(index => ({
    _id: `openai-compatible-${randomUUID()}`, display_name: `Connection ${index + 1}`, enabled: true,
    base_url: `https://${index ? '1.1.1.1' : '8.8.8.8'}/provider-${index + 1}/v1`,
    encrypted_api_key: seal(`service-fixture-${index + 1}`, encryptionKey),
  }))
  const models = providers.map(provider => ({ _id: 'model-' + randomUUID(), provider: provider._id, upstream_model: 'gpt-test', display_name: 'GPT test', enabled: true }))
  const customers = models.map((model, index) => ({
    _id: randomUUID(), name: `Customer ${index + 1}`, key_mode: 'service', daily_limit: 10, monthly_limit: 100,
    starts_at: null, ends_at: null, allowed_models: [model._id], max_length: 2500,
  }))
  const tokens = ['fixture-site-token-0001', 'fixture-site-token-0002']
  const sites = customers.map((customer, index) => ({
    _id: randomUUID(), name: `Website ${index + 1}`, customer_id: customer._id, token_hash: digest(tokens[index]),
    webhook_url: null, webhook_secret: null,
  }))
  const tables: Tables = { ai_providers: providers, ai_models: models, customers, sites, jobs: [], quota_reservations: [] }
  const config = { encryptionKey, serviceKeys: {}, usdToVnd: 25_000, workerConcurrency: 5, webhookConcurrency: 3 } as unknown as Config
  const app = Fastify()
  installErrorHandler(app)
  const reads: Read[] = []
  const db = memoryDatabase(tables, reads)
  registerPublic(app, db, config)
  registerPrices(app, db, config)
  registerReports(app, db, config)
  await app.ready()
  t.after(() => app.close())
  const headers = (index = 0) => ({ authorization: 'Bearer ' + tokens[index], 'idempotency-key': randomUUID() })
  const create = (index = 0, fields: Row = {}) => app.inject({ method: 'POST', url: '/v1/article-jobs', headers: headers(index), payload: {
    model: models[index]._id, keyword: 'Nội dung thử nghiệm', tone: 'Chuyên nghiệp', style: 'SEO', length: 1500, ...fields,
  } })
  const catalog = (index = 0) => app.inject({ url: '/v1/models', headers: headers(index) })
  return { app, tables, providers, models, customers, sites, config, reads, headers, create, catalog }
}

test('service grants select the correct compatible connection despite identical upstream model codes', async t => {
  const f = await fixture(t)
  for (const index of [0, 1]) {
    const response = await f.create(index)
    assert.equal(response.statusCode, 202, response.body)
    const saved = f.tables.jobs.find(job => job._id === response.json<Row>().job_id)!
    assert.equal(saved.provider, f.providers[index]._id)
    assert.equal(saved.model, f.models[index]._id)
    assert.equal(saved.customer_id, f.customers[index]._id)
    assert.equal(saved.key_mode, 'service')
    assert.equal(saved.encrypted_key, null)
    const selected = f.tables.ai_providers.find(provider => provider._id === saved.provider)!
    assert.equal(selected.base_url, f.providers[index].base_url)
    assert.equal(unseal(selected.encrypted_api_key, f.config.encryptionKey), `service-fixture-${index + 1}`)
  }
  assert.equal(f.tables.quota_reservations.length, 2)
  assert.notEqual(f.tables.jobs[0].model, f.tables.jobs[1].model)
  assert.notEqual(f.tables.jobs[0].provider, f.tables.jobs[1].provider)
})

test('public catalogs expose connection labels and grants cannot leak across compatible connections', async t => {
  const f = await fixture(t)
  for (const index of [0, 1]) {
    const response = await f.catalog(index)
    assert.equal(response.statusCode, 200, response.body)
    const available = response.json<Row>().data
    assert.equal(available.length, 1)
    assert.equal(available[0].provider, f.providers[index]._id)
    assert.equal(available[0].model, f.models[index]._id)
    assert.equal(available[0].upstream_model, 'gpt-test')
    assert.equal(available[0].provider_display_name, f.providers[index].display_name)
    assert.ok(!response.body.includes('service-fixture-'))
    assert.ok(!response.body.includes('encrypted_api_key'))
  }
  const denied = await f.create(0, { model: f.models[1]._id })
  assert.equal(denied.statusCode, 403)
  assert.equal(denied.json<Row>().error.code, 'model_not_allowed')
  f.tables.ai_providers[0].enabled = false
  assert.deepEqual((await f.catalog()).json<Row>().data, [])
  const disabled = await f.create()
  assert.equal(disabled.statusCode, 400)
  assert.equal(disabled.json<Row>().error.code, 'model_unavailable')
  assert.equal(f.tables.jobs.length, 0)
  assert.equal(f.tables.quota_reservations.length, 0)
})

test('unreadable service keys are excluded from the catalog and rejected before reserving quota', async t => {
  const f = await fixture(t)
  f.tables.ai_providers[0].encrypted_api_key = seal('other-server-fixture-key', Buffer.alloc(32, 29))
  const catalog = await f.catalog()
  assert.equal(catalog.statusCode, 200)
  assert.deepEqual(catalog.json<Row>().data, [])
  // The other connection remains healthy and independent.
  assert.equal((await f.catalog(1)).json<Row>().data.length, 1)
  const response = await f.create()
  assert.equal(response.statusCode, 422, response.body)
  assert.equal(response.json<Row>().error.code, 'service_key_unreadable')
  assert.match(response.json<Row>().error.message, /không giải mã được/)
  assert.ok(!response.body.includes('other-server-fixture-key'))
  assert.ok(!response.body.includes(f.tables.ai_providers[0].encrypted_api_key))
  assert.equal(f.tables.jobs.length, 0)
  assert.equal(f.tables.quota_reservations.length, 0)
})

test('missing service credentials remain distinct from encrypted credentials that cannot be read', async t => {
  const f = await fixture(t)
  delete f.tables.ai_providers[0].encrypted_api_key
  const response = await f.create()
  assert.equal(response.statusCode, 422)
  assert.equal(response.json<Row>().error.code, 'service_key_unavailable')
  assert.equal(f.tables.jobs.length, 0)
  assert.equal(f.tables.quota_reservations.length, 0)
})

test('personal key jobs do not depend on the readability of a provider service credential', async t => {
  const f = await fixture(t)
  f.tables.customers[0].key_mode = 'own'
  f.tables.ai_providers[0].encrypted_api_key = 'unreadable-fixture-ciphertext'
  const catalog = await f.catalog()
  assert.equal(catalog.statusCode, 200)
  assert.equal(catalog.json<Row>().data.length, 2)
  const response = await f.create(0, { provider: f.providers[0]._id, api_key: 'own-fixture-key' })
  assert.equal(response.statusCode, 202, response.body)
  assert.equal(unseal(f.tables.jobs[0].encrypted_key, f.config.encryptionKey), 'own-fixture-key')
  assert.equal(f.tables.quota_reservations.length, 0)
})

test('personal keys require the selected custom model and route identity without changing its endpoint', async t => {
  const f = await fixture(t)
  f.tables.customers[0].key_mode = 'own'
  const response = await f.create(0, { provider: f.providers[1]._id, model: f.models[1]._id, api_key: 'own-fixture-key' })
  assert.equal(response.statusCode, 202, response.body)
  const saved = f.tables.jobs[0]
  assert.equal(saved.provider, f.providers[1]._id)
  assert.equal(saved.model, f.models[1]._id)
  assert.equal(saved.key_mode, 'own')
  assert.notEqual(saved.encrypted_key, 'own-fixture-key')
  assert.equal(unseal(saved.encrypted_key, f.config.encryptionKey), 'own-fixture-key')
  assert.equal(f.tables.ai_providers.find(row => row._id === saved.provider)!.base_url, f.providers[1].base_url)
  assert.equal(f.tables.quota_reservations.length, 0)
  const mismatched = await f.create(0, { provider: f.providers[0]._id, model: f.models[1]._id, api_key: 'own-fixture-key' })
  assert.equal(mismatched.statusCode, 400)
  assert.equal(mismatched.json<Row>().error.code, 'provider_model_mismatch')
  const unknown = await f.create(0, { provider: 'openai-compatible-' + randomUUID(), model: 'unknown-custom-model', api_key: 'own-fixture-key' })
  assert.equal(unknown.statusCode, 400)
  assert.equal(unknown.json<Row>().error.code, 'model_unavailable')
  f.tables.ai_providers[1].enabled = false
  const disabled = await f.create(0, { provider: f.providers[1]._id, model: f.models[1]._id, api_key: 'own-fixture-key' })
  assert.equal(disabled.statusCode, 400)
  assert.equal(disabled.json<Row>().error.code, 'provider_unavailable')
  assert.equal(f.tables.jobs.length, 1)
})

test('custom providers are accepted by job filters and retain independent runtime counters', async t => {
  const f = await fixture(t)
  assert.equal((await f.create(0)).statusCode, 202)
  assert.equal((await f.create(1)).statusCode, 202)
  const now = new Date()
  Object.assign(f.tables.jobs[0], { status: 'writing', started_at: now, lease_token: 'fixture-valid-lease', lease_expires_at: new Date(now.getTime() + 60_000) })
  for (const index of [0, 1]) {
    const response = await f.app.inject('/jobs?provider=' + f.providers[index]._id)
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json<Row>().data.length, 1)
    assert.equal(response.json<Row>().data[0].provider, f.providers[index]._id)
    assert.equal(response.json<Row>().data[0].model, f.models[index]._id)
    assert.equal(response.json<Row>().data[0].provider_display_name, f.providers[index].display_name)
    assert.equal(response.json<Row>().data[0].upstream_model, 'gpt-test')
    assert.ok(!response.body.includes('encrypted_api_key'))
    assert.ok(!response.body.includes('service-fixture-'))
  }
  f.reads.length = 0
  const runtime = await f.app.inject('/dashboard/runtime')
  assert.equal(runtime.statusCode, 200, runtime.body)
  const counters = runtime.json<Row>().providers
  const first = counters.find((row: Row) => row.provider === f.providers[0]._id)
  const second = counters.find((row: Row) => row.provider === f.providers[1]._id)
  assert.equal(first.writing, 1)
  assert.equal(first.active_threads, 1)
  assert.equal(first.queued, 0)
  assert.equal(second.writing, 0)
  assert.equal(second.queued, 1)
  assert.equal(second.active_threads, 0)
  assert.equal(first.display_name, f.providers[0].display_name)
  assert.equal(second.display_name, f.providers[1].display_name)
  assert.equal(runtime.json<Row>().running[0].provider_display_name, f.providers[0].display_name)
  assert.equal(runtime.json<Row>().running[0].upstream_model, 'gpt-test')
  for (const connectionRead of f.reads.filter(read => ['ai_providers', 'ai_models'].includes(read.collection))) {
    assert.ok(connectionRead.projection, 'runtime connection metadata must have a positive projection')
    assert.ok(Object.values(connectionRead.projection).every(include => include === 1))
    assert.ok(!('encrypted_api_key' in connectionRead.projection))
    assert.ok(!('base_url' in connectionRead.projection))
    assert.ok(Array.isArray(connectionRead.filter._id.$in), 'metadata reads target only relevant connections and models')
  }
  assert.ok(!runtime.body.includes('service-fixture-'))
  assert.ok(!runtime.body.includes('encrypted_api_key'))
  assert.ok(!runtime.body.includes('fixture-valid-lease'))
  assert.equal((await f.app.inject('/jobs?provider=not-a-provider')).statusCode, 400)
})

test('custom job details expose readable connection and upstream attempt labels without reading provider credentials', async t => {
  const f = await fixture(t)
  const created = await f.create()
  assert.equal(created.statusCode, 202)
  const job = f.tables.jobs[0]
  f.tables.ai_attempts = [{
    _id: randomUUID(), job_id: job._id, provider: f.providers[0]._id, model: f.models[0]._id,
    stage: 'draft', status: 'succeeded', requested_at: new Date(), finished_at: new Date(), cost_usd: '0.04',
    cost_source: 'catalog', usage: { inputTokens: 20, outputTokens: 40 },
  }]
  f.reads.length = 0
  const detail = await f.app.inject('/jobs/' + job._id)
  assert.equal(detail.statusCode, 200, detail.body)
  const body = detail.json<Row>()
  assert.equal(body.provider, f.providers[0]._id)
  assert.equal(body.provider_display_name, f.providers[0].display_name)
  assert.equal(body.model, f.models[0]._id)
  assert.equal(body.upstream_model, 'gpt-test')
  assert.equal(body.attempts[0].model, f.models[0]._id)
  assert.equal(body.attempts[0].upstream_model, 'gpt-test')
  assert.equal(body.attempts[0].cost_vnd, '1000.000000000000')
  const connectionReads = f.reads.filter(read => ['ai_providers', 'ai_models'].includes(read.collection))
  assert.equal(connectionReads.length, 2)
  assert.deepEqual(connectionReads.find(read => read.collection === 'ai_providers')!.projection, { _id: 1, display_name: 1 })
  assert.deepEqual(connectionReads.find(read => read.collection === 'ai_models')!.projection, { _id: 1, provider: 1, upstream_model: 1 })
  assert.deepEqual(connectionReads.find(read => read.collection === 'ai_providers')!.filter._id.$in, [f.providers[0]._id])
  assert.deepEqual(connectionReads.find(read => read.collection === 'ai_models')!.filter._id.$in, [f.models[0]._id])
  for (const secret of ['service-fixture-', 'encrypted_api_key', f.providers[0].encrypted_api_key, f.providers[1].encrypted_api_key]) assert.ok(!detail.body.includes(secret))
})

test('pricing uses distinct internal models for identical upstream codes and rejects cross-provider rows', async t => {
  const f = await fixture(t)
  const fields = { source_url: 'https://example.com/pricing', effective_at: '2026-11-22T00:00:00+07:00' }
  for (const index of [0, 1]) {
    const response = await f.app.inject({ method: 'POST', url: '/prices', payload: {
      ...fields, provider: f.providers[index]._id, model: f.models[index]._id, total_vnd: String((index + 1) * 1000),
    } })
    assert.equal(response.statusCode, 201, response.body)
    assert.equal(response.json<Row>().provider, f.providers[index]._id)
    assert.equal(response.json<Row>().model, f.models[index]._id)
    const filtered = await f.app.inject('/prices?provider=' + f.providers[index]._id)
    assert.equal(filtered.statusCode, 200, filtered.body)
    assert.equal(filtered.json<Row>().data.length, 1)
    assert.equal(filtered.json<Row>().data[0].total_vnd, String((index + 1) * 1000))
  }
  for (const model of [f.models[0]._id, 'gpt-test']) {
    const rejected = await f.app.inject({ method: 'POST', url: '/prices', payload: { ...fields, provider: f.providers[1]._id, model, total_vnd: '5' } })
    assert.equal(rejected.statusCode, 400)
    assert.equal(rejected.json<Row>().error.code, 'model_provider_mismatch')
  }
  assert.equal(f.tables.model_prices.length, 2)
  const matched = await f.app.inject('/prices?q=gpt-test')
  assert.equal(matched.statusCode, 200, matched.body)
  assert.equal(matched.json<Row>().data.length, 2)
  assert.deepEqual(new Set(matched.json<Row>().data.map((row: Row) => row.model)), new Set(f.models.map(model => model._id)))
  assert.deepEqual((await f.app.inject('/prices?q=unknown-upstream')).json<Row>().data, [])
  const scoped = await f.app.inject('/prices?q=gpt-test&provider=' + f.providers[0]._id)
  assert.equal(scoped.statusCode, 200, scoped.body)
  assert.equal(scoped.json<Row>().data.length, 1)
  assert.equal(scoped.json<Row>().data[0].model, f.models[0]._id)
  const first = (await f.app.inject('/prices?q=gpt-test&limit=1')).json<Row>()
  assert.equal(first.data.length, 1)
  assert.ok(first.next_cursor)
  const next = await f.app.inject('/prices?q=gpt-test&limit=1&cursor=' + encodeURIComponent(first.next_cursor))
  assert.equal(next.statusCode, 200, next.body)
  const second = next.json<Row>()
  assert.equal(second.data.length, 1)
  assert.notEqual(second.data[0].id, first.data[0].id)
  assert.equal(second.next_cursor, null)
  const scopedNext = (await f.app.inject('/prices?q=gpt-test&provider=' + second.data[0].provider + '&cursor=' + encodeURIComponent(first.next_cursor))).json<Row>()
  assert.deepEqual(scopedNext.data.map((row: Row) => row.id), [second.data[0].id])
  const exhaustedScope = (await f.app.inject('/prices?q=gpt-test&provider=' + first.data[0].provider + '&cursor=' + encodeURIComponent(first.next_cursor))).json<Row>()
  assert.deepEqual(exhaustedScope.data, [])
})
