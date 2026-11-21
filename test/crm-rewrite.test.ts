import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerReports } from '../src/api/crm-reports.js'
import { installErrorHandler } from '../src/api/errors.js'
import { unseal } from '../src/security.js'
import { evaluateSeo } from '../src/worker/seo.js'

type Row = Record<string, any>
type Tables = Record<string, Row[]>

// Exercise the real route, catalog and createJob/quota logic without MongoDB,
// workers or a provider request. Roll back the fake transaction on failures.
function memoryDatabase(tables: Tables): Database {
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([field, expected]) => {
    if (field === '$or') return expected.some((branch: Row) => matches(row, branch))
    const actual = row[field]
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.includes(actual)
      if ('$ne' in expected) return actual !== expected.$ne
    }
    return actual === expected
  })
  const db = {
    collection(name: string) {
      const rows = () => tables[name] ??= []
      return {
        async findOne(filter: Row) { return structuredClone(rows().find(row => matches(row, filter)) ?? null) },
        find(filter: Row) {
          const cursor = {
            sort() { return cursor },
            async toArray() { return structuredClone(rows().filter(row => matches(row, filter))) },
          }
          return cursor
        },
        async insertOne(row: Row) { rows().push(structuredClone(row)); return { insertedId: row._id } },
        async updateOne(filter: Row, update: Row, options?: { upsert?: boolean }) {
          let row = rows().find(item => matches(item, filter))
          if (!row && options?.upsert) { row = { ...filter }; rows().push(row) }
          if (row) Object.assign(row, structuredClone(update.$set ?? {}))
          return { matchedCount: row ? 1 : 0 }
        },
        async updateMany(filter: Row, update: Row) {
          const matched = rows().filter(item => matches(item, filter))
          matched.forEach(item => Object.assign(item, structuredClone(update.$set ?? {})))
          return { matchedCount: matched.length, modifiedCount: matched.length }
        },
        async deleteOne(filter: Row) {
          const index = rows().findIndex(item => matches(item, filter))
          if (index < 0) return { deletedCount: 0 }
          rows().splice(index, 1)
          return { deletedCount: 1 }
        },
        async deleteMany(filter: Row) {
          const kept = rows().filter(item => !matches(item, filter))
          const deletedCount = rows().length - kept.length
          rows().splice(0, rows().length, ...kept)
          return { deletedCount }
        },
      }
    },
  }
  const client = {
    async connect() {},
    startSession() {
      return {
        async withTransaction<T>(callback: () => Promise<T>) {
          const before = structuredClone(tables)
          try { return await callback() }
          catch (error) {
            Object.keys(tables).forEach(name => delete tables[name])
            Object.assign(tables, before)
            throw error
          }
        },
        async endSession() {},
      }
    },
  }
  return { db, client } as unknown as Database
}

async function fixture(t: test.TestContext) {
  const customerId = randomUUID()
  const siteId = randomUUID()
  const sourceId = randomUUID()
  const now = new Date('2026-11-20T03:00:00Z')
  const article = {
    _id: sourceId, site_id: siteId, customer_id: customerId,
    client_request_id: 'original-request', request_hash: 'original-hash',
    mode: 'scheduled', source_article_id: null, retry_of_job_id: null, version: 1,
    provider: 'openai', model: 'gpt-test', keyword: 'thiết kế website',
    tone: 'Chuyên nghiệp', style: 'Hướng dẫn', length: 1200,
    instructions: 'Giữ ví dụ thực tế.', key_mode: 'service', encrypted_key: null,
    status: 'ready', scheduled_at: now, available_at: now, attempt_count: 1,
    lease_token: null, lease_expires_at: null, started_at: now, completed_at: now,
    result: [{ Title: 'Bài viết nguồn', Content: '<p>Nội dung nguồn.</p>', Slug: 'bai-viet-nguon', Desc: 'Mô tả nguồn.', Description: 'Mô tả SEO nguồn.', Keywords: ['thiết kế website'] }],
    error_code: null, error_message: null, created_at: now, updated_at: now,
  }
  const tables: Tables = {
    jobs: [article],
    sites: [{ _id: siteId, customer_id: customerId, name: 'Website thử nghiệm', token_hash: null, webhook_url: null, webhook_secret: null }],
    customers: [{ _id: customerId, name: 'Khách thử nghiệm', key_mode: 'service', daily_limit: 10, monthly_limit: 100, starts_at: null, ends_at: null, allowed_models: ['gpt-test'], max_length: 2500 }],
    ai_models: [{ _id: 'gpt-test', provider: 'openai', enabled: true }],
    ai_providers: [{ _id: 'openai', enabled: true }],
    quota_reservations: [],
  }
  const config = { encryptionKey: Buffer.alloc(32, 17), serviceKeys: { openai: 'fake-service-key' } } as unknown as Config
  const app = Fastify()
  installErrorHandler(app)
  registerReports(app, memoryDatabase(tables), config)
  await app.ready()
  t.after(() => app.close())
  return { app, tables, article, sourceId, customerId, siteId, config }
}

