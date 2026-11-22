import { randomUUID } from 'node:crypto'
import type { Config } from '../config.js'
import { collection, sessionOf, transaction, type Database, type TransactionContext } from '../db.js'
import { unseal } from '../security.js'
import { backoff, withLease } from './lease.js'
import { normalizeArticleFields, WorkerError } from './provider.js'
import { parseWebhookAcknowledgement, sendWebhook, type WebhookAcknowledgement, type WebhookInput, type WebhookResult } from './webhook.js'

const interrupted = 'Tiến trình giao bài bị gián đoạn trước khi lưu kết quả.'
const connectionError = 'Kết nối đến webhook gián đoạn hoặc hết thời gian chờ.'
const readyMaxAttempts = 4 // The first delivery plus three automatic retries.

function retryDelay(config: Config, delivery: Delivery, retryAfterMs = 0): number | null {
  if (delivery.event === 'article.ready') {
    return delivery.attempt_count < readyMaxAttempts ? (config.webhookRetryMinutes ?? 5) * 60_000 : null
  }
  return delivery.attempt_count < (config.webhookMaxAttempts ?? 5)
    ? backoff(delivery.attempt_count, 2_000, retryAfterMs)
    : null
}

interface Delivery {
  _id: string
  job_id: string
  site_id: string
  event: WebhookInput['event']
  attempt_count: number
  lease_token: string | null
}

interface Claim {
  delivery: Delivery
  lease: string
  attemptId: string
  input: Omit<WebhookInput, 'signal'>
}

export interface WebhookDependencies {
  send?: (input: WebhookInput) => Promise<WebhookResult>
}

async function transition(
  source: TransactionContext,
  delivery: Delivery,
  now: Date,
  status: number | null,
  error: string | null,
  delay: number | null,
  expired = false,
  acknowledgement: WebhookAcknowledgement | null = null,
) {
  const state = error === null ? 'delivered' : delay === null ? 'failed' : 'pending'
  const result = await collection<Delivery>(source, 'webhook_deliveries').updateOne({
    _id: delivery._id,
    status: 'sending',
    lease_token: delivery.lease_token,
    lease_expires_at: expired ? { $lte: now } : { $gt: now },
  }, {
    $set: {
      status: state,
      http_status: status,
      error,
      next_attempt_at: delay === null ? null : new Date(now.getTime() + delay),
      delivered_at: state === 'delivered' ? now : null,
      id_post: state === 'delivered' ? acknowledgement?.id_post ?? null : null,
      acknowledged_at: state === 'delivered' && acknowledgement ? now : null,
      lease_token: null,
      lease_expires_at: null,
      updated_at: now,
    },
  }, { session: sessionOf(source) })
  return result.matchedCount > 0
}

async function recoverDelivery(db: Database, config: Config, delivery: Delivery) {
  return transaction(db, async source => {
    const now = new Date()
    const delay = retryDelay(config, delivery)
    if (!await transition(source, delivery, now, null, interrupted, delay, true)) return false

    // Open attempts from before lease tokens were recorded are covered by the same ownership check.
    await collection(source, 'webhook_attempts').updateMany({ delivery_id: delivery._id, finished_at: null }, {
      $set: { finished_at: now, error: interrupted },
    }, { session: sessionOf(source) })
    return true
  })
}

