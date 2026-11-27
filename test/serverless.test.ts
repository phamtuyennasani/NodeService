import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import Fastify from 'fastify'
import { nodeServerlessHandler } from '../src/serverless.js'

test('serverless adapter reuses Fastify, preserves URLs and recovers after an initialization failure', async t => {
  const app = Fastify()
  app.get('/api/test', async request => ({ url: request.url }))
  let starts = 0
  const handler = nodeServerlessHandler(async () => {
    if (++starts === 1) throw new Error('fixture-unavailable')
    return app
  })
  t.mock.method(console, 'error', () => {})
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await app.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(origin + '/api/test')).status, 503)
  assert.deepEqual(await (await fetch(origin + '/api/test?x=1')).json(), { url: '/api/test?x=1' })
  assert.equal((await fetch(origin + '/api/test')).status, 200)
  assert.equal(starts, 2)
})

test('serverless SSE closes cleanly before the platform deadline and releases the subscription', async t => {
  const app = Fastify()
  let released = false
  app.get('/api/crm/jobs/events', (_req, reply) => {
    reply.hijack()
    reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' })
    reply.raw.write('event: ready\ndata: {}\n\n')
    reply.raw.once('close', () => { released = true })
  })
  const handler = nodeServerlessHandler(async () => app, 50)
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await app.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await fetch(`http://127.0.0.1:${address.port}/api/crm/jobs/events`)
  assert.equal(response.status, 200)
  assert.match(await response.text(), /event: ready/)
  assert.equal(released, true)
})
