import assert from 'node:assert/strict'
import { setTimeout as wait } from 'node:timers/promises'
import test from 'node:test'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { seal } from '../src/security.js'
import { runWebhookOnce } from '../src/worker/delivery.js'
import { runWorkers } from '../src/worker/index.js'
import { WorkerError } from '../src/worker/provider.js'
import { runWriterOnce } from '../src/worker/writer.js'

const createHeartbeat = () => ({ refresh() {}, async stop() {} })
const checkEncryption = async () => {}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (check()) return
    await wait(2)
  }
  assert.ok(check(), 'condition did not become true')
}

test('runtime worker pool scales both ways without interrupting in-flight snapshots', { timeout: 3_000 }, async () => {
  const controller = new AbortController()
  let target = 1
  const base = { workerConcurrency: 1, webhookConcurrency: 7, workerPollMs: 5 } as Config
  const tasks: { config: Config, finish: ReturnType<typeof deferred<boolean>> }[] = []
  let stopped = false
  const running = runWorkers({} as Database, base, controller.signal, 'writer', {
    checkEncryption,
    createHeartbeat,
    async getConfig() { return { ...base, workerConcurrency: target } },
    async runOnce(_db, config) {
      const finish = deferred<boolean>()
      tasks.push({ config, finish })
      return finish.promise
    },
  }).then(() => { stopped = true })
  try {
    await eventually(() => tasks.length === 1)
    target = 3
    await eventually(() => tasks.length === 3)
    assert.equal(tasks[0].config.workerConcurrency, 1, 'first claim retains its original snapshot')
    assert.equal(tasks[1].config.workerConcurrency, 3)
    target = 1
    await wait(15)
    tasks[1].finish.resolve(true)
    tasks[2].finish.resolve(true)
    await wait(25)
    assert.equal(tasks.length, 3, 'reduced pool must wait until active work is below the new limit')
    tasks[0].finish.resolve(true)
    await eventually(() => tasks.length === 4)
    assert.equal(tasks[3].config.workerConcurrency, 1)
    controller.abort()
    await wait(10)
    assert.equal(stopped, false, 'shutdown must wait for the in-flight job')
    tasks[3].finish.resolve(true)
    await running
    assert.equal(tasks.length, 4)
  } finally {
    controller.abort()
    tasks.forEach(task => task.finish.resolve(false))
    await running
  }
})

test('webhook pool uses delivery concurrency and delays empty queue polling', { timeout: 3_000 }, async () => {
  const controller = new AbortController()
  const config = { workerConcurrency: 8, webhookConcurrency: 2, workerPollMs: 70 } as Config
  let calls = 0
  const running = runWorkers({} as Database, config, controller.signal, 'webhook', {
    checkEncryption,
    createHeartbeat,
    async getConfig() { return { ...config } },
    async runOnce() { calls += 1; return false },
  })
  try {
    await eventually(() => calls === 2)
    await wait(20)
    assert.equal(calls, 2)
    await eventually(() => calls >= 4)
  } finally {
    controller.abort()
    await running
  }
})

test('a failed settings refresh prevents new claims until settings can be read', { timeout: 3_000 }, async t => {
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...values: unknown[]) => errors.push(values))
  const controller = new AbortController()
  const config = { workerConcurrency: 1, workerPollMs: 5 } as Config
  let unavailable = true
  let reads = 0
  let claims = 0
  const running = runWorkers({} as Database, config, controller.signal, 'writer', {
    checkEncryption,
    createHeartbeat,
    async getConfig() {
      reads += 1
      if (unavailable) throw Object.assign(new Error('private connection details'), { code: 'SETTINGS_UNAVAILABLE' })
      return { ...config }
    },
    async runOnce() { claims += 1; controller.abort(); return true },
  })
  try {
    await eventually(() => reads > 0)
    await wait(20)
    assert.equal(claims, 0)
    assert.deepEqual(errors[0], ['writer worker error', 'SETTINGS_UNAVAILABLE'])
    unavailable = false
    await running
    assert.equal(claims, 1)
  } finally {
    controller.abort()
    await running
  }
})