test('CRM job detail carries the same precise priced cost used for targeted row updates', async t => {
  const { app, tables, sourceId } = await fixture(t)
  tables.ai_attempts = [
    { _id: randomUUID(), job_id: sourceId, cost_usd: '0.100000000001' },
    { _id: randomUUID(), job_id: sourceId, cost_usd: '0.2' },
    { _id: randomUUID(), job_id: sourceId, cost_usd: null },
  ]
  const request = () => app.inject({ method: 'GET', url: `/jobs/${sourceId}` })
  assert.equal((await request()).json().cost_usd, '0.300000000001')
  tables.ai_attempts = [{ _id: randomUUID(), job_id: sourceId, cost_usd: '0' }]
  assert.equal((await request()).json().cost_usd, '0.000000000000')
  tables.ai_attempts = [{ _id: randomUUID(), job_id: sourceId, cost_usd: null }]
  assert.equal((await request()).json().cost_usd, null)
})

test('CRM rewrite queues a separate version and retains source settings and instructions', async t => {
  const { app, tables, article, sourceId, customerId, siteId } = await fixture(t)
  const before = structuredClone(article)
  const response = await app.inject({ method: 'POST', url: `/jobs/${sourceId}/rewrite`, payload: { instructions: 'Bổ sung phần chi phí.' } })

  assert.equal(response.statusCode, 202, response.body)
  const body = response.json()
  assert.equal(body.status, 'queued')
  assert.equal(body.source_article_id, sourceId)
  assert.equal(body.retry_of_job_id, null)
  assert.notEqual(body.job_id, sourceId)
  assert.equal(tables.jobs.length, 2)
  assert.deepEqual(tables.jobs.find(job => job._id === sourceId), before)
  const rewritten = tables.jobs.find(job => job._id === body.job_id)!
  assert.deepEqual({
    site_id: rewritten.site_id, customer_id: rewritten.customer_id,
    mode: rewritten.mode, source_article_id: rewritten.source_article_id,
    model: rewritten.model, provider: rewritten.provider, keyword: rewritten.keyword,
    tone: rewritten.tone, style: rewritten.style, length: rewritten.length,
    instructions: rewritten.instructions, status: rewritten.status,
    result: rewritten.result, attempt_count: rewritten.attempt_count,
    scheduled_at: rewritten.scheduled_at,
  }, {
    site_id: siteId, customer_id: customerId,
    mode: 'rewrite', source_article_id: sourceId,
    model: before.model, provider: before.provider, keyword: before.keyword,
    tone: before.tone, style: before.style, length: before.length,
    instructions: 'Giữ ví dụ thực tế.\n\nBổ sung phần chi phí.', status: 'queued',
    result: null, attempt_count: 0, scheduled_at: null,
  })
  assert.equal(tables.quota_reservations.length, 1)
  assert.equal(tables.quota_reservations[0].job_id, body.job_id)
  assert.equal(tables.quota_reservations[0].status, 'reserved')
})

