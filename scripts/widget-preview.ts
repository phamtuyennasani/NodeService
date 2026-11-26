import { randomBytes, timingSafeEqual } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { z } from 'zod'
import { listModelsForCustomer } from '../src/api/catalog.js'
import { ApiError, idSchema, installErrorHandler, notFound } from '../src/api/errors.js'
import { createJob, writingFields, type Site } from '../src/api/public.js'
import { loadConfig } from '../src/config.js'
import { assertEncryptionContext } from '../src/encryption-context.js'
import { assertTransactionSupport, close, collection, connect } from '../src/db.js'
import { normalizeArticleFields } from '../src/worker/provider.js'

// This is a local customer-website adapter, not a separate writing pipeline.
// Keep the CRM API and its existing workers running with `npm run dev`.
const config = loadConfig()
const port = z.coerce.number().int().min(1).max(65_535).parse(process.env.WIDGET_PREVIEW_PORT ?? 3220)
const db = connect(config.mongodbUri, config.mongodbDatabase, config.poolSize)
const app = Fastify({ bodyLimit: 16_384 })
const widgetPath = fileURLToPath(new URL('../dist/widget/v1/ai-writer.js', import.meta.url))
const csrfToken = randomBytes(32).toString('base64url')
const allowedHosts = new Set(['127.0.0.1', 'localhost'].map(host => `${host}${port === 80 ? '' : `:${port}`}`))
const writingSchema = writingFields.omit({ provider: true, base_url: true, api_key: true, keyAI: true }).strict()
const idempotencySchema = z.string().min(1).max(160).regex(/^[\x21-\x7E]+$/)

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

const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)

