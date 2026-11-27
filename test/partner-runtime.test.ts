import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setImmediate as tick } from 'node:timers/promises'
import test from 'node:test'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { runPartnerServices } from '../src/partner-runtime.js'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function eventually(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await tick()
  }
  assert.ok(check(), 'supervisor did not reach the expected state')
}
const config = { serviceKeys: { openai: 'root-only-key' }, mail: { host: 'root-only-smtp' } } as Config

function controlDatabase(read: () => { _id: string }[]) {
  return { client: { db: (databaseName: string) => ({ databaseName }) },
    db: { databaseName: 'root-fixture', collection(name: string) {
      assert.equal(name, 'partners')
      return { find(query: unknown) { assert.deepEqual(query, { enabled: true }); return { async toArray() { return read() } } } }
    } },
  } as unknown as Database
}

test('partner supervisor discovers groups, drains disabled work and never overlaps a re-enabled pool', { timeout: 5_000 }, async t => {
  const a = randomUUID(), b = randomUUID()
  let enabled = [a]
  let unavailable = false
  const root = controlDatabase(() => {
    if (unavailable) throw new Error('control database unavailable')
    return enabled.map(_id => ({ _id }))
  })
  const controller = new AbortController()
  const pauses: ReturnType<typeof deferred>[] = []
  const tasks: { id: string, role: string, signal: AbortSignal, finish: ReturnType<typeof deferred> }[] = []
  const warnings = t.mock.method(console, 'error', () => {})
  let stopped = false
  function pool(db: Database, scoped: Config, signal: AbortSignal, role: string) {
    assert.equal(db.root, root)
    assert.match(db.db.databaseName, /^crm_p_[a-f0-9]{32}$/)
    assert.equal(scoped.serviceKeys.openai, undefined)
    assert.equal(scoped.mail, undefined)
    const finish = deferred()
    tasks.push({ id: db.partnerId!, role, signal, finish })
    return finish.promise
  }
  const running = runPartnerServices(root, config, controller.signal, 'all', {
    initialize: async () => {},
    maintenance: (db, cfg, signal) => pool(db, cfg, signal, 'maintenance'),
    workers: pool,
    pause(signal) {
      const pause = deferred()
      pauses.push(pause)
      signal.addEventListener('abort', pause.resolve, { once: true })
      return pause.promise.finally(() => signal.removeEventListener('abort', pause.resolve))
    },
  }).then(() => { stopped = true })
  async function refresh() {
    const count = pauses.length
    pauses.at(-1)!.resolve()
    await eventually(() => pauses.length > count)
    await tick()
  }
  try {
    await eventually(() => tasks.length === 3 && pauses.length === 1)
    assert.deepEqual(tasks.map(task => task.role), ['maintenance', 'writer', 'webhook'])
    enabled = [b]
    await refresh()
    assert.equal(tasks.length, 6)
    assert.ok(tasks.filter(task => task.id === a).every(task => task.signal.aborted))
    assert.ok(tasks.filter(task => task.id === b).every(task => !task.signal.aborted))
    enabled = [a, b]
    await refresh()
    assert.equal(tasks.length, 6, 're-enable must wait until old work has drained')
    tasks.filter(task => task.id === a).forEach(task => task.finish.resolve())
    await tick()
    await refresh()
    assert.equal(tasks.length, 9)
    assert.ok(tasks.slice(6).every(task => task.id === a && !task.signal.aborted))
    unavailable = true
    await refresh()
    assert.ok(tasks.every(task => task.signal.aborted), 'unknown access must stop new claims in every group')
    assert.equal(warnings.mock.callCount(), 1)
    controller.abort()
    await tick()
    assert.equal(stopped, false, 'shutdown waits for in-flight work')
  } finally {
    controller.abort()
    tasks.forEach(task => task.finish.resolve())
    await running
  }
  assert.equal(stopped, true)
})

test('separate API, writer and webhook roles only start their matching partner services', { timeout: 5_000 }, async t => {
  for (const role of ['api', 'writer', 'webhook']) await t.test(role, async () => {
    const root = controlDatabase(() => [{ _id: randomUUID() }])
    const controller = new AbortController()
    const roles: string[] = []
    const pool = (_db: Database, _config: Config, signal: AbortSignal, kind: string) => {
      roles.push(kind)
      return new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    }
    const running = runPartnerServices(root, config, controller.signal, role, {
      initialize: async () => {}, maintenance: (db, cfg, signal) => pool(db, cfg, signal, 'maintenance'), workers: pool,
    })
    try {
      await eventually(() => roles.length === (role === 'api' ? 1 : 2))
      assert.deepEqual(roles, role === 'api' ? ['maintenance'] : ['maintenance', role])
    } finally { controller.abort(); await running }
  })
})
