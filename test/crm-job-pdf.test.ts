import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerJobPdfRoute } from '../src/api/crm-job-pdf.js'
import { registerSessions } from '../src/api/crm-session.js'
import { installErrorHandler } from '../src/api/errors.js'
import { JobPdfError, type renderJobPdf } from '../src/job-pdf.js'
import { digest } from '../src/security.js'
import { browserProofFixture } from './crm-proof-fixture.js'

type Row = Record<string, any>
const id = '12850dc1-a858-42dd-881a-48daff6bb34a'
const path = `/jobs/${id}/pdf`
const article = { Title: 'Bài viết tiếng Việt', Content: '<h2>Tiêu đề</h2><p>Nội dung.</p>' }
const pdf = Buffer.from('%PDF-1.7\nsynthetic-export\n%%EOF')
type Renderer = typeof renderJobPdf

async function fixture(t: test.TestContext, options: { job?: Row | null, renderer?: Renderer, authenticated?: boolean, limited?: boolean } = {}) {
  const app = Fastify()
  t.after(() => app.close())
  installErrorHandler(app)
  if (options.limited) await app.register(rateLimit, { global: false })
  const origin = 'https://crm.example.test'
  const browser = browserProofFixture(origin)
  const token = randomBytes(32).toString('base64url')
  const session = { _id: digest(token), user_id: 'pdf-admin', csrf_token: 'synthetic-csrf',
    expires_at: new Date(Date.now() + 60_000), ...browser.sessionFields() }
  const job = options.job === undefined ? { _id: id, status: 'ready', result: [article], outline: { title: 'Dàn ý' } } : options.job
  const lookups: { filter: Row, options: Row }[] = []
  const calls: Parameters<Renderer>[] = []
  const proofs = new Set<string>()
  const matchesSession = (filter: Row) => Object.entries(filter).every(([key, expected]) => {
    const actual = session[key as keyof typeof session]
    if (expected && typeof expected === 'object' && '$gt' in expected) return actual instanceof Date && actual > expected.$gt
    return actual === expected
  })
  const db = { db: { collection(name: string) { return {
    async findOne(filter: Row, dbOptions: Row = {}) {
      if (name === 'jobs') { lookups.push({ filter, options: dbOptions }); return job && filter._id === job._id ? structuredClone(job) : null }
      if (name === 'sessions' && matchesSession(filter)) return structuredClone(session)
      if (name === 'users' && filter._id === session.user_id) return { _id: session.user_id, username: 'pdf-admin' }
      return null
    },
    async insertOne(row: Row) {
      assert.equal(name, 'crm_request_proofs')
      if (proofs.has(row._id)) throw Object.assign(new Error('Duplicate proof'), { code: 11000 })
      proofs.add(row._id)
      return { insertedId: row._id }
    },
    async updateOne(filter: Row, update: Row) {
      assert.equal(name, 'sessions')
      if (!matchesSession(filter)) return { matchedCount: 0 }
      if (update.$max.last_active_at > session.last_active_at) session.last_active_at = update.$max.last_active_at
      return { matchedCount: 1 }
    },
  } } } } as unknown as Database
  const renderer: Renderer = async (...args) => {
    calls.push(args)
    return options.renderer ? options.renderer(...args) : { bytes: pdf, filename: 'bai-viet-tieng-viet-12850dc1.pdf' }
  }
  if (options.authenticated) {
    await app.register(cookie)
    await app.register(async crm => {
      registerSessions(crm, db, { origin, secureCookies: false } as Config)
      registerJobPdfRoute(crm, db, renderer)
    }, { prefix: '/api/crm' })
  } else registerJobPdfRoute(app, db, renderer)
  await app.ready()
  return { app, job, lookups, calls, token, browser, target: options.authenticated ? `/api/crm${path}` : path }
}

test('job PDF downloads one attachment using only export fields and the stored outline', async t => {
  const { app, calls, lookups, job } = await fixture(t)
  const response = await app.inject({ method: 'GET', url: path })
  assert.equal(response.statusCode, 200)
  assert.match(response.headers['content-type']!, /^application\/pdf/)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.equal(response.headers['content-disposition'], 'attachment; filename="bai-viet-tieng-viet-12850dc1.pdf"')
  assert.deepEqual(response.rawPayload, pdf)
  assert.deepEqual(lookups, [{ filter: { _id: id }, options: { projection: { _id: 1, status: 1, result: 1, outline: 1 } } }])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0][0], { id, article, outline: job!.outline })
  assert.equal(calls[0][1]?.aborted, false)
})

test('job PDF accepts legacy content without outline or modern SEO metadata', async t => {
  const legacy = { Title: 'Bài cũ', Content: '<p>Nội dung đã lưu.</p>', Desction: 'Mô tả cũ', 'Từ khóa': 'bài cũ' }
  const { app, calls } = await fixture(t, { job: { _id: id, status: 'ready', result: [legacy] } })
  const response = await app.inject({ method: 'GET', url: path })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(calls[0][0], { id, article: legacy, outline: null })
})

