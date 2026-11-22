import assert from 'node:assert/strict'
import { setImmediate as nextTurn, setTimeout as wait } from 'node:timers/promises'
import test from 'node:test'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import { startWorkerHeartbeat, type WorkerHeartbeatState } from '../src/worker/heartbeat.js'
import { runWorkers } from '../src/worker/index.js'

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

function heartbeatDatabase() {
  const writes: { _id: string, role: string, heartbeat_at: Date, expires_at: Date }[] = []
  const removals: string[] = []
  const events: string[] = []
  let update = async () => {}
  let remove = async () => {}
  const db = { db: { collection(name: string) {
    assert.equal(name, 'worker_heartbeats')
    return {
      async updateOne(filter: { _id: string }, change: { $set: object }, options: object) {
        assert.deepEqual(options, { upsert: true })
        writes.push(structuredClone({ ...filter, ...change.$set }) as typeof writes[number])
        events.push('write-start')
        await update()
        events.push('write-end')
      },
      async deleteOne(filter: { _id: string }) {
        removals.push(filter._id)
        events.push('delete')
        await remove()
      },
    }
  } } } as unknown as Database
  return { db, writes, removals, events, failUpdates(call: () => Promise<void>) { update = call }, failRemoval(call: () => Promise<void>) { remove = call } }
}

function manualClock() {
  let time = Date.UTC(2026, 10, 22)
  const pulses = new Set<() => void>()
  return {
    now: () => new Date(time),
    schedule(pulse: () => void, intervalMs: number) {
      assert.equal(intervalMs, 5_000)
      pulses.add(pulse)
      return () => { pulses.delete(pulse) }
    },
    async tick() {
      time += 5_000
      pulses.forEach(pulse => pulse())
      await nextTurn()
    },
    count: () => pulses.size,
  }
}

test('heartbeats persist minimal per-instance state every five seconds and expire after fifteen', async () => {
  const f = heartbeatDatabase()
  const clock = manualClock()
  let state: WorkerHeartbeatState = { concurrency: 3, active_tasks: 2, accepting_work: true }
  const first = startWorkerHeartbeat(f.db, 'writer', () => state, clock)
  const second = startWorkerHeartbeat(f.db, 'writer', () => state, clock)
  try {
    await nextTurn()
    assert.equal(f.writes.length, 2)
    assert.notEqual(f.writes[0]._id, f.writes[1]._id)
    assert.match(f.writes[0]._id, /^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/)
    assert.deepEqual(Object.keys(f.writes[0]).sort(), ['_id', 'accepting_work', 'active_tasks', 'concurrency', 'expires_at', 'heartbeat_at', 'role'])
    assert.deepEqual(f.writes[0], { _id: f.writes[0]._id, role: 'writer', ...state,
      heartbeat_at: clock.now(), expires_at: new Date(clock.now().getTime() + 15_000) })
    state = { concurrency: 1, active_tasks: 0, accepting_work: false }
    await clock.tick()
    assert.equal(f.writes.length, 4)
    assert.deepEqual(f.writes[2], { _id: f.writes[0]._id, role: 'writer', ...state,
      heartbeat_at: clock.now(), expires_at: new Date(clock.now().getTime() + 15_000) })
  } finally { await Promise.all([first.stop(), second.stop()]) }
  assert.equal(clock.count(), 0)
  assert.deepEqual(f.removals.sort(), f.writes.slice(0, 2).map(row => row._id).sort())
  await clock.tick()
  assert.equal(f.writes.length, 4)
})

