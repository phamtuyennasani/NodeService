import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Readable, PassThrough } from 'node:stream'
import { request as httpsRequest } from 'node:https'
import { publicFetch } from '../src/public-fetch.js'
import { generateArticle, type GenerateInput } from '../src/worker/provider.js'

type Row = Record<string, any>
const dns = async () => [{ address: '93.184.216.34', family: 4 }]
function network(body: string | Buffer | Readable = '{}', status = 200, headers: Row = { 'content-type': 'application/json' }) {
  const calls: { url: URL, options: Row, body?: string }[] = []
  let response: Readable
  const request = ((url: URL, options: Row, receive: (response: any) => void) => {
    const call = { url, options } as typeof calls[number]
    calls.push(call)
    const connection = new EventEmitter() as EventEmitter & { end: (value?: string) => void }
    connection.end = value => {
      call.body = value
      queueMicrotask(() => {
        response = typeof body === 'string' || Buffer.isBuffer(body) ? Readable.from([body]) : body
        Object.assign(response, { statusCode: status, headers })
        receive(response)
      })
    }
    return connection
  }) as typeof httpsRequest
  return { request, calls, response: () => response }
}

test('public transport pins the checked IP to the original HTTPS hostname and streams article chunks', async () => {
  const body = new PassThrough()
  const f = network(body, 200, { 'content-type': 'text/event-stream', 'set-cookie': ['private=1'], connection: 'keep-alive' })
  let resolutions = 0
  const response = await publicFetch('https://provider.example/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' }, body: '{"model":"test"}',
  }, { resolve: async () => { resolutions++; return resolutions === 1 ? await dns() : [{ address: '127.0.0.1', family: 4 }] }, request: f.request })
  const observed = f.calls[0]
  assert.equal(resolutions, 1)
  assert.equal(observed.url.hostname, 'provider.example', 'TLS and Host keep the configured hostname')
  assert.equal(observed.options.agent, false)
  assert.equal(observed.options.headers['accept-encoding'], 'identity')
  assert.equal(observed.options.headers.authorization, 'Bearer fixture')
  assert.equal(observed.body, '{"model":"test"}')
  const pinned: any[][] = []
  observed.options.lookup('provider.example', {}, (...values: any[]) => pinned.push(values))
  observed.options.lookup('provider.example', {}, (...values: any[]) => pinned.push(values))
  assert.deepEqual(pinned, [[null, '93.184.216.34', 4], [null, '93.184.216.34', 4]])
  assert.equal(resolutions, 1, 'socket lookup never performs a second DNS resolution')
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.equal(response.headers.get('set-cookie'), null)
  assert.equal(response.headers.get('connection'), null)
  body.write('data: first\n\n')
  body.end('data: second\n\n')
  assert.equal(await response.text(), 'data: first\n\ndata: second\n\n')
})

test('public transport rejects private, mixed and mapped DNS answers before sending credentials', async () => {
  for (const addresses of [[], [{ address: '10.1.2.3', family: 4 }], [{ address: '::ffff:127.0.0.1', family: 6 }], [...await dns(), { address: '192.168.1.2', family: 4 }]]) {
    const f = network()
    await assert.rejects(publicFetch('https://provider.example/chat', { headers: { authorization: 'Bearer fixture' } }, { resolve: async () => addresses, request: f.request }))
    assert.equal(f.calls.length, 0)
  }
  for (const url of ['https://127.0.0.1/chat', 'https://[::1]/chat', 'http://8.8.8.8/chat', 'https://user:pass@provider.example/chat', 'https://provider.example/chat#fragment']) {
    const f = network()
    await assert.rejects(publicFetch(url, {}, { resolve: dns, request: f.request }))
    assert.equal(f.calls.length, 0)
  }
})

test('public transport never follows redirects and retains safe status and rate limit headers', async () => {
  for (const status of [301, 302, 307, 308]) {
    const f = network('', status, { location: 'https://127.0.0.1/private' })
    await assert.rejects(publicFetch('https://provider.example/chat', {}, { resolve: dns, request: f.request }), /redirect/)
    assert.equal(f.calls.length, 1)
  }
  for (const status of [101, 600, 999]) {
    const f = network('', status)
    await assert.rejects(publicFetch('https://provider.example/chat', {}, { resolve: dns, request: f.request }), /Invalid public response status/)
    assert.equal(f.response().destroyed, true)
  }
  for (const status of [401, 403, 429, 500]) {
    const f = network('upstream body', status, { 'retry-after': '30', 'content-type': 'application/json' })
    const response = await publicFetch('https://provider.example/chat', {}, { resolve: dns, request: f.request })
    assert.equal(response.status, status)
    assert.equal(response.headers.get('retry-after'), '30')
    await response.body!.cancel()
    assert.equal(f.response().destroyed, true)
  }
})

test('public transport rejects oversized/compressed responses and caps streaming bytes', async () => {
  for (const headers of [{ 'content-length': String(8 * 1024 * 1024 + 1) }, { 'content-length': 'invalid' }, { 'content-encoding': 'gzip' }]) {
    const f = network('{}', 200, headers)
    await assert.rejects(publicFetch('https://provider.example/chat', {}, { resolve: dns, request: f.request }))
    assert.equal(f.response().destroyed, true)
  }
  const f = network(Buffer.alloc(8 * 1024 * 1024 + 1, 65))
  const response = await publicFetch('https://provider.example/chat', {}, { resolve: dns, request: f.request })
  await assert.rejects(response.text(), /size limit/)
  assert.equal(f.response().destroyed, true)
})

test('DNS waits honor caller cancellation without starting a connection', async () => {
  const controller = new AbortController()
  const f = network()
  const pending = publicFetch('https://provider.example/chat', { signal: controller.signal }, { resolve: () => new Promise(() => {}), request: f.request })
  controller.abort(new Error('Canceled fixture request'))
  await assert.rejects(pending, /Canceled fixture request/)
  assert.equal(f.calls.length, 0)
})

test('compatible writer default refuses private destinations even if native fetch would accept them', async t => {
  let unsafeFetchCalls = 0
  t.mock.method(globalThis, 'fetch', async () => { unsafeFetchCalls++; throw new Error('Unsafe fetch should not run') })
  const input: GenerateInput = { provider: 'openai-compatible', baseUrl: 'https://127.0.0.1/v1', key: 'fixture', model: 'test', keyword: 'test', tone: 'test', style: 'test', length: 1000, instructions: null, source: null, signal: new AbortController().signal }
  await assert.rejects(generateArticle(input), { code: 'AI_CONNECTION' })
  assert.equal(unsafeFetchCalls, 0)
})
