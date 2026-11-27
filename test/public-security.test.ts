import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { registerPublic } from '../src/api/public.js'
import { installErrorHandler } from '../src/api/errors.js'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { digest, seal } from '../src/security.js'
import { decodeOwnConnection } from '../src/own-connection.js'
import { siteProofMessage } from '../src/site-proof.js'
import { buildWidgetPreviewApp } from '../src/widget-preview-app.js'
import { WIDGET_REQUEST_BODY_LIMIT } from '../src/widget-limits.js'

type Row = Record<string, any>
type Tables = Record<string, Row[]>
type Session = { working?: Tables }
type Options = { session?: Session, limit?: number, maxTimeMS?: number, projection?: Row }

async function fixture(t: test.TestContext, limit = 2, keyMode: 'own' | 'service' = 'own', limited = false) {
  const token = 'public-security-fixture-site-token'
  const customerId = randomUUID()
  const siteId = randomUUID()
  const secondSiteId = randomUUID()
  const calls: { table: string, action: string, filter: Row, options?: Options }[] = []
  const tables: Tables = {
    sites: [siteId, secondSiteId].map(_id => ({ _id, customer_id: customerId, domain: 'example.com', token_hash: digest(token), webhook_url: 'https://example.com/webhook', webhook_secret: 'encrypted-fixture-secret' })),
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
        async insertOne(row: Row, options?: Options) {
          record('insertOne', {}, options)
          if (rows(options).some(existing => existing._id === row._id)) throw Object.assign(new Error('Duplicate key'), { code: 11000 })
          rows(options).push(structuredClone(row)); return { insertedId: row._id }
        },
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
  if (limited) await app.register(rateLimit, { global: false })
  installErrorHandler(app)
  const config = { maxPendingJobsPerCustomer: limit, encryptionKey: Buffer.alloc(32, 17), serviceKeys: { openai: 'fixture-service-key' } } as unknown as Config
  registerPublic(app, db, config)
  await app.ready()
  const headers = { authorization: 'Bearer ' + token }
  const writing = { model: 'test-model', keyword: 'Thiết kế website', tone: 'Chuyên nghiệp', style: 'Hướng dẫn', length: 1500, ...(keyMode === 'own' ? { base_url: 'https://personal-ai.example.com/v1', api_key: 'fixture-own-key' } : {}) }
  const create = (id: string = randomUUID(), payload: Row = writing) => app.inject({ method: 'POST', url: '/v1/article-jobs', headers: { ...headers, 'idempotency-key': id }, payload })
  const grant = (expires = Math.floor(Date.now() / 1000) + 3500, origin = 'https://example.com', id = siteId) => ({
    origin, 'x-widget-expires': String(expires),
    'x-widget-signature': createHmac('sha256', digest(token)).update(`widget\n${id}\n${origin}\n${expires}`).digest('hex'),
  })
  return { app, db, config, tables, calls, headers, create, writing, customerId, siteId, secondSiteId, grant, beforeTransaction(fn: () => void) { beforeTransaction = fn } }
}

test('signed widgets and the demo accept long UTF-8 translation snapshots while enforcing the shared byte limit', async t => {
  const f = await fixture(t, 10, 'service')
  const site = f.tables.sites[0]
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  site.proof_required = true
  site.signing_public_key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const origin = 'https://example.com'
  const widgetUrl = `/v1/widget/${f.siteId}/previews`
  const widgetHeaders = (body: string, id: string) => {
    const created = String(Math.floor(Date.now() / 1000))
    const nonce = randomBytes(16).toString('hex')
    const message = siteProofMessage({ id: f.siteId, token_hash: site.token_hash }, 'POST', widgetUrl, origin, body, id, '', created, nonce)
    const proof = `${created}.${nonce}.${sign('sha256', Buffer.from(message), keys.privateKey).toString('base64url')}`
    return { origin, 'content-type': 'application/json', 'idempotency-key': id, 'x-site-proof': proof }
  }
  const csrfToken = 'c'.repeat(43)
  const password = 'demo:body-limit-test'
  const demo = await buildWidgetPreviewApp(f.db, f.config, { origin, siteId: f.siteId, csrfToken, passwordHash: digest(password) })
  t.after(() => demo.close())
  const demoHeaders = (_body: string, id: string) => ({
    host: 'example.com', origin, 'x-csrf-token': csrfToken, 'idempotency-key': id,
    authorization: 'Basic ' + Buffer.from(password).toString('base64'), 'content-type': 'application/json',
  })
  const source = { Title: 'Bản gốc tiếng Việt đã duyệt', Content: '<p>Nội dung tiếng Việt, tiếng Nhật 日本語 và HTML đầy đủ.</p>'.repeat(1700) }
  const payload = JSON.stringify({ ...f.writing, languages: { source: 'vi', targets: ['en'] }, locale: 'en', translation_source: source, use_research: false })
  assert.ok(Buffer.byteLength(payload) > 16 * 1024)
  assert.ok(Buffer.byteLength(payload) < WIDGET_REQUEST_BODY_LIMIT)
  for (const { app, url, headers, prefix } of [
    { app: f.app, url: widgetUrl, headers: widgetHeaders, prefix: 'signed' },
    { app: demo, url: '/admin/ai/previews', headers: demoHeaders, prefix: 'demo' },
  ]) {
    const accepted = await app.inject({ method: 'POST', url, headers: headers(payload, prefix), payload })
    assert.equal(accepted.statusCode, 202, accepted.body)
    const job = f.tables.jobs.find(row => row._id === accepted.json().job_id)!
    assert.deepEqual(job.translation_source, source, 'keep the complete approved UTF-8 HTML snapshot')
    assert.equal(job.locale, 'en')
    const jobsBeforeInvalid = f.tables.jobs.length
    const reservationsBeforeInvalid = f.tables.quota_reservations.length
    const atLimit = '{"padding":"' + 'x'.repeat(WIDGET_REQUEST_BODY_LIMIT - 14) + '"}'
    assert.equal(Buffer.byteLength(atLimit), WIDGET_REQUEST_BODY_LIMIT)
    const parsed = await app.inject({ method: 'POST', url, headers: headers(atLimit, prefix + '-at-limit'), payload: atLimit })
    assert.equal(parsed.statusCode, 400, parsed.body)
    assert.equal(parsed.json().error.code, 'invalid_request', 'the inclusive limit still reaches schema validation')
    const tooLarge = atLimit.replace('"}', 'x"}')
    assert.equal(Buffer.byteLength(tooLarge), WIDGET_REQUEST_BODY_LIMIT + 1)
    const rejected = await app.inject({ method: 'POST', url, headers: headers(tooLarge, prefix + '-over-limit'), payload: tooLarge })
    assert.equal(rejected.statusCode, 413, rejected.body)
    assert.equal(f.tables.jobs.length, jobsBeforeInvalid, 'rejected requests never create jobs or reserve quota')
    assert.equal(f.tables.quota_reservations.length, reservationsBeforeInvalid)
  }
  assert.equal(f.tables.jobs.length, 2)
})

test('language jobs preserve source and target configuration, validate translation snapshots and reserve each request once', async t => {
  const f = await fixture(t, 10, 'service')
  const languages = { source: 'en', targets: ['vi', 'ja'] }
  const source = await f.create('source-en', { ...f.writing, languages, locale: 'en' })
  assert.equal(source.statusCode, 202, source.body)
  assert.deepEqual(f.tables.jobs[0].languages, languages)
  assert.equal(f.tables.jobs[0].locale, 'en')
  for (const extra of [{ locale: 'fr' }, { locale: 'vi' }, { locale: 'en', translation_source: { Title: 'X', Content: '<p>X</p>' } }]) {
    const response = await f.create(randomUUID(), { ...f.writing, languages, ...extra })
    assert.equal(response.statusCode, 400, response.body)
  }
  const translation_source = { Title: 'Reviewed source', Content: '<p>Final English text 123.</p>' }
  const payload = { ...f.writing, languages, locale: 'ja', translation_source, use_research: false }
  const translated = await f.create('translation-ja', payload)
  assert.equal(translated.statusCode, 202, translated.body)
  assert.deepEqual(translated.json().languages, languages)
  assert.equal(translated.json().locale, 'ja')
  assert.equal(translated.json().translation_source, undefined)
  const status = await f.app.inject({ url: '/v1/article-jobs/' + translated.json().job_id, headers: f.headers })
  assert.equal(status.statusCode, 200)
  assert.equal(status.json().locale, 'ja')
  assert.equal(status.json().translation_source, undefined, 'polls return metadata, not the full source snapshot')
  const retry = await f.create('translation-ja', payload)
  assert.equal(retry.json().job_id, translated.json().job_id)
  assert.equal(f.tables.jobs.length, 2)
  assert.equal(f.tables.quota_reservations.length, 2)
  assert.deepEqual(f.tables.jobs[1].translation_source, translation_source)
  const conflict = await f.create('translation-ja', { ...payload, locale: 'vi' })
  assert.equal(conflict.statusCode, 409)
  const duplicate = await f.create('duplicate-language', { ...f.writing, languages: { source: 'en', targets: ['EN'] } })
  assert.equal(duplicate.statusCode, 400)
})

test('article identities link source, translations and retries within one website without relying on request order', async t => {
  const f = await fixture(t, 30, 'service')
  const languages = { source: 'en', targets: ['vi', 'ja'] }
  const source = await f.create('article-original', { ...f.writing, article_ref: 'news:7', languages, locale: 'en' })
  assert.equal(source.statusCode, 202, source.body)
  const root = source.json().job_id
  f.tables.jobs.find(row => row._id === root)!.status = 'ready'
  assert.equal(source.json().original_job_id, root)
  const otherToken = 'other-website-group-token'
  const otherSite = f.tables.sites.find(row => row._id === f.secondSiteId)!
  otherSite.token_hash = digest(otherToken)
  const other = await f.app.inject({ method: 'POST', url: '/v1/article-jobs', headers: { authorization: 'Bearer ' + otherToken, 'idempotency-key': 'other-website' }, payload: { ...f.writing, article_ref: 'news:7', languages, locale: 'en' } })
  assert.equal(other.statusCode, 202, other.body)
  assert.notEqual(other.json().article_group_id, source.json().article_group_id)
  const body = { ...f.writing, article_ref: 'news:7', languages, locale: 'ja', translation_of_job_id: root, translation_source: { Title: 'Approved English', Content: '<p>Reviewed content.</p>' } }
  const ja = await f.create('article-ja', body)
  const vi = await f.create('article-vi', { ...body, locale: 'vi' })
  assert.equal(ja.statusCode, 202, ja.body)
  assert.equal(vi.statusCode, 202, vi.body)
  assert.equal(ja.json().article_group_id, root)
  assert.equal(vi.json().original_job_id, root)
  assert.equal(vi.json().translation_of_job_id, root)
  const replay = await f.create('article-ja', body)
  assert.equal(replay.json().job_id, ja.json().job_id)
  const before = f.tables.jobs.length
  const crossing = await f.app.inject({ method: 'POST', url: '/v1/article-jobs', headers: { authorization: 'Bearer ' + otherToken, 'idempotency-key': 'crossed-parent' }, payload: body })
  assert.equal(crossing.statusCode, 404, crossing.body)
  const wrongReference = await f.create('wrong-reference', { ...body, article_ref: 'news:99' })
  assert.equal(wrongReference.statusCode, 409)
  assert.equal(f.tables.jobs.length, before)
  assert.equal(f.tables.quota_reservations.length, before)
})

test('concurrent originals and translations from a manual source keep a stable article group', async t => {
  const f = await fixture(t, 30, 'service')
  const languages = { source: 'ja', targets: ['vi', 'en'] }
  const manual = await f.create('manual-first', { ...f.writing, article_ref: 'news:manual', languages, locale: 'vi', translation_source: { Title: '手入力の原稿', Content: '<p>手入力の内容です。</p>' } })
  assert.equal(manual.statusCode, 202, manual.body)
  assert.equal(manual.json().original_job_id, null)
  const [a, b] = await Promise.all(['original-a', 'original-b'].map(id => f.create(id, { ...f.writing, article_ref: 'news:manual', languages, locale: 'ja' })))
  assert.equal(a.statusCode, 202, a.body)
  assert.equal(b.statusCode, 202, b.body)
  assert.equal(a.json().article_group_id, manual.json().article_group_id)
  assert.equal(b.json().article_group_id, a.json().article_group_id)
  assert.equal(b.json().original_job_id, a.json().job_id)
})

test('site model catalog returns the current key mode without exposing credentials', async t => {
  for (const mode of ['own', 'service'] as const) await t.test(mode, async t => {
    const f = await fixture(t, 2, mode)
    f.tables.ai_models[0].display_name = 'Test model'
    const read = () => f.app.inject({ method: 'GET', url: '/v1/models', headers: f.headers })
    const response = await read()
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(response.json(), { key_mode: mode, data: [{ provider: 'openai', model: 'test-model', display_name: 'Test model' }] })
    f.tables.customers[0].key_mode = mode === 'own' ? 'service' : 'own'
    assert.equal((await read()).json().key_mode, f.tables.customers[0].key_mode, 'a package change is reflected immediately')
    assert.equal((await f.app.inject({ method: 'GET', url: '/v1/models' })).statusCode, 401)
    assert.equal(f.tables.jobs.length, 0)
  })
})

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

test('own connections force OpenAI Compatible and use private model names without the CRM catalog', async t => {
  const f = await fixture(t)
  f.tables.ai_models = []
  f.tables.ai_providers = []
  const response = await f.create('own-compatible', { ...f.writing, provider: 'anthropic', model: 'my-team/custom-model:free@latest', base_url: 'https://personal-ai.example.com/v1/' })
  assert.equal(response.statusCode, 202, response.body)
  const job = f.tables.jobs[0]
  assert.equal(job.provider, 'openai-compatible')
  assert.equal(job.model, 'my-team/custom-model:free@latest')
  assert.deepEqual(decodeOwnConnection(job.encrypted_key, Buffer.alloc(32, 17)), { apiKey: 'fixture-own-key', baseUrl: 'https://personal-ai.example.com/v1' })
  assert.doesNotMatch(JSON.stringify(job), /fixture-own-key|personal-ai\.example\.com/)
  assert.equal(f.tables.quota_reservations.length, 0)
  assert.equal(f.calls.some(call => ['ai_models', 'ai_providers'].includes(call.table)), false)
  const read = await f.app.inject({ url: `/v1/article-jobs/${job._id}`, headers: f.headers })
  assert.equal(read.statusCode, 200, read.body)
  assert.doesNotMatch(read.body + response.body, /fixture-own-key|personal-ai\.example\.com|encrypted_key|base_url/)
})

test('own connections reject missing credentials and unsafe base URLs before storing a job', async t => {
  const f = await fixture(t)
  const { api_key: _key, base_url: _base, ...withoutConnection } = { ...f.writing, api_key: 'fixture-own-key', base_url: 'https://personal-ai.example.com/v1' }
  for (const [name, payload, code] of [
    ['missing key', { ...withoutConnection, base_url: _base }, 'key_required'],
    ['missing base URL', { ...withoutConnection, api_key: _key }, 'base_url_required'],
    ['conflicting keys', { ...f.writing, keyAI: 'different-key' }, 'conflicting_keys'],
  ] as const) {
    const response = await f.create(name.replaceAll(' ', '-'), payload)
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(response.json().error.code, code)
  }
  for (const base_url of ['http://api.example.com/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://10.0.0.2/v1', 'https://[::1]/v1', 'https://user:secret@example.com/v1', 'https://api.example.com/v1?key=secret', 'https://api.example.com/v1#fragment', 'https://api.example.com/v1?', 'https://api.example.com/v1#']) {
    const response = await f.create(randomUUID(), { ...f.writing, base_url })
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(response.json().error.code, 'invalid_request')
  }
  assert.equal(f.tables.jobs.length, 0)
})

test('service customers cannot override the connection with a personal Base URL', async t => {
  const f = await fixture(t, 2, 'service')
  const response = await f.create('service-endpoint-override', { ...f.writing, base_url: 'https://personal-ai.example.com/v1' })
  assert.equal(response.statusCode, 400, response.body)
  assert.equal(response.json().error.code, 'personal_key_not_allowed')
  assert.equal(f.tables.jobs.length, 0)
  assert.equal(f.tables.quota_reservations.length, 0)
})

test('quota customers can explicitly choose their own connection without consuming service quota', async t => {
  const f = await fixture(t, 2, 'service')
  f.tables.ai_models = []
  f.tables.ai_providers = []
  f.tables.customers[0].daily_limit = 0
  f.tables.customers[0].monthly_limit = 0
  const payload = { ...f.writing, key_mode: 'own', model: 'private/custom-model', base_url: 'https://own.example.com/v1', api_key: 'personal-fixture-key' }
  const response = await f.create('quota-own', payload)
  assert.equal(response.statusCode, 202, response.body)
  const job = f.tables.jobs[0]
  assert.equal(job.key_mode, 'own')
  assert.equal(job.provider, 'openai-compatible')
  assert.equal(job.model, 'private/custom-model')
  assert.deepEqual(decodeOwnConnection(job.encrypted_key, Buffer.alloc(32, 17)), { apiKey: 'personal-fixture-key', baseUrl: 'https://own.example.com/v1' })
  assert.equal(f.tables.quota_reservations.length, 0)
  assert.equal(f.calls.some(call => ['ai_models', 'ai_providers'].includes(call.table)), false)
  assert.doesNotMatch(response.body, /personal-fixture-key|own\.example\.com|encrypted_key/)
  const replay = await f.create('quota-own', payload)
  assert.equal(replay.statusCode, 202, replay.body)
  assert.equal(replay.json().job_id, response.json().job_id)
  const conflict = await f.create('quota-own', { ...f.writing, key_mode: 'service' })
  assert.equal(conflict.statusCode, 409, conflict.body)
  assert.equal(conflict.json().error.code, 'idempotency_conflict')
})

test('service selection reserves quota and rejects personal credential fields', async t => {
  const f = await fixture(t, 2, 'service')
  const rejected = await f.create('service-with-key', { ...f.writing, key_mode: 'service', base_url: 'https://own.example.com/v1', api_key: 'personal-fixture-key' })
  assert.equal(rejected.statusCode, 400, rejected.body)
  assert.equal(rejected.json().error.code, 'personal_key_not_allowed')
  const accepted = await f.create('explicit-service', { ...f.writing, key_mode: 'service' })
  assert.equal(accepted.statusCode, 202, accepted.body)
  assert.equal(f.tables.jobs[0].key_mode, 'service')
  assert.equal(f.tables.jobs[0].encrypted_key, null)
  assert.equal(f.tables.quota_reservations.length, 1)
})

test('own-only customers cannot request service entitlement', async t => {
  const f = await fixture(t)
  const response = await f.create('own-service-upgrade', { ...f.writing, key_mode: 'service' })
  assert.equal(response.statusCode, 403, response.body)
  assert.equal(response.json().error.code, 'service_not_allowed')
  assert.equal(f.tables.jobs.length, 0)
  assert.equal(f.tables.quota_reservations.length, 0)
})

test('quota customers keep a scheduled personal connection and cannot switch its charging mode', async t => {
  const f = await fixture(t, 2, 'service')
  const response = await f.create('scheduled-quota-own', { ...f.writing, key_mode: 'own', model: 'private/model', base_url: 'https://own.example.com/v1', api_key: 'personal-fixture-key', mode: 'scheduled', scheduled_at: '2099-01-01T00:00:00Z' })
  assert.equal(response.statusCode, 202, response.body)
  const id = response.json().job_id
  const before = structuredClone(f.tables.jobs[0])
  const rejected = await f.app.inject({ method: 'PATCH', url: `/v1/schedules/${id}`, headers: { ...f.headers, 'if-match': '1' }, payload: { key_mode: 'service', model: 'test-model' } })
  assert.equal(rejected.statusCode, 409, rejected.body)
  assert.equal(rejected.json().error.code, 'key_mode_not_editable')
  assert.deepEqual(f.tables.jobs[0], before)
  const edited = await f.app.inject({ method: 'PATCH', url: `/v1/schedules/${id}`, headers: { ...f.headers, 'if-match': '1' }, payload: { key_mode: 'own', tone: 'Updated tone' } })
  assert.equal(edited.statusCode, 200, edited.body)
  assert.equal(f.tables.jobs[0].key_mode, 'own')
  assert.deepEqual(decodeOwnConnection(f.tables.jobs[0].encrypted_key, Buffer.alloc(32, 17)), decodeOwnConnection(before.encrypted_key, Buffer.alloc(32, 17)))
  assert.equal(f.tables.quota_reservations.length, 0)
})

test('scheduled own connections preserve their endpoint on edits and replace only submitted connection fields', async t => {
  const f = await fixture(t)
  const response = await f.create('scheduled-own', { ...f.writing, mode: 'scheduled', scheduled_at: '2099-01-01T00:00:00Z' })
  assert.equal(response.statusCode, 202, response.body)
  const id = response.json().job_id
  const change = (version: number, payload: Row) => f.app.inject({ method: 'PATCH', url: `/v1/schedules/${id}`, headers: { ...f.headers, 'if-match': String(version) }, payload })
  const edit = await change(1, { model: 'another/private-model', tone: 'Thân thiện' })
  assert.equal(edit.statusCode, 200, edit.body)
  assert.equal(f.tables.jobs[0].model, 'another/private-model')
  const before = structuredClone(f.tables.jobs[0])
  const redirect = await change(2, { base_url: 'https://attacker.example.com/v1' })
  assert.equal(redirect.statusCode, 400, redirect.body)
  assert.equal(redirect.json().error.code, 'key_required_for_endpoint_change')
  assert.deepEqual(f.tables.jobs[0], before, 'endpoint cannot redirect an unknown encrypted key')
  const replacement = await change(2, { api_key: 'fixture-new-own-key', base_url: 'https://new-ai.example.com/api/v1/' })
  assert.equal(replacement.statusCode, 200, replacement.body)
  assert.deepEqual(decodeOwnConnection(f.tables.jobs[0].encrypted_key, Buffer.alloc(32, 17)), { apiKey: 'fixture-new-own-key', baseUrl: 'https://new-ai.example.com/api/v1' })
  assert.doesNotMatch(replacement.body + edit.body, /fixture-new-own-key|new-ai\.example\.com|encrypted_key/)
  const canceled = await f.app.inject({ method: 'DELETE', url: `/v1/schedules/${id}`, headers: f.headers })
  assert.equal(canceled.statusCode, 204, canceled.body)
  assert.equal(f.tables.jobs[0].encrypted_key, null)
})

test('a complete replacement repairs an unreadable scheduled own connection', async t => {
  const f = await fixture(t)
  const response = await f.create('repair-connection', { ...f.writing, mode: 'scheduled', scheduled_at: '2099-01-01T00:00:00Z' })
  assert.equal(response.statusCode, 202, response.body)
  f.tables.jobs[0].encrypted_key = 'corrupt-ciphertext'
  const repaired = await f.app.inject({ method: 'PATCH', url: `/v1/schedules/${response.json().job_id}`, headers: { ...f.headers, 'if-match': '1' }, payload: { base_url: 'https://repaired-ai.example.com/v1', api_key: 'replacement-fixture-key' } })
  assert.equal(repaired.statusCode, 200, repaired.body)
  assert.deepEqual(decodeOwnConnection(f.tables.jobs[0].encrypted_key, Buffer.alloc(32, 17)), { apiKey: 'replacement-fixture-key', baseUrl: 'https://repaired-ai.example.com/v1' })
})

test('rescheduling preserves a legacy own key and its provider', async t => {
  const f = await fixture(t)
  const scheduledAt = new Date('2099-01-01T00:00:00Z')
  const jobId = randomUUID()
  const encryptedKey = seal('legacy-fixture-key', Buffer.alloc(32, 17))
  f.tables.jobs.push({ _id: jobId, site_id: f.siteId, customer_id: f.customerId,
    mode: 'scheduled', status: 'scheduled', version: 1, scheduled_at: scheduledAt,
    key_mode: 'own', provider: 'anthropic', model: 'legacy-model', encrypted_key: encryptedKey,
    keyword: 'Bài đã lên lịch', tone: 'Thân thiện', style: 'Hướng dẫn', length: 800 })
  const response = await f.app.inject({ method: 'PATCH', url: `/v1/schedules/${jobId}`,
    headers: { ...f.headers, 'if-match': '1' }, payload: { scheduled_at: '2099-01-02T00:00:00Z' } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(f.tables.jobs[0].provider, 'anthropic')
  assert.equal(f.tables.jobs[0].encrypted_key, encryptedKey)
  assert.equal(f.tables.quota_reservations.length, 0)
})

test('own article rewrites accept an independent compatible connection', async t => {
  const f = await fixture(t)
  const articleId = randomUUID()
  f.tables.jobs.push({ _id: articleId, site_id: f.siteId, customer_id: f.customerId, status: 'ready', model: 'private/upstream', keyword: 'Bài gốc', tone: 'Chuyên nghiệp', style: 'Hướng dẫn', length: 1500, use_research: false })
  const rewrite = await f.app.inject({ method: 'POST', url: `/v1/articles/${articleId}/rewrites`, headers: { ...f.headers, 'idempotency-key': 'own-rewrite' }, payload: { base_url: 'https://rewrite-ai.example.com/v1', api_key: 'fixture-rewrite-key' } })
  assert.equal(rewrite.statusCode, 202, rewrite.body)
  const job = f.tables.jobs.find(row => row._id === rewrite.json().job_id)!
  assert.equal(job.provider, 'openai-compatible')
  assert.equal(job.model, 'private/upstream')
  assert.equal(job.use_research, false)
  assert.deepEqual(decodeOwnConnection(job.encrypted_key, Buffer.alloc(32, 17)), { apiKey: 'fixture-rewrite-key', baseUrl: 'https://rewrite-ai.example.com/v1' })
})

test('direct widget catalog requires an origin-bound signed grant and never creates work', async t => {
  const f = await fixture(t, 2, 'service')
  const url = `/v1/widget/${f.siteId}/models`
  const expires = Math.floor(Date.now() / 1000) + 3500
  const response = await f.app.inject({ url, headers: f.grant(expires) })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.headers['access-control-allow-origin'], 'https://example.com')
  assert.equal(response.headers.vary, 'Origin')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['cross-origin-resource-policy'], 'cross-origin')
  assert.equal(response.headers['access-control-allow-credentials'], undefined)
  assert.deepEqual(response.json(), { key_mode: 'service', data: [{ provider: 'openai', model: 'test-model' }], grant_expires_at: expires })
  assert.equal(f.calls.some(call => ['insertOne', 'updateOne'].includes(call.action)), false)
  assert.equal(f.tables.jobs.length, 0)
  for (const headers of [
    { origin: 'https://example.com' },
    { ...f.grant(), 'x-widget-signature': '0'.repeat(64) },
    f.grant(undefined, 'https://another.example.com'),
    f.grant(undefined, 'http://example.com'),
    { ...f.grant(), origin: 'https://example.com:444' },
    { ...f.grant(), origin: 'https://example.com.attacker.example' },
    { ...f.grant(), origin: 'null' },
    { ...f.grant(), origin: 'https://example.com/' },
  ]) {
    const denied = await f.app.inject({ url, headers })
    assert.ok([401, 403].includes(denied.statusCode), denied.body)
    assert.equal(denied.json().data, undefined)
  }
  const expired = await f.app.inject({ url, headers: f.grant(Math.floor(Date.now() / 1000) - 1) })
  assert.equal(expired.statusCode, 401, expired.body)
  assert.equal(expired.json().error.code, 'widget_grant_expired')
  const tooLong = await f.app.inject({ url, headers: f.grant(Math.floor(Date.now() / 1000) + 7200) })
  assert.equal(tooLong.statusCode, 401, tooLong.body)
  const wrongSite = await f.app.inject({ url: `/v1/widget/${f.secondSiteId}/models`, headers: f.grant() })
  assert.equal(wrongSite.statusCode, 401, wrongSite.body)
})

test('widget preflight checks the exact origin, method and permitted headers', async t => {
  const f = await fixture(t)
  const url = `/v1/widget/${f.siteId}/previews`
  const headers = { origin: 'https://example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, idempotency-key, x-widget-expires, x-widget-signature' }
  const allowed = await f.app.inject({ method: 'OPTIONS', url, headers })
  assert.equal(allowed.statusCode, 204, allowed.body)
  assert.equal(allowed.headers['access-control-allow-methods'], 'POST')
  assert.match(String(allowed.headers['access-control-allow-headers']), /x-widget-read-token/)
  assert.equal(allowed.headers['access-control-allow-credentials'], undefined)
  for (const change of [
    { origin: 'https://forged.example' },
    { 'access-control-request-method': 'DELETE' },
    { 'access-control-request-headers': 'authorization' },
  ]) {
    const denied = await f.app.inject({ method: 'OPTIONS', url, headers: { ...headers, ...change } })
    assert.equal(denied.statusCode, 403, denied.body)
  }
  assert.equal(f.tables.jobs.length, 0)
})

test('direct quota widget selects personal or service AI and keeps started results readable after page-grant expiry', async t => {
  const f = await fixture(t, 2, 'service')
  const url = `/v1/widget/${f.siteId}/previews`
  const own = { ...f.writing, key_mode: 'own', model: 'private/model', base_url: 'https://own.example.com/v1', api_key: 'widget-fixture-own-key' }
  const headers = { ...f.grant(), 'idempotency-key': 'widget-own' }
  const response = await f.app.inject({ method: 'POST', url, headers, payload: own })
  assert.equal(response.statusCode, 202, response.body)
  const { job_id: jobId, read_token: readToken } = response.json()
  assert.match(readToken, /^[a-f0-9]{64}$/)
  assert.equal(f.tables.jobs[0].key_mode, 'own')
  assert.equal(f.tables.jobs[0].widget_origin, 'https://example.com')
  assert.equal(f.tables.quota_reservations.length, 0)
  const replay = await f.app.inject({ method: 'POST', url, headers, payload: own })
  assert.equal(replay.json().job_id, jobId)
  assert.equal(replay.json().read_token, readToken)
  assert.equal(f.tables.jobs.length, 1)
  const service = await f.app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': 'widget-service' }, payload: { ...f.writing, key_mode: 'service' } })
  assert.equal(service.statusCode, 202, service.body)
  assert.equal(f.tables.quota_reservations.length, 1)
  const readHeaders = { ...f.grant(Math.floor(Date.now() / 1000) - 1), 'x-widget-read-token': readToken }
  const pending = await f.app.inject({ url: `${url}/${jobId}/result`, headers: readHeaders })
  assert.equal(pending.statusCode, 202, pending.body)
  f.tables.jobs[0].status = 'ready'
  f.tables.jobs[0].completed_at = new Date()
  f.tables.jobs[0].result = [{ Title: 'Widget article', Content: '<p>Written content</p>', Description: 'Description' }]
  const status = await f.app.inject({ url: `${url}/${jobId}`, headers: readHeaders })
  assert.equal(status.statusCode, 200, status.body)
  assert.equal(status.json().status, 'ready')
  assert.equal(status.json().keyword, own.keyword)
  assert.doesNotMatch(status.body, /widget-fixture-own-key|own\.example\.com|encrypted_key|read_token/)
  const result = await f.app.inject({ url: `${url}/${jobId}/result`, headers: readHeaders })
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(result.json()[0].Title, 'Widget article')
  const wrongJob = await f.app.inject({ url: `${url}/${service.json().job_id}`, headers: readHeaders })
  assert.equal(wrongJob.statusCode, 401, wrongJob.body)
  const wrongSite = await f.app.inject({ url: `/v1/widget/${f.secondSiteId}/previews/${jobId}`, headers: readHeaders })
  assert.equal(wrongSite.statusCode, 401, wrongSite.body)
  f.tables.sites[0].token_hash = digest('replacement-site-token')
  const revokedRead = await f.app.inject({ url: `${url}/${jobId}`, headers: readHeaders })
  assert.equal(revokedRead.statusCode, 401, revokedRead.body)
  const revokedGrant = await f.app.inject({ url: `/v1/widget/${f.siteId}/models`, headers: f.grant() })
  assert.equal(revokedGrant.statusCode, 401, revokedGrant.body)
})

test('widget creation is preview-only, validates personal endpoints and checks site changes inside its transaction', async t => {
  const f = await fixture(t)
  const url = `/v1/widget/${f.siteId}/previews`
  const headers = { ...f.grant(), 'idempotency-key': 'widget-safe' }
  for (const change of [
    { mode: 'scheduled', scheduled_at: '2099-01-01T00:00:00Z' },
    { base_url: 'https://127.0.0.1/v1' },
    { base_url: 'http://public.example.com/v1' },
    { base_url: 'https://public.example.com/v1?key=secret' },
    { key_mode: 'service' },
  ]) {
    const response = await f.app.inject({ method: 'POST', url, headers, payload: { ...f.writing, ...change } })
    assert.ok([400, 403].includes(response.statusCode), response.body)
    assert.equal(f.tables.jobs.length, 0)
  }
  f.beforeTransaction(() => { f.tables.sites[0].domain = 'changed.example.com' })
  const changed = await f.app.inject({ method: 'POST', url, headers, payload: f.writing })
  assert.equal(changed.statusCode, 401, changed.body)
  assert.equal(f.tables.jobs.length, 0)
})

test('widget cannot reuse ordinary API jobs or credentials to expose their result', async t => {
  const f = await fixture(t)
  const existing = await f.create('ordinary-api', f.writing)
  assert.equal(existing.statusCode, 202, existing.body)
  const response = await f.app.inject({ method: 'POST', url: `/v1/widget/${f.siteId}/previews`, headers: { ...f.grant(), 'idempotency-key': 'ordinary-api' }, payload: f.writing })
  assert.equal(response.statusCode, 409, response.body)
  const jobId = existing.json().job_id
  const token = createHmac('sha256', f.tables.sites[0].token_hash).update(`widget-read\n${f.siteId}\n${f.customerId}\nhttps://example.com\n${jobId}`).digest('hex')
  const read = await f.app.inject({ url: `/v1/widget/${f.siteId}/previews/${jobId}`, headers: { origin: 'https://example.com', 'x-widget-read-token': token } })
  assert.equal(read.statusCode, 404, read.body)
})

test('widget creation applies the stricter per-site and client rate limit', async t => {
  const f = await fixture(t, 2, 'own', true)
  const input = { method: 'POST' as const, url: `/v1/widget/${f.siteId}/previews`, headers: { ...f.grant(), 'idempotency-key': 'limited-widget' }, payload: f.writing }
  for (let index = 0; index < 12; index++) {
    const response = await f.app.inject(input)
    assert.equal(response.statusCode, 202, response.body)
  }
  const limited = await f.app.inject(input)
  assert.equal(limited.statusCode, 429, limited.body)
  assert.equal(f.tables.jobs.length, 1)
})

test('server-bound sites reject stolen tokens and page grants, bind exact requests and reserve quota once', async t => {
  const f = await fixture(t, 10, 'service')
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const site = f.tables.sites[0]
  site.proof_required = true
  site.signing_public_key = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const url = `/v1/widget/${f.siteId}/previews`
  const payload = JSON.stringify({ ...f.writing, key_mode: 'service' })
  const proofFor = (target: string, body = payload, id = 'signed-once', nonce = randomBytes(16).toString('hex'), created = String(Math.floor(Date.now() / 1000)), method = 'POST', origin = 'https://example.com', ifMatch = '') => {
    const message = siteProofMessage({ id: site._id, token_hash: site.token_hash }, method, target, origin, body, id, ifMatch, created, nonce)
    return `${created}.${nonce}.${sign('sha256', Buffer.from(message), privateKey).toString('base64url')}`
  }
  const headers = { ...f.grant(), 'content-type': 'application/json', 'idempotency-key': 'signed-once' }
  const send = (proof: string | undefined, body = payload, changes: Row = {}) => f.app.inject({ method: 'POST', url, headers: { ...headers, ...(proof ? { 'x-site-proof': proof } : {}), ...changes }, payload: body })
  assert.equal((await send(undefined)).statusCode, 401, 'a copied one-hour page grant cannot create a job')
  assert.equal((await f.create()).statusCode, 401, 'the raw bearer token alone cannot bypass widget protection')
  for (const endpoint of ['/v1/article-jobs', '/v1/articles/' + randomUUID() + '/rewrites', '/v1/site-content']) {
    assert.equal((await f.app.inject({ method: 'POST', url: endpoint, headers: f.headers, payload: {} })).statusCode, 401)
  }
  const proof = proofFor(url)
  assert.equal((await send(proof, JSON.stringify({ ...f.writing, keyword: 'changed' }))).statusCode, 401)
  assert.equal((await send(proof, payload, { 'idempotency-key': 'changed' })).statusCode, 401)
  assert.equal((await send(proof, payload, { origin: 'https://other.example' })).statusCode, 403)
  assert.equal((await send(proofFor(url, payload, 'signed-once', undefined, String(Math.floor(Date.now() / 1000) - 61)))).statusCode, 401)
  const results = await Promise.all([send(proof), send(proof)])
  assert.deepEqual(results.map(response => response.statusCode), [202, 202])
  assert.equal(results[0].json().job_id, results[1].json().job_id)
  assert.equal(f.tables.jobs.length, 1)
  assert.equal(f.tables.quota_reservations.length, 1)
  assert.equal(f.tables.site_request_proofs.length, 1)
  const firstNonce = 'a'.repeat(32)
  assert.equal((await send(proofFor(url, payload, 'second', firstNonce), payload, { 'idempotency-key': 'second' })).statusCode, 202)
  const replay = await send(proofFor(url, payload, 'third', firstNonce), payload, { 'idempotency-key': 'third' })
  assert.equal(replay.statusCode, 409, replay.body)
  assert.equal(replay.json().error.code, 'site_proof_replayed')
  assert.equal(f.tables.jobs.length, 2)
  assert.equal(f.tables.quota_reservations.length, 2)
  // Public API requests bind an empty Origin, their own endpoint and exact JSON bytes.
  const apiHeaders = { ...f.headers, 'content-type': 'application/json', 'idempotency-key': 'server-api',
    'x-site-proof': proofFor('/v1/article-jobs', payload, 'server-api', undefined, undefined, 'POST', '') }
  const api = await f.app.inject({ method: 'POST', url: '/v1/article-jobs', headers: apiHeaders, payload })
  assert.equal(api.statusCode, 202, api.body)
  const changedKeyProof = proofFor(url, payload, 'rotating')
  f.beforeTransaction(() => { f.tables.sites[0].signing_public_key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'pem' }).toString() })
  const rotated = await send(changedKeyProof, payload, { 'idempotency-key': 'rotating' })
  assert.equal(rotated.statusCode, 401, rotated.body)
  assert.equal(f.tables.jobs.length, 3)
})