test('overlapping pulses serialize and shutdown cannot leave a resurrected heartbeat', async () => {
  const f = heartbeatDatabase()
  const clock = manualClock()
  const blocked = deferred<void>()
  f.failUpdates(() => blocked.promise)
  const heartbeat = startWorkerHeartbeat(f.db, 'webhook', () => ({ concurrency: 2, active_tasks: 2, accepting_work: true }), clock)
  await clock.tick()
  await clock.tick()
  heartbeat.refresh()
  assert.equal(f.writes.length, 1, 'overlapping updates must coalesce while MongoDB is busy')
  let stopped = false
  const stopping = heartbeat.stop().then(() => { stopped = true })
  assert.equal(heartbeat.stop(), heartbeat.stop(), 'stop is idempotent')
  await nextTurn()
  assert.equal(stopped, false)
  assert.equal(f.removals.length, 0)
  blocked.resolve()
  await stopping
  assert.deepEqual(f.events, ['write-start', 'write-end', 'delete'])
  await clock.tick()
  heartbeat.refresh()
  await nextTurn()
  assert.equal(f.writes.length, 1)
})

test('heartbeat errors are isolated and logs never expose driver error messages or unsafe codes', async t => {
  const errors: unknown[][] = []
  t.mock.method(console, 'error', (...values: unknown[]) => errors.push(values))
  const f = heartbeatDatabase()
  const clock = manualClock()
  f.failUpdates(async () => { throw Object.assign(new Error('mongodb://private:password@host'), { code: 'CONNECTION_FAILED' }) })
  const heartbeat = startWorkerHeartbeat(f.db, 'writer', () => ({ concurrency: 1, active_tasks: 1, accepting_work: true }), clock)
  await nextTurn()
  assert.deepEqual(errors, [['writer worker heartbeat error', 'CONNECTION_FAILED']])
  f.failUpdates(async () => {})
  await clock.tick()
  assert.equal(f.writes.length, 2, 'a failed heartbeat must not stop future pulses')
  f.failRemoval(async () => { throw Object.assign(new Error('secret'), { code: 'mongodb://secret' }) })
  await heartbeat.stop()
  assert.deepEqual(errors[1], ['writer worker heartbeat error', 'UNEXPECTED'])
})

test('pool reports active work separately from idle delays and keeps live pulses while draining', { timeout: 3_000 }, async () => {
  const f = heartbeatDatabase()
  const clock = manualClock()
  const controller = new AbortController()
  const config = { workerConcurrency: 1, webhookConcurrency: 2, workerPollMs: 20 } as Config
  const jobs: ReturnType<typeof deferred<boolean>>[] = []
  let snapshot!: () => WorkerHeartbeatState
  let target = 2
  const running = runWorkers(f.db, config, controller.signal, 'webhook', {
    createHeartbeat(db, role, getState) {
      assert.equal(role, 'webhook')
      snapshot = getState
      return startWorkerHeartbeat(db, role, getState, clock)
    },
    async getConfig() { return { ...config, webhookConcurrency: target } },
    async runOnce() {
      const job = deferred<boolean>()
      jobs.push(job)
      return job.promise
    },
  })
  try {
    await eventually(() => jobs.length === 2)
    await clock.tick()
    assert.deepEqual(snapshot(), { concurrency: 2, active_tasks: 2, accepting_work: true })
    const before = f.writes.length
    await clock.tick()
    assert.equal(f.writes.length, before + 1, 'long-running jobs do not block pulses')
    target = 1
    await eventually(() => snapshot().concurrency === 1)
    assert.equal(snapshot().active_tasks, 2, 'lowering concurrency must not hide in-flight work')
    jobs[0].resolve(false)
    await eventually(() => snapshot().active_tasks === 1)
    assert.equal(jobs.length, 2, 'empty slot cooldown still occupies a pool slot')
    controller.abort()
    await nextTurn()
    assert.equal(snapshot().accepting_work, false)
    assert.equal(f.removals.length, 0, 'active work must drain before removing liveness')
    await clock.tick()
    assert.equal((f.writes.at(-1) as unknown as WorkerHeartbeatState).active_tasks, 1)
    jobs[1].resolve(true)
    await running
    assert.equal(f.removals.length, 1)
  } finally {
    controller.abort()
    jobs.forEach(job => job.resolve(false))
    await running
  }
})