test('CRM deletes a completed article and its related processing records', async t => {
  const { app, tables, sourceId } = await fixture(t)
  tables.ai_attempts = [{ _id: 'attempt-1', job_id: sourceId }]
  tables.webhook_deliveries = [{ _id: 'delivery-1', job_id: sourceId }]
  tables.webhook_attempts = [{ _id: 'webhook-attempt-1', delivery_id: 'delivery-1' }]
  tables.quota_reservations = [{ _id: 'reservation-1', job_id: sourceId }]
  const response = await app.inject({ method: 'DELETE', url: `/jobs/${sourceId}` })
  assert.equal(response.statusCode, 204, response.body)
  assert.equal(tables.jobs.some(job => job._id === sourceId), false)
  assert.equal(tables.ai_attempts.some(row => row.job_id === sourceId), false)
  assert.equal(tables.webhook_deliveries.some(row => row.job_id === sourceId), false)
  assert.equal(tables.webhook_attempts.some(row => row.delivery_id === 'delivery-1'), false)
  assert.equal(tables.quota_reservations.some(row => row.job_id === sourceId), false)
})

test('CRM refuses to delete a job while the writer is processing it', async t => {
  const { app, article } = await fixture(t)
  article.status = 'writing'
  const response = await app.inject({ method: 'DELETE', url: `/jobs/${article._id}` })
  assert.equal(response.statusCode, 409, response.body)
  assert.equal(response.json().error.code, 'job_in_progress')
})

test('CRM deletion clears only references to the deleted job', async t => {
  const { app, tables, sourceId } = await fixture(t)
  const otherSource = randomUUID()
  const otherRetry = randomUUID()
  const sourceChild = { ...structuredClone(tables.jobs[0]), _id: randomUUID(), source_article_id: sourceId, retry_of_job_id: otherRetry }
  const retryChild = { ...structuredClone(tables.jobs[0]), _id: randomUUID(), source_article_id: otherSource, retry_of_job_id: sourceId }
  tables.jobs.push(sourceChild, retryChild)
  const response = await app.inject({ method: 'DELETE', url: `/jobs/${sourceId}` })
  assert.equal(response.statusCode, 204, response.body)
  assert.equal(sourceChild.source_article_id, null)
  assert.equal(sourceChild.retry_of_job_id, otherRetry)
  assert.equal(retryChild.source_article_id, otherSource)
  assert.equal(retryChild.retry_of_job_id, null)
})

test('CRM refuses deletion while a rewrite uses the source or its webhook is sending', async t => {
  for (const scenario of ['rewrite', 'webhook']) {
    await t.test(scenario, async t => {
      const { app, tables, sourceId } = await fixture(t)
      if (scenario === 'rewrite') tables.jobs.push({ ...structuredClone(tables.jobs[0]), _id: randomUUID(), source_article_id: sourceId, status: 'writing' })
      else tables.webhook_deliveries = [{ _id: randomUUID(), job_id: sourceId, status: 'sending' }]
      const before = structuredClone(tables)
      const response = await app.inject({ method: 'DELETE', url: `/jobs/${sourceId}` })
      assert.equal(response.statusCode, 409, response.body)
      assert.equal(response.json().error.code, 'job_in_progress')
      assert.deepEqual(tables, before)
    })
  }
})

test('CRM webhook history advances past the date and id cursor', async t => {
  const { app, tables, sourceId, siteId } = await fixture(t)
  const ids = [randomUUID(), randomUUID(), randomUUID()].sort().reverse()
  const createdAt = new Date('2026-11-20T03:00:00Z')
  tables.webhook_deliveries = ids.map(id => ({ _id: id, job_id: sourceId, site_id: siteId, status: 'delivered', event: 'article.ready', created_at: createdAt }))
  const first = await app.inject({ method: 'GET', url: '/deliveries?limit=1' })
  assert.equal(first.statusCode, 200, first.body)
  assert.deepEqual(first.json().data.map((row: Row) => row.id), [ids[0]])
  const second = await app.inject({ method: 'GET', url: `/deliveries?limit=1&cursor=${first.json().next_cursor}` })
  assert.equal(second.statusCode, 200, second.body)
  assert.deepEqual(second.json().data.map((row: Row) => row.id), [ids[1]])
  const last = await app.inject({ method: 'GET', url: `/deliveries?limit=1&cursor=${second.json().next_cursor}` })
  assert.equal(last.statusCode, 200, last.body)
  assert.deepEqual(last.json().data.map((row: Row) => row.id), [ids[2]])
  assert.equal(last.json().next_cursor, null)
})

