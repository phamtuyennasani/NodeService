export interface ResearchSource {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

export interface ResearchContext {
  query: string
  sources: ResearchSource[]
  researchedAt: string
}

export interface ResearchConfig {
  enabled: boolean
  timeoutMs: number
  maxResults: number
  provider: 'duckduckgo' | 'tavily'
  endpoint?: string
  apiKey?: string
}

type Fetcher = typeof fetch

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, limit)
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, ' ')
    .trim()
}

function sourceUrl(value: string): string | null {
  let candidate = value
  try {
    if (candidate.startsWith('//')) candidate = 'https:' + candidate
    const parsed = new URL(candidate)
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname === '/l/') {
      const destination = parsed.searchParams.get('uddg')
      if (destination) candidate = destination
    }
    const url = new URL(candidate)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

function parseDuckDuckGo(html: string, maxResults: number): ResearchSource[] {
  const results: ResearchSource[] = []
  const pattern = /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while (results.length < maxResults && (match = pattern.exec(html))) {
    const url = sourceUrl(decodeHtml(match[1]))
    const title = decodeHtml(match[2])
    if (!url || !title) continue
    const end = Math.min(html.length, pattern.lastIndex + 2_000)
    const block = html.slice(pattern.lastIndex, end)
    const snippetMatch = /class=["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(block)
    const snippet = decodeHtml(snippetMatch?.[1] ?? '')
    if (!snippet) continue
    if (results.some(item => item.url === url)) continue
    results.push({ title: title.slice(0, 300), url, snippet: snippet.slice(0, 800) })
  }
  return results
}

async function tavily(query: string, config: ResearchConfig, fetcher: Fetcher): Promise<ResearchSource[]> {
  if (!config.apiKey) return []
  const endpoint = config.endpoint || 'https://api.tavily.com/search'
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: config.apiKey, query, topic: 'general', search_depth: 'advanced', max_results: config.maxResults, include_answer: false, include_raw_content: false }),
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: 'error',
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return []
  }
  const payload = object(await response.json())
  const rows = Array.isArray(payload.results) ? payload.results : []
  return rows.slice(0, config.maxResults).flatMap(value => {
    const row = object(value)
    const url = typeof row.url === 'string' ? sourceUrl(row.url) : null
    const title = text(row.title, 300)
    const snippet = text(row.content ?? row.snippet, 800)
    if (!url || !title || !snippet) return []
    const publishedAt = text(row.published_date, 80)
    return [{ title, url, snippet, ...(publishedAt ? { publishedAt } : {}) }]
  })
}

async function duckduckgo(query: string, config: ResearchConfig, fetcher: Fetcher): Promise<ResearchSource[]> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=vn-vi`
  const response = await fetcher(endpoint, {
    method: 'GET',
    headers: { accept: 'text/html', 'user-agent': 'node-content-crm research/1.0' },
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: 'error',
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return []
  }
  return parseDuckDuckGo(await response.text(), config.maxResults)
}

/**
 * Search for current public information before writing an article. Research is
 * deliberately best-effort so a temporary search outage cannot lose a queued
 * article. The writing prompt receives no sources when the search fails.
 */
export async function researchTopic(keyword: string, config: ResearchConfig, fetcher: Fetcher = fetch): Promise<ResearchContext | null> {
  const query = keyword.trim().slice(0, 500)
  if (!config.enabled || !query) return null
  try {
    const sources = config.provider === 'tavily'
      ? await tavily(query, config, fetcher)
      : await duckduckgo(query, config, fetcher)
    if (!sources.length) return null
    return { query, sources, researchedAt: new Date().toISOString() }
  } catch {
    return null
  }
}