test('pool stops advertising acceptance after settings fail and resumes after recovery', { timeout: 3_000 }, async t => {
  t.mock.method(console, 'error', () => {})
  const controller = new AbortController()
  const config = { workerConcurrency: 2, webhookConcurrency: 1, workerPollMs: 5 } as Config
  let unavailable = false
  let snapshot!: () => WorkerHeartbeatState
  let claims = 0
  const jobs: ReturnType<typeof deferred<boolean>>[] = []
  const running = runWorkers({} as Database, config, controller.signal, 'writer', {
    createHeartbeat(_db, _role, getState) {
      snapshot = getState
      return { refresh() {}, async stop() {} }
    },
    async getConfig() {
      if (unavailable) throw new Error('unavailable')
      return { ...config }
    },
    async runOnce() {
      claims += 1
      const job = deferred<boolean>()
      jobs.push(job)
      return job.promise
    },
  })
  try {
    await eventually(() => claims === 2)
    unavailable = true
    await eventually(() => !snapshot().accepting_work)
    jobs.forEach(job => job.resolve(true))
    await eventually(() => snapshot().active_tasks === 0)
    assert.equal(snapshot().concurrency, 2, 'retain last known configuration while paused')
    await wait(20)
    assert.equal(claims, 2)
    unavailable = false
    await eventually(() => claims === 4)
    assert.equal(snapshot().accepting_work, true)
  } finally {
    controller.abort()
    jobs.forEach(job => job.resolve(false))
    await running
  }
})

test('production pool path persists and removes a heartbeat without injected telemetry', { timeout: 3_000 }, async () => {
  const f = heartbeatDatabase()
  const controller = new AbortController()
  const config = { workerConcurrency: 1, webhookConcurrency: 2, workerPollMs: 5 } as Config
  const job = deferred<boolean>()
  let claimed = false
  const running = runWorkers(f.db, config, controller.signal, 'writer', {
    async getConfig() { return config },
    async runOnce() { claimed = true; return job.promise },
  })
  try {
    await eventually(() => claimed && f.writes.length >= 2)
    assert.deepEqual(f.writes.at(-1), { _id: f.writes[0]._id, role: 'writer',
      concurrency: 1, active_tasks: 1, accepting_work: true,
      heartbeat_at: f.writes.at(-1)!.heartbeat_at, expires_at: f.writes.at(-1)!.expires_at })
    controller.abort()
    await nextTurn()
    assert.equal(f.removals.length, 0)
    job.resolve(true)
    await running
    assert.deepEqual(f.removals, [f.writes[0]._id])
  } finally { controller.abort(); job.resolve(false); await running }
})

test('migration provisions a native TTL index for expired worker heartbeats', async () => {
  const collections: string[] = []
  const heartbeatIndexes: { key: object, options: object }[] = []
  const db = {
    client: { async connect() {} },
    db: {
      async createCollection(name: string) { collections.push(name) },
      collection(name: string) {
        return {
          async createIndex(key: object, options: object) {
            if (name === 'worker_heartbeats') heartbeatIndexes.push({ key, options })
          },
          async indexes() { return [] },
          async findOne() { return null },
          async updateMany() {},
          async updateOne() {},
        }
      },
    },
  } as unknown as Database
  await migrate(db)
  assert.ok(collections.includes('worker_heartbeats'))
  assert.deepEqual(heartbeatIndexes, [{ key: { expires_at: 1 }, options: { expireAfterSeconds: 0 } }])
})

test('an already stopped pool does not create telemetry or claim work', async () => {
  const controller = new AbortController()
  controller.abort()
  const unexpected = () => { throw new Error('stopped pool must remain inactive') }
  await runWorkers({} as Database, {} as Config, controller.signal, 'writer', {
    createHeartbeat: unexpected, getConfig: unexpected, runOnce: unexpected,
  })
})
