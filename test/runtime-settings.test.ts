import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { loadConfig, type Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerSettings } from '../src/api/crm-settings.js'
import { registerSessions } from '../src/api/crm-session.js'
import { installErrorHandler } from '../src/api/errors.js'
import { defaultSettings, effectiveConfig, invalidateSettings, readSettings } from '../src/runtime-settings.js'
import { digest } from '../src/security.js'
import { registerPrices } from '../src/api/crm-prices.js'
import { maintenanceTick } from '../src/worker/maintenance.js'
import { browserBodyHash } from '../src/crm-proof.js'
import { browserProofFixture } from './crm-proof-fixture.js'

type Row = Record<string, any>
function config(): Config {
  const previous = process.env
  process.env = { MONGODB_URI: 'mongodb://127.0.0.1:27017', ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }
  try { return loadConfig() } finally { process.env = previous }
}
function memory() {
  const tables = new Map<string, Row[]>()
  let unavailable = false
  const rows = (name: string) => {
    if (!tables.has(name)) tables.set(name, [])
    return tables.get(name)!
  }
  const matches = (row: Row, filter: Row) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([operator, bound]) => operator === '$gt' ? row[key] > (bound as any)
        : operator === '$lte' ? row[key] <= (bound as any) : false)
    }
    return row[key] === value
  })
  const database = {
    collection(name: string) {
      return {
        async findOne(filter: Row) {
          if (unavailable && name === 'runtime_settings') throw new Error('Database unavailable')
          return structuredClone(rows(name).find(row => matches(row, filter)) ?? null)
        },
        async insertOne(row: Row) {
          if (rows(name).some(value => value._id === row._id)) throw Object.assign(new Error('Duplicate'), { code: 11000 })
          rows(name).push(structuredClone(row))
          return { insertedId: row._id }
        },
        async findOneAndDelete(filter: Row) {
          const index = rows(name).findIndex(row => matches(row, filter))
          if (index < 0) return null
          return structuredClone(rows(name).splice(index, 1)[0])
        },
        async updateOne(filter: Row, update: Row) {
          const row = rows(name).find(value => matches(value, filter))
          if (!row) return { matchedCount: 0 }
          Object.assign(row, structuredClone(update.$set ?? {}))
          for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(value)
          for (const [key, value] of Object.entries(update.$max ?? {})) {
            if (row[key] === undefined || row[key] < (value as any)) row[key] = structuredClone(value)
          }
          return { matchedCount: 1 }
        },
        find(filter: Row) {
          const cursor = { sort() { return cursor }, async toArray() { return structuredClone(rows(name).filter(row => matches(row, filter))) } }
          return cursor
        },
      }
    },
  }
  const db = { db: database } as unknown as Database
  return { db, rows, setUnavailable: (value: boolean) => { unavailable = value }, reconnect: () => ({ db: database } as unknown as Database) }
}

async function fixture(t: test.TestContext) {
  const store = memory()
  const base = config()
  const app = Fastify()
  installErrorHandler(app)
  registerSettings(app, store.db, base)
  await app.ready()
  t.after(() => app.close())
  const save = (revision: number, values: Row) => app.inject({ method: 'PUT', url: '/settings', payload: { revision, values } })
  return { ...store, app, base, save }
}

test('settings starts from environment defaults with retention disabled and exposes no infrastructure secrets', async t => {
  const { app, base, rows } = await fixture(t)
  const response = await app.inject('/settings')
  assert.equal(response.statusCode, 200)
  const result = response.json()
  assert.deepEqual(result.values, defaultSettings(base))
  assert.equal(result.revision, 0)
  assert.equal(result.updated_at, null)
  assert.equal(result.values.job_retention_days, 0)
  assert.equal(result.values.delivery_retention_days, 0)
  assert.equal(result.values.delivery_retry_minutes, 5)
  assert.doesNotMatch(response.body, /encryptionKey|ENCRYPTION_KEY|mongodb|serviceKeys|apiKey|api_key/)
  assert.equal(rows('runtime_settings').length, 0, 'reading never enables cleanup or writes defaults')
})