test('job PDF validates IDs and does not render absent or unfinished jobs', async t => {
  const invalid = await fixture(t)
  assert.equal((await invalid.app.inject({ method: 'GET', url: '/jobs/not-a-uuid/pdf' })).statusCode, 400)
  assert.equal((await invalid.app.inject({ method: 'HEAD', url: path })).statusCode, 404)
  assert.equal(invalid.lookups.length, 0)
  for (const [job, expected] of [
    [null, 404],
    [{ _id: id, status: 'writing', result: [article] }, 409],
    [{ _id: id, status: 'failed', result: [article] }, 409],
    [{ _id: id, status: 'ready', result: [] }, 409],
    [{ _id: id, status: 'ready' }, 409],
  ] as const) {
    const { app, calls } = await fixture(t, { job })
    const response = await app.inject({ method: 'GET', url: path })
    assert.equal(response.statusCode, expected)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(calls.length, 0)
  }
})

test('job PDF maps renderer failures to bounded generic errors and remains retryable', async t => {
  for (const [error, expected, code] of [
    [new JobPdfError('empty', 'private article text'), 409, 'job_pdf_empty'],
    [new JobPdfError('busy', 'internal pool state'), 503, 'job_pdf_busy'],
    [new JobPdfError('limit', 'internal page count'), 413, 'job_pdf_limit'],
    [new JobPdfError('unavailable', '/private/chromium/path'), 503, 'job_pdf_unavailable'],
    [new Error('/private/browser-launcher secret'), 503, 'job_pdf_unavailable'],
  ] as const) {
    let failed = false
    const { app, calls } = await fixture(t, { renderer: async () => {
      if (!failed) { failed = true; throw error }
      return { bytes: pdf, filename: 'retry.pdf' }
    } })
    const response = await app.inject({ method: 'GET', url: path })
    assert.equal(response.statusCode, expected)
    assert.equal(response.json().error.code, code)
    assert.ok(!response.body.includes(error.message))
    if (code === 'job_pdf_busy') assert.equal(response.headers['retry-after'], '5')
    assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 200)
    assert.equal(calls.length, 2)
  }
})

test('job PDF rejects header injection from alternate renderer filenames', async t => {
  const { app } = await fixture(t, { renderer: async () => ({ bytes: pdf, filename: 'file.pdf"\r\nX-Injected: true' }) })
  const response = await app.inject({ method: 'GET', url: path })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-disposition'], `attachment; filename="bai-viet-${id}.pdf"`)
  assert.equal(response.headers['x-injected'], undefined)
})

test('job PDF rate limits expensive renders to six exports per minute', async t => {
  const { app, calls } = await fixture(t, { limited: true })
  for (let i = 0; i < 6; i++) assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 200)
  assert.equal((await app.inject({ method: 'GET', url: path })).statusCode, 429)
  assert.equal(calls.length, 6)
})

test('job PDF cancels rendering when the download connection closes', { timeout: 10_000 }, async t => {
  let started!: () => void
  let aborted!: () => void
  const didStart = new Promise<void>(resolve => { started = resolve })
  const didAbort = new Promise<void>(resolve => { aborted = resolve })
  const { app } = await fixture(t, { renderer: async (_input, signal) => {
    started()
    await new Promise<void>(resolve => {
      signal!.addEventListener('abort', () => { aborted(); resolve() }, { once: true })
    })
    throw new JobPdfError('unavailable')
  } })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  const controller = new AbortController()
  const request = fetch(`${address}${path}`, { signal: controller.signal }).catch(error => error)
  await didStart
  controller.abort()
  await didAbort
  assert.equal((await request).name, 'AbortError')
})

test('job PDF requires the existing CRM session and matching browser proof before rendering', async t => {
  const { app, calls, lookups, token, browser, target } = await fixture(t, { authenticated: true })
  assert.equal((await app.inject({ method: 'GET', url: target })).statusCode, 401)
  const copiedCookie = { cookie: `crm_session=${token}` }
  assert.equal((await app.inject({ method: 'GET', url: target, headers: copiedCookie })).statusCode, 401)
  const otherBrowser = browserProofFixture('https://crm.example.test')
  assert.equal((await app.inject({ method: 'GET', url: target, headers: { ...copiedCookie, 'x-crm-proof': otherBrowser.proof('GET', target) } })).statusCode, 401)
  assert.equal(calls.length, 0)
  assert.equal(lookups.length, 0)
  const headers = { ...copiedCookie, 'x-crm-proof': browser.proof('GET', target) }
  const response = await app.inject({ method: 'GET', url: target, headers })
  assert.equal(response.statusCode, 200)
  assert.equal(calls.length, 1)
  assert.equal((await app.inject({ method: 'GET', url: target, headers })).statusCode, 401)
  assert.equal(calls.length, 1)
})
