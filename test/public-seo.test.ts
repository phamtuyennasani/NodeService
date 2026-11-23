import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import Fastify from 'fastify'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerPublic } from '../src/api/public.js'
import { installErrorHandler } from '../src/api/errors.js'
import { digest } from '../src/security.js'
import { evaluateSeo } from '../src/worker/seo.js'

test('site job status exposes final CRM SEO metadata and preserves the article-result array contract', async t => {
  const siteId = randomUUID()
  const otherSiteId = randomUUID()
  const jobId = randomUUID()
  const token = 'seo_site_token_012345678901'
  const otherToken = 'other_seo_site_token_0123456'
  const now = new Date()
  const article = {
    Title: 'Cách chọn máy lọc nước gia đình', Content: '<p>Kiểm tra nguồn nước trước khi chọn thiết bị.</p>',
    Slug: 'cach-chon-may-loc-nuoc-gia-dinh', Desc: 'Tóm tắt.', Description: 'Mô tả SEO.',
    Keywords: ['nguồn nước', 'lõi lọc'],
  }
  const keyword = 'máy lọc nước gia đình'
  const report = evaluateSeo(article, { keyword })
  const job: Record<string, any> = {
    _id: jobId, site_id: siteId, customer_id: randomUUID(), status: 'writing', mode: 'preview',
    keyword, length: 1500, use_research: true, version: 1, result: [article], created_at: now,
    seo_report: report, seo_repair_status: 'kept_draft',
    encrypted_key: 'must-not-be-exposed', instructions: 'private writing instructions',
  }
  const tables: Record<string, Record<string, any>[]> = {
    sites: [
      { _id: siteId, customer_id: job.customer_id, token_hash: digest(token) },
      { _id: otherSiteId, customer_id: randomUUID(), token_hash: digest(otherToken) },
    ],
    jobs: [job], webhook_deliveries: [],
  }
  const db = { db: { collection(name: string) { return {
    async findOne(filter: Record<string, any>) {
      return (tables[name] ?? []).find(row => Object.entries(filter).every(([key, value]) => row[key] === value)) ?? null
    },
    async updateOne() { return { matchedCount: 1 } },
  } } } } as unknown as Database
  const app = Fastify()
  t.after(() => app.close())
  installErrorHandler(app)
  registerPublic(app, db, {} as Config)
  const read = (suffix = '', bearer = token) => app.inject({
    method: 'GET', url: `/v1/article-jobs/${jobId}${suffix}`, headers: { authorization: `Bearer ${bearer}` },
  })

  const pending = await read()
  assert.equal(pending.statusCode, 200, pending.body)
  assert.equal(pending.json().keyword, keyword)
  assert.equal(pending.json().length, 1500)
  assert.equal(pending.json().seo_report, null, 'do not publish an intermediate report')
  assert.equal(pending.json().seo_repair_status, null)

  job.status = 'ready'
  const ready = await read()
  assert.equal(ready.statusCode, 200, ready.body)
  assert.equal(ready.json().keyword, keyword, 'focus keyword is the original job keyword, not related Keywords')
  assert.equal(ready.json().length, 1500, 'retain the requested word budget for later form evaluation')
  assert.deepEqual(ready.json().seo_report, report)
  assert.equal(ready.json().seo_repair_status, 'kept_draft')
  assert.equal('result' in ready.json(), false)
  assert.doesNotMatch(ready.body, /must-not-be-exposed|private writing instructions/)
  const result = await read('/result')
  assert.equal(result.statusCode, 200, result.body)
  assert.deepEqual(result.json(), [article])
  assert.equal((await read('', otherToken)).statusCode, 404)
  assert.equal((await read('/result', otherToken)).statusCode, 404)

  delete job.seo_report
  delete job.seo_repair_status
  const legacy = await read()
  assert.equal(legacy.json().seo_report, null)
  assert.equal(legacy.json().seo_repair_status, null)
})
