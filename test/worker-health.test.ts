import assert from 'node:assert/strict'
import test from 'node:test'
import { startWorkerHealthServer } from '../src/worker/health-server.js'

test('worker health reports database failure and recovery without exposing error details', async t => {
  let available = true
  const health = await startWorkerHealthServer(async () => {
    if (!available) throw new Error('private database connection details')
  }, 0, '127.0.0.1')
  t.after(health.close)
  const address = health.server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(url + '/health')).status, 200)
  available = false
  const failed = await fetch(url + '/health')
  assert.equal(failed.status, 503)
  assert.deepEqual(await failed.json(), { status: 'unavailable' })
  available = true
  assert.equal((await fetch(url + '/health')).status, 200)
  assert.equal((await fetch(url + '/unknown')).status, 404)
  assert.equal((await fetch(url + '/health', { method: 'POST' })).status, 404)
})
