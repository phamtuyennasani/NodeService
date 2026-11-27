import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { keywordInputSchema } from '../src/keywords/contracts.js'
import { fetchKeywordSuggestions, normalizeKeywordResults, readKeywordResponse, unwrapKeywordTool } from '../src/keywords/source.js'
import { validateKeywordAi, keywordTask } from '../src/keywords/worker.js'
import { keywordHash } from '../src/keywords/service.js'
import { crmRequiresActionAuthorization } from '../src/api/crm-session.js'

const input = keywordInputSchema.parse({ website_id: randomUUID(), client_request_id: randomUUID(), seed: 'máy lọc nước', country: 'VN', locale: 'vi' })
const raw = { success: true, data: [
  { string: 'máy lọc nước', volume: 0, trend: 0, cmp: 0, top_of_page_bid_low: 0, top_of_page_bid_high: 0 },
  { string: 'máy lọc nước gia đình' }, { string: '  máy  lọc nước  ' }, { string: 'maý lọc nước' },
  { string: 'từ khóa số 5', volume: 2 }, { string: 'từ khóa số 6', volume: 999, metrics_status: 'included' },
], total_count: 676 }

test('keyword source preserves zero, accents, missing data, guest coverage and source provenance', () => {
  const r = normalizeKeywordResults(raw, input, 'guest')
  assert.equal(r.candidates.length, 5)
  assert.equal(r.candidates[0].volume, 0)
  assert.equal(r.candidates[0].trend, 0)
  assert.equal(r.candidates[0].ads_competition, 0)
  assert.equal(r.candidates[1].volume, null)
  assert.equal(r.candidates.at(-1)!.volume, null, 'sixth source row cannot inherit metrics after deduplication')
  assert.equal(r.total_count, 676)
  assert.equal(r.source, 'keywordtool_guest')
  assert.equal(r.metrics_scope, 'unverified_cache')
  assert.equal(r.country, 'Vietnam')
  assert.notEqual(r.candidates[0].id, r.candidates[2].id)
  assert.equal(normalizeKeywordResults({ data: [], results_may_be_incomplete: true }, input, 'guest').partial, true)
})

test('MCP parser accepts structured content and text JSON but rejects tool/RPC failures', () => {
  assert.equal(unwrapKeywordTool({ result: { structuredContent: raw } }), raw)
  assert.deepEqual(unwrapKeywordTool({ result: { content: [{ type: 'text', text: JSON.stringify(raw) }] } }), raw)
  assert.throws(() => unwrapKeywordTool({ error: { message: 'private upstream detail' } }), /từ chối/)
  assert.throws(() => unwrapKeywordTool({ result: { isError: true, content: [] } }), /chưa trả/)
  assert.throws(() => unwrapKeywordTool({ success: false, rate_limit_reached: true }), /hạn mức/)
})

test('MCP response reader handles split Unicode/SSE and stops after result without waiting for stream closure', async () => {
  const text = `: keepalive\r\n\r\nevent: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { text: 'máy lọc nước' } })}\r\n\r\n`
  const bytes = new TextEncoder().encode(text)
  let canceled = false
  const body = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])) }, cancel() { canceled = true } })
  const r = await readKeywordResponse(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
  assert.equal(r.result.text, 'máy lọc nước')
  assert.equal(canceled, true)
  await assert.rejects(readKeywordResponse(new Response('x'.repeat(1_048_577))), /vượt giới hạn/)
  await assert.rejects(readKeywordResponse(Response.json({}, { status: 429 })), /hạn mức/)
})

