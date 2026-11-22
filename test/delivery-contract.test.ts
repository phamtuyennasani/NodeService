import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { seal } from '../src/security.js'
import { runWebhookOnce } from '../src/worker/delivery.js'
import { webhookHeaders } from '../src/worker/webhook.js'

type Row = Record<string, any>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function memoryDatabase(tables: Record<string, Row[]>, hooks: {
  afterReadExpired?: (delivery: Row | null) => Promise<void>
  beforeInsertAttempt?: () => void
} = {}): Database {
  const activeSessions = new Set<object>()
  const checkSession = (options: Row | undefined) => {
    assert.ok(activeSessions.has(options?.session), 'write must run in an active MongoDB transaction')
  }
  const matches = (row: Row, filter: Row) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$gt' in value) return row[key] > value.$gt
      if ('$gte' in value) return row[key] >= value.$gte
      if ('$lte' in value) return row[key] <= value.$lte
    }
    return row[key] === value
  })
  return {
    db: {
      collection(name: string) {
        const rows = tables[name] ??= []
        const update = (row: Row, changes: Row) => {
          Object.assign(row, structuredClone(changes.$set ?? {}))
          for (const [field, amount] of Object.entries(changes.$inc ?? {})) row[field] += amount
        }
        return {
          async findOne(filter: Row, options?: Row) {
            if (name === 'jobs' || name === 'sites') checkSession(options)
            const row = structuredClone(rows.find(row => matches(row, filter)) ?? null)
            if (name === 'webhook_deliveries' && filter.lease_expires_at?.$lte) await hooks.afterReadExpired?.(row)
            return row
          },
          async findOneAndUpdate(filter: Row, changes: Row, options?: Row) {
            checkSession(options)
            const row = rows.find(row => matches(row, filter))
            if (!row) return null
            update(row, changes)
            return structuredClone(row)
          },
          async insertOne(row: Row, options?: Row) {
            checkSession(options)
            if (name === 'webhook_attempts') hooks.beforeInsertAttempt?.()
            rows.push(structuredClone(row))
          },
          async updateOne(filter: Row, changes: Row, options?: Row) {
            if (!changes.$set?.lease_expires_at || changes.$set?.status) checkSession(options)
            const row = rows.find(row => matches(row, filter))
            if (row) update(row, changes)
            return { matchedCount: row ? 1 : 0 }
          },
          async updateMany(filter: Row, changes: Row, options?: Row) {
            checkSession(options)
            for (const row of rows.filter(row => matches(row, filter))) update(row, changes)
          },
        }
      },
    },
    client: {
      async connect() {},
      startSession() {
        const session = {
          async withTransaction<T>(callback: () => Promise<T>) {
            const snapshot = structuredClone(tables)
            activeSessions.add(session)
            try {
              return await callback()
            } catch (error) {
              for (const [table, rows] of Object.entries(snapshot)) tables[table].splice(0, tables[table].length, ...rows)
              throw error
            } finally {
              activeSessions.delete(session)
            }
          },
          async endSession() {},
        }
        return session
      },
    },
  } as unknown as Database
}

