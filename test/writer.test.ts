import assert from 'node:assert/strict'
import test from 'node:test'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { jobEvents, type JobEvent } from '../src/job-events.js'
import { seal } from '../src/security.js'
import { cleanArticle, generateArticle, WorkerError, type Article, type ArticleOutline, type GenerationMetadata } from '../src/worker/provider.js'
import { estimateGenerationTokens } from '../src/worker/provider.js'
import { evaluateSeo } from '../src/worker/seo.js'
import { runWriterOnce, type WriterDependencies } from '../src/worker/writer.js'
import { providerHasCapacity, ProviderCapacityPending, reserveProviderRequest } from '../src/worker/provider-limits.js'
import { siteContentSearchTerms } from '../src/site-content.js'

type Row = Record<string, any>
type Operation = { table: string; method: string; filter: Row; session: unknown }

function memoryDatabase(tables: Record<string, Row[]>, operations: Operation[] = [], failAccounting = false): Database {
  let activeSession: object | undefined
  function matches(row: Row, filter: Row) {
    return Object.entries(filter).every(([key, expected]) => {
      const actual = row[key]
      if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
        if ('$in' in expected) return Array.isArray(actual) ? actual.some(value => expected.$in.includes(value)) : expected.$in.includes(actual)
        if ('$nin' in expected) return !expected.$nin.includes(actual)
        if ('$gt' in expected) return actual != null && actual > expected.$gt
        if ('$elemMatch' in expected) return Array.isArray(actual) && actual.some(value => matches(value, expected.$elemMatch))
        if ('$lte' in expected) return actual instanceof Date && actual <= expected.$lte
      }
      return actual === expected
    })
  }
  function apply(row: Row, update: Row, filter: Row = {}) {
    const fields = structuredClone(update.$set ?? {})
    if ('slots.$.expires' in fields) {
      const slot = row.slots.find((value: Row) => matches(value, filter.slots.$elemMatch))
      slot.expires = fields['slots.$.expires']
      delete fields['slots.$.expires']
    }
    if (update.$pull?.slots) row.slots = row.slots.filter((slot: Row) => slot.id !== update.$pull.slots.id)
    for (const [key, maximum] of Object.entries(update.$max ?? {})) row[key] = Math.max(row[key] ?? 0, Number(maximum))
    Object.assign(row, fields)
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
          find(filter: Row, options?: Row) {
            observed(name, 'find', filter, options)
            let limit = Infinity
            const cursor = {
              sort() { return cursor },
              limit(value: number) { limit = value; return cursor },
              async toArray() { return structuredClone(rows.filter(row => matches(row, filter)).slice(0, limit)) },
            }
            return cursor
          },
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
            if (row._id != null && rows.some(value => value._id === row._id)) {
              throw Object.assign(new Error('Duplicate ID'), { code: 11000 })
            }
            rows.push(structuredClone(row))
          },
          async updateOne(filter: Row, update: Row, options?: Row) {
            observed(name, 'updateOne', filter, options)
            const row = rows.find(row => matches(row, filter))
            if (failAccounting && name === 'ai_attempts' && row?.stage === 'draft') throw new Error('Accounting temporarily unavailable')
            if (row) apply(row, update, filter)
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
  Slug: 'pha-ca-phe', Desc: 'Cách chuẩn bị cà phê.', Description: 'Hướng dẫn pha cà phê.', Keywords: ['cà phê'],
}
function seoArticle(): Article {
  return {
    Title: 'Cà phê cold brew: cách pha ngon và bảo quản tại nhà',
    Content: '<h2>Cà phê cold brew cho người mới</h2>' + Array.from({ length: 10 }, () => '<p>Cà phê cold brew ' + 'thơm '.repeat(58).trim() + '.</p>').join(''),
    Slug: 'ca-phe-cold-brew', Desc: 'Hướng dẫn pha tại nhà.',
    Description: 'Cà phê cold brew ' + 'à'.repeat(140), Keywords: [keyword],
  }
}
function articleWithLongParagraph(): Article {
  const article = seoArticle()
  return { ...article, Content: article.Content.replaceAll('</p><p>', ' ') }
}
function fixture(jobValues: Row = {}, configValues: Row = {}, accountingFailure = false) {
  const job: Row = {
    _id: 'scheduled-job', site_id: 'test-site', customer_id: 'test-customer', mode: 'scheduled', provider: 'openai',
    model: 'test-model', keyword, tone: 'rõ ràng', style: 'hướng dẫn',
    length: 1500, instructions: null, key_mode: 'service', encrypted_key: null,
    source_article_id: null, attempt_count: 0, status: 'scheduled', lease_token: null,
    available_at: new Date(0), result: null, error_code: null, error_message: null,
    ...jobValues,
  }
  const reservation = { job_id: job._id, customer_id: job.customer_id, status: 'reserved' }
  const tables: Record<string, Row[]> = {
    jobs: [job], ai_attempts: [], quota_reservations: [reservation], webhook_deliveries: [],
    sites: [{ _id: 'test-site', customer_id: 'test-customer', domain: 'example.vn' }],
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
  assert.deepEqual(Object.keys(f.job.result[0]).sort(), ['Title', 'Content', 'Slug', 'Desc', 'Description', 'Keywords'].sort())
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

test('scheduled writer skips research when the request disables it', async () => {
  const f = fixture({ use_research: false }, { research: { enabled: true, timeoutMs: 1_000, maxResults: 1, provider: 'duckduckgo' } })
  let researchCalls = 0
  await f.run({
    async research() { researchCalls += 1; return { query: keyword, sources: [], researchedAt: new Date().toISOString() } },
    async outline(input) {
      assert.equal(input.research, null)
      return { outline, ...metadata }
    },
  })
  assert.equal(researchCalls, 0)
  assertReady(f, seoArticle(), 'not_needed')
})

test('outline reasoning reserves extra draft output and matches the provider token reservation', async () => {
  const f = fixture({ length: 1000 })
  let requestedOutput = 0
  let reservedTokens = 0
  let estimatedTokens = 0
  await f.run({
    async outline() {
      return { outline, ...metadata, usage: { input: 25, output: 2048, reasoning: 2000 } }
    },
    generate: input => generateArticle(input, async (_url, request) => {
      requestedOutput = JSON.parse(String(request?.body)).max_output_tokens
      estimatedTokens = estimateGenerationTokens(input, 'article')
      reservedTokens = f.tables.provider_limits[0].requests.at(-1).tokens
      const body = [
        { type: 'response.output_text.delta', delta: JSON.stringify(seoArticle()) },
        { type: 'response.completed', response: { id: 'reasoning-draft', model: input.model, usage: { input_tokens: 25, output_tokens: 40 }, status: 'completed' } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }),
  })
  assertReady(f, seoArticle(), 'not_needed')
  assert.equal(requestedOutput, 15_216)
  assert.equal(reservedTokens, estimatedTokens)
  assert.ok(reservedTokens > requestedOutput, 'the reservation also accounts for the prompt')
})

test('unknown models keep the original draft budget when reasoning usage is absent', async () => {
  for (const usage of [null, metadata.usage]) {
    const f = fixture({ length: 1000, model: 'unknown-model' })
    let requestedOutput = 0
    await f.run({
      outline: async () => ({ outline, ...metadata, usage }),
      generate: input => generateArticle(input, async (_url, request) => {
        requestedOutput = JSON.parse(String(request?.body)).max_output_tokens
        const body = [
          { type: 'response.output_text.delta', delta: JSON.stringify(seoArticle()) },
          { type: 'response.completed', response: { id: 'ordinary-draft', model: input.model, status: 'completed' } },
        ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }),
    })
    assertReady(f, seoArticle(), 'not_needed')
    assert.equal(requestedOutput, 7024)
  }
})

test('a persisted truncated draft doubles its output budget without inflating the next outline', async () => {
  const f = fixture({ length: 1000, attempt_count: 1, status: 'queued' })
  f.tables.ai_attempts.push({
    _id: 'previous-truncated-draft', job_id: f.job._id, provider: f.job.provider, model: f.job.model,
    stage: 'draft', status: 'failed', requested_at: new Date(0), finished_at: new Date(1),
    usage: { input: 25, output: 7024 }, error_code: 'AI_ARTICLE',
    generation: { maxOutputTokens: 7024, outputCharacters: 12, finishReason: 'length', invalidReason: 'truncated' },
  })
  let requestedOutput = 0
  let outlineTokens = 0
  let originalOutlineTokens = 0
  await f.run({
    async outline(input) {
      outlineTokens = estimateGenerationTokens(input, 'outline')
      originalOutlineTokens = estimateGenerationTokens({ ...input, tokenBudget: undefined }, 'outline')
      return { outline, ...metadata }
    },
    generate: input => generateArticle(input, async (_url, request) => {
      requestedOutput = JSON.parse(String(request?.body)).max_output_tokens
      const body = [
        { type: 'response.output_text.delta', delta: JSON.stringify(seoArticle()) },
        { type: 'response.completed', response: { id: 'retried-draft', model: input.model, status: 'completed' } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }),
  })
  assertReady(f, seoArticle(), 'not_needed')
  assert.equal(requestedOutput, 14_048)
  assert.ok(outlineTokens > 0)
  assert.equal(outlineTokens, originalOutlineTokens)
  assert.equal(f.job.attempt_count, 2)
})

test('legacy exhausted drafts retain reasoning headroom and ignore another model history', async () => {
  const f = fixture({ length: 1000, attempt_count: 1, status: 'queued' })
  f.tables.ai_attempts.push({
    _id: 'legacy-draft', job_id: f.job._id, provider: f.job.provider, model: f.job.model,
    stage: 'draft', status: 'failed', requested_at: new Date(0), finished_at: new Date(1),
    usage: { input: 25, output: 7024, reasoning: 7017 }, error_code: 'AI_ARTICLE',
  }, {
    _id: 'different-model-draft', job_id: f.job._id, provider: f.job.provider, model: 'other-model',
    stage: 'draft', status: 'failed', requested_at: new Date(0), finished_at: new Date(1),
    usage: { input: 25, output: 32768, reasoning: 30000 }, error_code: 'AI_ARTICLE',
    generation: { maxOutputTokens: 32768, outputCharacters: 0, finishReason: 'length', invalidReason: 'truncated' },
  })
  let requestedOutput = 0
  await f.run({
    generate: input => generateArticle(input, async (_url, request) => {
      requestedOutput = JSON.parse(String(request?.body)).max_output_tokens
      const body = [
        { type: 'response.output_text.delta', delta: JSON.stringify(seoArticle()) },
        { type: 'response.completed', response: { id: 'legacy-retry', model: input.model, status: 'completed' } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }),
  })
  assertReady(f, seoArticle(), 'not_needed')
  assert.equal(requestedOutput, 17_550)
})

test('manual retries inherit token headroom from a verified failed predecessor', async () => {
  const f = fixture({ length: 1000, retry_of_job_id: 'failed-predecessor' })
  f.tables.jobs.push({ ...structuredClone(f.job), _id: 'failed-predecessor', retry_of_job_id: null, status: 'failed' })
  f.tables.ai_attempts.push({
    _id: 'predecessor-draft', job_id: 'failed-predecessor', provider: f.job.provider, model: f.job.model,
    stage: 'draft', status: 'failed', requested_at: new Date(0), finished_at: new Date(1),
    usage: { input: 25, output: 7024, reasoning: 7017 }, error_code: 'AI_ARTICLE',
  })
  let requestedOutput = 0
  await f.run({
    generate: input => generateArticle(input, async (_url, request) => {
      requestedOutput = JSON.parse(String(request?.body)).max_output_tokens
      const body = [
        { type: 'response.output_text.delta', delta: JSON.stringify(seoArticle()) },
        { type: 'response.completed', response: { id: 'manual-retry', model: input.model, status: 'completed' } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }),
  })
  assertReady(f, seoArticle(), 'not_needed')
  assert.equal(requestedOutput, 17_550)
  assert.equal(f.tables.jobs.find(row => row._id === 'failed-predecessor')?.status, 'failed')
})

test('manual retries cannot inherit token budgets across customers, sites, models or connections', async () => {
  for (const mismatch of [
    { customer_id: 'another-customer' },
    { site_id: 'another-site' },
    { model: 'another-model' },
    { provider: 'xai' },
    { status: 'ready' },
  ]) {
    const f = fixture({ length: 1000, retry_of_job_id: 'unrelated-predecessor' })
    f.tables.jobs.push({
      ...structuredClone(f.job), _id: 'unrelated-predecessor', retry_of_job_id: null, status: 'failed', ...mismatch,
    })
    f.tables.ai_attempts.push({
      _id: 'unrelated-draft', job_id: 'unrelated-predecessor', provider: f.job.provider, model: f.job.model,
      stage: 'draft', status: 'failed', requested_at: new Date(0), finished_at: new Date(1),
      usage: { input: 25, output: 7024, reasoning: 7017 }, error_code: 'AI_ARTICLE',
    })
    let requestedOutput = 0
    await f.run({
      generate: input => generateArticle(input, async (_url, request) => {
        requestedOutput = JSON.parse(String(request?.body)).max_output_tokens
        const body = [
          { type: 'response.output_text.delta', delta: JSON.stringify(seoArticle()) },
          { type: 'response.completed', response: { id: 'isolated-retry', model: input.model, status: 'completed' } },
        ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }),
    })
    assertReady(f, seoArticle(), 'not_needed')
    assert.equal(requestedOutput, 7024, JSON.stringify(mismatch))
  }
})

test('invalid JSON with full output usage does not trigger the legacy truncation budget', async () => {
  const f = fixture({ length: 1000, attempt_count: 1, status: 'queued' })
  f.tables.ai_attempts.push({
    _id: 'invalid-json-draft', job_id: f.job._id, provider: f.job.provider, model: f.job.model,
    stage: 'draft', status: 'failed', requested_at: new Date(0), finished_at: new Date(1),
    usage: { input: 25, output: 7024 }, error_code: 'AI_ARTICLE',
    generation: { maxOutputTokens: 7024, outputCharacters: 20_000, finishReason: 'stop', invalidReason: 'invalid_json' },
  })
  let requestedOutput = 0
  await f.run({
    generate: input => generateArticle(input, async (_url, request) => {
      requestedOutput = JSON.parse(String(request?.body)).max_output_tokens
      const body = [
        { type: 'response.output_text.delta', delta: JSON.stringify(seoArticle()) },
        { type: 'response.completed', response: { id: 'json-retry', model: input.model, status: 'completed' } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    }),
  })
  assertReady(f, seoArticle(), 'not_needed')
  assert.equal(requestedOutput, 7024)
})

test('a truncated draft retains generation diagnostics, usage and actual cost', async () => {
  const f = fixture({ length: 1000, attempt_count: 2 })
  const usage = { input: 25, output: 7024, reasoning: 7017 }
  const generation: NonNullable<GenerationMetadata['generation']> = {
    maxOutputTokens: 7024, outputCharacters: 7, finishReason: 'length', invalidReason: 'truncated',
  }
  await f.run({
    async generate() {
      throw new WorkerError('AI_ARTICLE', 'Article output reached its token limit.', true, 0, { ...metadata, usage, generation })
    },
  })
  assert.equal(f.job.status, 'failed')
  assert.equal(f.job.error_code, 'AI_ARTICLE')
  const failed = f.tables.ai_attempts.find(row => row.stage === 'draft')
  assert.equal(failed?.status, 'failed')
  assert.deepEqual(failed?.generation, generation)
  assert.deepEqual(failed?.usage, usage)
  assert.equal(failed?.provider_response_id, metadata.responseId)
  assert.equal(failed?.cost_usd, '0.021147000000', 'reasoning is already included in output and must not be billed twice')
})

test('draft reasoning is available to the targeted SEO repair', async () => {
  const f = fixture()
  const draft = articleWithLongParagraph()
  let repairReasoning: number | undefined
  await f.run({
    generate: async () => ({ article: draft, ...metadata, usage: { input: 25, output: 6500, reasoning: 6000 } }),
    async repair(input) {
      repairReasoning = input.tokenBudget?.reasoningTokens
      return { article: seoArticle(), ...metadata }
    },
  })
  assertReady(f, seoArticle(), 'applied')
  assert.equal(repairReasoning, 6000)
})

test('reasoning headroom cannot bypass the configured provider token capacity', async () => {
  const f = fixture({ length: 1000 })
  const input = {
    provider: 'openai' as const, key: 'test-key', model: f.job.model, keyword, tone: f.job.tone, style: f.job.style,
    length: 1000, instructions: null, source: null, research: null, siteDomain: 'example.vn',
  }
  f.config.providerLimits.openai.tokensPerMinute = estimateGenerationTokens(input, 'article') + 100
  let generated = false
  await f.run({
    async outline() {
      f.tables.provider_limits[0].requests[0].time -= 60_000
      return { outline, ...metadata, usage: { input: 25, output: 2048, reasoning: 2000 } }
    },
    async generate() { generated = true; return { article: seoArticle(), ...metadata } },
  })
  assert.equal(generated, false)
  assert.equal(f.job.status, 'failed')
  assert.equal(f.job.error_code, 'AI_TOKEN_CAPACITY')
  assert.deepEqual(f.tables.ai_attempts.map(row => row.stage), ['outline'])
})

test('a service job left by an older quota rejection fails without calling AI', async () => {
  const f = fixture({ mode: 'preview', status: 'queued' })
  f.tables.quota_reservations.length = 0
  await f.run({
    async outline() { assert.fail('Outline must not run without reserved quota') },
    async generate() { assert.fail('Generation must not run without reserved quota') },
  })
  assert.equal(f.job.status, 'failed')
  assert.equal(f.job.error_code, 'QUOTA_RESERVATION_MISSING')
  assert.deepEqual(f.tables.ai_attempts, [])
})

test('provider limits defer a draft without consuming a retry or repeating its outline', async () => {
  const f = fixture()
  f.config.providerLimits.openai.requestsPerMinute = 1
  let outlines = 0
  const deps: WriterDependencies = {
    async outline() { outlines++; return { outline, ...metadata } },
    async generate(input) {
      assert.deepEqual(input.outline, outline)
      return { article: seoArticle(), ...metadata }
    },
  }
  const events: JobEvent[] = []
  const unsubscribe = jobEvents.subscribe(event => events.push(event), f.job._id)
  try {
    assert.equal(await f.run(deps), true)
  } finally { unsubscribe() }
  assert.equal(f.job.status, 'queued')
  assert.equal(events.at(-1)?.status, 'queued', 'realtime fallback observes capacity deferral after the update succeeds')
  assert.equal(f.job.attempt_count, 0)
  assert.equal(f.job.capacity_deferred, true)
  assert.deepEqual(f.tables.ai_attempts.map(row => row.stage), ['outline'])
  assert.equal(await f.run(deps), false)
  f.tables.provider_limits[0].requests[0].time -= 60_000
  f.job.available_at = new Date(0)
  assert.equal(await f.run(deps), true)
  assert.equal(outlines, 1)
  assertReady(f, seoArticle(), 'not_needed')
})

test('a writer can claim another provider while all slots for the first are occupied', async () => {
  const f = fixture()
  f.config.serviceKeys.xai = 'fake-xai-key'
  const xai: Row = { ...f.job, _id: 'other-provider-job', provider: 'xai' }
  let signalStart!: () => void
  let signalContinue!: () => void
  const firstStarted = new Promise<void>(resolve => { signalStart = resolve })
  const continueFirst = new Promise<void>(resolve => { signalContinue = resolve })
  const first = f.run({
    async outline() {
      signalStart()
      await continueFirst
      return { outline, ...metadata }
    },
  })
  try {
    await firstStarted
    f.tables.jobs.push(xai)
    f.tables.quota_reservations.push({ ...f.reservation, job_id: xai._id })
    assert.equal(await f.run(), true)
    assert.equal(f.tables.jobs.find(row => row._id === xai._id)?.status, 'ready')
    assert.equal(f.job.status, 'writing')
  } finally {
    signalContinue()
    await first
  }
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

test('an outline timeout measures idle time between streamed chunks', { timeout: 2_000 }, async () => {
  const f = fixture({}, { aiTimeoutMs: 5_000, outlineTimeoutMs: 20 })
  let aborted = false
  await f.run({
    outline: input => new Promise((_resolve, reject) => {
      const timer = setInterval(() => input.onChunk?.(), 2)
      setTimeout(() => clearInterval(timer), 35)
      input.signal.addEventListener('abort', () => { aborted = true; clearInterval(timer); reject(input.signal.reason) }, { once: true })
    }),
  })
  assert.equal(aborted, true)
  assertReady(f, seoArticle(), 'not_needed')
  assert.equal(f.tables.ai_attempts[0].error_code, 'AI_OUTLINE_TIMEOUT')
})

test('an outline deadline can exceed the shared AI idle timeout', { timeout: 2_000 }, async () => {
  const f = fixture({}, { aiTimeoutMs: 20, outlineTimeoutMs: 80 })
  await f.run({
    outline: async input => {
      await new Promise(resolve => setTimeout(resolve, 45))
      input.signal.throwIfAborted()
      return { outline, ...metadata }
    },
  })
  assert.equal(f.job.status, 'ready')
  assert.equal(f.tables.ai_attempts[0]?.stage, 'outline')
  assert.equal(f.tables.ai_attempts[0]?.status, 'succeeded')
})

test('provider reservations preserve streamed activity timeouts for outline and SEO repair', { timeout: 2_000 }, async () => {
  const f = fixture({}, { aiTimeoutMs: 100, outlineTimeoutMs: 25, seoRepairTimeoutMs: 25 })
  function streamed<T>(input: { signal: AbortSignal; onChunk?: () => void }, result: T) {
    return new Promise<T>((resolve, reject) => {
      const timer = setInterval(() => input.onChunk?.(), 3)
      const finish = setTimeout(() => { clearInterval(timer); resolve(result) }, 65)
      input.signal.addEventListener('abort', () => {
        clearInterval(timer)
        clearTimeout(finish)
        reject(input.signal.reason)
      }, { once: true })
    })
  }
  await f.run({
    outline: input => streamed(input, { outline, ...metadata }),
    generate: async () => ({ article: shortArticle, ...metadata }),
    repair: input => streamed(input, { article: seoArticle(), ...metadata }),
  })
  assertReady(f, seoArticle(), 'applied')
  assert.ok(f.tables.ai_attempts.every(row => row.status === 'succeeded'))
})

test('one SEO repair applies improvements after the original draft is durably stored', async () => {
  const draft = articleWithLongParagraph()
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
      assert.deepEqual(input.issues.map(issue => issue.key), ['contentHasShortParagraphs'])
      return { article: { ...input.draft, Content: seoArticle().Content }, ...metadata }
    },
  })
  assert.equal(repairs, 1)
  assertReady(f, seoArticle(), 'applied')
  assert.equal(f.job.seo_report.warnings.filter((row: Row) => row.repairable).length, 0)
  assert.deepEqual(f.tables.ai_attempts.map(row => row.stage), ['outline', 'draft', 'seo_repair'])
})

test('SEO repair is discarded when it breaks a criterion the draft passed', async () => {
  const draft = articleWithLongParagraph()
  const f = fixture()
  await f.run({
    generate: async () => ({ article: draft, ...metadata }),
    repair: async input => ({ article: { ...input.draft, Content: '<p>Quá ngắn.</p><p>Nội dung bị thay đổi.</p>' }, ...metadata }),
  })
  assertReady(f, draft, 'kept_draft')
})

test('short useful copy and natural keyword use remain advisory without an automatic repair', async () => {
  const article: Article = {
    Title: 'Cách pha bằng nước lạnh',
    Content: '<p>Trộn cà phê xay thô với nước sạch trong bình có nắp. Bắt đầu bằng mẻ nhỏ để dễ điều chỉnh độ đậm theo khẩu vị.</p>'
      + '<p>Lọc bỏ bã khi đồ uống đạt hương vị mong muốn và bảo quản trong ngăn mát. Vệ sinh bình, bộ lọc sau mỗi lần dùng.</p>',
    Slug: 'pha-bang-nuoc-lanh',
    Desc: 'Các bước chuẩn bị một mẻ nhỏ tại nhà.',
    Description: 'Hướng dẫn chuẩn bị, lọc và bảo quản đồ uống từ cà phê ngâm nước lạnh.',
    Keywords: ['cà phê'],
  }
  const f = fixture()
  await f.run({
    generate: async () => ({ article, ...metadata }),
    async repair() { assert.fail('Advisory length and keyword heuristics must not spend another AI call') },
  })
  assertReady(f, article, 'not_needed')
  assert.deepEqual(f.tables.ai_attempts.map(row => row.stage), ['outline', 'draft'])
  const warnings = f.job.seo_report.warnings as Row[]
  assert.ok(warnings.some(row => row.key === 'lengthTitle'))
  assert.ok(warnings.some(row => row.key === 'lengthMetaDescription'))
  assert.ok(warnings.some(row => row.key === 'lengthContent'))
  assert.ok(warnings.some(row => row.key === 'keywordDensity'))
  assert.ok(warnings.every(row => row.repairable === false))
  assert.equal(f.job.seo_report.metrics.keywordOccurrences, 0)
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

test('SEO repair timeout measures idle time between streamed chunks', { timeout: 2_000 }, async () => {
  const f = fixture({}, { aiTimeoutMs: 5_000, seoRepairTimeoutMs: 20 })
  let aborted = false
  await f.run({
    generate: async () => ({ article: shortArticle, ...metadata }),
    repair: input => new Promise((_resolve, reject) => {
      const timer = setInterval(() => input.onChunk?.(), 2)
      setTimeout(() => clearInterval(timer), 35)
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

test('compatible connections keep their keys, endpoints, catalog models and pricing isolated', async () => {
  const firstProvider = 'openai-compatible-10000000-0000-4000-8000-000000000001'
  const secondProvider = 'openai-compatible-10000000-0000-4000-8000-000000000002'
  const f = fixture({ provider: firstProvider, model: 'model-first' })
  const secondJob: Row = { ...structuredClone(f.job), _id: 'second-job', provider: secondProvider, model: 'model-second' }
  f.tables.jobs.push(secondJob)
  f.tables.quota_reservations.push({ job_id: secondJob._id, customer_id: secondJob.customer_id, status: 'reserved' })
  f.tables.ai_providers = [
    { _id: firstProvider, enabled: true, base_url: 'https://first.example/v1', encrypted_api_key: seal('first-key', f.config.encryptionKey) },
    // A disabled connection can finish work it accepted before being disabled.
    { _id: secondProvider, enabled: false, base_url: 'https://second.example/v1', encrypted_api_key: seal('second-key', f.config.encryptionKey) },
  ]
  f.tables.ai_models = [
    { _id: 'model-first', provider: firstProvider, upstream_model: 'shared-upstream-model' },
    { _id: 'model-second', provider: secondProvider, upstream_model: 'shared-upstream-model' },
  ]
  f.tables.model_prices.push({ _id: 'price-second', provider: secondProvider, model: 'model-second', effective_at: new Date(0), rates: { total: 7 } })
  const calls: { key: string; baseUrl?: string; model: string; provider: string }[] = []
  const verify = (input: Parameters<NonNullable<WriterDependencies['generate']>>[0]) => {
    calls.push({ key: input.key, baseUrl: input.baseUrl, model: input.model, provider: input.provider })
  }
  for (let index = 0; index < 2; index += 1) assert.equal(await f.run({
    async outline(input) { verify(input); return { outline, ...metadata } },
    async generate(input) { verify(input); return { article: seoArticle(), ...metadata } },
  }), true)
  assert.equal(f.job.status, 'ready')
  assert.equal(secondJob.status, 'ready')
  assert.equal(calls.length, 4)
  assert.ok(calls.every(call => call.provider === 'openai-compatible' && call.model === 'shared-upstream-model'))
  assert.equal(calls.filter(call => call.key === 'first-key' && call.baseUrl === 'https://first.example/v1').length, 2)
  assert.equal(calls.filter(call => call.key === 'second-key' && call.baseUrl === 'https://second.example/v1').length, 2)
  for (const [provider, model, price] of [[firstProvider, 'model-first', 'price-test'], [secondProvider, 'model-second', 'price-second']]) {
    const attempts = f.tables.ai_attempts.filter(attempt => attempt.provider === provider)
    assert.equal(attempts.length, 2)
    assert.ok(attempts.every(attempt => attempt.model === model && attempt.pricing_id === price && attempt.cost_usd !== null))
  }
  const modelLookups = f.operations.filter(operation => operation.table === 'ai_models' && operation.method === 'findOne')
  assert.deepEqual(modelLookups.map(operation => operation.filter).sort((a, b) => a._id.localeCompare(b._id)), [
    { _id: 'model-first', provider: firstProvider }, { _id: 'model-second', provider: secondProvider },
  ])
  assert.equal(await f.run(), false)
})

test('a compatible connection without a key cannot borrow the legacy connection key', async () => {
  const provider = 'openai-compatible-10000000-0000-4000-8000-000000000003'
  const f = fixture({ provider })
  ;(f.config.serviceKeys as Record<string, string | undefined>)['openai-compatible'] = 'legacy-key'
  f.tables.ai_providers = [{ _id: provider, base_url: 'https://missing-key.example/v1' }]
  assert.equal(await f.run({ async generate() { assert.fail('No upstream request without this connection key') } }), true)
  assert.equal(f.job.status, 'failed')
  assert.equal(f.job.error_code, 'AI_KEY_UNAVAILABLE')
  assert.equal(f.tables.ai_attempts.length, 0)
})

test('a compatible connection never sends an unresolved internal model ID upstream', async () => {
  const provider = 'openai-compatible-10000000-0000-4000-8000-000000000006'
  const f = fixture({ provider, model: 'model-missing' })
  f.tables.ai_providers = [{ _id: provider, base_url: 'https://example.test/v1', encrypted_api_key: seal('provider-key', f.config.encryptionKey) }]
  f.tables.ai_models = [{ _id: 'model-missing', provider: 'openai-compatible', upstream_model: 'wrong-provider-model' }]
  assert.equal(await f.run({ async generate() { assert.fail('No request for an unresolved model') } }), true)
  assert.equal(f.job.status, 'failed')
  assert.equal(f.job.error_code, 'AI_MODEL_UNAVAILABLE')
  assert.equal(f.tables.ai_attempts.length, 0)
})

test('compatible connections use shared limit defaults with independent capacity windows', async () => {
  const firstProvider = 'openai-compatible-10000000-0000-4000-8000-000000000004'
  const secondProvider = 'openai-compatible-10000000-0000-4000-8000-000000000005'
  const f = fixture()
  const signal = new AbortController().signal
  await reserveProviderRequest(f.db, f.config, firstProvider, 'first-request', 1_000, signal)
  assert.equal(await providerHasCapacity(f.db, f.config, firstProvider), false)
  assert.equal(await providerHasCapacity(f.db, f.config, secondProvider), true)
  await assert.rejects(reserveProviderRequest(f.db, f.config, firstProvider, 'blocked-request', 1_000, signal), ProviderCapacityPending)
  await reserveProviderRequest(f.db, f.config, secondProvider, 'second-request', 1_000, signal)
  assert.equal(await providerHasCapacity(f.db, f.config, secondProvider), false)
  assert.deepEqual(f.tables.provider_limits.map(row => ({ provider: row._id, slots: row.slots.map((slot: Row) => slot.id) })), [
    { provider: firstProvider, slots: ['first-request'] }, { provider: secondProvider, slots: ['second-request'] },
  ])
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
    async outline() {
      // A prior request is outside the rolling minute when the draft starts.
      f.tables.provider_limits[0].requests[0].time -= 60_000
      return { outline: { ...outline, angle: 'Nội dung dài '.repeat(2000) }, ...metadata }
    },
    async generate(input) { assert.equal(input.outline, null); return { article: seoArticle(), ...metadata } },
  })
  assertReady(f, seoArticle(), 'not_needed')
})

test('repair is skipped when its full prompt would exceed the per-call token budget', async () => {
  const f = fixture()
  f.config.providerLimits.openai.tokensPerMinute = 18_000
  const longDraft = { ...seoArticle(), Content: '<p>Cà phê cold brew ' + 'từ '.repeat(5000) + '</p>' }
  await f.run({
    async outline() {
      f.tables.provider_limits[0].requests[0].time -= 60_000
      return { outline, ...metadata }
    },
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
  const article = { ...seoArticle(), Keywords: ['pha chế', 'đồ uống'] }
  await f.run({ generate: async () => ({ article, ...metadata }) })
  assert.deepEqual(f.job.seo_report, evaluateSeo(cleanArticle(article), { keyword, siteUrl: 'example.vn' }))
})

test('own-key attempts keep usage unpriced and do not read catalog pricing', async () => {
  const f = fixture({ key_mode: 'own', encrypted_key: seal('customer-key', Buffer.alloc(32, 3)) })
  await f.run()
  assert.ok(f.tables.ai_attempts.length >= 2)
  assert.ok(f.tables.ai_attempts.every(row => row.cost_usd === null && row.cost_source === null && row.pricing_id === null))
})

function catalogPage(id: string, url: string, title: string, overrides: Row = {}) {
  const summary = 'Hướng dẫn lựa chọn cà phê cold brew và dụng cụ pha tại nhà.'
  return {
    _id: `content-${id}`, external_id: id, site_id: 'test-site', customer_id: 'test-customer',
    url, title, summary, categories: [], search_terms: siteContentSearchTerms(`${title} ${summary}`),
    updated_at: new Date(), ...overrides,
  }
}

test('writer uses current per-site catalog after outlining without an additional AI call', async () => {
  const f = fixture({ exclude_content_ids: ['self'] })
  f.tables.site_content = [catalogPage('old', 'https://example.vn/old', 'Cà phê cold brew cũ')]
  const accepted = catalogPage('guide', 'https://example.vn/chon-hat', 'Chọn hạt cà phê cold brew')
  const article = { ...seoArticle(), Content: '<p>Tham khảo <a href="https://example.vn/chon-hat">cách chọn hạt cà phê</a>, '
    + '<a href="https://example.vn/chon-hat">chọn hạt lần nữa</a> và <a href="https://example.vn/bia-link">dụng cụ pha</a>.</p><p>Chọn nguyên liệu phù hợp với khẩu vị.</p>' }
  await f.run({
    async outline(input) {
      assert.equal(input.internalLinks, undefined)
      f.tables.site_content = [accepted,
        catalogPage('self', 'https://example.vn/self', 'Cà phê cold brew của tôi'),
        catalogPage('foreign', 'https://other.vn/page', 'Cà phê cold brew', { site_id: 'other-site' }),
        catalogPage('old-owner', 'https://example.vn/private', 'Cà phê cold brew', { customer_id: 'other-customer' }),
      ]
      return { outline, ...metadata }
    },
    async generate(input) {
      assert.deepEqual(input.internalLinks?.map(row => row.id), ['guide'])
      return { article, ...metadata }
    },
    async repair() { assert.fail('Link selection must not create a repair call') },
  })
  const result = f.job.result[0]
  assert.equal(f.job.status, 'ready')
  assert.equal((result.Content.match(/<a\b/g) ?? []).length, 1)
  assert.ok(result.Content.includes('chọn hạt lần nữa'))
  assert.ok(result.Content.includes('dụng cụ pha'))
  assert.equal(result.Content.includes('bia-link'), false)
  assert.deepEqual(f.job.internal_link_report.used, [{ url: accepted.url, anchor: 'cách chọn hạt cà phê' }])
  assert.equal(f.job.internal_link_report.removed, 2)
  assert.deepEqual(f.tables.ai_attempts.map(row => row.stage), ['outline', 'draft'])
  assert.deepEqual(Object.keys(result).sort(), Object.keys(seoArticle()).sort())
})

test('links removed or retargeted by Laravel while AI writes are not saved as approved links', async () => {
  for (const change of ['deleted', 'retargeted', 'domain', 'owner']) {
    const f = fixture()
    f.tables.site_content = [catalogPage('guide', 'https://example.vn/chon-hat', 'Chọn hạt cà phê cold brew')]
    await f.run({
      async generate(input) {
        assert.equal(input.internalLinks?.length, 1)
        if (change === 'deleted') f.tables.site_content = []
        if (change === 'retargeted') f.tables.site_content[0].url = 'https://example.vn/moved'
        if (change === 'domain') f.tables.sites[0].domain = 'changed.vn'
        if (change === 'owner') f.tables.sites[0].customer_id = 'other-customer'
        return { article: { ...seoArticle(), Content: '<p>Đọc <a href="https://example.vn/chon-hat">cách chọn hạt cà phê</a>.</p>' }, ...metadata }
      },
    })
    assert.equal(f.job.status, 'ready', change)
    assert.equal(f.job.result[0].Content, '<p>Đọc cách chọn hạt cà phê.</p>', change)
    assert.deepEqual(f.job.internal_link_report.used, [], change)
  }
})

test('catalog checks run again after SEO repair and preserve intentional source links', async () => {
  const f = fixture({ mode: 'rewrite', source_article_id: 'original' })
  f.tables.jobs.push({ _id: 'original', site_id: 'test-site', status: 'ready', result: [{ ...shortArticle,
    Content: '<p><a href="https://reference.example/source">hướng dẫn gốc</a></p>' }] })
  f.tables.site_content = [catalogPage('guide', 'https://example.vn/chon-hat', 'Chọn hạt cà phê cold brew')]
  const links = '<p><a href="https://reference.example/source">hướng dẫn gốc</a> và <a href="https://example.vn/chon-hat">cách chọn hạt cà phê</a>.</p>'
  await f.run({
    generate: async () => ({ article: { ...articleWithLongParagraph(), Content: articleWithLongParagraph().Content + links }, ...metadata }),
    async repair(input) {
      assert.ok(input.draft.Content.includes('https://example.vn/chon-hat'))
      f.tables.site_content = []
      return { article: { ...seoArticle(), Content: seoArticle().Content + links }, ...metadata }
    },
  })
  assert.equal(f.job.status, 'ready')
  assert.ok(f.job.result[0].Content.includes('href="https://reference.example/source"'))
  assert.equal(f.job.result[0].Content.includes('href="https://example.vn/chon-hat"'), false)
  assert.deepEqual(f.job.internal_link_report.used, [])
})

test('own-key catalog linking keeps usage unpriced and does not read pricing', async () => {
  const f = fixture({ key_mode: 'own', encrypted_key: seal('customer-key', Buffer.alloc(32, 3)) })
  f.tables.site_content = [catalogPage('guide', 'https://example.vn/chon-hat', 'Chọn hạt cà phê cold brew')]
  await f.run({ generate: async input => {
    assert.equal(input.internalLinks?.length, 1)
    return { article: { ...seoArticle(), Content: '<p><a href="https://example.vn/chon-hat">cách chọn hạt cà phê</a>.</p>' }, ...metadata }
  } })
  assert.equal(f.job.internal_link_report.used.length, 1)
  assert.ok(f.tables.ai_attempts.every(row => row.cost_usd === null && row.cost_source === null && row.pricing_id === null))
  assert.equal(f.operations.some(row => row.table === 'model_prices'), false)
})

test('a synced empty, unrelated or unavailable catalog never permits invented links', async () => {
  for (const state of ['empty', 'unrelated', 'unavailable']) {
    const f = fixture()
    f.tables.sites[0].site_content_synced_at = new Date()
    f.tables.site_content = state === 'unrelated'
      ? [catalogPage('unrelated', 'https://example.vn/shoes', 'Running shoes', { summary: 'Sports equipment', search_terms: ['running', 'shoes'] })] : []
    if (state === 'unavailable') {
      const original = f.db.db.collection.bind(f.db.db)
      f.db.db.collection = ((name: string, ...args: any[]) => {
        if (name === 'site_content') throw new Error('Catalog temporarily unavailable')
        return original(name, ...args)
      }) as typeof f.db.db.collection
    }
    await f.run({ generate: async () => ({ article: { ...seoArticle(), Content: '<p>Đọc <a href="https://example.vn/guessed">hướng dẫn pha cà phê</a>.</p><p>Chuẩn bị dụng cụ sạch.</p>' }, ...metadata }) })
    assert.equal(f.job.status, 'ready', state)
    assert.equal(f.job.result[0].Content.includes('<a'), false, state)
    assert.equal(f.job.internal_link_report.status, state === 'unavailable' ? 'unavailable' : 'no_candidates')
    assert.equal(f.tables.ai_attempts.length, 2)
  }
})

test('optional catalog context is dropped instead of failing an otherwise affordable draft', async () => {
  const f = fixture()
  f.tables.sites[0].site_content_synced_at = new Date()
  f.tables.site_content = Array.from({ length: 8 }, (_, i) => catalogPage(`guide${i}`, `https://example.vn/guide${i}`, `Cà phê cold brew guide ${i}`, { summary: 'nguyên liệu '.repeat(100) }))
  const input = { provider: 'openai' as const, key: 'test-key', model: 'test-model', keyword, tone: 'rõ ràng', style: 'hướng dẫn', length: 1500, instructions: null, source: null, research: null, siteDomain: 'example.vn', outline }
  const baseline = estimateGenerationTokens({ ...input, internalLinks: [] }, 'article')
  await f.run({
    outline: async () => {
      f.config.providerLimits.openai.tokensPerMinute = baseline + 20
      f.tables.provider_limits[0].requests[0].time -= 60_000
      return { outline, ...metadata }
    },
    generate: async actual => {
      assert.equal(actual.internalLinks, undefined)
      assert.ok(estimateGenerationTokens(actual, 'article') <= f.config.providerLimits.openai.tokensPerMinute)
      return { article: seoArticle(), ...metadata }
    },
  })
  assert.equal(f.job.status, 'ready')
  assert.equal(f.job.internal_link_report.candidates, 0)
})

test('capacity deferral reuses the outline but selects the latest catalog for the eventual draft', async () => {
  const f = fixture()
  f.config.providerLimits.openai.requestsPerMinute = 1
  f.tables.site_content = [catalogPage('old', 'https://example.vn/old', 'Cà phê cold brew cũ')]
  let outlines = 0
  const deps: WriterDependencies = {
    outline: async () => { outlines++; return { outline, ...metadata } },
    generate: async input => {
      assert.deepEqual(input.internalLinks?.map(row => row.id), ['new'])
      return { article: seoArticle(), ...metadata }
    },
  }
  await f.run(deps)
  assert.equal(f.job.status, 'queued')
  f.tables.site_content = [catalogPage('new', 'https://example.vn/new', 'Cà phê cold brew mới')]
  f.tables.provider_limits[0].requests[0].time -= 60_000
  f.job.available_at = new Date(0)
  await f.run(deps)
  assert.equal(f.job.status, 'ready')
  assert.equal(outlines, 1)
})

test('expired draft recovery revalidates catalog links without calling AI or losing source links', async () => {
  const url = 'https://example.vn/chon-hat'
  const f = fixture({ status: 'writing', mode: 'rewrite', source_article_id: 'original', lease_token: 'old-lease', lease_expires_at: new Date(0), attempt_count: 2,
    result: [{ ...shortArticle, Content: `<p><a href="${url}">cách chọn hạt cà phê</a> và <a href="https://reference.example/original">nguồn tham khảo</a>.</p>` }],
    internal_link_report: { status: 'checked', candidates: 1, used: [{ url, anchor: 'cách chọn hạt cà phê' }], removed: 0, checked_at: new Date(0).toISOString() },
  })
  f.tables.sites[0].site_content_synced_at = new Date()
  f.tables.site_content = []
  f.tables.jobs.push({ _id: 'original', site_id: 'test-site', customer_id: 'test-customer', status: 'ready', result: [{ ...shortArticle, Content: '<p><a href="https://reference.example/original">nguồn tham khảo</a>.</p>' }] })
  await f.run({ outline: async () => { assert.fail('Recovery cannot call AI') } })
  assert.equal(f.job.status, 'ready')
  assert.equal(f.job.result[0].Content.includes(url), false)
  assert.ok(f.job.result[0].Content.includes('href="https://reference.example/original"'))
  assert.deepEqual(f.job.internal_link_report.used, [])
  assert.equal(f.tables.ai_attempts.length, 0)
})

test('configured catalog URL is pulled after the outline and used in the existing draft call', async () => {
  const f = fixture()
  f.tables.sites[0].content_catalog_url = 'https://example.vn/api/ai/content-catalog'
  const order: string[] = []
  await f.run({
    outline: async () => { order.push('outline'); return { outline, ...metadata } },
    syncCatalog: async (db, siteId, options) => {
      order.push('catalog')
      assert.equal(db, f.db)
      assert.equal(siteId, 'test-site')
      assert.equal(options?.expectedUrl, 'https://example.vn/api/ai/content-catalog')
      assert.equal(options?.expectedCustomerId, 'test-customer')
      assert.equal(options?.signal?.aborted, false)
      f.tables.site_content = [catalogPage('guide', 'https://example.vn/chon-hat', 'Chọn hạt cà phê cold brew')]
      return { status: 'synced', count: 1, synced_at: new Date().toISOString() }
    },
    generate: async input => {
      order.push('draft')
      assert.deepEqual(input.internalLinks?.map(row => row.id), ['guide'])
      return { article: { ...seoArticle(), Content: seoArticle().Content + '<p><a href="https://example.vn/chon-hat">cách chọn hạt cà phê</a>.</p>' }, ...metadata }
    },
  })
  assert.equal(f.job.status, 'ready')
  assert.deepEqual(order, ['outline', 'catalog', 'draft'])
  assert.equal(f.job.internal_link_report.used.length, 1)
  assert.equal(f.tables.ai_attempts.length, 2)
})

test('configured pull failure or busy sync never falls back to old or invented links', async () => {
  for (const state of ['failure', 'busy', 'not_configured']) {
    const f = fixture()
    f.tables.sites[0].content_catalog_url = 'https://example.vn/catalog'
    f.tables.site_content = [catalogPage('stale', 'https://example.vn/stale', 'Cà phê cold brew cũ')]
    await f.run({
      syncCatalog: async () => {
        if (state === 'failure') throw new Error('Fixture upstream failure')
        return { status: state as 'busy' | 'not_configured', count: 1, synced_at: null }
      },
      generate: async input => {
        assert.deepEqual(input.internalLinks, [])
        return { article: { ...seoArticle(), Content: seoArticle().Content + '<p>Đọc <a href="https://example.vn/stale">cách pha cà phê cold brew</a> và <a href="https://example.vn/guessed">cách chọn dụng cụ</a>.</p>' }, ...metadata }
      },
    })
    assert.equal(f.job.status, 'ready', state)
    assert.equal(f.job.result[0].Content.includes('<a'), false, state)
    assert.equal(f.job.internal_link_report.status, 'unavailable')
    assert.equal(f.tables.ai_attempts.length, 2)
  }
})

test('changing the configured catalog URL during generation invalidates its original shortlist', async () => {
  const f = fixture()
  f.tables.sites[0].content_catalog_url = 'https://example.vn/catalog-a'
  f.tables.site_content = [catalogPage('guide', 'https://example.vn/chon-hat', 'Chọn hạt cà phê cold brew')]
  await f.run({
    syncCatalog: async () => ({ status: 'cached', count: 1, synced_at: new Date().toISOString() }),
    generate: async () => {
      f.tables.sites[0].content_catalog_url = 'https://example.vn/catalog-b'
      return { article: { ...seoArticle(), Content: '<p><a href="https://example.vn/chon-hat">cách chọn hạt cà phê</a>.</p>' }, ...metadata }
    },
  })
  assert.equal(f.job.status, 'ready')
  assert.equal(f.job.result[0].Content.includes('<a'), false)
  assert.deepEqual(f.job.internal_link_report.used, [])
})

test('expired draft recovery pulls the catalog and preserves source links when pull fails', async () => {
  const url = 'https://example.vn/chon-hat'
  const f = fixture({ status: 'writing', mode: 'rewrite', source_article_id: 'original', lease_token: 'old-lease', lease_expires_at: new Date(0), attempt_count: 2,
    result: [{ ...shortArticle, Content: `<p><a href="${url}">cách chọn hạt cà phê</a> và <a href="https://reference.example/original">nguồn tham khảo</a>.</p>` }],
    internal_link_report: { status: 'checked', candidates: 1, used: [{ url, anchor: 'cách chọn hạt cà phê' }], removed: 0, checked_at: new Date(0).toISOString() },
  })
  f.tables.sites[0].content_catalog_url = 'https://example.vn/catalog'
  f.tables.site_content = [catalogPage('guide', url, 'Chọn hạt cà phê cold brew')]
  f.tables.jobs.push({ _id: 'original', site_id: 'test-site', customer_id: 'test-customer', status: 'ready', result: [{ ...shortArticle, Content: '<p><a href="https://reference.example/original">nguồn tham khảo</a>.</p>' }] })
  let pulls = 0
  await f.run({
    syncCatalog: async () => { pulls++; throw new Error('Upstream unavailable') },
    outline: async () => { assert.fail('Recovery cannot call AI') },
  })
  assert.equal(pulls, 1)
  assert.equal(f.job.status, 'ready')
  assert.equal(f.job.result[0].Content.includes(url), false)
  assert.ok(f.job.result[0].Content.includes('href="https://reference.example/original"'))
  assert.equal(f.job.internal_link_report.status, 'unavailable')
  assert.equal(f.tables.ai_attempts.length, 0)
})
