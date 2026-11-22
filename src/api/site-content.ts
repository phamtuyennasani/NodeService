import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { collection, transaction, type Database, type TransactionContext } from '../db.js'
import { normalizeInternalUrl, siteContentIdSchema, siteContentSearchTerms, type SiteContentDocument } from '../site-content.js'
import { authenticateSite, type Site } from './public.js'
import { ApiError } from './errors.js'

const externalId = siteContentIdSchema
const plain = (max: number, required = false) => z.string().trim().max(max)
  .refine(value => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), 'Chỉ nhận văn bản thuần, không có HTML hoặc ký tự điều khiển.')
  .refine(value => !required || value.length > 0, 'Cần có nội dung.')
const itemSchema = z.object({
  id: externalId,
  url: z.string().trim().min(1).max(2048),
  title: plain(300, true),
  summary: plain(1200),
  categories: z.array(plain(120, true)).max(10).default([]),
}).strict()
const batchSchema = z.object({ items: z.array(itemSchema).min(1).max(100) }).strict()
const listSchema = z.object({ cursor: externalId.optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).strict()

async function lockSite(source: TransactionContext, site: Site) {
  const filter = { _id: site.id, customer_id: site.customer_id, token_hash: site.token_hash }
  const result = await collection(source, 'sites').updateOne(filter, { $inc: { relation_version: 1 } }, { session: source.session })
  if (!result.matchedCount) throw new ApiError(401, 'invalid_site_token', 'Token hoặc chủ sở hữu website đã thay đổi. Vui lòng kết nối lại.')
  const current = await collection(source, 'sites').findOne(filter, { session: source.session })
  if (!current) throw new ApiError(401, 'invalid_site_token', 'Website không còn khả dụng.')
  return current
}

function view(row: SiteContentDocument) {
  return { id: row.external_id, url: row.url, title: row.title, summary: row.summary, categories: row.categories, updated_at: row.updated_at }
}

/** Laravel publishes metadata here; this endpoint never crawls supplied URLs. */
export function registerSiteContent(app: FastifyInstance, db: Database) {
  app.post('/v1/site-content', { bodyLimit: 800_000 }, async request => {
    const site = await authenticateSite(db, request)
    const { items } = batchSchema.parse(request.body)
    const ids = new Set<string>()
    for (const item of items) {
      if (ids.has(item.id)) throw new ApiError(400, 'duplicate_content_id', 'Mỗi mã nội dung chỉ được xuất hiện một lần trong lô.')
      ids.add(item.id)
    }
    return transaction(db, async source => {
      const current = await lockSite(source, site)
      if (current.content_catalog_url) throw new ApiError(409, 'content_catalog_pull_configured', 'Website đang đọc danh mục từ URL đã cấu hình. Hãy cập nhật dữ liệu tại Laravel rồi kiểm tra lại danh mục.')
      const scope = { site_id: site.id, customer_id: site.customer_id }
      const urls = new Set<string>()
      // Validate the complete batch before its first catalog write.
      const normalized = items.map(item => {
        const url = normalizeInternalUrl(item.url, current.domain)
        if (!url) throw new ApiError(400, 'invalid_internal_url', 'URL nội dung phải là HTTP(S) tuyệt đối thuộc đúng website, không có tài khoản hoặc fragment.')
        if (urls.has(url)) throw new ApiError(400, 'duplicate_content_url', 'Mỗi URL chỉ được xuất hiện một lần trong lô.')
        urls.add(url)
        return { ...item, url, categories: [...new Set(item.categories)] }
      })
      for (const item of normalized) {
        const collision = await collection<SiteContentDocument>(source, 'site_content').findOne({ ...scope, url: item.url, external_id: { $ne: item.id } }, { session: source.session, projection: { _id: 1 } })
        if (collision) throw new ApiError(409, 'duplicate_content_url', 'URL này đã thuộc một mã nội dung khác trên website.')
      }
      const now = new Date()
      for (const item of normalized) {
        await collection<SiteContentDocument>(source, 'site_content').updateOne({ ...scope, external_id: item.id }, {
          $set: { url: item.url, title: item.title, summary: item.summary, categories: item.categories, search_terms: siteContentSearchTerms([item.title, item.summary, ...item.categories].join(' ')), updated_at: now },
          $setOnInsert: { _id: randomUUID(), ...scope, external_id: item.id, created_at: now },
        }, { upsert: true, session: source.session })
      }
      await collection(source, 'sites').updateOne({ _id: site.id, customer_id: site.customer_id }, { $set: { site_content_synced_at: now } }, { session: source.session })
      return { upserted: normalized.length, synced_at: now.toISOString() }
    })
  })

  app.get('/v1/site-content', async request => {
    const site = await authenticateSite(db, request)
    const { cursor, limit } = listSchema.parse(request.query)
    return transaction(db, async source => {
      const current = await lockSite(source, site)
      const rows = await collection<SiteContentDocument>(source, 'site_content').find({ site_id: site.id, customer_id: site.customer_id, ...(cursor ? { external_id: { $gt: cursor } } : {}) }, {
        session: source.session, projection: { external_id: 1, url: 1, title: 1, summary: 1, categories: 1, updated_at: 1 }, maxTimeMS: 5_000,
      }).sort({ external_id: 1 }).limit(limit + 1).toArray()
      const total = await collection(source, 'site_content').countDocuments({ site_id: site.id, customer_id: site.customer_id }, { session: source.session, maxTimeMS: 5_000 })
      return { data: rows.slice(0, limit).map(view), next_cursor: rows.length > limit ? rows[limit - 1]!.external_id : null, total, synced_at: current.site_content_synced_at ?? null }
    })
  })

  app.delete('/v1/site-content/:id', async (request, reply) => {
    const site = await authenticateSite(db, request)
    const { id } = z.object({ id: externalId }).parse(request.params)
    await transaction(db, async source => {
      const current = await lockSite(source, site)
      if (current.content_catalog_url) throw new ApiError(409, 'content_catalog_pull_configured', 'Website đang đọc danh mục từ URL đã cấu hình. Hãy cập nhật dữ liệu tại Laravel rồi kiểm tra lại danh mục.')
      await collection(source, 'site_content').deleteOne({ site_id: site.id, customer_id: site.customer_id, external_id: id }, { session: source.session })
      await collection(source, 'sites').updateOne({ _id: site.id, customer_id: site.customer_id }, { $set: { site_content_synced_at: new Date() } }, { session: source.session })
    })
    return reply.code(204).send()
  })
}