test('CRM job source aliases match their canonical scheduling and widget modes', async t => {
  const { app, tables, sourceId } = await fixture(t)
  const previewId = randomUUID()
  tables.jobs.push({ ...structuredClone(tables.jobs[0]), _id: previewId, mode: 'preview' })
  for (const source of ['schedule', 'scheduled']) {
    const response = await app.inject({ method: 'GET', url: `/jobs?source=${source}` })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().data.map((row: Row) => row.id), [sourceId])
  }
  for (const source of ['widget', 'preview']) {
    const response = await app.inject({ method: 'GET', url: `/jobs?source=${source}` })
    assert.equal(response.statusCode, 200, response.body)
    assert.deepEqual(response.json().data.map((row: Row) => row.id), [previewId])
  }
})

test('CRM failed job rewrite queues a fresh request and retains the failed job and history', async t => {
  const { app, tables, sourceId, customerId, siteId } = await fixture(t)
  Object.assign(tables.jobs[0], { status: 'failed', result: null, error_code: 'AI_TIMEOUT', error_message: 'Provider timed out.' })
  tables.ai_attempts = [{ _id: randomUUID(), job_id: sourceId, status: 'failed', requested_at: new Date(), error_code: 'AI_TIMEOUT' }]
  tables.webhook_deliveries = [{ _id: randomUUID(), job_id: sourceId, site_id: siteId, event: 'article.failed', status: 'failed', created_at: new Date() }]
  const before = structuredClone(tables.jobs[0])
  const attemptsBefore = structuredClone(tables.ai_attempts)
  const deliveriesBefore = structuredClone(tables.webhook_deliveries)
  const response = await app.inject({ method: 'POST', url: `/jobs/${sourceId}/rewrite`, payload: { instructions: 'Thử lại với ví dụ mới.' } })

  assert.equal(response.statusCode, 202, response.body)
  const body = response.json()
  assert.equal(body.status, 'queued')
  assert.equal(body.source_article_id, null)
  assert.equal(body.retry_of_job_id, sourceId)
  assert.notEqual(body.job_id, sourceId)
  assert.equal(tables.jobs.length, 2)
  assert.deepEqual(tables.jobs.find(job => job._id === sourceId), before)
  assert.deepEqual(tables.ai_attempts, attemptsBefore)
  assert.deepEqual(tables.webhook_deliveries, deliveriesBefore)
  const rewritten = tables.jobs.find(job => job._id === body.job_id)!
  assert.deepEqual({
    site_id: rewritten.site_id, customer_id: rewritten.customer_id,
    mode: rewritten.mode, source_article_id: rewritten.source_article_id,
    retry_of_job_id: rewritten.retry_of_job_id,
    provider: rewritten.provider, model: rewritten.model, keyword: rewritten.keyword,
    tone: rewritten.tone, style: rewritten.style, length: rewritten.length,
    instructions: rewritten.instructions, status: rewritten.status,
    result: rewritten.result, attempt_count: rewritten.attempt_count,
    scheduled_at: rewritten.scheduled_at, error_code: rewritten.error_code,
    error_message: rewritten.error_message,
  }, {
    site_id: siteId, customer_id: customerId,
    mode: 'rewrite', source_article_id: null, retry_of_job_id: sourceId,
    provider: before.provider, model: before.model, keyword: before.keyword,
    tone: before.tone, style: before.style, length: before.length,
    instructions: 'Giữ ví dụ thực tế.\n\nThử lại với ví dụ mới.', status: 'queued',
    result: null, attempt_count: 0, scheduled_at: null, error_code: null, error_message: null,
  })
  assert.equal(tables.quota_reservations.length, 1)
  assert.equal(tables.quota_reservations[0].job_id, body.job_id)
  assert.equal(tables.quota_reservations[0].status, 'reserved')
  const list = await app.inject({ method: 'GET', url: '/jobs' })
  const detail = await app.inject({ method: 'GET', url: `/jobs/${body.job_id}` })
  assert.equal(list.statusCode, 200, list.body)
  assert.equal(detail.statusCode, 200, detail.body)
  assert.equal(list.json().data.find((job: Row) => job.id === body.job_id).retry_of_job_id, sourceId)
  assert.equal(detail.json().retry_of_job_id, sourceId)
})