test('delivery retry interval accepts bounded environment defaults', () => {
  const previous = process.env
  process.env = { MONGODB_URI: 'mongodb://127.0.0.1:27017', ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') }
  try {
    assert.equal(loadConfig().webhookRetryMinutes, 5)
    process.env.WEBHOOK_RETRY_MINUTES = '1440'
    assert.equal(loadConfig().webhookRetryMinutes, 1440)
    for (const value of ['0', '1.5', '1441', 'not-a-number']) {
      process.env.WEBHOOK_RETRY_MINUTES = value
      assert.throws(loadConfig, /WEBHOOK_RETRY_MINUTES/)
    }
  } finally { process.env = previous }
})

test('legacy saved settings gain the five-minute interval without rewriting persisted values', async t => {
  const { app, rows, db, base, save } = await fixture(t)
  const values: Row = defaultSettings(base)
  delete values.delivery_retry_minutes
  rows('runtime_settings').push({ _id: 'crm', revision: 2, updated_at: new Date(), values })
  const response = await app.inject('/settings')
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().values.delivery_retry_minutes, 5)
  assert.equal((await effectiveConfig(db, base)).webhookRetryMinutes, 5)
  assert.equal(rows('runtime_settings')[0].values.delivery_retry_minutes, undefined)
  const saved = await save(2, { ...response.json().values, delivery_retry_minutes: 9 })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(saved.json().values.delivery_retry_minutes, 9)
  assert.equal((await effectiveConfig(db, base)).webhookRetryMinutes, 9)
})

test('settings validates every value, rejects secret/unknown fields and cannot partially overwrite configuration', async t => {
  const { save, base, rows } = await fixture(t)
  const values = defaultSettings(base)
  for (const change of [
    { writer_concurrency: 0 }, { delivery_concurrency: 101 }, { worker_poll_ms: 1 },
    { usd_to_vnd: 1.25 }, { job_retention_days: -1 }, { delivery_retention_days: 3651 },
    { cleanup_interval_minutes: 0 }, { research_enabled: 'false' }, { research_max_results: 9 },
    { writer_max_attempts: 11 }, { webhook_timeout_ms: 0 }, { ai_timeout_ms: 900_001 },
    { delivery_retry_minutes: 0 }, { delivery_retry_minutes: 1.5 }, { delivery_retry_minutes: 1441 },
    { encryption_key: 'must-not-persist' },
    { provider_limits: { ...values.provider_limits, openai: { ...values.provider_limits.openai, concurrency: 0 } } },
  ]) {
    const response = await save(0, { ...values, ...change })
    assert.equal(response.statusCode, 400, response.body)
  }
  assert.equal((await save(0, { usd_to_vnd: 26_000 })).statusCode, 400)
  assert.equal(rows('runtime_settings').length, 0)
})

test('legacy environment values stay readable and cannot turn a successful save into a validation error', async t => {
  const { base, app, save } = await fixture(t)
  const valid = defaultSettings(base)
  base.workerPollMs = 50
  base.workerConcurrency = 101
  const read = await app.inject('/settings')
  assert.equal(read.statusCode, 200, read.body)
  assert.equal(read.json().values.worker_poll_ms, 50)
  assert.equal(read.json().defaults.writer_concurrency, 101)
  const saved = await save(0, valid)
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(saved.json().revision, 1)
  assert.equal((await app.inject('/settings')).json().values.worker_poll_ms, 500)
})

test('atomic revision checks prevent two browsers from overwriting each other including the first save', async t => {
  const { save, base, app, rows } = await fixture(t)
  const values = defaultSettings(base)
  const results = await Promise.all([save(0, { ...values, usd_to_vnd: 26_000 }), save(0, { ...values, usd_to_vnd: 27_000 })])
  assert.deepEqual(results.map(response => response.statusCode).sort(), [200, 409])
  const saved = results.find(response => response.statusCode === 200)!.json()
  assert.equal(saved.revision, 1)
  assert.equal(rows('runtime_settings').length, 1)
  const updated = await save(1, { ...saved.values, writer_concurrency: 8 })
  assert.equal(updated.statusCode, 200, updated.body)
  assert.equal(updated.json().revision, 2)
  const stale = await save(1, values)
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error.code, 'settings_conflict')
  assert.equal((await app.inject('/settings')).json().values.writer_concurrency, 8)
})

