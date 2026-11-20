import assert from 'node:assert/strict'
import test from 'node:test'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { seal } from '../src/security.js'
import { cleanArticle, generateArticle, WorkerError, type Article, type ArticleOutline, type GenerationMetadata } from '../src/worker/provider.js'
import { estimateGenerationTokens } from '../src/worker/provider.js'
import { evaluateSeo } from '../src/worker/seo.js'
import { runWriterOnce, type WriterDependencies } from '../src/worker/writer.js'

type Row = Record<string, any>
type Operation = { table: string; method: string; filter: Row; session: unknown }

function memoryDatabase(tables: Record<string, Row[]>, operations: Operation[] = [], failAccounting = false): Database {
  let activeSession: object | undefined
  function matches(row: Row, filter: Row) {
    return Object.entries(filter).every(([key, expected]) => {
      const actual = row[key]
      if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        if ('$in' in expected) return expected.$in.includes(actual)
        if ('$gt' in expected) return actual instanceof Date && actual > expected.$gt
        if ('$lte' in expected) return actual instanceof Date && actual <= expected.$lte
      }
      return actual === expected
    })
  }
  function apply(row: Row, update: Row) {
    Object.assign(row, structuredClone(update.$set ?? {}))
    for (const [key, amount] of Object.entries(update.$inc ?? {})) row[key] = Number(row[key] ?? 0) + Number(amount)
  }
  function observed(name: string, method: string, filter: Row, options?: Row) {
    if (activeSession) assert.equal(options?.session, activeSession, `${name}.${method} must participate in the transaction`)
    operations.push({ table: name, method, filter: structuredClone(filter), session: options?.session })
  }
  return {
    db: {
      collection(name: string) {
        const rows = tables[name] ??= []
        return {
          async findOne(filter: Row, options?: Row) {
            observed(name, 'findOne', filter, options)
            return structuredClone(rows.find(row => matches(row, filter)) ?? null)
          },
          async findOneAndUpdate(filter: Row, update: Row, options?: Row) {
            observed(name, 'findOneAndUpdate', filter, options)
            const row = rows.find(row => matches(row, filter))
            if (!row) return null
            apply(row, update)
            return structuredClone(row)
          },
          async insertOne(row: Row, options?: Row) {
            observed(name, 'insertOne', {}, options)
            rows.push(structuredClone(row))
          },
          async updateOne(filter: Row, update: Row, options?: Row) {
            observed(name, 'updateOne', filter, options)
            const row = rows.find(row => matches(row, filter))
            if (failAccounting && name === 'ai_attempts' && row?.stage === 'draft') throw new Error('Accounting temporarily unavailable')
            if (row) apply(row, update)
            else if (options?.upsert) rows.push(structuredClone(update.$setOnInsert ?? {}))
            return { matchedCount: row ? 1 : 0 }
          },
          async updateMany(filter: Row, update: Row, options?: Row) {
            observed(name, 'updateMany', filter, options)
            const selected = rows.filter(row => matches(row, filter))
            selected.forEach(row => apply(row, update))
            return { matchedCount: selected.length }
          },
        }
      },
    },
    client: {
      async connect() {},
      startSession() {
        const session = {
          async withTransaction<T>(callback: () => Promise<T>) {
            activeSession = session
            try { return await callback() } finally { activeSession = undefined }
          },
          async endSession() {},
        }
        return session
      },
    },
  } as unknown as Database
}

