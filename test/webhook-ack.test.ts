import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import test, { type TestContext } from 'node:test'
import { parseWebhookAcknowledgement, sendWebhook, type WebhookInput } from '../src/worker/webhook.js'

async function endpoint(t: TestContext, respond: (response: ServerResponse) => void) {
  const server = createServer((request, response) => { request.resume(); respond(response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/receive`
}

function input(url: string, signal = AbortSignal.timeout(2_000)): WebhookInput {
  return {
    url, secret: 'test-only-secret', event: 'article.ready', eventId: 'event-1', jobId: 'job-1',
    clientRequestId: 'laravel-1', body: '[]', allowLocal: true, signal,
  }
}

test('acknowledgement accepts only strict success with a bounded stable ID', () => {
  assert.deepEqual(parseWebhookAcknowledgement({ success: true, id_post: 42, ignored: 'not retained' }), { success: true, id_post: 42 })
  assert.deepEqual(parseWebhookAcknowledgement({ success: true, id_post: '  post:42  ' }), { success: true, id_post: 'post:42' })
  assert.deepEqual(parseWebhookAcknowledgement({ success: true, id_post: 'a'.repeat(160) }), { success: true, id_post: 'a'.repeat(160) })
  for (const value of [
    null, [], 'true', { success: false, id_post: 1 }, { success: 1, id_post: 1 }, { success: 'true', id_post: 1 },
    { success: true }, { success: true, id_post: null }, { success: true, id_post: 0 }, { success: true, id_post: -1 },
    { success: true, id_post: 1.1 }, { success: true, id_post: Number.MAX_SAFE_INTEGER + 1 },
    { success: true, id_post: '' }, { success: true, id_post: '  ' }, { success: true, id_post: 'a\nb' },
    { success: true, id_post: 'a'.repeat(161) }, { success: true, id_post: {} },
  ]) assert.equal(parseWebhookAcknowledgement(value), null, JSON.stringify(value))
})

test('ready webhook waits for the complete JSON acknowledgement before resolving', async t => {
  let endResponse!: () => void
  const pending = new Promise<void>(resolve => { endResponse = resolve })
  const url = await endpoint(t, response => {
    response.writeHead(201, { 'content-type': 'application/json' })
    response.write('{"success":true,')
    void pending.then(() => response.end('"id_post":123}'))
  })
  let settled = false
  const response = sendWebhook(input(url)).then(result => { settled = true; return result })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(settled, false)
  endResponse()
  assert.deepEqual(await response, { status: 201, retryAfterMs: 0, acknowledgement: { success: true, id_post: 123 } })
})

test('ready webhook rejects empty, malformed, false and missing-ID acknowledgement bodies', async t => {
  for (const body of ['', 'ok', '{', '{"success":false,"id_post":1}', '{"success":true}', '{"success":"true","id_post":1}']) {
    const url = await endpoint(t, response => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
    })
    assert.deepEqual(await sendWebhook(input(url)), { status: 200, retryAfterMs: 0, acknowledgement: null }, body)
  }
})

test('ready webhook bounds response bodies and preserves the HTTP status for an invalid receipt', async t => {
  const url = await endpoint(t, response => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ success: true, id_post: 123, padding: 'x'.repeat(65_536) }))
  })
  assert.deepEqual(await sendWebhook(input(url)), { status: 200, retryAfterMs: 0, acknowledgement: null })
})

test('ready webhook abort during a hanging body cannot acknowledge delivery', async t => {
  const url = await endpoint(t, response => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.write('{"success":true,"id_post":123')
  })
  const result = await sendWebhook(input(url, AbortSignal.timeout(50))).catch(() => null)
  assert.ok(result === null || result.acknowledgement === null)
})

test('non-2xx and failed-event responses retain HTTP-only handling', async t => {
  for (const [status, event] of [[500, 'article.ready'], [200, 'article.failed']] as const) {
    const url = await endpoint(t, response => {
      response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '60' })
      response.write('{"success":true,"id_post":123') // Intentionally never completes.
    })
    assert.deepEqual(await sendWebhook({ ...input(url), event }), { status, retryAfterMs: 60_000 })
  }
})