test('ready delivery preserves the six-field Laravel payload and excludes internal writing data', async () => {
  const jobId = randomUUID()
  const siteId = randomUUID()
  const eventId = randomUUID()
  const encryptionKey = Buffer.alloc(32, 8)
  const secret = 'test-webhook-secret'
  const article = {
    Title: 'Cà phê tại nhà và bí quyết chọn hương vị riêng',
    Content: '<p style="color:#333">Chọn cà phê phù hợp với khẩu vị.</p>',
    Slug: 'ca-phe-tai-nha',
    Desc: 'Hướng dẫn pha cà phê tại nhà.',
    Description: 'Bí quyết chọn cà phê và phương pháp pha tại nhà.',
    Keywords: ['cà phê', 'pha tại nhà'],
  }
  const tables: Record<string, Row[]> = {
    jobs: [{
      _id: jobId,
      keyword: 'cà phê',
      client_request_id: 'laravel-schedule-123',
      result: [article],
      status: 'ready',
      writing_stage: 'complete',
      seo_report: { score: 80, warnings: [{ key: 'lengthMetaDescription' }] },
      outline: { searchIntent: 'informational' },
      research: { sources: [{ title: 'Internal reference' }] },
    }],
    sites: [{
      _id: siteId,
      webhook_url: 'https://example.vn/receive',
      webhook_secret: seal(secret, encryptionKey),
    }],
    webhook_deliveries: [{
      _id: eventId,
      job_id: jobId,
      site_id: siteId,
      event: 'article.ready',
      attempt_count: 0,
      status: 'pending',
      next_attempt_at: new Date(0),
      lease_token: null,
      lease_expires_at: null,
    }],
    webhook_attempts: [],
  }
  let sent = 0
  const handled = await runWebhookOnce(memoryDatabase(tables), { encryptionKey, leaseMs: 30_000, allowLocalWebhooks: false } as Config, {
    async send(input) {
      sent += 1
      assert.equal(input.jobId, jobId)
      assert.equal(input.clientRequestId, 'laravel-schedule-123')
      assert.equal(input.event, 'article.ready')
      assert.deepEqual(JSON.parse(input.body), [article])
      assert.deepEqual(Object.keys(JSON.parse(input.body)[0]), ['Title', 'Content', 'Slug', 'Desc', 'Description', 'Keywords'])
      assert.doesNotMatch(input.body, /seo_report|outline|research|writing_stage/)

      const headers = webhookHeaders({ ...input, timestamp: '2000000000' })
      assert.equal(headers['x-client-request-id'], 'laravel-schedule-123')
      const message = ['2000000000', input.event, eventId, jobId, input.clientRequestId, input.body].join('\n')
      assert.equal(headers['x-signature'], 'sha256=' + createHmac('sha256', secret).update(message).digest('hex'))
      return { status: 200, retryAfterMs: 0, acknowledgement: { success: true, id_post: 123 } }
    },
  })
  assert.equal(handled, true)
  assert.equal(sent, 1)
  assert.equal(tables.webhook_deliveries[0].status, 'delivered')
  assert.equal(tables.webhook_deliveries[0].id_post, 123)
  assert.ok(tables.webhook_deliveries[0].acknowledged_at instanceof Date)
  assert.equal(tables.webhook_attempts[0].http_status, 200)
  assert.equal(tables.webhook_attempts[0].id_post, 123)
  assert.deepEqual(tables.webhook_attempts[0].acknowledged_at, tables.webhook_deliveries[0].acknowledged_at)
})

function expiredDeliveryFixture() {
  const encryptionKey = Buffer.alloc(32, 8)
  const config = { encryptionKey, leaseMs: 30_000, allowLocalWebhooks: false } as Config
  const delivery: Row = {
    _id: 'delivery', job_id: 'job', site_id: 'site', event: 'article.failed',
    status: 'sending', attempt_count: 1, lease_token: 'expired-owner', lease_expires_at: new Date(0),
  }
  const expiredAttempt: Row = { _id: 'expired-attempt', delivery_id: 'delivery', finished_at: null }
  const tables = {
    jobs: [{ _id: 'job', client_request_id: 'request', error_code: 'AI_ARTICLE', error_message: 'AI failed.' }],
    sites: [{ _id: 'site', webhook_url: 'https://example.vn/receive', webhook_secret: seal('secret', encryptionKey) }],
    webhook_deliveries: [delivery],
    webhook_attempts: [expiredAttempt],
  }
  return { config, delivery, expiredAttempt, tables }
}

test('a delayed recovery cannot requeue an event already delivered by a new worker', { timeout: 2_000 }, async () => {
  const { config, delivery, expiredAttempt, tables } = expiredDeliveryFixture()
  const expiredRead = deferred<void>()
  const resumeRecovery = deferred<void>()
  let paused = false
  const db = memoryDatabase(tables, {
    async afterReadExpired(row) {
      if (!row || paused) return
      paused = true
      expiredRead.resolve()
      await resumeRecovery.promise
    },
  })

  let sent = 0
  const deps = { async send() { sent += 1; return { status: 200, retryAfterMs: 0 } } }
  const staleWorker = runWebhookOnce(db, config, deps)
  try {
    await expiredRead.promise
    assert.equal(await runWebhookOnce(db, config, deps), true)
    assert.equal(delivery.status, 'pending')
    assert.match(expiredAttempt.error, /gián đoạn/)
    delivery.next_attempt_at = new Date(0)
    assert.equal(await runWebhookOnce(db, config, deps), true)
    assert.equal(delivery.status, 'delivered')
  } finally {
    resumeRecovery.resolve()
  }
  assert.equal(await staleWorker, false)
  assert.equal(delivery.status, 'delivered')
  assert.equal(tables.webhook_attempts.length, 2)
  assert.equal(tables.webhook_attempts[1].http_status, 200)
  assert.equal(sent, 1)
})