test('CRM failed rewrite retains a usable earlier source and falls back for unusable sources', async t => {
  for (const scenario of [
    { name: 'valid source', patch: {}, retain: true },
    { name: 'missing source', patch: {}, missing: true, retain: false },
    { name: 'other website', patch: { site_id: randomUUID() }, retain: false },
    { name: 'other customer', patch: { customer_id: randomUUID() }, retain: false },
    { name: 'unfinished source', patch: { status: 'writing' }, retain: false },
    { name: 'failed source', patch: { status: 'failed' }, retain: false },
    { name: 'empty source', patch: { result: [] }, retain: false },
    { name: 'null source', patch: { result: [null] }, retain: false },
    { name: 'malformed source', patch: { result: [{ Title: 'Nguồn', Content: '<p>Nội dung</p>' }] }, retain: false },
    { name: 'unsafe empty content', patch: { result: [{ Title: 'Nguồn', Content: '<script>bad()</script>', Slug: 'nguon', Desc: 'Mô tả', Description: 'Mô tả', Keywords: ['nguồn'] }] }, retain: false },
    { name: 'invalid slug', patch: { result: [{ Title: 'Nguồn', Content: '<p>Nội dung</p>', Slug: '!!!', Desc: 'Mô tả', Description: 'Mô tả', Keywords: ['nguồn'] }] }, retain: false },
  ]) {
    await t.test(scenario.name, async t => {
      const { app, tables, sourceId } = await fixture(t)
      const failedId = randomUUID()
      const failed = { ...structuredClone(tables.jobs[0]), _id: failedId, client_request_id: 'failed-rewrite', mode: 'rewrite', status: 'failed', result: null, source_article_id: sourceId }
      if (scenario.missing) tables.jobs.length = 0
      else Object.assign(tables.jobs[0], scenario.patch)
      tables.jobs.push(failed)
      const before = structuredClone(tables.jobs)
      const response = await app.inject({ method: 'POST', url: `/jobs/${failedId}/rewrite`, payload: {} })
      assert.equal(response.statusCode, 202, response.body)
      assert.equal(response.json().source_article_id, scenario.retain ? sourceId : null)
      assert.equal(response.json().retry_of_job_id, failedId)
      const rewritten = tables.jobs.find(job => job._id === response.json().job_id)!
      assert.equal(rewritten.source_article_id, scenario.retain ? sourceId : null)
      assert.equal(rewritten.retry_of_job_id, failedId)
      assert.deepEqual(tables.jobs.slice(0, before.length), before)
    })
  }
})

test('CRM failed retries are idempotent and cannot reuse another failed parent request key', async t => {
  const { app, tables, sourceId } = await fixture(t)
  Object.assign(tables.jobs[0], { status: 'failed', result: null })
  const secondId = randomUUID()
  tables.jobs.push({ ...structuredClone(tables.jobs[0]), _id: secondId, client_request_id: 'second-failed-request' })
  const request = { method: 'POST' as const, url: `/jobs/${sourceId}/rewrite`, headers: { 'idempotency-key': 'retry-failed-once' }, payload: {} }
  const first = await app.inject(request)
  const again = await app.inject(request)
  assert.equal(first.statusCode, 202, first.body)
  assert.equal(again.statusCode, 202, again.body)
  assert.equal(again.json().job_id, first.json().job_id)
  assert.equal(again.json().retry_of_job_id, sourceId)
  assert.equal(tables.jobs.length, 3)
  assert.equal(tables.quota_reservations.length, 1)
  const conflict = await app.inject({ ...request, url: `/jobs/${secondId}/rewrite` })
  assert.equal(conflict.statusCode, 409, conflict.body)
  assert.equal(conflict.json().error.code, 'idempotency_conflict')
  assert.equal(tables.jobs.length, 3)
  assert.equal(tables.quota_reservations.length, 1)
})