test('a shorter poll setting wakes idle slots instead of retaining their old delay', { timeout: 3_000 }, async () => {
  const controller = new AbortController()
  const config = { workerConcurrency: 1, workerPollMs: 500 } as Config
  let poll = 500
  let calls = 0
  let stopped = false
  const running = runWorkers({} as Database, config, controller.signal, 'writer', {
    checkEncryption,
    createHeartbeat,
    async getConfig() { return { ...config, workerPollMs: poll } },
    async runOnce() { calls += 1; return false },
  }).then(() => { stopped = true })
  try {
    await eventually(() => calls === 1)
    // A second active slot is not needed to wake the supervisor: its bounded
    // settings timer refreshes and then retires the obsolete idle wait.
    poll = 5
    await eventually(() => calls >= 2)
    await wait(20)
    assert.ok(calls > 2, 'subsequent empty polls use the shorter interval')
  } finally {
    controller.abort()
    await running
  }
  assert.equal(stopped, true)
})

type Row = Record<string, any>

function memoryDatabase(tables: Record<string, Row[]>): Database {
  function matches(row: Row, filter: Row): boolean {
    return Object.entries(filter).every(([key, expected]) => {
      const actual = row[key]
      if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        if ('$in' in expected) return expected.$in.includes(actual)
        if ('$gt' in expected) return actual != null && actual > expected.$gt
        if ('$lte' in expected) return actual != null && actual <= expected.$lte
        if ('$elemMatch' in expected) return Array.isArray(actual) && actual.some(value => matches(value, expected.$elemMatch))
      }
      return actual === expected
    })
  }
  function apply(row: Row, update: Row, filter: Row) {
    const fields = structuredClone(update.$set ?? {})
    if ('slots.$.expires' in fields) {
      const slot = row.slots.find((value: Row) => matches(value, filter.slots.$elemMatch))
      slot.expires = fields['slots.$.expires']
      delete fields['slots.$.expires']
    }
    Object.assign(row, fields)
    for (const [key, amount] of Object.entries(update.$inc ?? {})) row[key] = Number(row[key] ?? 0) + Number(amount)
    if (update.$pull?.slots) row.slots = row.slots.filter((slot: Row) => slot.id !== update.$pull.slots.id)
    for (const [key, value] of Object.entries(update.$max ?? {})) row[key] = Math.max(row[key] ?? 0, Number(value))
  }
  return {
    db: {
      collection(name: string) {
        const rows = tables[name] ??= []
        return {
          find(filter: Row) { return { async toArray() { return structuredClone(rows.filter(row => matches(row, filter))) } } },
          async findOne(filter: Row) { return structuredClone(rows.find(row => matches(row, filter)) ?? null) },
          async findOneAndUpdate(filter: Row, update: Row) {
            const row = rows.find(row => matches(row, filter))
            if (!row) return null
            apply(row, update, filter)
            return structuredClone(row)
          },
          async insertOne(row: Row) { rows.push(structuredClone(row)) },
          async updateOne(filter: Row, update: Row, options?: Row) {
            const row = rows.find(row => matches(row, filter))
            if (row) apply(row, update, filter)
            else if (options?.upsert) rows.push(structuredClone(update.$setOnInsert ?? {}))
            return { matchedCount: row ? 1 : 0 }
          },
          async updateMany(filter: Row, update: Row) {
            const selected = rows.filter(row => matches(row, filter))
            selected.forEach(row => apply(row, update, filter))
            return { matchedCount: selected.length }
          },
        }
      },
    },
    client: {
      async connect() {},
      startSession() { return { async withTransaction<T>(call: () => Promise<T>) { return call() }, async endSession() {} } },
    },
  } as unknown as Database
}

