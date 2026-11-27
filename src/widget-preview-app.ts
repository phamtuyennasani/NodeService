import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import Fastify from 'fastify'
import { z } from 'zod'
import { listModelsForCustomer } from './api/catalog.js'
import { ApiError, idSchema, installErrorHandler, notFound } from './api/errors.js'
import { createJob, writingFields, type Site } from './api/public.js'
import type { Config } from './config.js'
import { collection, type Database } from './db.js'
import { digest } from './security.js'
import { normalizeArticleFields } from './worker/provider.js'
import { widgetPreviewPage } from './widget-preview-page.js'
import { WIDGET_REQUEST_BODY_LIMIT } from './widget-limits.js'

const writingSchema = writingFields.omit({ provider: true, base_url: true, api_key: true, keyAI: true }).strict()
const idempotencySchema = z.string().min(1).max(160).regex(/^[\x21-\x7E]+$/)

export function validPreviewAuthorization(header: string | undefined, expected: string) {
  if (!header || header.length > 1024 || !header.startsWith('Basic ') || !/^[a-f0-9]{64}$/.test(expected)) return false
  const supplied = digest(Buffer.from(header.slice(6), 'base64').toString('utf8'))
  return timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(expected, 'hex'))
}

interface PreviewCustomer {
  _id: string
  name: string
  key_mode: 'own' | 'service'
  allowed_models: string[]
  daily_limit: number | null
  monthly_limit: number | null
  max_length: number | null
}

interface PreviewSite {
  _id: string
  customer_id: string
  name: string
  domain: string
  token_hash?: string | null
  proof_required?: boolean
  signing_public_key?: string | null
  webhook_url?: string | null
  webhook_secret?: string | null
}

async function selectSite(db: Database, selectedId?: string) {
  if (selectedId) {
    const id = idSchema.parse(selectedId)
    const site = await collection<PreviewSite>(db, 'sites').findOne({ _id: id })
    if (!site) throw new Error('WIDGET_SITE_ID không khớp website nào trong CRM.')
    return site as PreviewSite
  }
  const sites = await collection<PreviewSite>(db, 'sites').find({}).limit(2).toArray() as PreviewSite[]
  if (sites.length !== 1) {
    throw new Error(sites.length
      ? 'CRM có nhiều website. Đặt WIDGET_SITE_ID để chọn đúng website khách hàng.'
      : 'CRM chưa có website. Tạo website trong CRM trước khi chạy widget preview.')
  }
  return sites[0]
}