test('saved values survive process recreation and each new claim receives an isolated snapshot', async t => {
  const { save, base, db, reconnect, rows } = await fixture(t)
  const before = await effectiveConfig(db, base)
  assert.equal(before.workerConcurrency, 5)
  const values = { ...defaultSettings(base), writer_concurrency: 9, delivery_concurrency: 4, usd_to_vnd: 28_000,
     ai_timeout_ms: 900_000, research_enabled: false, writer_max_attempts: 2, delivery_max_attempts: 7, delivery_retry_minutes: 12 }
  assert.equal((await save(0, values)).statusCode, 200)
  const after = await effectiveConfig(db, base)
  assert.equal(after.workerConcurrency, 9)
  assert.equal(after.webhookConcurrency, 4)
  assert.equal(after.usdToVnd, 28_000)
  assert.equal(after.research.enabled, false)
  assert.equal(after.writerMaxAttempts, 2)
  assert.equal(after.webhookMaxAttempts, 7)
  assert.equal(after.webhookRetryMinutes, 12)
  assert.ok(after.leaseMs > after.aiTimeoutMs + after.research.timeoutMs)
  assert.equal(before.workerConcurrency, 5)
  assert.equal(before.webhookRetryMinutes, 5)
  assert.equal(base.research.enabled, true)
  after.providerLimits.openai.concurrency = 99
  assert.equal((await effectiveConfig(db, base)).providerLimits.openai.concurrency, 10)
  assert.equal(base.providerLimits.openai.concurrency, 10)
  const restarted = await effectiveConfig(reconnect(), { ...base, workerConcurrency: 1 })
  assert.equal(restarted.workerConcurrency, 9)
  assert.equal(restarted.webhookRetryMinutes, 12)
  assert.equal(rows('runtime_settings')[0].values.writer_concurrency, 9)
})

test('expired runtime reads fail closed rather than returning stale settings or environment defaults', async () => {
  const store = memory()
  const base = config()
  await effectiveConfig(store.db, base)
  store.setUnavailable(true)
  invalidateSettings(store.db)
  await assert.rejects(effectiveConfig(store.db, base), /unavailable/)
  await assert.rejects(effectiveConfig(store.db, base), /unavailable/)
  store.setUnavailable(false)
  assert.equal((await effectiveConfig(store.db, base)).workerConcurrency, 5)
  store.rows('runtime_settings').push({ _id: 'crm', revision: 1, values: { writer_concurrency: -1 } })
  invalidateSettings(store.db)
  await assert.rejects(effectiveConfig(store.db, base))
})

test('settings endpoints require a bound CRM session, proof, CSRF and one-use action authorization for writes', async t => {
  const { db, rows } = memory()
  const base = config()
  const token = 'a'.repeat(43)
  const browser = browserProofFixture(base.origin)
  rows('users').push({ _id: 'admin-id', username: 'test-admin' })
  rows('sessions').push({ _id: digest(token), user_id: 'admin-id', csrf_token: 'csrf-test',
    expires_at: new Date(Date.now() + 60_000), ...browser.sessionFields() })
  const app = Fastify()
  t.after(() => app.close())
  installErrorHandler(app)
  await app.register(cookie)
  await app.register(async crm => { registerSessions(crm, db, base); registerSettings(crm, db, base) }, { prefix: '/api/crm' })
  assert.equal((await app.inject('/api/crm/settings')).statusCode, 401)
  const headers = { cookie: 'crm_session=' + token }
  const target = '/api/crm/settings'
  const cookieOnly = await app.inject({ url: target, headers })
  assert.equal(cookieOnly.statusCode, 401)
  assert.equal(cookieOnly.json().error.code, 'browser_proof_required')
  assert.equal((await app.inject({ url: target, headers: { ...headers, 'x-crm-proof': browser.proof('GET', target) } })).statusCode, 200)
  const payload = JSON.stringify({ revision: 0, values: defaultSettings(base) })
  const writeHeaders = () => ({ ...headers, 'content-type': 'application/json', 'x-crm-proof': browser.proof('PUT', target, payload) })
  const noCsrf = await app.inject({ method: 'PUT', url: target, headers: writeHeaders(), payload })
  assert.equal(noCsrf.statusCode, 403)
  assert.equal(noCsrf.json().error.code, 'csrf_invalid')
  const noAction = await app.inject({ method: 'PUT', url: target, headers: { ...writeHeaders(), 'x-csrf-token': 'csrf-test' }, payload })
  assert.equal(noAction.statusCode, 403)
  assert.equal(noAction.json().error.code, 'reauthentication_required')
  const actionToken = 't'.repeat(43)
  rows('crm_action_tokens').push({ _id: digest(actionToken), session_id: digest(token), method: 'PUT',
    target, body_hash: browserBodyHash(payload), expires_at: new Date(Date.now() + 60_000) })
  const saved = await app.inject({ method: 'PUT', url: target, headers: { ...writeHeaders(), 'x-csrf-token': 'csrf-test', 'x-crm-action-token': actionToken }, payload })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(rows('crm_action_tokens').length, 0)
  const replayedAction = await app.inject({ method: 'PUT', url: target, headers: { ...writeHeaders(), 'x-csrf-token': 'csrf-test', 'x-crm-action-token': actionToken }, payload })
  assert.equal(replayedAction.statusCode, 403)
  assert.equal(replayedAction.json().error.code, 'reauthentication_required')
})