test('new protected sites fail closed before key enrollment and malformed key data never falls back to bearer auth', async t => {
  const f = await fixture(t, 2, 'service')
  f.tables.sites[0].proof_required = true
  assert.equal((await f.create()).statusCode, 403)
  f.tables.sites[0].signing_public_key = 'unreadable-public-key'
  assert.equal((await f.create()).statusCode, 401)
  assert.equal(f.tables.jobs.length, 0)
  assert.equal(f.tables.quota_reservations.length, 0)
})

test('protected schedule changes, reads and rewrites require fresh proofs and failed transactions preserve nonce and quota', async t => {
  const f = await fixture(t, 10, 'service')
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  f.tables.sites[0].signing_public_key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const request = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body: Row | undefined, id = '', ifMatch = '', nonce = randomBytes(16).toString('hex')) => {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const created = String(Math.floor(Date.now() / 1000))
    const message = siteProofMessage({ id: f.siteId, token_hash: f.tables.sites[0].token_hash }, method, url, '', raw, id, ifMatch, created, nonce)
    return { method, url, payload: raw || undefined, headers: { ...f.headers, ...(body ? { 'content-type': 'application/json' } : {}),
      'idempotency-key': id, ...(ifMatch ? { 'if-match': ifMatch } : {}),
      'x-site-proof': `${created}.${nonce}.${sign('sha256', Buffer.from(message), keys.privateKey).toString('base64url')}` } }
  }
  const create = await f.app.inject(request('POST', '/v1/article-jobs', { ...f.writing, scheduled_at: '2099-01-01T00:00:00Z' }, 'scheduled'))
  assert.equal(create.statusCode, 202, create.body)
  const jobId = create.json().job_id
  const scheduleUrl = `/v1/schedules/${jobId}`
  const patch = request('PATCH', scheduleUrl, { tone: 'Updated' }, '', '1')
  const tamperedVersion = await f.app.inject({ ...patch, headers: { ...patch.headers, 'if-match': '2' } })
  assert.equal(tamperedVersion.statusCode, 401)
  assert.equal((await f.app.inject(patch)).statusCode, 200)
  assert.equal((await f.app.inject(patch)).statusCode, 409)
  const failedNonce = 'b'.repeat(32)
  const failedPatch = await f.app.inject(request('PATCH', scheduleUrl, { tone: 'Failed' }, '', '1', failedNonce))
  assert.equal(failedPatch.statusCode, 412)
  const retryPatch = await f.app.inject(request('PATCH', scheduleUrl, { tone: 'Retried' }, '', '2', failedNonce))
  assert.equal(retryPatch.statusCode, 200, retryPatch.body)
  const listing = request('GET', '/v1/schedules', undefined)
  assert.equal((await f.app.inject(listing)).statusCode, 200)
  assert.equal((await f.app.inject(listing)).statusCode, 409)
  assert.equal((await f.app.inject({ method: 'DELETE', url: scheduleUrl, headers: f.headers })).statusCode, 401)
  const cancel = await f.app.inject(request('DELETE', scheduleUrl, undefined))
  assert.equal(cancel.statusCode, 204, cancel.body)
  assert.equal(f.tables.quota_reservations[0].status, 'released')
  Object.assign(f.tables.jobs[0], { status: 'ready', mode: 'preview' })
  const rewriteUrl = `/v1/articles/${jobId}/rewrites`
  const rewrite = await f.app.inject(request('POST', rewriteUrl, { instructions: 'Rewrite' }, 'rewrite'))
  assert.equal(rewrite.statusCode, 202, rewrite.body)
  assert.equal(f.tables.jobs.length, 2)
})
