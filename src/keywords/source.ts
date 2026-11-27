import { createHash } from 'node:crypto'
import { keywordLanguages, keywordMarkets, type KeywordInput, type KeywordCandidate, type KeywordSourceResult } from './contracts.js'

const guestEndpoint = 'https://mcp.keywordtool.io/guest'
const protocol = '2025-03-26'
export class KeywordSourceError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}

/** Read a bounded JSON or Streamable HTTP MCP response, including fragmented SSE. */
export async function readKeywordResponse(response: Response): Promise<any> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new KeywordSourceError(response.status === 429 ? 'source_quota' : 'source_connection',
      response.status === 429 ? 'Nguồn từ khóa đã hết hạn mức. Vui lòng thử lại sau.' : `Nguồn từ khóa chưa sẵn sàng (HTTP ${response.status}).`)
  }
  if (response.status === 202 || response.status === 204) { await response.body?.cancel(); return {} }
  const reader = response.body?.getReader()
  if (!reader) throw new KeywordSourceError('source_response', 'Nguồn từ khóa trả phản hồi rỗng.')
  let size = 0, text = ''
  const decoder = new TextDecoder()
  const sse = response.headers.get('content-type')?.includes('text/event-stream')
  const eventResult = (complete: boolean) => {
    const frames = text.replace(/\r\n/g, '\n').split('\n\n')
    if (!complete) frames.pop()
    for (const frame of frames) {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
      if (!data || data === '[DONE]') continue
      const parsed = JSON.parse(data)
      if (parsed.result !== undefined || parsed.error !== undefined) return parsed
    }
  }
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 1_048_576) throw new KeywordSourceError('source_response', 'Phản hồi từ khóa vượt giới hạn xử lý.')
      text += decoder.decode(next.value, { stream: true })
      if (sse) { const found = eventResult(false); if (found) return found }
    }
    text += decoder.decode()
    if (sse) {
      const found = eventResult(true)
      if (found) return found
      throw new Error('No MCP result')
    }
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof KeywordSourceError) throw error
    throw new KeywordSourceError('source_response', 'Không đọc được dữ liệu từ nguồn từ khóa.')
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}

export function unwrapKeywordTool(value: unknown): Record<string, any> {
  const rpc = record(value)
  if (rpc.error) throw new KeywordSourceError('source_response', 'Nguồn từ khóa từ chối yêu cầu. Kiểm tra ngôn ngữ và thị trường.')
  const result = record(rpc.result ?? rpc)
  let data = record(result.structuredContent)
  if (!Object.keys(data).length) {
    const text = Array.isArray(result.content) ? result.content.find((item: any) => item.type === 'text' && typeof item.text === 'string')?.text : undefined
    if (text) { try { data = record(JSON.parse(text)) } catch { /* handled below */ } }
  }
  if (!Object.keys(data).length && !('content' in result)) data = result
  if (result.isError || data.success === false || data.rate_limit_reached) {
    throw new KeywordSourceError(data.rate_limit_reached ? 'source_quota' : 'source_response',
      data.rate_limit_reached ? 'Nguồn từ khóa đã hết hạn mức miễn phí.' : 'Nguồn từ khóa chưa trả được kết quả. Hãy thử lại sau.')
  }
  return data
}

