import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { publicAddress, validateWebhookUrl } from './worker/webhook.js'

const maxResponseBytes = 8 * 1024 * 1024

export interface PublicFetchOptions {
  /** Network seams for tests. Production always pins one checked public IP. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>
  request?: typeof httpsRequest
}

async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  const canceled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try { signal.throwIfAborted(); return await Promise.race([work, canceled]) }
  finally { signal.removeEventListener('abort', abort) }
}

/** Minimal bounded HTTPS transport for configured AI hosts. Never follows redirects. */
export async function publicFetch(input: string | URL | Request, init: RequestInit = {}, options: PublicFetchOptions = {}): Promise<Response> {
  // Current callers pass URL/string and JSON text, never browser Request objects,
  // streaming uploads or cookies. Reject unsupported forms rather than bypassing
  // validation through an implicit fetch implementation.
  if (input instanceof Request || (init.body != null && typeof init.body !== 'string')) throw new Error('Unsupported public request')
  const url = validateWebhookUrl(String(input), false)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const signal = init.signal ?? AbortSignal.timeout(120_000)
  signal.throwIfAborted()
  const literal = isIP(hostname)
  const addresses = literal ? [{ address: hostname, family: literal }] : await untilAborted(
    (options.resolve ?? (host => lookup(host, { all: true })))(hostname), signal,
  )
  const destination = addresses[0]
  if (!destination || addresses.some(item => !publicAddress(item.address))) throw new Error('Public destination required')
  signal.throwIfAborted()
  const headers = new Headers(init.headers)
  for (const name of ['host', 'cookie', 'connection', 'transfer-encoding', 'content-length']) {
    if (headers.has(name)) throw new Error('Unsupported public request header')
  }
  headers.set('accept-encoding', 'identity')
  if (init.body != null) headers.set('content-length', String(Buffer.byteLength(init.body)))
  const method = (init.method ?? 'GET').toUpperCase()
  if (!['GET', 'POST'].includes(method)) throw new Error('Unsupported public request method')

  return new Promise<Response>((resolve, reject) => {
    const connection = (options.request ?? httpsRequest)(url, {
      method, headers: Object.fromEntries(headers), signal, agent: false,
      family: destination.family,
      lookup: (_host, _options, callback) => callback(null, destination.address, destination.family),
    }, response => {
      const status = response.statusCode ?? 502
      const fail = (message: string) => { response.destroy(); reject(new Error(message)) }
      if (status < 200 || status > 599) return fail('Invalid public response status')
      if (status >= 300 && status < 400) return fail('Public redirects are not permitted')
      const encoding = response.headers['content-encoding']
      if (encoding && String(encoding).toLowerCase() !== 'identity') return fail('Compressed public responses are not permitted')
      const length = response.headers['content-length']
      if (length && (!/^\d+$/.test(String(length)) || Number(length) > maxResponseBytes)) return fail('Public response exceeds size limit')
      const responseHeaders = new Headers()
      for (const [name, value] of Object.entries(response.headers)) {
        if (['set-cookie', 'connection', 'transfer-encoding', 'keep-alive'].includes(name) || value == null) continue
        for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(name, item)
      }
      if (status === 204 || status === 205 || status === 304) {
        response.destroy()
        resolve(new Response(null, { status, headers: responseHeaders }))
        return
      }
      let bytes = 0
      let finished = false
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const interrupted = () => {
            if (finished) return
            finished = true
            controller.error(new Error('Public response interrupted'))
          }
          response.on('data', (chunk: Buffer | string) => {
            if (finished) return
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            bytes += data.byteLength
            if (bytes > maxResponseBytes) { finished = true; controller.error(new Error('Public response exceeds size limit')); response.destroy(); return }
            controller.enqueue(data)
            if ((controller.desiredSize ?? 0) <= 0) response.pause()
          })
          response.once('end', () => { if (!finished) { finished = true; controller.close() } })
          response.once('error', interrupted)
          response.once('aborted', interrupted)
        },
        pull() { response.resume() },
        cancel() { finished = true; response.destroy() },
      })
      resolve(new Response(stream, { status, headers: responseHeaders }))
    })
    connection.once('error', () => reject(new Error('Public connection failed')))
    connection.end(init.body ?? undefined)
  })
}