const metadata: GenerationMetadata = { usage: { input: 25, output: 40 }, responseId: 'response-test', model: 'test-model' }
const keyword = 'cà phê cold brew'
const outline: ArticleOutline = {
  title: 'Cà phê cold brew tại nhà', searchIntent: 'Tìm cách pha cold brew', audience: 'Người mới pha cà phê',
  angle: 'Thử mẻ nhỏ trước khi điều chỉnh', questions: ['Dùng tỉ lệ nào?'],
  sections: [{ heading: 'Cách pha', purpose: 'Chỉ dẫn các bước', estimatedWords: 600, subheadings: [], evidence: [] }],
}
const shortArticle: Article = {
  Title: 'Pha cà phê tại nhà', Content: '<p>Dùng nước lạnh và cà phê xay thô.</p>',
  Slug: 'pha-ca-phe', Desc: 'Cách chuẩn bị cà phê.', Desction: 'Hướng dẫn pha cà phê.', 'Từ khóa': ['cà phê'],
}
function seoArticle(): Article {
  return {
    Title: 'Cà phê cold brew: cách pha ngon và bảo quản tại nhà',
    Content: '<h2>Cà phê cold brew cho người mới</h2>' + Array.from({ length: 10 }, () => '<p>Cà phê cold brew ' + 'thơm '.repeat(58).trim() + '.</p>').join(''),
    Slug: 'ca-phe-cold-brew', Desc: 'Hướng dẫn pha tại nhà.',
    Desction: 'Cà phê cold brew ' + 'à'.repeat(140), 'Từ khóa': [keyword],
  }
}
function fixture(jobValues: Row = {}, configValues: Row = {}, accountingFailure = false) {
  const job: Row = {
    _id: 'scheduled-job', site_id: 'test-site', mode: 'scheduled', provider: 'openai',
    model: 'test-model', keyword, tone: 'rõ ràng', style: 'hướng dẫn',
    length: 1500, instructions: null, key_mode: 'service', encrypted_key: null,
    source_article_id: null, attempt_count: 0, status: 'scheduled', lease_token: null,
    available_at: new Date(0), result: null, error_code: null, error_message: null,
    ...jobValues,
  }
  const reservation = { job_id: job._id, status: 'reserved' }
  const tables: Record<string, Row[]> = {
    jobs: [job], ai_attempts: [], quota_reservations: [reservation], webhook_deliveries: [],
    sites: [{ _id: 'test-site', domain: 'example.vn' }],
    model_prices: [{ _id: 'price-test', provider: job.provider, model: job.model, effective_at: new Date(0), rates: { total: 3 } }],
  }
  const config = {
    aiTimeoutMs: 5_000, outlineTimeoutMs: 1_000, seoRepairTimeoutMs: 1_000,
    leaseMs: 30_000, encryptionKey: Buffer.alloc(32, 3),
    research: { enabled: false, timeoutMs: 1_000, maxResults: 1, provider: 'duckduckgo' },
    providerLimits: Object.fromEntries(['openai', 'anthropic', 'xai', 'openai-compatible'].map(provider => [provider, { concurrency: 1, requestsPerMinute: 10, tokensPerMinute: 120_000 }])),
    serviceKeys: { openai: 'test-key' }, ...configValues,
  } as Config
  const operations: Operation[] = []
  const db = memoryDatabase(tables, operations, accountingFailure)
  const defaults: WriterDependencies = {
    outline: async () => ({ outline, ...metadata }),
    generate: async () => ({ article: seoArticle(), ...metadata }),
    repair: async input => ({ article: input.draft, ...metadata }),
  }
  return { job, tables, reservation, config, db, operations, run: (deps: WriterDependencies = {}) => runWriterOnce(db, config, { ...defaults, ...deps }) }
}

function assertReady(f: ReturnType<typeof fixture>, article: Article, repairStatus: string) {
  assert.equal(f.job.status, 'ready')
  assert.deepEqual(f.job.result, [cleanArticle(article)])
  assert.equal(f.job.error_code, null)
  assert.equal(f.job.error_message, null)
  assert.equal(f.job.writing_stage, null)
  assert.equal(f.job.seo_repair_status, repairStatus)
  assert.equal(f.reservation.status, 'used')
  assert.deepEqual(Object.keys(f.job.result[0]).sort(), ['Title', 'Content', 'Slug', 'Desc', 'Desction', 'Từ khóa'].sort())
  assert.deepEqual(f.tables.webhook_deliveries.map(({ job_id, event, status }) => ({ job_id, event, status })), [
    { job_id: f.job._id, event: 'article.ready', status: 'pending' },
  ])
}