test('an HTTP response from an expired owner cannot complete a new attempt', { timeout: 2_000 }, async () => {
  const { config, delivery, tables } = expiredDeliveryFixture()
  delivery.status = 'pending'
  delivery.attempt_count = 0
  delivery.lease_token = null
  delivery.lease_expires_at = null
  delivery.next_attempt_at = new Date(0)
  tables.webhook_attempts.length = 0
  const db = memoryDatabase(tables)
  const sending = deferred<void>()
  const oldResponse = deferred<{ status: number; retryAfterMs: number }>()
  const oldWorker = runWebhookOnce(db, config, {
    async send() {
      sending.resolve()
      return oldResponse.promise
    },
  })

  try {
    await sending.promise
    delivery.lease_expires_at = new Date(0)
    assert.equal(await runWebhookOnce(db, config), true)
    delivery.next_attempt_at = new Date(0)
    assert.equal(await runWebhookOnce(db, config, {
      async send() { return { status: 429, retryAfterMs: 60_000 } },
    }), true)
  } finally {
    oldResponse.resolve({ status: 200, retryAfterMs: 0 })
  }
  await oldWorker

  assert.equal(delivery.status, 'pending')
  assert.equal(delivery.http_status, 429)
  assert.ok(delivery.next_attempt_at.getTime() - delivery.updated_at.getTime() >= 60_000)
  assert.equal(tables.webhook_attempts.length, 2)
  assert.match(tables.webhook_attempts[0].error, /gián đoạn/)
  assert.equal(tables.webhook_attempts[0].http_status, null)
  assert.equal(tables.webhook_attempts[1].http_status, 429)
})

test('claim rolls back if its attempt cannot be recorded', async () => {
  const { config, delivery, tables } = expiredDeliveryFixture()
  delivery.status = 'pending'
  delivery.attempt_count = 0
  delivery.lease_token = null
  delivery.lease_expires_at = null
  delivery.next_attempt_at = new Date(0)
  tables.webhook_attempts.length = 0
  let rejectAttempt = true
  const db = memoryDatabase(tables, {
    beforeInsertAttempt() {
      if (rejectAttempt) throw new Error('Attempt insert failed')
    },
  })
  let sent = 0
  const deps = { async send() { sent += 1; return { status: 200, retryAfterMs: 0 } } }

  await assert.rejects(runWebhookOnce(db, config, deps), /Attempt insert failed/)
  assert.equal(tables.webhook_deliveries[0].status, 'pending')
  assert.equal(tables.webhook_deliveries[0].attempt_count, 0)
  assert.equal(tables.webhook_attempts.length, 0)
  assert.equal(sent, 0)

  rejectAttempt = false
  assert.equal(await runWebhookOnce(db, config, deps), true)
  assert.equal(tables.webhook_deliveries[0].status, 'delivered')
  assert.equal(tables.webhook_deliveries[0].attempt_count, 1)
  assert.equal(tables.webhook_attempts.length, 1)
  assert.equal(sent, 1)
})

function readyDeliveryFixture() {
  const f = expiredDeliveryFixture()
  f.delivery.event = 'article.ready'
  f.delivery.status = 'pending'
  f.delivery.attempt_count = 0
  f.delivery.lease_token = null
  f.delivery.lease_expires_at = null
  f.delivery.next_attempt_at = new Date(0)
  f.tables.webhook_attempts.length = 0
  Object.assign(f.tables.jobs[0], { result: [{ Title: 'Bài viết', Content: '<p>Nội dung</p>', Slug: 'bai-viet', Desc: '', Description: '', Keywords: [] }] })
  return { ...f, db: memoryDatabase(f.tables) }
}

test('ready delivery requires a valid acknowledgement and waits five minutes before each of three retries', async () => {
  const { config, delivery, tables, db } = readyDeliveryFixture()
  config.webhookMaxAttempts = 10 // Legacy settings cannot increase ready-delivery retries.
  let sends = 0
  const deps = { async send() { sends += 1; return { status: 200, retryAfterMs: 60 * 60_000 } } }
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.equal(await runWebhookOnce(db, config, deps), true)
    assert.equal(delivery.attempt_count, attempt)
    assert.equal(delivery.status, attempt === 4 ? 'failed' : 'pending')
    assert.equal(delivery.http_status, 200)
    assert.equal(delivery.id_post, null)
    assert.equal(delivery.acknowledged_at, null)
    assert.equal(delivery.delivered_at, null)
    assert.match(delivery.error, /xác nhận hợp lệ/)
    assert.equal(tables.webhook_attempts[attempt - 1].id_post, null)
    if (attempt === 4) assert.equal(delivery.next_attempt_at, null)
    if (attempt < 4) {
      assert.equal(delivery.next_attempt_at.getTime() - delivery.updated_at.getTime(), 5 * 60_000)
      assert.equal(await runWebhookOnce(db, config, deps), false)
      delivery.next_attempt_at = new Date(0)
    }
  }
  assert.equal(await runWebhookOnce(db, config, deps), false)
  assert.equal(sends, 4)
  assert.equal(tables.webhook_attempts.length, 4)
})

