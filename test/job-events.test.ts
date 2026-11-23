import assert from 'node:assert/strict'
import test from 'node:test'
import cookie from '@fastify/cookie'
import Fastify from 'fastify'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerReports } from '../src/api/crm-reports.js'
import { registerSessions } from '../src/api/crm-session.js'
import { installErrorHandler } from '../src/api/errors.js'
import { DatabaseJobEvents, JobEventBroker, jobEvents, type JobEvent } from '../src/job-events.js'
import { digest } from '../src/security.js'
import { browserProofFixture } from './crm-proof-fixture.js'

const jobId = '12850dc1-a858-42dd-881a-48daff6bb34a'
const otherId = '9e18af13-7d6c-4d74-8ead-4c75e706f20c'

function authenticatedStreamStore(token: string, userId: string) {
  const origin = 'https://crm.example.test'
  const browser = browserProofFixture(origin)
  const session = { _id: digest(token), user_id: userId, csrf_token: 'stream-csrf',
    expires_at: new Date(Date.now() + 60_000), ...browser.sessionFields() }
  const proofs = new Set<string>()
  const matches = (filter: Record<string, any>) => Object.entries(filter).every(([name, expected]) => {
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) return session[name as keyof typeof session] instanceof Date &&
      (session[name as keyof typeof session] as Date) > expected.$gt
    return session[name as keyof typeof session] === expected
  })
  const db = { db: { collection(name: string) { return {
    async findOne(filter: Record<string, any>) {
      if (name === 'sessions' && matches(filter)) return structuredClone(session)
      if (name === 'users' && filter._id === userId) return { _id: userId, username: 'stream-admin' }
      return null
    },
    async insertOne(row: Record<string, any>) {
      assert.equal(name, 'crm_request_proofs')
      if (proofs.has(row._id)) throw Object.assign(new Error('Duplicate proof'), { code: 11000 })
      proofs.add(row._id)
      return { insertedId: row._id }
    },
    async updateOne(filter: Record<string, any>, update: Record<string, any>) {
      assert.equal(name, 'sessions')
      if (!matches(filter)) return { matchedCount: 0 }
      assert.ok(update.$max.last_active_at instanceof Date)
      if (update.$max.last_active_at > session.last_active_at) session.last_active_at = update.$max.last_active_at
      return { matchedCount: 1 }
    },
  } } } } as unknown as Database
  const config = { origin, secureCookies: false } as Config
  return { db, config, browser, headers: (target: string) => ({ cookie: `crm_session=${token}`, 'x-crm-proof': browser.proof('GET', target) }) }
}

test('job events isolate subscribers and include ready in job-filtered subscriptions', () => {
  const broker = new JobEventBroker()
  const events: JobEvent[] = []
  const removeThrowing = broker.subscribe(() => { throw new Error('closed') })
  const remove = broker.subscribe(event => events.push(event), jobId)
  broker.publish({ type: 'job.updated', job_id: otherId })
  broker.publish({ type: 'ready' })
  broker.publish({ type: 'job.updated', job_id: jobId })
  assert.deepEqual(events, [{ type: 'ready' }, { type: 'job.updated', job_id: jobId }])
  remove(); removeThrowing()
  assert.equal(broker.size, 0)
})

test('database event feed uses safe invalidation and resumes after reconnecting', async () => {
  const streams: { closed: boolean; resumeToken: any; tryNext(): Promise<any>; close(): Promise<void>; resolve(value: any): void; reject(error: unknown): void }[] = []
  const watches: { pipeline: any[]; options: any }[] = []
  const db = { db: { collection: () => ({ async findOne() { return { job_id: jobId } } }), watch(pipeline: any[], options: any) {
    watches.push({ pipeline, options })
    let nextResolve: (value: any) => void = () => {}
    let nextReject: (error: unknown) => void = () => {}
    const stream = {
      closed: false, resumeToken: { _data: `token-${streams.length}` },
      tryNext() { return new Promise((resolve, reject) => { nextResolve = resolve; nextReject = reject }) },
      async close() { stream.closed = true; nextResolve(null) },
      resolve(value: any) { nextResolve(value) }, reject(error: unknown) { nextReject(error) },
    }
    streams.push(stream)
    return stream
  } } } as unknown as Database
  const warnings: unknown[] = []
  const feed = new DatabaseJobEvents(db, error => warnings.push(error))
  const events: JobEvent[] = []
  feed.subscribe(event => events.push(event), jobId)
  feed.start()
  const turn = () => new Promise(resolve => setImmediate(resolve))
  try {
    streams[0].resolve(null)
    await turn()
    assert.deepEqual(events, [{ type: 'ready' }])
    jobEvents.publish({ type: 'job.updated', job_id: jobId, source: 'local-duplicate' })
    assert.equal(events.length, 1, 'healthy shared stream suppresses duplicate local updates')
    streams[0].resolve({ ns: { coll: 'jobs' }, operationType: 'update', documentKey: { _id: jobId }, fullDocument: { encrypted_key: 'secret', result: ['private'] } })
    await turn()
    assert.deepEqual(events[1], { type: 'job.updated', job_id: jobId })
    streams[0].reject(new Error('temporary network loss'))
    await turn()
    jobEvents.publish({ type: 'job.updated', job_id: jobId, source: 'local-fallback' })
    assert.equal(events[2].source, 'local-fallback')
    await new Promise(resolve => setTimeout(resolve, 1_050))
    assert.equal(streams.length, 2)
    assert.deepEqual(watches[1].options.resumeAfter, { _data: 'token-0' })
    streams[1].resolve(null)
    await turn()
    assert.equal(events[3].type, 'ready', 'reconcile any missed events on reconnect')
    streams[1].resolve({ ns: { coll: 'jobs' }, operationType: 'delete', documentKey: { _id: jobId } })
    await turn()
    assert.deepEqual(events[4], { type: 'job.deleted', job_id: jobId })
    for (const [collection, document] of [
      ['ai_attempts', { job_id: jobId, cost_usd: '1.5', usage: { input: 123 }, error: 'private error' }],
      ['webhook_deliveries', { job_id: jobId, status: 'delivered' }],
      ['webhook_attempts', { delivery_id: 'delivery-test', http_status: 200 }],
    ] as const) {
      streams[1].resolve({ ns: { coll: collection }, operationType: 'update', documentKey: { _id: 'child-record' }, fullDocument: document })
      await turn()
      assert.deepEqual(events.at(-1), { type: 'job.updated', job_id: jobId }, `${collection} invalidates its parent job without exposing related details`)
    }
    assert.equal(events.length, 8)
    assert.equal(warnings.length, 1)
    const pipeline = JSON.stringify(watches[0].pipeline)
    assert.ok(pipeline.includes('writing_stage'))
    assert.ok(pipeline.includes('id_post'))
    assert.ok(pipeline.includes('acknowledged_at'))
    assert.ok(!pipeline.includes('lease_expires_at'))
    assert.deepEqual(watches[0].pipeline.at(-1), { $project: { _id: 1, operationType: 1, documentKey: 1, 'ns.coll': 1, 'fullDocument.job_id': 1, 'fullDocument.delivery_id': 1 } })
  } finally { await feed.close() }
  assert.equal(streams.at(-1)?.closed, true)
})