async function claimDelivery(db: Database, config: Config): Promise<Claim | boolean> {
  const expired: Delivery | null = await collection<Delivery>(db, 'webhook_deliveries').findOne({
    status: 'sending',
    lease_expires_at: { $lte: new Date() },
  })
  if (expired && await recoverDelivery(db, config, expired)) return true

  return transaction(db, async source => {
    const now = new Date()
    const lease = randomUUID()
    const session = sessionOf(source)
    // Existing pending deliveries may have been queued under an older retry
    // policy. Retire them without issuing a fifth request or inventing an attempt.
    const exhausted = await collection<Delivery>(source, 'webhook_deliveries').findOneAndUpdate({
      status: 'pending', event: 'article.ready', attempt_count: { $gte: readyMaxAttempts },
      next_attempt_at: { $lte: now },
    }, {
      $set: {
        status: 'failed', error: 'Đã hết ba lần tự động gửi lại bài viết đến Laravel.',
        next_attempt_at: null,
        delivered_at: null, id_post: null, acknowledged_at: null,
        lease_token: null, lease_expires_at: null, updated_at: now,
      },
    }, { session, sort: { next_attempt_at: 1, _id: 1 }, returnDocument: 'after' })
    if (exhausted) return true
    const delivery: Delivery | null = await collection<Delivery>(source, 'webhook_deliveries').findOneAndUpdate({
      status: 'pending',
      next_attempt_at: { $lte: now },
    }, {
      $set: {
        status: 'sending',
        lease_token: lease,
        lease_expires_at: new Date(now.getTime() + config.leaseMs),
        updated_at: now,
      },
      $inc: { attempt_count: 1 },
    }, { session, sort: { next_attempt_at: 1, _id: 1 }, returnDocument: 'after' })
    if (!delivery) return false

    const site = await collection(source, 'sites').findOne({ _id: delivery.site_id }, { session })
    const job = await collection(source, 'jobs').findOne({ _id: delivery.job_id }, { session })
    const attemptId = randomUUID()
    await collection(source, 'webhook_attempts').insertOne({
      _id: attemptId,
      delivery_id: delivery._id,
      attempted_at: now,
      finished_at: null,
      http_status: null,
      error: null,
      id_post: null,
      acknowledged_at: null,
    }, { session })

    let secret: string
    try {
      secret = unseal(site?.webhook_secret, config.encryptionKey)
    } catch {
      await completeDelivery(source, config, delivery, attemptId, null, new WorkerError(
        'WEBHOOK_SECRET', 'Không đọc được khóa ký webhook của website.', false,
      ))
      return true
    }

    const result = job?.result
    const payload = delivery.event === 'article.ready'
      ? Array.isArray(result) ? result.map(normalizeArticleFields) : result
      : { error: { code: job?.error_code, message: job?.error_message } }

    return { delivery, lease, attemptId, input: {
      url: site.webhook_url,
      secret,
      body: JSON.stringify(payload),
      allowLocal: config.allowLocalWebhooks,
      event: delivery.event,
      eventId: delivery._id,
      jobId: delivery.job_id,
      clientRequestId: job?.client_request_id,
    } }
  })
}

async function completeDelivery(
  source: TransactionContext,
  config: Config,
  delivery: Delivery,
  attemptId: string,
  status: number | null,
  error: WorkerError | null,
  acknowledgement: WebhookAcknowledgement | null = null,
) {
  const now = new Date()
  const delay = error?.retryable ? retryDelay(config, delivery, error.retryAfterMs) : null
  if (!await transition(source, delivery, now, status, error?.message ?? null, delay, false, acknowledgement)) return

  await collection(source, 'webhook_attempts').updateOne({ _id: attemptId, finished_at: null }, {
    $set: {
      finished_at: now, http_status: status, error: error?.message ?? null,
      id_post: error === null ? acknowledgement?.id_post ?? null : null,
      acknowledged_at: error === null && acknowledgement ? now : null,
    },
  }, { session: sessionOf(source) })
}

export async function runWebhookOnce(db: Database, config: Config, deps: WebhookDependencies = {}): Promise<boolean> {
  const claim = await claimDelivery(db, config)
  if (typeof claim === 'boolean') return claim
  const { delivery, lease, input, attemptId } = claim
  const send = deps.send ?? sendWebhook
  let status: number | null = null
  let error: WorkerError | null = null
  let acknowledgement: WebhookAcknowledgement | null = null
  try {
    const response = await withLease(db, config, 'webhook_deliveries', delivery._id, lease,
      Math.min(config.webhookTimeoutMs ?? 15_000, config.leaseMs - 1), async signal => {
        // The claim may have expired while its transaction committed or the worker was paused.
        const owned = await collection<Delivery>(db, 'webhook_deliveries').findOne({
          _id: delivery._id,
          status: 'sending',
          lease_token: lease,
          lease_expires_at: { $gt: new Date() },
        })
        if (!owned) return null
        signal.throwIfAborted()
        return send({ ...input, signal })
      })
    if (!response) return true
    status = response.status
    if (!Number.isInteger(status) || status < 200 || status >= 300) {
      const retryable = delivery.event === 'article.ready' || status === 408 || status === 425 || status === 429 || status >= 500
      error = new WorkerError('WEBHOOK_HTTP', 'Webhook phản hồi HTTP ' + status + '.', retryable, response.retryAfterMs)
    } else if (delivery.event === 'article.ready') {
      acknowledgement = parseWebhookAcknowledgement(response.acknowledgement)
      if (!acknowledgement) error = new WorkerError('WEBHOOK_ACKNOWLEDGEMENT',
        'Laravel chưa trả xác nhận hợp lệ với success: true và id_post.', true)
    }
  } catch (failure) {
    error = failure instanceof WorkerError ? failure : new WorkerError('WEBHOOK_CONNECTION', connectionError, true)
  }
  await transaction(db, source => completeDelivery(source, config, delivery, attemptId, status, error, acknowledgement))
  return true
}