test('ready delivery uses configured fixed minutes for HTTP errors and then records a valid Laravel ID', async () => {
  const { config, delivery, tables, db } = readyDeliveryFixture()
  config.webhookRetryMinutes = 7
  config.webhookMaxAttempts = 1 // Ready events always get the promised three retries.
  for (const status of [400, 503]) {
    await runWebhookOnce(db, config, { async send() {
      return { status, retryAfterMs: 99 * 60_000, acknowledgement: { success: true, id_post: 999 } }
    } })
    assert.equal(delivery.status, 'pending')
    assert.equal(delivery.next_attempt_at.getTime() - delivery.updated_at.getTime(), 7 * 60_000)
    assert.equal(delivery.id_post, null)
    delivery.next_attempt_at = new Date(0)
  }
  await runWebhookOnce(db, config, { async send() {
    return { status: 201, retryAfterMs: 0, acknowledgement: { success: true, id_post: '  post:42  ' } }
  } })
  assert.equal(delivery.status, 'delivered')
  assert.equal(delivery.id_post, 'post:42')
  assert.equal(delivery.next_attempt_at, null)
  assert.equal(delivery.attempt_count, 3)
  assert.ok(delivery.acknowledged_at instanceof Date)
  assert.equal(tables.webhook_attempts[2].id_post, 'post:42')
})

test('ready acknowledgement validates injected send results and never stores an invalid ID', async () => {
  for (const acknowledgement of [
    { success: false, id_post: 1 }, { success: 'true', id_post: 1 }, { success: true },
    { success: true, id_post: 0 }, { success: true, id_post: -1 }, { success: true, id_post: 1.5 },
    { success: true, id_post: '' }, { success: true, id_post: ' \n ' }, { success: true, id_post: { id: 1 } },
  ]) {
    const { config, delivery, db } = readyDeliveryFixture()
    await runWebhookOnce(db, config, { async send() {
      return { status: 200, retryAfterMs: 0, acknowledgement } as any
    } })
    assert.equal(delivery.status, 'pending', JSON.stringify(acknowledgement))
    assert.equal(delivery.id_post, null)
  }
})

test('pending ready events queued by an old retry policy cannot send a fifth request', async () => {
  for (const count of [4, 8]) {
    const { config, delivery, tables, db } = readyDeliveryFixture()
    delivery.attempt_count = count
    assert.equal(await runWebhookOnce(db, config, { async send() {
      assert.fail('Exhausted ready delivery must not make a request')
    } }), true)
    assert.equal(delivery.status, 'failed')
    assert.equal(delivery.attempt_count, count)
    assert.equal(delivery.next_attempt_at, null)
    assert.equal(tables.webhook_attempts.length, 0)
    assert.equal(await runWebhookOnce(db, config), false)
  }
})

test('interrupted ready delivery recovery uses the fixed retry interval and stops after four attempts', async () => {
  for (const attempts of [1, 3, 4]) {
    const { config, delivery, expiredAttempt, tables } = expiredDeliveryFixture()
    delivery.event = 'article.ready'
    delivery.attempt_count = attempts
    config.webhookRetryMinutes = 9
    assert.equal(await runWebhookOnce(memoryDatabase(tables), config), true)
    assert.equal(delivery.status, attempts === 4 ? 'failed' : 'pending')
    assert.equal(delivery.id_post, null)
    assert.equal(delivery.acknowledged_at, null)
    if (attempts < 4) assert.equal(delivery.next_attempt_at.getTime() - delivery.updated_at.getTime(), 9 * 60_000)
    assert.match(expiredAttempt.error, /gián đoạn/)
  }
})

test('a stale ready worker cannot record its Laravel acknowledgement after lease ownership changes', async () => {
  const { config, delivery, tables, db } = readyDeliveryFixture()
  const sent = deferred<void>()
  const ack = deferred<{ status: number; retryAfterMs: number; acknowledgement: { success: true; id_post: number } }>()
  const oldWorker = runWebhookOnce(db, config, { async send() { sent.resolve(); return ack.promise } })
  await sent.promise
  delivery.lease_expires_at = new Date(0)
  await runWebhookOnce(db, config)
  delivery.next_attempt_at = new Date(0)
  await runWebhookOnce(db, config, { async send() {
    return { status: 200, retryAfterMs: 0, acknowledgement: { success: true, id_post: 222 } }
  } })
  ack.resolve({ status: 200, retryAfterMs: 0, acknowledgement: { success: true, id_post: 111 } })
  await oldWorker
  assert.equal(delivery.status, 'delivered')
  assert.equal(delivery.id_post, 222)
  assert.equal(tables.webhook_attempts[0].id_post, null)
  assert.equal(tables.webhook_attempts[1].id_post, 222)
})
