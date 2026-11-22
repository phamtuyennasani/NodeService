import { collection, type Database } from './db.js'
import { z } from 'zod'

export const siteContentIdSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)
export const excludedContentIdsSchema = z.array(siteContentIdSchema).max(20)

/** Published page metadata supplied by the website; never treated as instructions. */
export interface InternalLinkCandidate {
  id: string
  url: string
  title: string
  summary: string
  categories?: string[]
}

export interface SiteContentDocument {
  _id: string
  site_id: string
  customer_id: string
  external_id: string
  url: string
  title: string
  summary: string
  categories: string[]
  search_terms: string[]
  created_at: Date
  updated_at: Date
}

const hostname = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')

/** Accept supplied absolute URLs only; never manufacture a URL from a slug. */
export function normalizeInternalUrl(value: string, siteDomain: string | null | undefined): string | null {
  if (!siteDomain || typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f\\#]/.test(value)) return null
  if (!/^https?:\/\//i.test(value)) return null
  try {
    const site = new URL(siteDomain.includes('://') ? siteDomain : 'https://' + siteDomain)
    const url = new URL(value)
    if (!['http:', 'https:'].includes(site.protocol) || site.username || site.password || !site.hostname) return null
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) return null
    if (hostname(url) !== hostname(site) || url.port !== site.port) return null
    return url.toString()
  } catch { return null }
}

export function foldSearchText(value: string): string {
  return value.normalize('NFD').toLowerCase().replace(/\p{Mark}/gu, '').replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}

const stopwords = new Set(('a an and are as at be by for from how in is it of on or that the this to was what when where which who why with ' +
  'ai bai ban bang bao bi bo cac cai can cho co cua cung da dang day de den di do du duoc gi hay hon khi khong la lai lam len ma moi mot nay nen nhu nhung noi o phai qua ra rat se su tai theo thi thoi tren trong tu va van ve voi').split(' '))

export function siteContentSearchTerms(value: string): string[] {
  return [...new Set(foldSearchText(value).split(' ').filter(term => term.length >= 2 && !stopwords.has(term)))].slice(0, 160)
}

type SelectionOptions = {
  siteId: string
  customerId: string
  siteDomain: string | null
  keyword: string
  context?: string
  excludeTitles?: string[]
  excludeIds?: string[]
}

/** Conservative lexical shortlist: no AI call, crawling, or cross-site fallback. */
export function rankInternalLinkCandidates(rows: readonly InternalLinkCandidate[], options: Omit<SelectionOptions, 'siteId' | 'customerId'>): InternalLinkCandidate[] {
  const mainTerms = siteContentSearchTerms(options.keyword)
  const queryTerms = new Set([...mainTerms, ...siteContentSearchTerms(options.context ?? '')].slice(0, 24))
  if (!mainTerms.length) return []
  const phrase = foldSearchText(options.keyword)
  const excluded = new Set((options.excludeTitles ?? []).map(foldSearchText))
  const excludedIds = new Set(options.excludeIds ?? [])
  const seenUrls = new Set<string>()
  return rows.flatMap(row => {
    const url = normalizeInternalUrl(row.url, options.siteDomain)
    if (!url || excludedIds.has(row.id) || excluded.has(foldSearchText(row.title)) || seenUrls.has(url)) return []
    seenUrls.add(url)
    const title = foldSearchText(row.title)
    const categories = foldSearchText((row.categories ?? []).join(' '))
    const text = foldSearchText([row.title, row.summary, ...(row.categories ?? [])].join(' '))
    const terms = new Set(siteContentSearchTerms(text))
    const mainOverlap = mainTerms.filter(term => terms.has(term)).length
    const phraseMatch = phrase.length >= 2 && (' ' + text + ' ').includes(' ' + phrase + ' ')
    if (!phraseMatch && mainOverlap < Math.min(2, mainTerms.length)) return []
    // A single generic token is too weak unless it occurs as a whole phrase.
    if (mainTerms.length === 1 && !phraseMatch) return []
    const score = mainOverlap * 5 + [...queryTerms].filter(term => terms.has(term)).length
      + mainTerms.filter(term => (' ' + title + ' ').includes(' ' + term + ' ')).length * 3
      + mainTerms.filter(term => (' ' + categories + ' ').includes(' ' + term + ' ')).length * 2
      + (phraseMatch ? 10 : 0)
    return [{ candidate: { id: row.id, url, title: row.title, summary: row.summary, categories: row.categories ?? [] }, score }]
  }).sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id)).slice(0, 8).map(row => row.candidate)
}

export async function selectInternalLinkCandidates(db: Database, options: SelectionOptions): Promise<InternalLinkCandidate[]> {
  const terms = [...new Set([...siteContentSearchTerms(options.keyword), ...siteContentSearchTerms(options.context ?? '')])].slice(0, 24)
  if (!terms.length) return []
  const rows = await collection<SiteContentDocument>(db, 'site_content').find({
    site_id: options.siteId, customer_id: options.customerId, search_terms: { $in: terms },
    ...(options.excludeIds?.length ? { external_id: { $nin: options.excludeIds.slice(0, 20) } } : {}),
  }, { projection: { external_id: 1, url: 1, title: 1, summary: 1, categories: 1 }, maxTimeMS: 5_000 })
    .sort({ updated_at: -1, external_id: 1 }).limit(120).toArray()
  return rankInternalLinkCandidates(rows.map(row => ({ id: row.external_id, url: row.url, title: row.title, summary: row.summary, categories: row.categories })), options)
}

/** Revalidate the exact shortlist after AI work; never substitute newly eligible URLs. */
export async function refreshInternalLinkCandidates(db: Database, options: {
  siteId: string
  customerId: string
  siteDomain: string | null
  candidates: readonly InternalLinkCandidate[]
  excludeIds?: readonly string[]
  expectedCatalogUrl?: string | null
}): Promise<InternalLinkCandidate[]> {
  if (!options.candidates.length) return []
  const site = await collection(db, 'sites').findOne({ _id: options.siteId, customer_id: options.customerId }, { projection: { domain: 1, content_catalog_url: 1 }, maxTimeMS: 5_000 })
  if (!site?.domain || !options.siteDomain) return []
  if (options.expectedCatalogUrl !== undefined && (site.content_catalog_url ?? null) !== options.expectedCatalogUrl) return []
  try {
    const original = new URL(options.siteDomain.includes('://') ? options.siteDomain : 'https://' + options.siteDomain)
    const current = new URL(site.domain.includes('://') ? site.domain : 'https://' + site.domain)
    if (hostname(original) !== hostname(current) || original.port !== current.port) return []
  } catch { return [] }
  const excluded = new Set(options.excludeIds ?? [])
  const candidates = options.candidates.slice(0, 8).filter(row => !excluded.has(row.id))
  if (!candidates.length) return []
  const rows = await collection<SiteContentDocument>(db, 'site_content').find({
    site_id: options.siteId, customer_id: options.customerId, external_id: { $in: candidates.map(row => row.id) },
  }, { projection: { external_id: 1, url: 1, title: 1, summary: 1, categories: 1 }, maxTimeMS: 5_000 }).limit(8).toArray()
  return candidates.flatMap(candidate => {
    const row = rows.find(row => row.external_id === candidate.id)
    const originalUrl = normalizeInternalUrl(candidate.url, options.siteDomain)
    const currentUrl = row && normalizeInternalUrl(row.url, site.domain)
    if (!row || !originalUrl || originalUrl !== currentUrl) return []
    return [{ id: row.external_id, url: currentUrl, title: row.title, summary: row.summary, categories: row.categories }]
  })
}