test('guest source performs initialization and one bounded read with no key or paid endpoint', async () => {
  const requests: any[] = []
  const fetcher = async (url: any, options: any) => {
    assert.equal(url, 'https://mcp.keywordtool.io/guest')
    assert.equal(options.redirect, 'error')
    const body = JSON.parse(options.body); requests.push(body)
    assert.ok(!options.headers.authorization)
    if (body.method === 'initialize') return Response.json({ result: { protocolVersion: '2025-03-26' } }, { headers: { 'mcp-session-id': 'synthetic-session' } })
    assert.equal(options.headers['Mcp-Session-Id'], 'synthetic-session')
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    assert.equal(body.params.name, 'keywordtool-suggestions-guest')
    assert.equal(body.params.arguments.country, 'Vietnam')
    assert.equal(body.params.arguments.language, 'Vietnamese')
    assert.equal(body.params.arguments.limit, 100)
    assert.equal(body.params.arguments.next_page, 0)
    return Response.json({ result: { structuredContent: raw } })
  }
  const r = await fetchKeywordSuggestions(input, { mode: 'guest', fetcher: fetcher as typeof fetch })
  assert.equal(r.candidates.length, 5)
  assert.equal(requests.filter(r => r.method === 'tools/call').length, 1)
})

test('paid adapter requires an explicit key, uses requested VN metrics and never falls back to Guest', async () => {
  let calls = 0
  await assert.rejects(fetchKeywordSuggestions(input, { mode: 'paid', fetcher: (() => { calls++; throw new Error() }) as typeof fetch }), /API key/)
  assert.equal(calls, 0)
  const r = await fetchKeywordSuggestions(input, { mode: 'paid', apiKey: 'synthetic-pro-key', fetcher: (async (url, options) => {
    calls++
    assert.equal(url, 'https://api.keywordtool.io/v2/search/suggestions/google')
    const body = JSON.parse(String(options!.body))
    assert.equal(body.apikey, 'synthetic-pro-key'); assert.equal(body.metrics, true)
    assert.deepEqual(body.metrics_location, [2704]); assert.deepEqual(body.metrics_language, ['vi'])
    return Response.json({ results: { 'máy lọc nước': { volume: 1200, cmp: 0.9, trend: 0.2 } } })
  }) as typeof fetch })
  assert.equal(r.metrics_scope, 'requested_market')
  assert.equal(r.candidates[0].volume, 1200)
  assert.equal(r.candidates[0].trend, 20)
})

test('AI is limited to source candidate IDs and cannot manufacture metrics or URLs', () => {
  const result = normalizeKeywordResults(raw, input, 'guest')
  const suggestion = { candidate_id: result.candidates[0].id, related_ids: [], title: 'Chọn máy lọc nước', intent: 'Tìm hiểu', angle: 'Theo nhu cầu', reason: 'Phù hợp hộ gia đình' }
  assert.equal(validateKeywordAi({ suggestions: [suggestion] }, result).length, 1)
  for (const patch of [{ candidate_id: 'invented' }, { volume: 123 }, { url: 'https://fake.test' }, { related_ids: ['invented'] }]) {
    assert.throws(() => validateKeywordAi({ suggestions: [{ ...suggestion, ...patch }] }, result))
  }
  assert.throws(() => validateKeywordAi({ suggestions: [suggestion, suggestion] }, result))
  const task = keywordTask({ input, result } as any)
  assert.ok(!task.prompt.includes('60500'))
  assert.equal(task.maxTokens, 4096)
  assert.match(task.system, /Không khẳng định/)
})

test('cache identity separates websites, markets, languages, source modes and AI settings', () => {
  const hash = keywordHash(input, 'guest')
  assert.equal(hash, keywordHash({ ...input, client_request_id: randomUUID() }, 'guest'))
  for (const patch of [{ country: 'US' }, { locale: 'ja' }, { website_id: randomUUID() }, { ai_model: 'gpt-4.1' }, { business: 'different business' }]) {
    assert.notEqual(hash, keywordHash({ ...input, ...patch } as any, 'guest'))
  }
  assert.notEqual(hash, keywordHash(input, 'paid'))
  assert.equal(crmRequiresActionAuthorization('PUT', '/api/crm/settings/keywords?workspace=test'), true)
  assert.equal(crmRequiresActionAuthorization('POST', '/api/crm/keyword-analyses'), false)
})
