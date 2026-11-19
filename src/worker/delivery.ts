import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { Config } from '../config.js'
import { transaction, type Database } from '../db.js'
import { unseal } from '../security.js'
import { backoff, withLease } from './lease.js'
import { WorkerError } from './provider.js'
import { sendWebhook, type WebhookInput, type WebhookResult } from './webhook.js'

const maxAttempts = 5

interface Delivery {
  id: string
  job_id: string
  event: WebhookInput['event']
  attempt_count: number
  webhook_url: string
  webhook_secret: string
  client_request_id: string
  result: unknown
  error_code: string | null
  error_message: string | null
}

export interface WebhookDependencies {
  send?: (input: WebhookInput) => Promise<WebhookResult>
}

async function transition(client: PoolClient, id: string, status: number | null, error: string | null, delay: number | null) {
  const state = error === null ? 'delivered' : delay === null ? 'failed' : 'pending'
  await client.query(`
    UPDATE webhook_deliveries SET status=$2,http_status=$3,error=$4,
      next_attempt_at=CASE WHEN $5::int IS NULL THEN next_attempt_at
        ELSE clock_timestamp()+($5::int*interval '1 ms') END,
      delivered_at=CASE WHEN $2='delivered' THEN clock_timestamp() ELSE NULL END,
      lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
    WHERE id=$1
  `, [id, state, status, error, delay])
}

async function claimDelivery(db: Database, config: Config) {
  return transaction(db, async client => {
    const { rows: [expired] } = await client.query<{ id: string; attempt_count: number }>(`
      SELECT id,attempt_count FROM webhook_deliveries
      WHERE status='sending' AND lease_expires_at<=now()
      ORDER BY lease_expires_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
    `)
    if (expired) {
      const error = 'Tiến trình giao bài bị gián đoạn trước khi lưu kết quả.'
      await client.query(`
        UPDATE webhook_attempts SET finished_at=clock_timestamp(),error=$2
        WHERE delivery_id=$1 AND finished_at IS NULL
      `, [expired.id, error])
      await transition(client, expired.id, null, error,
        expired.attempt_count < maxAttempts ? backoff(expired.attempt_count, 2_000) : null)
      return true
    }

    const { rows: [delivery] } = await client.query<Delivery>(`
      SELECT w.*,s.webhook_url,s.webhook_secret,j.result,j.client_request_id,j.error_code,j.error_message
      FROM webhook_deliveries w
      JOIN sites s ON s.id=w.site_id
      JOIN jobs j ON j.id=w.job_id
      WHERE w.status='pending' AND w.next_attempt_at<=now()
      ORDER BY w.next_attempt_at,w.id LIMIT 1 FOR UPDATE OF w SKIP LOCKED
    `)
    if (!delivery) return false

    let secret: string
    try {
      secret = unseal(delivery.webhook_secret, config.encryptionKey)
    } catch {
      await transition(client, delivery.id, null, 'Không đọc được khóa ký webhook của website.', null)
      return true
    }
    const lease = randomUUID()
    await client.query(`
      UPDATE webhook_deliveries SET status='sending',attempt_count=attempt_count+1,
        lease_token=$2,lease_expires_at=clock_timestamp()+($3::int*interval '1 ms'),updated_at=clock_timestamp()
      WHERE id=$1
    `, [delivery.id, lease, config.leaseMs])
    const { rows: [attempt] } = await client.query<{ id: string }>(`
      INSERT INTO webhook_attempts(delivery_id) VALUES($1) RETURNING id
    `, [delivery.id])
    delivery.attempt_count += 1
    const body = JSON.stringify(delivery.event === 'article.ready' ? delivery.result : {
      error: { code: delivery.error_code, message: delivery.error_message },
    })
    return {
      delivery, lease, attemptId: attempt.id,
      input: {
        url: delivery.webhook_url, secret, body, allowLocal: config.allowLocalWebhooks,
        event: delivery.event, eventId: delivery.id, jobId: delivery.job_id, clientRequestId: delivery.client_request_id,
      },
    }
  })
}

export async function runWebhookOnce(db: Database, config: Config, deps: WebhookDependencies = {}): Promise<boolean> {
  const claim = await claimDelivery(db, config)
  if (typeof claim === 'boolean') return claim

  const { delivery, lease, input, attemptId } = claim
  const send = deps.send ?? sendWebhook
  let status: number | null = null
  let error: WorkerError | null = null
  try {
    const response = await withLease(db, config, 'webhook_deliveries', delivery.id, lease,
      Math.min(15_000, config.leaseMs - 1), signal => send({ ...input, signal }))
    status = response.status
    if (status < 200 || status >= 300) {
      const retryable = status === 408 || status === 425 || status === 429 || status >= 500
      error = new WorkerError('WEBHOOK_HTTP', 'Webhook phản hồi HTTP ' + status + '.', retryable, response.retryAfterMs)
    }
  } catch (failure) {
    error = failure instanceof WorkerError ? failure
      : new WorkerError('WEBHOOK_CONNECTION', 'Kết nối đến webhook gián đoạn hoặc hết thời gian chờ.', true)
  }

  await transaction(db, async client => {
    const { rowCount: owned } = await client.query(`
      SELECT 1 FROM webhook_deliveries
      WHERE id=$1 AND status='sending' AND lease_token=$2 AND lease_expires_at>clock_timestamp() FOR UPDATE
    `, [delivery.id, lease])
    if (!owned) return
    await client.query(`
      UPDATE webhook_attempts SET finished_at=clock_timestamp(),http_status=$2,error=$3 WHERE id=$1
    `, [attemptId, status, error?.message ?? null])
    const delay = error?.retryable && delivery.attempt_count < maxAttempts
      ? backoff(delivery.attempt_count, 2_000, error.retryAfterMs) : null
    await transition(client, delivery.id, status, error?.message ?? null, delay)
  })
  return true
}