test('new CRM prices use the saved runtime exchange rate and preserve the original VND snapshot', async t => {
  const store = memory()
  const base = config()
  const values = { ...defaultSettings(base), usd_to_vnd: 30_000 }
  store.rows('runtime_settings').push({ _id: 'crm', revision: 1, updated_at: new Date(), values })
  store.rows('ai_models').push({ _id: 'model', provider: 'openai' })
  const app = Fastify()
  t.after(() => app.close())
  installErrorHandler(app)
  registerPrices(app, store.db, base, () => effectiveConfig(store.db, base))
  const response = await app.inject({ method: 'POST', url: '/prices', payload: {
    provider: 'openai', model: 'model', source_url: 'https://example.com/prices', effective_at: '2026-11-22T00:00:00Z', total_vnd: '30000',
  } })
  assert.equal(response.statusCode, 201, response.body)
  assert.equal(store.rows('model_prices')[0].rates.total, '1.000000000000')
  assert.equal(store.rows('model_prices')[0].rates.exchange_rate, 30_000)
  assert.equal(store.rows('model_prices')[0].rates.totalVnd, '30000')
})

test('maintenance is disabled by default, waits the configured interval, and claims one shared deadline', async () => {
  const store = memory()
  const base = config()
  let calls = 0
  const cleanup = async () => { calls++; return { jobs: 0, deliveries: 0 } }
  const start = new Date('2026-11-22T00:00:00Z')
  assert.equal(await maintenanceTick(store.db, base, start, cleanup), false)
  assert.equal(store.rows('runtime_maintenance').length, 0)
  store.rows('runtime_settings').push({ _id: 'crm', revision: 1, updated_at: start,
    values: { ...defaultSettings(base), job_retention_days: 30, cleanup_interval_minutes: 5 } })
  assert.equal(await maintenanceTick(store.db, base, start, cleanup), false)
  const due = new Date(start.getTime() + 300_000)
  store.rows('runtime_settings')[0].revision++
  store.rows('runtime_settings')[0].values.usd_to_vnd = 30_000
  assert.deepEqual((await Promise.all([maintenanceTick(store.db, base, due, cleanup), maintenanceTick(store.db, base, due, cleanup)])).sort(), [false, true])
  assert.equal(calls, 1, 'an unrelated operational change does not postpone retention')
  store.rows('runtime_settings')[0].revision++
  store.rows('runtime_settings')[0].values.job_retention_days = 7
  assert.equal(await maintenanceTick(store.db, base, new Date(due.getTime() + 300_000), cleanup), false)
  assert.equal(calls, 1, 'a policy change starts a new interval instead of immediately deleting data')
  assert.equal((await readSettings(store.db, base)).values.job_retention_days, 7)
})