function writerFixture(attemptCount: number, expired = false) {
  const encryptionKey = Buffer.alloc(32, 4)
  const job: Row = {
    _id: 'job', site_id: 'site', customer_id: 'customer', provider: 'openai', model: 'model', mode: 'preview',
    keyword: 'kiểm thử', tone: 'rõ ràng', style: 'hướng dẫn', length: 1500, instructions: null,
    key_mode: 'own', encrypted_key: seal('test-key', encryptionKey), source_article_id: null,
    attempt_count: attemptCount, status: expired ? 'writing' : 'queued', available_at: new Date(0),
    lease_token: expired ? 'expired' : null, lease_expires_at: expired ? new Date(0) : null,
  }
  const tables = { jobs: [job], ai_attempts: [], quota_reservations: [{ job_id: 'job', customer_id: 'customer', status: 'reserved' }], webhook_deliveries: [] }
  const config = {
    encryptionKey, writerMaxAttempts: 1, aiTimeoutMs: 5_000, outlineTimeoutMs: 1_000, seoRepairTimeoutMs: 1_000,
    leaseMs: 30_000, workerPollMs: 5, research: { enabled: false }, serviceKeys: {},
    providerLimits: Object.fromEntries(['openai', 'anthropic', 'xai', 'openai-compatible'].map(provider => [provider,
      { concurrency: 1, requestsPerMinute: 60, tokensPerMinute: 120_000 }])),
  } as Config
  return { job, tables, config, db: memoryDatabase(tables) }
}

test('writer retry setting applies to new failures and expired lease recovery', async () => {
  const fresh = writerFixture(0)
  await runWriterOnce(fresh.db, fresh.config, {
    async outline() { throw new WorkerError('OUTLINE', 'skip optional outline', false) },
    async generate() { throw new WorkerError('RETRYABLE', 'temporary failure', true) },
  })
  assert.equal(fresh.job.status, 'failed')
  assert.equal(fresh.job.attempt_count, 1)
  assert.equal(fresh.job.encrypted_key, null)

  const expired = writerFixture(1, true)
  await runWriterOnce(expired.db, expired.config)
  assert.equal(expired.job.status, 'failed')
  assert.equal(expired.job.error_code, 'AI_LEASE_EXPIRED')

  const increased = writerFixture(3, true)
  increased.config.writerMaxAttempts = 4
  await runWriterOnce(increased.db, increased.config)
  assert.equal(increased.job.status, 'queued', 'a raised retry limit also applies to recovered work')
})

function deliveryFixture(attemptCount: number, expired = false) {
  const encryptionKey = Buffer.alloc(32, 5)
  const delivery: Row = {
    _id: 'delivery', job_id: 'job', site_id: 'site', event: 'article.failed', attempt_count: attemptCount,
    status: expired ? 'sending' : 'pending', next_attempt_at: new Date(0),
    lease_token: expired ? 'expired' : null, lease_expires_at: expired ? new Date(0) : null,
  }
  const tables = {
    jobs: [{ _id: 'job', error_code: 'TEST', error_message: 'test' }],
    sites: [{ _id: 'site', webhook_url: 'https://example.vn', webhook_secret: seal('secret', encryptionKey) }],
    webhook_deliveries: [delivery], webhook_attempts: [] as Row[],
  }
  const config = { encryptionKey, leaseMs: 30_000, webhookMaxAttempts: 1, webhookTimeoutMs: 12 } as Config
  return { delivery, tables, config, db: memoryDatabase(tables) }
}

test('delivery retry setting applies to HTTP failures and expired leases', async () => {
  const fresh = deliveryFixture(0)
  await runWebhookOnce(fresh.db, fresh.config, { async send() { return { status: 503, retryAfterMs: 0 } } })
  assert.equal(fresh.delivery.status, 'failed')
  assert.equal(fresh.delivery.attempt_count, 1)

  const expired = deliveryFixture(1, true)
  await runWebhookOnce(expired.db, expired.config)
  assert.equal(expired.delivery.status, 'failed')

  const increased = deliveryFixture(5, true)
  increased.config.webhookMaxAttempts = 6
  await runWebhookOnce(increased.db, increased.config)
  assert.equal(increased.delivery.status, 'pending')
})

test('delivery uses the configured webhook timeout', { timeout: 3_000 }, async () => {
  const f = deliveryFixture(0)
  let aborted = false
  const keepAlive = setTimeout(() => {}, 500)
  try {
    await runWebhookOnce(f.db, f.config, {
      send: input => new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => { aborted = true; reject(input.signal.reason) }, { once: true })
      }),
    })
  } finally { clearTimeout(keepAlive) }
  assert.equal(aborted, true)
  assert.equal(f.delivery.status, 'failed')
  assert.match(f.delivery.error, /hết thời gian chờ/)
})