test('SSE authenticates real HTTP clients, remains live and closes on app shutdown', async () => {
  const token = 'a'.repeat(43)
  const before = jobEvents.size
  const auth = authenticatedStreamStore(token, 'test-user')
  const { db, config } = auth
  const app = Fastify()
  installErrorHandler(app)
  await app.register(cookie)
  await app.register(async crm => {
    registerSessions(crm, db, config)
    registerReports(crm, db, config)
  }, { prefix: '/api/crm' })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const controller = new AbortController()
  try {
    const unauthorized = await fetch(`${address}/api/crm/jobs/events`)
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).error.code, 'session_required')
    const cookieOnly = await fetch(`${address}/api/crm/jobs/events`, { headers: { cookie: `crm_session=${token}` } })
    assert.equal(cookieOnly.status, 401)
    assert.equal((await cookieOnly.json()).error.code, 'browser_proof_required')
    const target = `/api/crm/jobs/events?job_id=${jobId}`
    const response = await fetch(`${address}${target}`, {
      headers: auth.headers(target), signal: controller.signal,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type')!, /text\/event-stream/)
    assert.equal(response.headers.get('x-accel-buffering'), 'no')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin')
    const reader = response.body!.getReader()
    const first = await reader.read()
    assert.match(new TextDecoder().decode(first.value), /event: ready/)
    await new Promise(resolve => setTimeout(resolve, 25))
    jobEvents.publish({ type: 'job.updated', job_id: otherId })
    jobEvents.publish({ type: 'job.updated', job_id: jobId, status: 'completed' })
    const update = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('SSE update did not arrive')), 2_000).unref()),
    ])
    const text = new TextDecoder().decode(update.value)
    assert.match(text, /event: job.updated/)
    assert.match(text, new RegExp(jobId))
    assert.ok(!text.includes(otherId))
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Open SSE prevented app shutdown')), 2_000).unref()),
    ])
    assert.equal((await reader.read()).done, true)
    assert.equal(jobEvents.size, before, 'shutdown releases the local broker subscription')
  } finally { controller.abort(); await app.close() }
})

test('SSE caps each session and releases closed connections for a reconnect', async t => {
  const token = 'b'.repeat(43)
  const auth = authenticatedStreamStore(token, 'stream-admin')
  const { db, config } = auth
  const app = Fastify()
  installErrorHandler(app)
  await app.register(cookie)
  await app.register(async crm => {
    registerSessions(crm, db, config)
    registerReports(crm, db, config)
  }, { prefix: '/api/crm' })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => app.close())
  const controllers: AbortController[] = []
  const open = async () => {
    const controller = new AbortController(); controllers.push(controller)
    return fetch(`${address}/api/crm/jobs/events`, { headers: auth.headers('/api/crm/jobs/events'), signal: controller.signal })
  }
  try {
    for (let i = 0; i < 4; i++) assert.equal((await open()).status, 200)
    const blocked = await open()
    assert.equal(blocked.status, 429)
    assert.equal((await blocked.json()).error.code, 'stream_limit')
    assert.equal(blocked.headers.get('retry-after'), '30')
    controllers[0].abort()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal((await open()).status, 200)
  } finally {
    for (const controller of controllers) controller.abort()
    await app.close()
  }
})