export async function buildWidgetPreviewApp(db: Database, config: Config, options: {
  origin: string; csrfToken: string; siteId?: string; passwordHash?: string
}) {
  const origin = new URL(options.origin)
  if (origin.origin !== options.origin || !['http:', 'https:'].includes(origin.protocol)) throw new Error('Widget origin must be an HTTP(S) origin.')
  if (config.production && (origin.protocol !== 'https:' || !options.passwordHash)) throw new Error('Public widget demo requires HTTPS and demo authentication.')
  const app = Fastify({ bodyLimit: 16_384, logger: false })
  const csrfToken = options.csrfToken
  if (csrfToken.length < 32) throw new Error('Widget demo requires a shared CSRF token of at least 32 characters.')
  const allowedHosts = new Set([origin.host])
  if (!config.production && ['localhost', '127.0.0.1'].includes(origin.hostname)) {
    allowedHosts.add(`${origin.hostname === 'localhost' ? '127.0.0.1' : 'localhost'}${origin.port ? ':' + origin.port : ''}`)
  }
  const widgetPath = resolve('dist/widget/v1/ai-writer.js')
  const editorPath = resolve('dist/widget-preview/editor.js')
  const editorStylePath = resolve('dist/widget-preview/editor.css')
  const selected = await selectSite(db, options.siteId)

  async function customerContext() {
    const site = await collection<PreviewSite>(db, 'sites').findOne({ _id: selected._id, customer_id: selected.customer_id }) as PreviewSite | null
    if (!site) throw new ApiError(404, 'preview_site_unavailable', 'Website hoặc chủ sở hữu đã thay đổi trong CRM. Khởi động lại widget preview để chọn lại.')
    const customer = await collection<PreviewCustomer>(db, 'customers').findOne({ _id: site.customer_id }) as PreviewCustomer | null
    if (!customer) throw notFound()
    if (customer.key_mode !== 'service') {
      throw new ApiError(422, 'preview_service_customer_required', 'Widget preview này cần khách hàng dùng quota dịch vụ. Chọn website của khách hàng service bằng WIDGET_SITE_ID.')
    }
    return { site, customer }
  }

  await customerContext()
  installErrorHandler(app)
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    const host = request.headers.host?.toLowerCase()
    if (!host || !allowedHosts.has(host)) {
      throw new ApiError(403, 'invalid_preview_host', 'Tên miền không khớp cấu hình demo widget.')
    }
    if (options.passwordHash && request.url.split('?', 1)[0] !== '/health' && !validPreviewAuthorization(request.headers.authorization, options.passwordHash)) {
      return reply.header('WWW-Authenticate', 'Basic realm="Widget demo", charset="UTF-8"').code(401).send({ error: { code: 'demo_auth_required', message: 'Đăng nhập demo để tiếp tục.' } })
    }
    if (request.method === 'POST') {
      const expectedOrigin = config.production ? options.origin : `${origin.protocol}//${host}`
      if (request.headers.origin !== expectedOrigin || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new ApiError(403, 'invalid_origin', 'Yêu cầu viết bài phải xuất phát từ trang widget preview này.')
      }
      const supplied = request.headers['x-csrf-token']
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(csrfToken)
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken))) {
        throw new ApiError(403, 'invalid_csrf_token', 'Phiên widget không hợp lệ. Tải lại trang trước khi viết bài.')
      }
    }
  })

  app.get('/health', async () => { await db.db.command({ ping: 1 }); return { status: 'ok' } })
  app.get('/', async (_request, reply) => {
    const { site, customer } = await customerContext()
    const models = await listModelsForCustomer(db, config, customer)
    const defaultModel = models.find(model => model.model.endsWith('/gemini-4-argon') || model.model === 'gemini-4-argon')?.model
    return reply.type('text/html; charset=utf-8').send(widgetPreviewPage({ site, customer, csrfToken, defaultModel }))
  })
  app.get('/widget/v1/ai-writer.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(await readFile(widgetPath)))
  app.get('/preview/editor.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(await readFile(editorPath)))
  app.get('/preview/editor.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(await readFile(editorStylePath)))
  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send())
  app.get('/admin/ai/models', async () => {
    const { customer } = await customerContext()
    return { data: await listModelsForCustomer(db, config, customer) }
  })
  app.post('/admin/ai/previews', { bodyLimit: WIDGET_REQUEST_BODY_LIMIT }, async (request, reply) => {
    const writing = writingSchema.parse(request.body)
    const requestId = idempotencySchema.parse(request.headers['idempotency-key'])
    const { site } = await customerContext()
    const crmSite: Site = {
      id: site._id, customer_id: site.customer_id, token_hash: site.token_hash ?? null,
      proof_required: site.proof_required, signing_public_key: site.signing_public_key,
      webhook_url: site.webhook_url ?? null, webhook_secret: site.webhook_secret ?? null,
    }
    return reply.code(202).send(await createJob(db, config, crmSite, requestId, writing, 'preview', undefined))
  })
  app.get('/admin/ai/previews/:job_id', async request => {
    const { job_id } = z.object({ job_id: idSchema }).strict().parse(request.params)
    const { site } = await customerContext()
    const job = await collection(db, 'jobs').findOne({ _id: job_id, site_id: site._id, customer_id: site.customer_id }, {
      projection: { _id: 1, status: 1, writing_stage: 1, keyword: 1, length: 1, seo_report: 1, seo_repair_status: 1, error_code: 1, error_message: 1, result: 1 },
    })
    if (!job) throw notFound()
    return {
      job_id: job._id, status: job.status, writing_stage: job.writing_stage ?? null,
      keyword: job.keyword, length: job.length,
      seo_report: job.status === 'ready' ? job.seo_report ?? null : null,
      seo_repair_status: job.status === 'ready' ? job.seo_repair_status ?? null : null,
      error_code: job.error_code ?? null, error_message: job.error_message ?? null,
      ...(job.status === 'ready' ? { result: Array.isArray(job.result) ? job.result.map(normalizeArticleFields) : job.result } : {}),
    }
  })

  return app
}