test('scheduled writer researches, outlines and streams a compliant article without a repair call', async () => {
  const article = seoArticle()
  const f = fixture({ instructions: 'Định dạng bảng bằng CSS inline' }, { research: { enabled: true, timeoutMs: 1_000, maxResults: 1, provider: 'duckduckgo' } })
  const calls: string[] = []
  const research = { query: keyword, sources: [{ title: 'Tài liệu', url: 'https://example.org/info', snippet: 'Tư liệu' }], researchedAt: new Date().toISOString() }
  assert.equal(await f.run({
    async research() { calls.push(f.job.writing_stage); return research },
    async outline(input) {
      calls.push(f.job.writing_stage)
      assert.deepEqual(input.research, research)
      assert.equal(input.instructions, f.job.instructions)
      return { outline, ...metadata }
    },
    generate: input => generateArticle(input, async (_url, request) => {
      calls.push(f.job.writing_stage)
      assert.equal(input.siteDomain, 'example.vn')
      assert.deepEqual(input.outline, outline)
      assert.deepEqual(input.research, research)
      assert.equal(JSON.parse(String(request?.body)).stream, true)
      const body = [
        { type: 'response.output_text.delta', delta: JSON.stringify(article) },
        { type: 'response.completed', response: { id: 'response-test', model: 'test-model', usage: { input_tokens: 25, output_tokens: 40 }, status: 'completed' } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }),
    async repair() { assert.fail('No repairable warnings remain') },
  }), true)
  assert.deepEqual(calls, ['research', 'outline', 'draft'])
  assertReady(f, article, 'not_needed')
  assert.equal(f.job.attempt_count, 1)
  assert.deepEqual(f.tables.ai_attempts.map(row => [row.stage, row.status]), [['outline', 'succeeded'], ['draft', 'succeeded']])
  assert.ok(f.tables.ai_attempts.every(row => row.cost_usd === '0.000195000000' && row.pricing_id === 'price-test'))
  const atomicWrites = f.operations.filter(op => op.session)
  assert.deepEqual(atomicWrites.map(op => op.table), ['jobs', 'quota_reservations', 'webhook_deliveries'])
})

test('a failed outline falls back to writing and does not fail the article', async () => {
  const f = fixture()
  await f.run({
    async outline() { throw new WorkerError('AI_OUTLINE', 'Dàn ý lỗi', false, 0, metadata) },
    async generate(input) { assert.equal(input.outline, null); return { article: seoArticle(), ...metadata } },
  })
  assertReady(f, seoArticle(), 'not_needed')
  assert.equal(f.tables.ai_attempts[0].status, 'failed')
  assert.equal(f.tables.ai_attempts[0].provider_response_id, 'response-test')
})

test('an outline with keepalives has a hard deadline and falls back to writing', { timeout: 2_000 }, async () => {
  const f = fixture({}, { outlineTimeoutMs: 20 })
  let aborted = false
  await f.run({
    outline: input => new Promise((_resolve, reject) => {
      const timer = setInterval(() => input.onChunk?.(), 2)
      input.signal.addEventListener('abort', () => { aborted = true; clearInterval(timer); reject(input.signal.reason) }, { once: true })
    }),
  })
  assert.equal(aborted, true)
  assertReady(f, seoArticle(), 'not_needed')
  assert.equal(f.tables.ai_attempts[0].error_code, 'AI_OUTLINE_TIMEOUT')
})

test('one SEO repair applies improvements after the original draft is durably stored', async () => {
  const draft = { ...seoArticle(), Desction: 'Cà phê cold brew dễ pha.' }
  const f = fixture()
  let repairs = 0
  await f.run({
    generate: async () => ({ article: draft, ...metadata }),
    async repair(input) {
      repairs += 1
      assert.equal(f.job.status, 'writing')
      assert.equal(f.job.writing_stage, 'seo_repair')
      assert.deepEqual(f.job.result, [cleanArticle(draft)])
      assert.equal(f.tables.webhook_deliveries.length, 0)
      assert.equal(f.reservation.status, 'reserved')
      assert.deepEqual(input.issues.map(issue => issue.key), ['lengthMetaDescription'])
      return { article: { ...input.draft, Desction: seoArticle().Desction }, ...metadata }
    },
  })
  assert.equal(repairs, 1)
  assertReady(f, seoArticle(), 'applied')
  assert.equal(f.job.seo_report.warnings.filter((row: Row) => row.repairable).length, 0)
  assert.deepEqual(f.tables.ai_attempts.map(row => row.stage), ['outline', 'draft', 'seo_repair'])
})

test('SEO repair is discarded when it breaks a criterion the draft passed', async () => {
  const draft = { ...seoArticle(), Desction: 'Cà phê cold brew dễ pha.' }
  const f = fixture()
  await f.run({
    generate: async () => ({ article: draft, ...metadata }),
    repair: async input => ({ article: { ...input.draft, Desction: seoArticle().Desction, Content: '<p>Quá ngắn.</p>' }, ...metadata }),
  })
  assertReady(f, draft, 'kept_draft')
})

test('SEO warnings remain editable and never turn a valid article into a failed job', async () => {
  const f = fixture()
  await f.run({ generate: async () => ({ article: shortArticle, ...metadata }) })
  assertReady(f, shortArticle, 'kept_draft')
  assert.ok(f.job.seo_report.warnings.length > 0)
  assert.equal(f.tables.ai_attempts.length, 3)
})

test('a repair error preserves the valid draft and records separate provider usage', async () => {
  const f = fixture()
  await f.run({
    generate: async () => ({ article: shortArticle, ...metadata }),
    async repair() { throw new WorkerError('AI_RESPONSE', 'Lượt chỉnh lỗi', true, 0, metadata) },
  })
  assertReady(f, shortArticle, 'kept_draft')
  assert.equal(f.tables.ai_attempts[2].status, 'failed')
  assert.equal(f.tables.ai_attempts[2].cost_usd, '0.000195000000')
})

test('SEO repair stops at its own deadline despite keepalives and delivers the draft', { timeout: 2_000 }, async () => {
  const f = fixture({}, { seoRepairTimeoutMs: 20 })
  let aborted = false
  await f.run({
    generate: async () => ({ article: shortArticle, ...metadata }),
    repair: input => new Promise((_resolve, reject) => {
      const timer = setInterval(() => input.onChunk?.(), 2)
      input.signal.addEventListener('abort', () => { aborted = true; clearInterval(timer); reject(input.signal.reason) }, { once: true })
    }),
  })
  assert.equal(aborted, true)
  assertReady(f, shortArticle, 'kept_draft')
  assert.equal(f.tables.ai_attempts[2].error_code, 'AI_SEO_REPAIR_TIMEOUT')
})

test('usage settlement failure cannot lose an already valid article', async () => {
  const f = fixture({}, {}, true)
  await f.run()
  assertReady(f, seoArticle(), 'kept_draft')
})

test('an expired lease with a durable draft is recovered and queues exactly one ready delivery', async () => {
  const f = fixture({ status: 'writing', result: [shortArticle], lease_token: 'old-lease', lease_expires_at: new Date(0), attempt_count: 2, writing_stage: 'seo_repair' })
  f.tables.ai_attempts.push({ _id: 'old-attempt', job_id: f.job._id, stage: 'seo_repair', status: 'running' })
  const deps = { outline: async () => { assert.fail('Recovery must not call AI') } }
  assert.equal(await f.run(deps), true)
  assertReady(f, shortArticle, 'kept_draft')
  assert.equal(f.tables.ai_attempts[0].status, 'abandoned')
  assert.equal(await f.run(deps), false)
  assert.equal(f.tables.webhook_deliveries.length, 1)
})

test('an expired lease before any valid draft requeues and abandons the interrupted attempt', async () => {
  const f = fixture({ status: 'writing', lease_token: 'old-lease', lease_expires_at: new Date(0), attempt_count: 1 })
  f.tables.ai_attempts.push({ _id: 'old-attempt', job_id: f.job._id, stage: 'draft', status: 'running' })
  await f.run()
  assert.equal(f.job.status, 'queued')
  assert.equal(f.job.error_code, 'AI_LEASE_EXPIRED')
  assert.equal(f.tables.ai_attempts[0].status, 'abandoned')
  assert.equal(f.tables.webhook_deliveries.length, 0)
  assert.equal(f.reservation.status, 'reserved')
})

test('an expired final attempt without a draft fails and releases the reservation', async () => {
  const f = fixture({ status: 'writing', lease_token: 'old-lease', lease_expires_at: new Date(0), attempt_count: 3 })
  await f.run()
  assert.equal(f.job.status, 'failed')
  assert.equal(f.reservation.status, 'released')
  assert.equal(f.tables.webhook_deliveries[0].event, 'article.failed')
})

test('an old worker cannot overwrite a recovered draft after its repair finishes', async () => {
  const f = fixture()
  const late = { ...shortArticle, Title: 'Bài từ worker cũ' }
  await f.run({
    generate: async () => ({ article: shortArticle, ...metadata }),
    async repair() {
      f.job.lease_expires_at = new Date(0)
      assert.equal(await f.run(), true)
      assert.equal(f.job.status, 'ready')
      return { article: late, ...metadata }
    },
  })
  assertReady(f, shortArticle, 'kept_draft')
  assert.equal(f.tables.webhook_deliveries.length, 1)
})

test('an old worker cannot replace the result or lease belonging to a new worker', async () => {
  const f = fixture()
  const newerDraft = cleanArticle(seoArticle())
  await f.run({
    async generate() {
      f.job.lease_token = 'new-worker-lease'
      f.job.result = [newerDraft]
      f.job.writing_stage = 'seo_repair'
      return { article: shortArticle, ...metadata }
    },
  })
  assert.equal(f.job.status, 'writing')
  assert.equal(f.job.lease_token, 'new-worker-lease')
  assert.deepEqual(f.job.result, [newerDraft])
  assert.equal(f.tables.webhook_deliveries.length, 0)
})

test('provider keys for OpenAI Compatible are read from current CRM settings', async () => {
  const f = fixture({ provider: 'openai-compatible' })
  f.tables.ai_providers = [{ _id: 'openai-compatible', base_url: 'https://example.test/v1', encrypted_api_key: seal('compatible-key', f.config.encryptionKey) }]
  await f.run({
    async generate(input) {
      assert.equal(input.key, 'compatible-key')
      assert.equal(input.baseUrl, 'https://example.test/v1')
      return { article: seoArticle(), ...metadata }
    },
  })
  assertReady(f, seoArticle(), 'not_needed')
})

test('rewrite keeps instructions and uses the existing article as source for the outline and draft', async () => {
  const f = fixture({ mode: 'rewrite', source_article_id: 'source-job', instructions: 'Giữ bảng với CSS inline' })
  f.tables.jobs.push({ _id: 'source-job', site_id: 'test-site', status: 'ready', result: [shortArticle] })
  let calls = 0
  await f.run({
    async outline(input) { assert.deepEqual(input.source, shortArticle); assert.equal(input.instructions, f.job.instructions); calls += 1; return { outline, ...metadata } },
    async generate(input) { assert.deepEqual(input.source, shortArticle); assert.equal(input.instructions, f.job.instructions); calls += 1; return { article: seoArticle(), ...metadata } },
  })
  assert.equal(calls, 2)
  assert.equal(f.job.status, 'ready')
  assert.equal(f.tables.webhook_deliveries.length, 0)
})

test('an oversized outline is discarded before writing so it cannot exhaust the prompt budget', async () => {
  const f = fixture()
  const input = { provider: 'openai' as const, key: 'test-key', model: 'test-model', keyword, tone: 'rõ ràng', style: 'hướng dẫn', length: 1500, instructions: null, source: null, siteDomain: 'example.vn', research: null }
  f.config.providerLimits.openai.tokensPerMinute = estimateGenerationTokens(input, 'article') + 10
  await f.run({
    outline: async () => ({ outline: { ...outline, angle: 'Nội dung dài '.repeat(2000) }, ...metadata }),
    async generate(input) { assert.equal(input.outline, null); return { article: seoArticle(), ...metadata } },
  })
  assertReady(f, seoArticle(), 'not_needed')
})

test('repair is skipped when its full prompt would exceed the per-call token budget', async () => {
  const f = fixture()
  f.config.providerLimits.openai.tokensPerMinute = 18_000
  const longDraft = { ...seoArticle(), Content: '<p>Cà phê cold brew ' + 'từ '.repeat(5000) + '</p>' }
  await f.run({
    generate: async () => ({ article: longDraft, ...metadata }),
    async repair() { assert.fail('The oversized repair must be skipped') },
  })
  assertReady(f, longDraft, 'skipped')
  assert.equal(f.tables.ai_attempts.length, 2)
})

test('article streaming continues past the idle timeout when chunks are still arriving', { timeout: 2_000 }, async () => {
  const f = fixture({}, { aiTimeoutMs: 25 })
  await f.run({
    generate: input => new Promise(resolve => {
      const timer = setInterval(() => input.onChunk?.(), 3)
      setTimeout(() => {
        clearInterval(timer)
        assert.equal(input.signal.aborted, false)
        resolve({ article: seoArticle(), ...metadata })
      }, 65)
    }),
  })
  assertReady(f, seoArticle(), 'not_needed')
})

test('a stalled draft without chunks is requeued under the existing retry policy', { timeout: 2_000 }, async () => {
  const f = fixture({}, { aiTimeoutMs: 15 })
  let aborted = false
  await f.run({
    generate: input => new Promise((_resolve, reject) => {
      input.signal.addEventListener('abort', () => { aborted = true; reject(input.signal.reason) }, { once: true })
    }),
  })
  assert.equal(aborted, true)
  assert.equal(f.job.status, 'queued')
  assert.equal(f.job.result, null)
  assert.equal(f.job.error_code, 'AI_CONNECTION')
  assert.equal(f.reservation.status, 'reserved')
  assert.equal(f.tables.webhook_deliveries.length, 0)
})

test('the report uses the requested main keyword instead of the related keyword list', async () => {
  const f = fixture()
  const article = { ...seoArticle(), 'Từ khóa': ['pha chế', 'đồ uống'] }
  await f.run({ generate: async () => ({ article, ...metadata }) })
  assert.deepEqual(f.job.seo_report, evaluateSeo(cleanArticle(article), { keyword, siteUrl: 'example.vn' }))
})