test('CRM job reads expose rewrite availability for completed articles with content and failed jobs', async t => {
  for (const scenario of [
    { name: 'ready article', status: 'ready', result: [{ Title: 'Nguồn' }], canRewrite: true },
    { name: 'writing article', status: 'writing', result: [{ Title: 'Nguồn' }], canRewrite: false },
    { name: 'failed article', status: 'failed', result: null, canRewrite: true },
    { name: 'scheduled article', status: 'scheduled', result: null, canRewrite: false },
    { name: 'queued article', status: 'queued', result: null, canRewrite: false },
    { name: 'canceled article', status: 'canceled', result: null, canRewrite: false },
    { name: 'ready without result', status: 'ready', result: [], canRewrite: false },
    { name: 'ready with empty first article', status: 'ready', result: [null], canRewrite: false },
  ]) {
    await t.test(scenario.name, async t => {
      const { app, tables, sourceId } = await fixture(t)
      tables.jobs[0].status = scenario.status
      tables.jobs[0].result = scenario.result
      const list = await app.inject({ method: 'GET', url: '/jobs' })
      const detail = await app.inject({ method: 'GET', url: `/jobs/${sourceId}` })
      assert.equal(list.statusCode, 200, list.body)
      assert.equal(detail.statusCode, 200, detail.body)
      assert.equal(list.json().data[0].id, sourceId)
      assert.equal(list.json().data[0].can_rewrite, scenario.canRewrite)
      assert.equal(detail.json().can_rewrite, scenario.canRewrite)
      assert.equal(list.json().data[0].retry_of_job_id, null)
      assert.equal(detail.json().retry_of_job_id, null)
      assert.equal(detail.json().status, scenario.status === 'ready' ? 'completed' : scenario.status)
    })
  }
})

test('CRM job details expose the saved outline with final content and SEO results', async t => {
  const { app, tables, sourceId } = await fixture(t)
  const article = tables.jobs[0].result[0]
  const report = evaluateSeo(article, { keyword: tables.jobs[0].keyword })
  const outline = {
    title: 'Thiết kế website phù hợp với doanh nghiệp', searchIntent: 'Tìm hiểu cách chọn website',
    audience: 'Chủ doanh nghiệp', angle: 'Bắt đầu từ nhu cầu sử dụng', questions: ['Website cần những chức năng nào?'],
    sections: [{ heading: 'Xác định nhu cầu', purpose: 'Chọn chức năng phục vụ khách hàng', estimatedWords: 400, subheadings: ['Chức năng cần thiết'], evidence: [{ sourceIndex: 1, fact: 'Ưu tiên nhu cầu đã xác minh.' }] }],
  }
  Object.assign(tables.jobs[0], { status: 'writing', writing_stage: 'seo_repair', seo_report: report, seo_repair_status: 'kept_draft', outline })
  tables.ai_attempts = [{ _id: randomUUID(), job_id: sourceId, provider: 'openai', model: 'gpt-test', stage: 'seo_repair', status: 'running', requested_at: new Date() }]
  const pending = await app.inject({ method: 'GET', url: `/jobs/${sourceId}` })
  assert.equal(pending.statusCode, 200, pending.body)
  assert.equal(pending.headers['cache-control'], 'no-store')
  assert.equal(pending.json().writing_stage, 'seo_repair')
  assert.equal(pending.json().result, null)
  assert.equal(pending.json().seo_report, null)
  assert.equal(pending.json().seo_repair_status, null)
  assert.equal(pending.json().attempts[0].stage, 'seo_repair')
  assert.equal(pending.json().outline, null)
  assert.equal(pending.json().encrypted_key, undefined)
  const list = await app.inject({ method: 'GET', url: '/jobs' })
  assert.equal(list.json().data[0].outline, undefined)

  tables.jobs[0].status = 'ready'
  const ready = await app.inject({ method: 'GET', url: `/jobs/${sourceId}` })
  assert.equal(ready.statusCode, 200, ready.body)
  assert.equal(ready.json().status, 'completed')
  assert.equal(ready.json().writing_stage, null)
  assert.deepEqual(ready.json().result, [article])
  assert.deepEqual(ready.json().outline, outline)
  assert.deepEqual(ready.json().seo_report, report)
  assert.equal(ready.json().seo_repair_status, 'kept_draft')
  assert.equal(ready.json().error_code, null)
  assert.equal(ready.json().error_message, null)
})

