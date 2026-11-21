import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import test from 'node:test'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { seal } from '../src/security.js'
import { runWebhookOnce } from '../src/worker/delivery.js'
import { webhookHeaders } from '../src/worker/webhook.js'

type Row = Record<string, any>

function memoryDatabase(tables: Record<string, Row[]>): Database {
  const matches = (row: Row, filter: Row) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$gt' in value) return row[key] > value.$gt
      if ('$lte' in value) return row[key] <= value.$lte
    }
    return row[key] === value
  })
  return {
    db: {
      collection(name: string) {
        const rows = tables[name] ??= []
        const update = (row: Row, changes: Row) => {
          Object.assign(row, structuredClone(changes.$set ?? {}))
          for (const [field, amount] of Object.entries(changes.$inc ?? {})) row[field] += amount
        }
        return {
          async findOne(filter: Row) { return structuredClone(rows.find(row => matches(row, filter)) ?? null) },
          async findOneAndUpdate(filter: Row, changes: Row) {
            const row = rows.find(row => matches(row, filter))
            if (!row) return null
            update(row, changes)
            return structuredClone(row)
          },
          async insertOne(row: Row) { rows.push(structuredClone(row)) },
          async updateOne(filter: Row, changes: Row) {
            const row = rows.find(row => matches(row, filter))
            if (row) update(row, changes)
            return { matchedCount: row ? 1 : 0 }
          },
        }
      },
    },
    client: {
      async connect() {},
      startSession() {
        return {
          async withTransaction<T>(callback: () => Promise<T>) { return callback() },
          async endSession() {},
        }
      },
    },
  } as unknown as Database
}

test('ready delivery preserves the six-field Laravel payload and excludes internal writing data', async () => {
  const jobId = randomUUID()
  const siteId = randomUUID()
  const eventId = randomUUID()
  const encryptionKey = Buffer.alloc(32, 8)
  const secret = 'test-webhook-secret'
  const article = {
    Title: 'Cà phê tại nhà và bí quyết chọn hương vị riêng',
    Content: '<p style="color:#333">Chọn cà phê phù hợp với khẩu vị.</p>',
    Slug: 'ca-phe-tai-nha',
    Desc: 'Hướng dẫn pha cà phê tại nhà.',
    Description: 'Bí quyết chọn cà phê và phương pháp pha tại nhà.',
    Keywords: ['cà phê', 'pha tại nhà'],
  }
  const tables: Record<string, Row[]> = {
    jobs: [{
      _id: jobId,
      keyword: 'cà phê',
      client_request_id: 'laravel-schedule-123',
      result: [article],
      status: 'ready',
      writing_stage: 'complete',
      seo_report: { score: 80, warnings: [{ key: 'lengthMetaDescription' }] },
      outline: { searchIntent: 'informational' },
      research: { sources: [{ title: 'Internal reference' }] },
    }],
    sites: [{
      _id: siteId,
      webhook_url: 'https://example.vn/receive',
      webhook_secret: seal(secret, encryptionKey),
    }],
    webhook_deliveries: [{
      _id: eventId,
      job_id: jobId,
      site_id: siteId,
      event: 'article.ready',
      attempt_count: 0,
      status: 'pending',
      next_attempt_at: new Date(0),
      lease_token: null,
      lease_expires_at: null,
    }],
    webhook_attempts: [],
  }
  let sent = 0
  const handled = await runWebhookOnce(memoryDatabase(tables), { encryptionKey, leaseMs: 30_000, allowLocalWebhooks: false } as Config, {
    async send(input) {
      sent += 1
      assert.equal(input.jobId, jobId)
      assert.equal(input.clientRequestId, 'laravel-schedule-123')
      assert.equal(input.event, 'article.ready')
      assert.deepEqual(JSON.parse(input.body), [article])
      assert.deepEqual(Object.keys(JSON.parse(input.body)[0]), ['Title', 'Content', 'Slug', 'Desc', 'Description', 'Keywords'])
      assert.doesNotMatch(input.body, /seo_report|outline|research|writing_stage/)

      const headers = webhookHeaders({ ...input, timestamp: '2000000000' })
      assert.equal(headers['x-client-request-id'], 'laravel-schedule-123')
      const message = ['2000000000', input.event, eventId, jobId, input.clientRequestId, input.body].join('\n')
      assert.equal(headers['x-signature'], 'sha256=' + createHmac('sha256', secret).update(message).digest('hex'))
      return { status: 200, retryAfterMs: 0 }
    },
  })
  assert.equal(handled, true)
  assert.equal(sent, 1)
  assert.equal(tables.webhook_deliveries[0].status, 'delivered')
  assert.equal(tables.webhook_attempts[0].http_status, 200)
})
