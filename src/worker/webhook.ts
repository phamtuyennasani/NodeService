import { createHmac } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import ipaddr from 'ipaddr.js'
import { retryAfter, WorkerError } from './provider.js'

const stripBrackets = (host: string) => host.replace(/^\[|\]$/g, '')

export function publicAddress(address: string): boolean {
  return ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast'
}

export async function assertPublicDestination(url: URL): Promise<void> {
  const hostname = stripBrackets(url.hostname)
  const literal = isIP(hostname)
  if (literal) {
    if (!publicAddress(hostname)) throw new Error('Private destination')
    return
  }
  const addresses = await lookup(hostname, { all: true })
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Private destination')
}

export function validateWebhookUrl(input: string, allowLocal: boolean): URL {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new WorkerError('WEBHOOK_URL', 'URL webhook không hợp lệ.', false)
  }
  if ((url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:')) ||
    url.username || url.password || url.hash) {
    throw new WorkerError('WEBHOOK_URL', 'Webhook cần URL HTTPS hợp lệ.', false)
  }
  const hostname = stripBrackets(url.hostname).toLowerCase().replace(/\.$/, '')
  if (!allowLocal && (isIP(hostname) ? !publicAddress(hostname) : (
    !hostname.includes('.') || /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(hostname)
  ))) {
    throw new WorkerError('WEBHOOK_DESTINATION', 'Địa chỉ mạng của webhook không được phép.', false)
  }
  return url
}

export interface WebhookInput {
  url: string
  secret: string
  event: 'article.ready' | 'article.failed'
  eventId: string
  jobId: string
  clientRequestId: string
  body: string
  signal: AbortSignal
  allowLocal: boolean
  timestamp?: string
}

export interface WebhookResult {
  status: number
  retryAfterMs: number
  acknowledgement?: WebhookAcknowledgement | null
}

export interface WebhookAcknowledgement {
  success: true
  id_post: string | number
}

/** Only this small acknowledgement is retained; response bodies may contain sensitive data. */
export function parseWebhookAcknowledgement(value: unknown): WebhookAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (row.success !== true) return null
  if (typeof row.id_post === 'number') {
    return Number.isSafeInteger(row.id_post) && row.id_post > 0 ? { success: true, id_post: row.id_post } : null
  }
  if (typeof row.id_post !== 'string') return null
  const id = row.id_post.trim()
  return id && id.length <= 160 && !/[\u0000-\u001f\u007f]/.test(row.id_post)
    ? { success: true, id_post: id }
    : null
}

export function webhookHeaders(input: WebhookInput): Record<string, string | number> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1_000).toString()
  const message = [timestamp, input.event, input.eventId, input.jobId, input.clientRequestId, input.body].join('\n')
  return {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(input.body),
    'x-article-event': input.event,
    'x-event-id': input.eventId,
    'x-job-id': input.jobId,
    'x-client-request-id': input.clientRequestId,
    'x-timestamp': timestamp,
    'x-signature': 'sha256=' + createHmac('sha256', input.secret).update(message).digest('hex'),
  }
}

async function resolveDestination(hostname: string, signal: AbortSignal) {
  const literal = isIP(hostname)
  if (literal) return [{ address: hostname, family: literal }]
  // DNS itself has no cancellation. Stop the worker waiting for it on timeout.
  let abort: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    signal.throwIfAborted()
    return await Promise.race([lookup(hostname, { all: true }), aborted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export async function sendWebhook(input: WebhookInput): Promise<WebhookResult> {
  const url = validateWebhookUrl(input.url, input.allowLocal)
  const hostname = stripBrackets(url.hostname)
  const addresses = await resolveDestination(hostname, input.signal).catch(() => {
    throw new WorkerError('WEBHOOK_DNS', 'Không phân giải được tên miền webhook.', true)
  })
  const destination = addresses[0]
  if (!destination || (!input.allowLocal && addresses.some(item => !publicAddress(item.address)))) {
    throw new WorkerError('WEBHOOK_DESTINATION', 'Địa chỉ mạng của webhook không được phép.', false)
  }

  const request = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, reject) => {
    const connection = request(url, {
      method: 'POST',
      headers: webhookHeaders(input),
      signal: input.signal,
      agent: false,
      family: destination.family,
      lookup: (_host, _options, callback) => callback(null, destination.address, destination.family),
    }, response => {
      const result: WebhookResult = {
        status: response.statusCode ?? 502,
        retryAfterMs: retryAfter(typeof response.headers['retry-after'] === 'string' ? response.headers['retry-after'] : null),
      }
      // Failure notifications retain their HTTP-only contract. Non-2xx ready
      // responses cannot acknowledge delivery, irrespective of their body.
      if (input.event !== 'article.ready' || result.status < 200 || result.status >= 300) {
        resolve(result)
        response.destroy()
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      let finished = false
      const finish = (acknowledgement: WebhookAcknowledgement | null) => {
        if (finished) return
        finished = true
        resolve({ ...result, acknowledgement })
      }
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 64 * 1_024) {
          finish(null)
          response.destroy()
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          finish(parseWebhookAcknowledgement(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
        } catch {
          finish(null)
        }
      })
      response.on('aborted', () => finish(null))
      response.on('error', () => finish(null))
    })
    connection.on('error', () => {
      reject(new WorkerError('WEBHOOK_CONNECTION', 'Kết nối đến webhook gián đoạn hoặc hết thời gian chờ.', true))
    })
    connection.end(input.body)
  })
}
