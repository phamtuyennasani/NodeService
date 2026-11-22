import { randomUUID } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { z } from 'zod'
import { collection, transaction, type Database } from './db.js'
import { normalizeInternalUrl, siteContentIdSchema, siteContentSearchTerms, type InternalLinkCandidate, type SiteContentDocument } from './site-content.js'
import { publicAddress, validateWebhookUrl } from './worker/webhook.js'

const MAX_BYTES = 5 * 1024 * 1024
const CACHE_MS = 5 * 60 * 1000
const FETCH_MS = 15 * 1000
const LEASE_MS = 20 * 1000

/** Safe, user-visible failures; upstream URLs, bodies, and raw errors are never retained. */
export class ContentCatalogError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'ContentCatalogError' }
}

export function validateContentCatalogUrl(value: string, siteDomain: string): URL {
  const normalized = normalizeInternalUrl(value, siteDomain)
  if (!normalized) throw new ContentCatalogError('CONTENT_CATALOG_URL', 'URL danh mục phải thuộc đúng tên miền website, không có tài khoản hoặc fragment.')
  try { return validateWebhookUrl(normalized, false) }
  catch { throw new ContentCatalogError('CONTENT_CATALOG_URL', 'Danh mục cần URL HTTPS công khai thuộc website.') }
}

const plain = (max: number, required = false) => z.string().trim().max(max)
  .refine(value => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
  .refine(value => !required || value.length > 0)
const catalogItems = z.array(z.object({
  id: siteContentIdSchema, url: z.string().trim().min(1).max(2048),
  title: plain(300, true), summary: plain(1200), categories: z.array(plain(120, true)).max(10).default([]),
}).strict()).max(2000)

function validatedItems(value: unknown, siteDomain: string): InternalLinkCandidate[] {
  let input = value
  if (!Array.isArray(value)) {
    const root = z.object({ items: z.unknown(), next_cursor: z.null().optional(), total: z.number().int().nonnegative().optional() }).strict().safeParse(value)
    if (!root.success) throw new ContentCatalogError('CONTENT_CATALOG_INVALID', 'Danh mục cần JSON chứa toàn bộ items; không hỗ trợ dữ liệu phân trang.')
    input = root.data.items
    if (root.data.total != null && (!Array.isArray(input) || root.data.total !== input.length)) throw new ContentCatalogError('CONTENT_CATALOG_INVALID', 'Danh mục chưa chứa đủ toàn bộ nội dung.')
  }
  const parsed = catalogItems.safeParse(input)
  if (!parsed.success) throw new ContentCatalogError('CONTENT_CATALOG_INVALID', 'Danh mục không đúng định dạng hoặc vượt giới hạn 2.000 nội dung.')
  const ids = new Set<string>(); const urls = new Set<string>()
  return parsed.data.map(item => {
    const url = normalizeInternalUrl(item.url, siteDomain)
    if (!url) throw new ContentCatalogError('CONTENT_CATALOG_INVALID', 'URL nội dung phải thuộc đúng website, không có tài khoản hoặc fragment.')
    if (ids.has(item.id) || urls.has(url)) throw new ContentCatalogError('CONTENT_CATALOG_INVALID', 'Danh mục chứa mã nội dung hoặc URL bị trùng.')
    ids.add(item.id); urls.add(url)
    return { ...item, url, categories: [...new Set(item.categories)] }
  })
}

export interface CatalogFetchOptions {
  signal?: AbortSignal
  /** Injectable network seams for isolated tests; production always pins the checked DNS address. */
  resolve?: (hostname: string) => Promise<LookupAddress[]>
  request?: typeof httpsRequest
}

async function awaitSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop: () => void = () => {}
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
  })
  try { signal.throwIfAborted(); return await Promise.race([work, aborted]) }
  finally { signal.removeEventListener('abort', stop) }
}