test('CRM job details return a null outline when planning failed or the job predates saved outlines', async t => {
  const { app, tables, sourceId } = await fixture(t)
  for (const outline of [undefined, null]) {
    tables.jobs[0].outline = outline
    const response = await app.inject({ method: 'GET', url: `/jobs/${sourceId}` })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().outline, null)
    assert.deepEqual(response.json().result, tables.jobs[0].result)
  }
})

test('CRM rewrite honors idempotency and rejects reusing a key for changed instructions', async t => {
  const { app, tables, sourceId } = await fixture(t)
  const request = { method: 'POST' as const, url: `/jobs/${sourceId}/rewrite`, headers: { 'idempotency-key': 'crm-rewrite-once' }, payload: { instructions: 'Viết rõ phần giá.' } }
  const first = await app.inject(request)
  const again = await app.inject(request)
  assert.equal(first.statusCode, 202, first.body)
  assert.equal(again.statusCode, 202, again.body)
  assert.equal(again.json().job_id, first.json().job_id)
  assert.equal(tables.jobs.length, 2)
  assert.equal(tables.quota_reservations.length, 1)

  const conflict = await app.inject({ ...request, payload: { instructions: 'Đổi thành bài phân tích.' } })
  assert.equal(conflict.statusCode, 409)
  assert.equal(conflict.json().error.code, 'idempotency_conflict')
  assert.equal(tables.jobs.length, 2)
})

test('CRM rewrite rejects missing, unfinished and empty source articles', async t => {
  for (const scenario of [
    { name: 'missing', status: 'ready', result: [{ Title: 'Nguồn' }], missing: true, expectedStatus: 404, expectedCode: 'not_found' },
    { name: 'writing', status: 'writing', result: [{ Title: 'Nguồn' }], missing: false, expectedStatus: 409, expectedCode: 'job_not_ready' },
    { name: 'scheduled', status: 'scheduled', result: null, missing: false, expectedStatus: 409, expectedCode: 'job_not_ready' },
    { name: 'queued', status: 'queued', result: null, missing: false, expectedStatus: 409, expectedCode: 'job_not_ready' },
    { name: 'canceled', status: 'canceled', result: null, missing: false, expectedStatus: 409, expectedCode: 'job_not_ready' },
    { name: 'empty result', status: 'ready', result: [], missing: false, expectedStatus: 409, expectedCode: 'job_not_ready' },
    { name: 'null result', status: 'ready', result: null, missing: false, expectedStatus: 409, expectedCode: 'job_not_ready' },
    { name: 'empty first article', status: 'ready', result: [null], missing: false, expectedStatus: 409, expectedCode: 'job_not_ready' },
  ]) {
    await t.test(scenario.name, async t => {
      const { app, tables, sourceId } = await fixture(t)
      tables.jobs[0].status = scenario.status
      tables.jobs[0].result = scenario.result
      const response = await app.inject({ method: 'POST', url: `/jobs/${scenario.missing ? randomUUID() : sourceId}/rewrite`, payload: {} })
      assert.equal(response.statusCode, scenario.expectedStatus, response.body)
      assert.equal(response.json().error.code, scenario.expectedCode)
      assert.equal(tables.jobs.length, 1)
      assert.equal(tables.quota_reservations.length, 0)
    })
  }
})

