import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { collection, connect } from '../src/db.js'
import { loadConfig } from '../src/config.js'
import { migrate } from '../src/migrate.js'
import { partnerDatabase } from '../src/workspaces.js'
import { keywordInputSchema } from '../src/keywords/contracts.js'
import { createKeywordAnalysis, keywordView, reserveKeywordSource } from '../src/keywords/service.js'
import { runKeywordOnce } from '../src/keywords/worker.js'
import { normalizeKeywordResults, KeywordSourceError } from '../src/keywords/source.js'
import { loadKeywordBrief } from '../src/keywords/brief.js'
import { keywordSettingsSchema } from '../src/keywords/settings.js'
import { buildApp } from '../src/app.js'
import { browserProofFixture } from './crm-proof-fixture.js'
import { digest } from '../src/security.js'
import { browserBodyHash } from '../src/crm-proof.js'

test('keyword discovery lifecycle, quotas, costs and tenant boundaries in MongoDB', {
  skip: !process.env.CRM_TEST_MONGODB_URI, timeout: 90_000,
}, async t => {
  const root = connect(process.env.CRM_TEST_MONGODB_URI!, `crm_keyword_test_${randomBytes(8).toString('hex')}`)
  const a = partnerDatabase(root, randomUUID()), b = partnerDatabase(root, randomUUID())
  const config = { ...loadConfig(), origin: 'http://localhost:3210', production: false, secureCookies: false,
    encryptionKey: randomBytes(32), serviceKeys: { openai: 'synthetic-ai-key', anthropic: undefined, xai: undefined, 'openai-compatible': undefined } }
  let app: Awaited<ReturnType<typeof buildApp>> | undefined
  t.after(async () => {
    await app?.close()
    for (const db of [a, b, root]) { assert.match(db.db.databaseName, /^(crm_keyword_test_|crm_p_)/); await db.db.dropDatabase() }
    await root.client.close()
  })
  for (const db of [root, a, b]) { await migrate(db); await migrate(db) }
  const customer = randomUUID(), website = randomUUID()
  for (const db of [root, a, b]) {
    await collection(db, 'customers').insertOne({ _id: customer, name: 'Khách thử', key_mode: 'service', allowed_models: ['gpt-4.1'] })
    await collection(db, 'sites').insertOne({ _id: website, customer_id: customer, name: 'Website mới', domain: 'new.example.test' })
  }
  const input = keywordInputSchema.parse({ website_id: website, client_request_id: randomUUID(), seed: 'máy lọc nước' })
  const source = normalizeKeywordResults({ data: [{ string: 'máy lọc nước', volume: 0 }, { string: 'máy lọc nước gia đình' }], total_count: 20 }, input, 'guest')
  const fakeSource = async () => structuredClone(source)

  await t.test('cold start and racing requests create one reservation and one source call', async () => {
    const requests = await Promise.all(Array.from({ length: 5 }, () => createKeywordAnalysis(a, config, { ...input, client_request_id: randomUUID() })))
    assert.equal(new Set(requests.map(r => r.id)).size, 1)
    assert.equal(await collection(a, 'keyword_quota_reservations').countDocuments({}), 1)
    let calls = 0
    await Promise.all([runKeywordOnce(a, config, { fetchSource: async () => { calls++; return fakeSource() } }), runKeywordOnce(a, config, { fetchSource: async () => { calls++; return fakeSource() } })])
    assert.equal(calls, 1)
    const row = await collection(a, 'keyword_analyses').findOne({ _id: requests[0].id })
    assert.equal(row.status, 'ready'); assert.equal(row.result.candidates[1].volume, null)
    assert.equal((await keywordView(a, row)).source_cost, 'free')
    assert.equal((await keywordView(a, row)).ai_called, false)
    assert.equal(await collection(a, 'quota_reservations').countDocuments({}), 0)
    assert.equal(await collection(a, 'site_content').countDocuments({}), 0)
    const cached = await createKeywordAnalysis(a, config, input)
    assert.equal(cached.reused, true)
    assert.equal(cached.id, row._id)
  })
  await t.test('idempotency rejects changed contents and another workspace cannot resolve an analysis', async () => {
    const first = await createKeywordAnalysis(a, config, { ...input, seed: 'dịch vụ thiết kế website' })
    await assert.rejects(createKeywordAnalysis(a, config, { ...input, seed: 'nội dung khác' }), (e: any) => e.code === 'keyword_request_conflict')
    assert.equal(await collection(b, 'keyword_analyses').findOne({ _id: first.id }), null)
    await runKeywordOnce(a, config, { fetchSource: fakeSource })
    await assert.rejects(loadKeywordBrief(b, website, customer, { analysis_id: first.id, candidate_id: source.candidates[0].id }, source.candidates[0].keyword, 'vi'))
    const brief = await loadKeywordBrief(a, website, customer, { analysis_id: first.id, candidate_id: source.candidates[0].id }, source.candidates[0].keyword, 'vi')
    assert.equal(brief.keyword, source.candidates[0].keyword)
    await assert.rejects(loadKeywordBrief(a, website, customer, { analysis_id: first.id, candidate_id: source.candidates[0].id }, 'changed keyword', 'vi'))
    await assert.rejects(loadKeywordBrief(a, website, customer, { analysis_id: first.id, candidate_id: source.candidates[0].id }, source.candidates[0].keyword, 'ja'))
  })
  await t.test('customer quota is atomic and independent of article quota', async () => {
    await collection(b, 'keyword_settings').insertOne({ _id: 'crm', revision: 1, values: keywordSettingsSchema.parse({ daily_limit: 1 }) })
    const outcomes = await Promise.allSettled([1, 2, 3].map(n => createKeywordAnalysis(b, config, { ...input, seed: `chủ đề ${n}`, client_request_id: randomUUID() })))
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(await collection(b, 'keyword_quota_reservations').countDocuments({ status: 'reserved' }), 1)
    await runKeywordOnce(b, config, { fetchSource: async () => { throw new KeywordSourceError('source_quota', 'Hết hạn mức nguồn') } })
    assert.equal(await collection(b, 'keyword_quota_reservations').countDocuments({ status: 'released' }), 1)
    assert.equal(await collection(b, 'quota_reservations').countDocuments({}), 0)
  })
  await t.test('Guest source quota is shared across partner databases and bounded under races', async () => {
    const now = Date.now()
    await collection(root, 'keyword_source_limits').updateOne({ _id: 'keywordtool-guest' }, { $set: { times: Array(59).fill(now), revision: 5 } }, { upsert: true })
    const outcomes = await Promise.allSettled([a, b, a, b].map(db => reserveKeywordSource(db, 'guest', undefined, 50, now)))
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal((await collection(root, 'keyword_source_limits').findOne({ _id: 'keywordtool-guest' })).times.length, 60)
    await collection(root, 'keyword_source_limits').deleteMany({})
  })
  await t.test('AI success records its real usage/cost and joins only source candidate IDs', async () => {
    await collection(a, 'model_prices').insertOne({ _id: randomUUID(), provider: 'openai', model: 'gpt-4.1', effective_at: new Date(0), rates: { input: 1, output: 1 } })
    const created = await createKeywordAnalysis(a, config, { ...input, seed: 'AI phân loại', client_request_id: randomUUID(), ai_model: 'gpt-4.1' })
    let calls = 0
    await runKeywordOnce(a, config, { fetchSource: fakeSource, aiFetcher: (async (url, options) => {
      calls++
      assert.equal(url, 'https://api.openai.com/v1/responses')
      const body = JSON.parse(String(options!.body)); assert.equal(body.max_output_tokens, 4096)
      assert.equal(body.tools, undefined)
      return Response.json({ id: 'synthetic-response', model: 'gpt-4.1', status: 'completed', usage: { input_tokens: 100, output_tokens: 50 },
        output_text: JSON.stringify({ suggestions: [{ candidate_id: source.candidates[0].id, related_ids: [source.candidates[1].id], title: 'Chọn máy lọc nước', intent: 'Tìm hiểu', angle: 'Theo nhu cầu gia đình', reason: 'Phù hợp sản phẩm' }] }) })
    }) as typeof fetch })
    assert.equal(calls, 1)
    const row = await collection(a, 'keyword_analyses').findOne({ _id: created.id })
    assert.equal(row.status, 'ready'); assert.equal(row.suggestions.length, 1)
    const view = await keywordView(a, row)
    assert.equal(view.ai_called, true); assert.equal(view.ai_cost_usd, '0.000150000000')
    assert.equal(await collection(a, 'ai_attempts').countDocuments({}), 0, 'article cost report is unaffected')
  })
  await t.test('AI cannot invent metrics; failed AI retains source rows and known billable usage', async () => {
    const created = await createKeywordAnalysis(a, config, { ...input, seed: 'AI lỗi', client_request_id: randomUUID(), ai_model: 'gpt-4.1' })
    await runKeywordOnce(a, config, { fetchSource: fakeSource, aiFetcher: (async () => Response.json({
      status: 'completed', usage: { input_tokens: 50, output_tokens: 20 }, output_text: JSON.stringify({ suggestions: [{ candidate_id: 'fake', volume: 999 }] }),
    })) as typeof fetch })
    const row = await collection(a, 'keyword_analyses').findOne({ _id: created.id })
    assert.equal(row.status, 'partial'); assert.ok(row.result.candidates.length); assert.equal(row.suggestions.length, 0)
    assert.equal((await keywordView(a, row)).ai_cost_usd, '0.000070000000')
  })
  await t.test('expired work is never blindly replayed and releases an unused reservation', async () => {
    const created = await createKeywordAnalysis(a, config, { ...input, seed: 'gián đoạn', client_request_id: randomUUID() })
    await collection(a, 'keyword_analyses').updateOne({ _id: created.id }, { $set: { status: 'running', lease_expires_at: new Date(0), ai_called: true } })
    await runKeywordOnce(a, config, { fetchSource: async () => { throw new Error('must not replay') } })
    assert.equal((await collection(a, 'keyword_analyses').findOne({ _id: created.id })).status, 'failed')
    assert.equal((await collection(a, 'keyword_quota_reservations').findOne({ _id: created.id })).status, 'released')
    const partial = await createKeywordAnalysis(a, config, { ...input, seed: 'đã lấy nguồn', client_request_id: randomUUID() })
    await collection(a, 'keyword_analyses').updateOne({ _id: partial.id }, { $set: { status: 'running', result: source, lease_expires_at: new Date(0), ai_called: true } })
    await runKeywordOnce(a, config, { fetchSource: async () => { throw new Error('must not replay') } })
    const recovered = await collection(a, 'keyword_analyses').findOne({ _id: partial.id })
    assert.equal(recovered.status, 'partial'); assert.equal(recovered.result.candidates.length, 2)
  })
  await t.test('CRM protects the routes and only settings saves require password reconfirmation', async () => {
    app = await buildApp(root, config, false)
    assert.equal((await app.inject('/api/crm/keyword-analyses')).statusCode, 401)
    const user = randomUUID(), token = randomBytes(32).toString('base64url'), csrf = randomUUID()
    const proof = browserProofFixture(config.origin), binding = proof.sessionFields()
    await collection(root, 'users').insertOne({ _id: user, username: 'keyword-admin', password_hash: 'fixture-password-hash', email: 'admin@example.test', email_verified_at: new Date(), email_revision: 1 })
    await collection(root, 'sessions').insertOne({ _id: digest(token), user_id: user, csrf_token: csrf, ...binding,
      credential_version: digest('fixture-password-hash'), email_revision: 1, expires_at: new Date(Date.now() + 3_600_000) })
    async function crm(method: any, path: string, payload?: any, authorize = false) {
      const url = `/api/crm${path}`, body = payload === undefined ? '' : JSON.stringify(payload)
      const action = randomBytes(32).toString('base64url')
      if (authorize) await collection(root, 'crm_action_tokens').insertOne({ _id: digest(action), session_id: digest(token), method, target: url, body_hash: browserBodyHash(body), expires_at: new Date(Date.now() + 60000) })
      return app!.inject({ method, url, headers: { cookie: `crm_session=${token}`, 'x-csrf-token': csrf,
        'x-crm-proof': proof.proof(method, url, body), ...(body ? { 'content-type': 'application/json' } : {}), ...(authorize ? { 'x-crm-action-token': action } : {}) }, ...(body ? { payload: body } : {}) })
    }
    const settings = (await crm('GET', '/settings/keywords')).json()
    const payload = { revision: settings.revision, values: settings.values }
    assert.equal((await crm('PUT', '/settings/keywords', payload)).statusCode, 403)
    const saved = await crm('PUT', '/settings/keywords', payload, true)
    assert.equal(saved.statusCode, 200, saved.body)
    const created = await crm('POST', '/keyword-analyses', { ...input, client_request_id: randomUUID() })
    assert.equal(created.statusCode, 202, created.body)
    const canceled = await crm('POST', `/keyword-analyses/${created.json().id}/cancel`)
    assert.equal(canceled.statusCode, 200, canceled.body); assert.equal(canceled.json().status, 'canceled')
    const forged = await crm('POST', '/keyword-analyses', { ...input, client_request_id: randomUUID(), website_id: randomUUID() })
    assert.equal(forged.statusCode, 404)
    assert.equal((await crm('PUT', '/settings/keywords', { revision: 1, values: { ...settings.values, mode: 'paid' } }, true)).statusCode, 422)
    await collection(root, 'customers').updateOne({ _id: customer }, { $set: { daily_limit: 100, monthly_limit: 1000, starts_at: null, ends_at: null, max_length: 2500 } })
    const ready = await crm('POST', '/keyword-analyses', { ...input, seed: 'chọn để viết', client_request_id: randomUUID() })
    assert.equal(ready.statusCode, 202, ready.body)
    await runKeywordOnce(root, config, { fetchSource: fakeSource })
    const job = await crm('POST', '/jobs', { customer_id: customer, website_id: website, model: 'gpt-4.1', keyword: source.candidates[0].keyword,
      tone: 'Chuyên nghiệp', style: 'SEO', length: 600, use_research: false, languages: { source: 'vi', targets: [] }, locale: 'vi',
      keyword_selection: { analysis_id: ready.json().id, candidate_id: source.candidates[0].id } })
    assert.equal(job.statusCode, 202, job.body)
    const stored = await collection(root, 'jobs').findOne({ _id: job.json().job_id })
    assert.equal(stored.keyword_brief.analysis_id, ready.json().id)
    assert.equal(stored.keyword_brief.keyword, source.candidates[0].keyword)
    assert.equal(stored.keyword_brief.locale, 'vi')
  })
})