const numeric = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null
export function normalizeKeywordResults(raw: Record<string, any>, input: KeywordInput, mode: 'guest' | 'paid'): KeywordSourceResult {
  const sourceRows = Array.isArray(raw.data) ? raw.data : Object.entries(record(raw.results)).map(([key, row]) => ({ string: key, ...record(row) }))
  if (!Array.isArray(raw.data) && !raw.results) throw new KeywordSourceError('source_response', 'Nguồn không trả danh sách từ khóa hợp lệ.')
  const seen = new Set<string>(), candidates: KeywordCandidate[] = []
  for (const [sourceIndex, row] of sourceRows.slice(0, 1000).entries()) {
    if (typeof row?.string !== 'string') continue
    const keyword = row.string.normalize('NFC').replace(/\s+/gu, ' ').trim().slice(0, 240)
    const identity = keyword.toLocaleLowerCase(input.locale)
    if (!keyword || seen.has(identity)) continue
    seen.add(identity)
    // Guest source only documents cached metrics for its first five rows. Never infer missing metrics.
    const hasMetrics = mode === 'paid' || sourceIndex < 5 && row.metrics_status !== 'requires Pro'
    const volume = hasMetrics && Number.isSafeInteger(row.volume) ? numeric(row.volume) : null
    const rawTrend = hasMetrics ? numeric(row.trend, mode === 'paid' ? -1 : -100, 1_000_000) : null
    // REST reports a change ratio; MCP Guest reports percentage points.
    const trend = rawTrend === null ? null : mode === 'paid' ? rawTrend * 100 : rawTrend
    const ads_competition = hasMetrics ? numeric(row.cmp, 0, 1) : null
    const bid_low = hasMetrics ? numeric(row.top_of_page_bid_low) : null
    const bid_high = hasMetrics ? numeric(row.top_of_page_bid_high) : null
    candidates.push({ id: createHash('sha256').update(identity).digest('hex').slice(0, 24), keyword,
      source_rank: candidates.length + 1, volume, trend, ads_competition, bid_low, bid_high,
      metrics_status: [volume, trend, ads_competition, bid_low, bid_high].some(v => v !== null) ? 'available' : 'unavailable' })
    if (candidates.length >= 100) break
  }
  return {
    candidates, total_count: numeric(raw.total_count) ?? sourceRows.length,
    partial: raw.data_quality === 'partial' || raw.results_may_be_incomplete === true || raw.notice?.code === 10,
    source: mode === 'guest' ? 'keywordtool_guest' : 'keywordtool_api', fetched_at: new Date().toISOString(),
    country: keywordMarkets[input.country].country, language: keywordLanguages[input.locale].name,
    // Guest does not accept metrics_location or report the historical metrics market/period.
    metrics_scope: mode === 'guest' ? 'unverified_cache' : 'requested_market',
  }
}

export async function fetchKeywordSuggestions(input: KeywordInput, options: {
  mode: 'guest' | 'paid'; apiKey?: string; signal?: AbortSignal; fetcher?: typeof fetch
}): Promise<KeywordSourceResult> {
  const fetcher = options.fetcher ?? fetch
  const signal = AbortSignal.any([AbortSignal.timeout(45_000), ...(options.signal ? [options.signal] : [])])
  const send = async (url: string, body: unknown, headers: Record<string, string>) => fetcher(url, {
    method: 'POST', body: JSON.stringify(body), headers, redirect: 'error', signal,
  })
  try {
    if (options.mode === 'paid') {
      if (!options.apiKey) throw new KeywordSourceError('source_configuration', 'Chưa cấu hình API key Keyword Tool Pro.')
      const response = await send('https://api.keywordtool.io/v2/search/suggestions/google', {
        apikey: options.apiKey, keyword: input.seed, country: input.country, language: input.locale,
        type: input.type, metrics: true, metrics_location: [keywordMarkets[input.country].location],
        metrics_language: [input.locale], metrics_network: 'googlesearch', metrics_currency: 'USD', output: 'json',
      }, { 'content-type': 'application/json', accept: 'application/json' })
      return normalizeKeywordResults(unwrapKeywordTool(await readKeywordResponse(response)), input, 'paid')
    }
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocol }
    const initialized = await send(guestEndpoint, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'crm-keyword-discovery', version: '1.0.0' },
    } }, headers)
    const session = initialized.headers.get('mcp-session-id')
    const hello = await readKeywordResponse(initialized)
    if (hello.error || !hello.result?.protocolVersion) throw new KeywordSourceError('source_connection', 'Không khởi tạo được kết nối Keyword Tool Guest.')
    if (session) headers['Mcp-Session-Id'] = session
    headers['MCP-Protocol-Version'] = hello.result.protocolVersion
    await readKeywordResponse(await send(guestEndpoint, { jsonrpc: '2.0', method: 'notifications/initialized' }, headers))
    const raw = await readKeywordResponse(await send(guestEndpoint, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'keywordtool-suggestions-guest', arguments: { keyword: input.seed, platform: 'google',
        country: keywordMarkets[input.country].country, language: keywordLanguages[input.locale].source,
        type: input.type, limit: 100, next_page: 0 },
    } }, headers))
    return normalizeKeywordResults(unwrapKeywordTool(raw), input, 'guest')
  } catch (error) {
    if (error instanceof KeywordSourceError) throw error
    throw new KeywordSourceError('source_connection', 'Kết nối Keyword Tool gián đoạn hoặc hết thời gian chờ. Chưa có kết quả để hiển thị.')
  }
}