function editorPage(site: PreviewSite, customer: PreviewCustomer, defaultModel?: string) {
  const defaultLength = Math.max(600, Math.min(1_500, customer.max_length ?? 1_500))
  const defaults = JSON.stringify({ length: defaultLength, use_research: true, ...(defaultModel ? { model: defaultModel } : {}) }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${csrfToken}">
  <title>Widget viết bài AI · Kết nối CRM</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f7fa; color: #162438; font-family: Inter, system-ui, sans-serif; }
    main { max-width: 960px; margin: 40px auto; padding: 0 24px 48px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 22px; }
    h1 { margin: 0 0 7px; font-size: 25px; letter-spacing: -.7px; }
    header p, .note { font-size: 13px; line-height: 1.6; margin: 0; }
    header p { color: #6d7b8e; }
    .badge { display: inline-block; margin-bottom: 12px; color: #2455d6; font-size: 11px; font-weight: 700; letter-spacing: 1px; }
    .note { padding: 12px 16px; border: 1px solid #cbdafa; background: #edf3ff; color: #284d9c; border-radius: 9px; margin-bottom: 20px; }
    form { padding: 25px; border: 1px solid #dbe3ec; border-radius: 12px; background: white; display: grid; gap: 18px; }
    label { display: grid; gap: 8px; font-size: 13px; font-weight: 600; }
    input, textarea { width: 100%; padding: 11px 12px; border: 1px solid #c9d5e3; border-radius: 8px; color: #162438; font: 14px/1.6 Inter, system-ui, sans-serif; background: #fff; }
    textarea { resize: vertical; }
    input:focus, textarea:focus { outline: 2px solid #8ea9ff; outline-offset: 1px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    #applied { color: #23734b; font-size: 13px; line-height: 1.6; margin-top: 14px; }
    @media(max-width:600px) { main { margin-top: 22px; } header { align-items: flex-start; flex-direction: column; } .row { grid-template-columns: 1fr; } form { padding: 18px; } }
  </style>
</head>
<body>
  <main>
    <span class="badge">NODESERVICE / WIDGET KẾT NỐI CRM</span>
    <header><div><h1>Biên tập bài viết</h1><p>Khách hàng: <strong>${escapeHtml(customer.name)}</strong> · Website: ${escapeHtml(site.name)} (${escapeHtml(site.domain)})</p></div><div id="tools"></div></header>
    <p class="note">Widget đang dùng tài khoản ${escapeHtml(customer.name)} trong CRM: ${escapeHtml(customer.daily_limit ?? 0)} lượt/ngày, ${escapeHtml(customer.monthly_limit ?? 0)} lượt/tháng. “Viết ngay” gửi yêu cầu thật về CRM, dùng chung quy trình nghiên cứu, lập dàn ý, viết bài và kiểm tra SEO. Bài viết được lưu trong CRM rồi trả đầy đủ về widget; yêu cầu sử dụng quota và có thể phát sinh chi phí AI. Dịch vụ CRM và worker cần đang chạy.</p>
    <form id="article">
      <label>Tiêu đề<input name="title" placeholder="Nhập tiêu đề hoặc dùng Viết bài AI"></label>
      <label>Đường dẫn (slug)<input name="slug" placeholder="duong-dan-bai-viet"></label>
      <label>Nội dung HTML<textarea name="body" rows="16" placeholder="Bài viết được chấp nhận sẽ xuất hiện tại đây…"></textarea></label>
      <div class="row"><label>Mô tả ngắn<input name="summary"></label><label>Mô tả SEO<input name="seo_description"></label></div>
      <label>Từ khóa chính<input name="focus_keyword" placeholder="Từ khóa chính của yêu cầu viết"></label>
      <label>Từ khóa liên quan<input name="keywords" placeholder="Từ khóa, phân cách bằng dấu phẩy"></label>
    </form>
    <p id="applied" role="status"></p>
  </main>
  <script src="/widget/v1/ai-writer.js"></script>
  <script>
    AIWriter.mount({
      mount: '#tools', form: '#article', endpoint: '/admin/ai/previews', modelsEndpoint: '/admin/ai/models', keyMode: 'service',
      defaults: ${defaults},
      fields: { Title: '[name="title"]', Content: '[name="body"]', Slug: '[name="slug"]', Desc: '[name="summary"]', Description: '[name="seo_description"]', Keywords: '[name="keywords"]', FocusKeyword: '[name="focus_keyword"]' }
    });
    document.querySelector('#article').addEventListener('submit', event => event.preventDefault());
    document.querySelector('#article').addEventListener('change', () => {
      document.querySelector('#applied').textContent = 'Nội dung đã được điền vào form website. Bài AI gốc được lưu trong CRM; các chỉnh sửa trong form này chỉ nằm trên trình duyệt.';
    });
    document.querySelector('#tools > span').shadowRoot.querySelector('.launch').click();
  </script>
</body>
</html>`
}

async function selectSite() {
  const selectedId = process.env.WIDGET_SITE_ID?.trim()
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

async function start() {
  await db.client.connect()
  await assertEncryptionContext(db, config)
  await assertTransactionSupport(db)
  try {
    await access(widgetPath)
  } catch {
    throw new Error('Chưa có bundle widget. Chạy npm run build:widget trước khi chạy npm run dev:widget.')
  }
  const selected = await selectSite()

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

  const initial = await customerContext()
  installErrorHandler(app)
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
    const host = request.headers.host?.toLowerCase()
    if (!host || !allowedHosts.has(host)) {
      throw new ApiError(403, 'invalid_preview_host', 'Widget preview chỉ nhận yêu cầu loopback tại cổng đã cấu hình.')
    }
    if (request.method === 'POST') {
      if (request.headers.origin !== `http://${host}` || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new ApiError(403, 'invalid_origin', 'Yêu cầu viết bài phải xuất phát từ trang widget preview này.')
      }
      const supplied = request.headers['x-csrf-token']
      if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(csrfToken)
        || !timingSafeEqual(Buffer.from(supplied), Buffer.from(csrfToken))) {
        throw new ApiError(403, 'invalid_csrf_token', 'Phiên widget không hợp lệ. Tải lại trang trước khi viết bài.')
      }
    }
  })

  app.get('/', async (_request, reply) => {
    const { site, customer } = await customerContext()
    const models = await listModelsForCustomer(db, config, customer)
    const defaultModel = models.find(model => model.model.endsWith('/gemini-4-argon') || model.model === 'gemini-4-argon')?.model
    return reply.type('text/html; charset=utf-8').send(editorPage(site, customer, defaultModel))
  })
  app.get('/widget/v1/ai-writer.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(await readFile(widgetPath)))
  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send())
  app.get('/admin/ai/models', async () => {
    const { customer } = await customerContext()
    return { data: await listModelsForCustomer(db, config, customer) }
  })
  app.post('/admin/ai/previews', async (request, reply) => {
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

  await app.listen({ host: '127.0.0.1', port })
  console.log(`Widget CRM preview: http://127.0.0.1:${port} · ${initial.customer.name} · ${initial.site.name}`)
  console.log('Viết bài thật qua CRM; sử dụng quota và provider hiện có. Preview không tự chạy worker hoặc migration.')
}

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await app.close()
  await close(db)
}
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })

try {
  await start()
} catch (error) {
  await shutdown()
  throw error
}