/** Fetch one bounded, complete JSON snapshot. No redirects, credentials, cookies, or page crawling. */
export async function fetchContentCatalog(value: string, siteDomain: string, options: CatalogFetchOptions = {}): Promise<InternalLinkCandidate[]> {
  const url = validateContentCatalogUrl(value, siteDomain)
  const timeout = AbortSignal.timeout(FETCH_MS)
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
  try {
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    const literal = isIP(hostname)
    const addresses = literal ? [{ address: hostname, family: literal }] : await awaitSignal(
      (options.resolve ?? (host => lookup(host, { all: true })))(hostname), signal,
    ).catch(error => {
      if (signal.aborted) throw error
      throw new ContentCatalogError('CONTENT_CATALOG_DNS', 'Không phân giải được tên miền danh mục.')
    })
    const destination = addresses[0]
    if (!destination || addresses.some(item => !publicAddress(item.address))) throw new ContentCatalogError('CONTENT_CATALOG_DESTINATION', 'Địa chỉ mạng của danh mục không được phép.')
    const body = await new Promise<Buffer>((resolve, reject) => {
      const connection = (options.request ?? httpsRequest)(url, {
        method: 'GET', headers: { accept: 'application/json', 'accept-encoding': 'identity' },
        signal, agent: false, family: destination.family,
        lookup: (_hostname, _options, callback) => callback(null, destination.address, destination.family),
      }, response => {
        const fail = (code: string, message: string) => { reject(new ContentCatalogError(code, message)); response.destroy() }
        if (response.statusCode !== 200) return fail('CONTENT_CATALOG_HTTP', `Website trả HTTP ${response.statusCode ?? 502}; danh mục cần phản hồi 200 trực tiếp.`)
        const type = response.headers['content-type']
        if (typeof type !== 'string' || !/^application\/(?:json|[a-z0-9!#$&^_.+-]+\+json)(?:\s*;|\s*$)/i.test(type)) return fail('CONTENT_CATALOG_RESPONSE', 'Website cần trả Content-Type application/json.')
        const encoding = response.headers['content-encoding']
        if (encoding && encoding !== 'identity') return fail('CONTENT_CATALOG_RESPONSE', 'Danh mục cần trả JSON không nén.')
        const length = response.headers['content-length']
        if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return fail('CONTENT_CATALOG_RESPONSE', 'Danh mục vượt giới hạn 5 MiB.')
        const chunks: Buffer[] = []; let size = 0
        response.on('data', (chunk: Buffer | string) => {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          size += data.length
          if (size > MAX_BYTES) { fail('CONTENT_CATALOG_RESPONSE', 'Danh mục vượt giới hạn 5 MiB.'); return }
          chunks.push(data)
        })
        response.on('end', () => resolve(Buffer.concat(chunks)))
        response.on('error', () => reject(new ContentCatalogError('CONTENT_CATALOG_CONNECTION', 'Kết nối đến danh mục bị gián đoạn.')))
        response.on('aborted', () => reject(new ContentCatalogError('CONTENT_CATALOG_CONNECTION', 'Kết nối đến danh mục bị gián đoạn.')))
      })
      connection.on('error', () => reject(new ContentCatalogError('CONTENT_CATALOG_CONNECTION', 'Không kết nối được đến danh mục website.')))
      connection.end()
    })
    let json: unknown
    try { json = JSON.parse(body.toString('utf8')) }
    catch { throw new ContentCatalogError('CONTENT_CATALOG_RESPONSE', 'Website không trả JSON hợp lệ.') }
    return validatedItems(json, siteDomain)
  } catch (error) {
    if (options.signal?.aborted) throw new ContentCatalogError('CONTENT_CATALOG_CANCELED', 'Đã dừng kiểm tra danh mục.')
    if (timeout.aborted) throw new ContentCatalogError('CONTENT_CATALOG_TIMEOUT', 'Danh mục không phản hồi trong 15 giây.')
    if (error instanceof ContentCatalogError) throw error
    throw new ContentCatalogError('CONTENT_CATALOG_CONNECTION', 'Không kết nối được đến danh mục website.')
  }
}

export interface CatalogSyncOptions {
  force?: boolean
  signal?: AbortSignal
  expectedCustomerId?: string
  expectedUrl?: string | null
  expectedDomain?: string
  fetchCatalog?: (url: string, siteDomain: string, options: { signal?: AbortSignal }) => Promise<InternalLinkCandidate[]>
}
export interface CatalogSyncResult {
  status: 'synced' | 'cached' | 'not_configured' | 'busy'
  count: number
  synced_at: string | null
}

const dateValue = (value: unknown): number => value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN
const isoDate = (value: unknown): string | null => Number.isFinite(dateValue(value)) ? new Date(dateValue(value)).toISOString() : null

/** Replace one tenant snapshot only after complete validation, guarded by a short per-site lease. */
export async function syncSiteContentCatalog(db: Database, siteId: string, options: CatalogSyncOptions = {}): Promise<CatalogSyncResult> {
  const sites = collection(db, 'sites')
  const expected = { _id: siteId, ...(options.expectedCustomerId != null ? { customer_id: options.expectedCustomerId } : {}),
    ...(options.expectedUrl !== undefined ? { content_catalog_url: options.expectedUrl } : {}), ...(options.expectedDomain != null ? { domain: options.expectedDomain } : {}) }
  const site = await sites.findOne(expected, { maxTimeMS: 5_000 })
  if (!site) throw new ContentCatalogError('CONTENT_CATALOG_CHANGED', 'Cấu hình website đã thay đổi. Vui lòng tải lại.')
  const existing = { count: typeof site.content_catalog_count === 'number' ? site.content_catalog_count : 0, synced_at: isoDate(site.site_content_synced_at) }
  if (!site.content_catalog_url) return { status: 'not_configured', ...existing }
  validateContentCatalogUrl(site.content_catalog_url, site.domain)
  const now = new Date()
  if (!options.force && now.getTime() - dateValue(site.content_catalog_checked_at) < CACHE_MS && site.content_catalog_error) throw new ContentCatalogError('CONTENT_CATALOG_UNAVAILABLE', 'Lần kiểm tra danh mục gần nhất chưa thành công. Thử kiểm tra lại trong cấu hình website.')
  if (!options.force && !site.content_catalog_error && now.getTime() - dateValue(site.site_content_synced_at) < CACHE_MS) return { status: 'cached', ...existing }
  const scope = { _id: siteId, customer_id: site.customer_id, domain: site.domain, content_catalog_url: site.content_catalog_url }
  const token = randomUUID()
  const locked = await sites.findOneAndUpdate({ ...scope, $or: [{ content_catalog_lease_expires_at: { $exists: false } }, { content_catalog_lease_expires_at: null }, { content_catalog_lease_expires_at: { $lte: now } }] },
    { $set: { content_catalog_lease_token: token, content_catalog_lease_expires_at: new Date(now.getTime() + LEASE_MS) } }, { returnDocument: 'after', maxTimeMS: 5_000 })
  if (!locked) return { status: 'busy', ...existing }
  const owned = { ...scope, content_catalog_lease_token: token }
  try {
    options.signal?.throwIfAborted()
    const fetched = await (options.fetchCatalog ?? fetchContentCatalog)(site.content_catalog_url, site.domain, { signal: options.signal })
    const items = validatedItems(fetched, site.domain)
    options.signal?.throwIfAborted()
    const syncedAt = new Date()
    await transaction(db, async source => {
      const held = await collection(source, 'sites').updateOne({ ...owned, content_catalog_lease_expires_at: { $gt: syncedAt } }, { $inc: { relation_version: 1 } }, { session: source.session })
      if (!held.matchedCount) throw new ContentCatalogError('CONTENT_CATALOG_CHANGED', 'Cấu hình website đã thay đổi trong lúc kiểm tra. Vui lòng thử lại.')
      const tenant = { site_id: siteId, customer_id: site.customer_id }
      await collection(source, 'site_content').deleteMany(tenant, { session: source.session })
      if (items.length) {
        const documents: SiteContentDocument[] = items.map(item => ({ _id: randomUUID(), ...tenant, external_id: item.id, url: item.url, title: item.title, summary: item.summary,
          categories: item.categories ?? [], search_terms: siteContentSearchTerms([item.title, item.summary, ...(item.categories ?? [])].join(' ')), created_at: syncedAt, updated_at: syncedAt }))
        await collection(source, 'site_content').insertMany(documents, { session: source.session })
      }
      await collection(source, 'sites').updateOne(owned, { $set: { site_content_synced_at: syncedAt, content_catalog_checked_at: syncedAt, content_catalog_count: items.length, content_catalog_error: null },
        $unset: { content_catalog_lease_token: '', content_catalog_lease_expires_at: '' } }, { session: source.session })
    })
    return { status: 'synced', count: items.length, synced_at: syncedAt.toISOString() }
  } catch (error) {
    const safe = error instanceof ContentCatalogError ? error : options.signal?.aborted
      ? new ContentCatalogError('CONTENT_CATALOG_CANCELED', 'Đã dừng kiểm tra danh mục.')
      : new ContentCatalogError('CONTENT_CATALOG_STORAGE', 'Không thể cập nhật danh mục. Dữ liệu trước đó được giữ lại.')
    await sites.updateOne(owned, { $set: { content_catalog_checked_at: new Date(), content_catalog_error: safe.message }, $unset: { content_catalog_lease_token: '', content_catalog_lease_expires_at: '' } }, { maxTimeMS: 5_000 }).catch(() => {})
    throw safe
  } finally {
    await sites.updateOne(owned, { $unset: { content_catalog_lease_token: '', content_catalog_lease_expires_at: '' } }, { maxTimeMS: 5_000 }).catch(() => {})
  }
}