test('CRM rewrite uses the current customer key mode and requires a fresh own key', async t => {
  const { app, tables, article, sourceId, config } = await fixture(t)
  tables.customers[0].key_mode = 'own'
  assert.equal(article.key_mode, 'service')

  const detail = await app.inject({ method: 'GET', url: `/jobs/${sourceId}` })
  assert.equal(detail.statusCode, 200, detail.body)
  assert.equal(detail.json().key_mode, 'service')
  assert.equal(detail.json().rewrite_key_mode, 'own')
  const noKey = await app.inject({ method: 'POST', url: `/jobs/${sourceId}/rewrite`, payload: {} })
  assert.equal(noKey.statusCode, 400, noKey.body)
  assert.equal(noKey.json().error.code, 'key_required')
  assert.equal(tables.jobs.length, 1)

  const withKey = await app.inject({ method: 'POST', url: `/jobs/${sourceId}/rewrite`, payload: { keyAI: 'fake-customer-key' } })
  assert.equal(withKey.statusCode, 202, withKey.body)
  const rewritten = tables.jobs.find(job => job._id === withKey.json().job_id)!
  assert.equal(rewritten.key_mode, 'own')
  assert.notEqual(rewritten.encrypted_key, 'fake-customer-key')
  assert.equal(unseal(rewritten.encrypted_key, config.encryptionKey), 'fake-customer-key')
  assert.equal(tables.quota_reservations.length, 0)
})

test('CRM failed retry requires a fresh key for the current own-key mode', async t => {
  const { app, tables, sourceId, config } = await fixture(t)
  Object.assign(tables.jobs[0], { status: 'failed', result: null, encrypted_key: 'old-key-not-reused' })
  tables.customers[0].key_mode = 'own'
  const before = structuredClone(tables.jobs[0])
  const noKey = await app.inject({ method: 'POST', url: `/jobs/${sourceId}/rewrite`, payload: {} })
  assert.equal(noKey.statusCode, 400, noKey.body)
  assert.equal(noKey.json().error.code, 'key_required')
  assert.equal(tables.jobs.length, 1)
  const withKey = await app.inject({ method: 'POST', url: `/jobs/${sourceId}/rewrite`, payload: { keyAI: 'fake-new-customer-key' } })
  assert.equal(withKey.statusCode, 202, withKey.body)
  const rewritten = tables.jobs.find(job => job._id === withKey.json().job_id)!
  assert.equal(rewritten.key_mode, 'own')
  assert.equal(rewritten.source_article_id, null)
  assert.equal(rewritten.retry_of_job_id, sourceId)
  assert.notEqual(rewritten.encrypted_key, before.encrypted_key)
  assert.equal(unseal(rewritten.encrypted_key, config.encryptionKey), 'fake-new-customer-key')
  assert.deepEqual(tables.jobs.find(job => job._id === sourceId), before)
  assert.equal(tables.quota_reservations.length, 0)
})

test('CRM rewrite still enforces current model availability and quota', async t => {
  await t.test('disabled model', async t => {
    const { app, tables, sourceId } = await fixture(t)
    tables.ai_models[0].enabled = false
    const response = await app.inject({ method: 'POST', url: `/jobs/${sourceId}/rewrite`, payload: {} })
    assert.equal(response.statusCode, 400, response.body)
    assert.equal(response.json().error.code, 'model_unavailable')
    assert.equal(tables.jobs.length, 1)
  })
  await t.test('exhausted quota', async t => {
    const { app, tables, sourceId } = await fixture(t)
    tables.customers[0].daily_limit = 0
    const response = await app.inject({ method: 'POST', url: `/jobs/${sourceId}/rewrite`, payload: {} })
    assert.equal(response.statusCode, 429, response.body)
    assert.equal(response.json().error.code, 'quota_exhausted')
    assert.equal(tables.jobs.length, 1)
    assert.equal(tables.quota_reservations.length, 0)
  })
})
