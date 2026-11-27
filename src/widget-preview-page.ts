const escapeHtml = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]!)

export const previewLanguages = { source: 'vi', targets: ['en'] }
export const previewLocales = [previewLanguages.source, ...previewLanguages.targets]

function articleFields(locale: string) {
  return `<section id="article-${locale}" class="article-panel" data-article-locale="${locale}" role="tabpanel" aria-labelledby="article-tab-${locale}"${locale === previewLanguages.source ? '' : ' hidden'}>
      <label class="form-field">Tiêu đề<input name="title[${locale}]" lang="${locale}" placeholder="Nhập tiêu đề hoặc dùng Viết bài AI"></label>
      <label class="form-field">Đường dẫn (slug)<input name="slug[${locale}]" lang="${locale}" placeholder="duong-dan-bai-viet"></label>
      <div class="form-field editor-field">
        <label for="article-content-${locale}" id="content-label-${locale}">Nội dung HTML</label>
        <textarea id="article-content-${locale}" name="body[${locale}]" data-editor-locale="${locale}" lang="${locale}" rows="16" aria-describedby="editor-status-${locale}" placeholder="Bài viết được chấp nhận sẽ xuất hiện tại đây…"></textarea>
        <p id="editor-status-${locale}" class="editor-status" role="status">Đang khởi tạo trình soạn thảo…</p>
      </div>
      <div class="row"><label class="form-field">Mô tả ngắn<input name="summary[${locale}]" lang="${locale}"></label><label class="form-field">Mô tả SEO<input name="seo_description[${locale}]" lang="${locale}"></label></div>
      <label class="form-field">Từ khóa chính<input name="focus_keyword[${locale}]" lang="${locale}" placeholder="Từ khóa chính của yêu cầu viết"></label>
      <label class="form-field">Từ khóa liên quan<input name="keywords[${locale}]" lang="${locale}" placeholder="Từ khóa, phân cách bằng dấu phẩy"></label>
    </section>`
}

export function widgetPreviewPage({ site, customer, csrfToken, defaultModel }: {
  site: { name: string; domain: string }
  customer: { name: string; daily_limit: number | null; monthly_limit: number | null; max_length: number | null }
  csrfToken: string
  defaultModel?: string
}) {
  const defaultLength = Math.max(600, Math.min(1_500, customer.max_length ?? 1_500))
  const defaults = JSON.stringify({ length: defaultLength, use_research: true, ...(defaultModel ? { model: defaultModel } : {}) }).replace(/</g, '\\u003c')
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${csrfToken}">
  <title>Widget viết bài AI · Kết nối CRM</title>
  <link rel="stylesheet" href="/preview/editor.css">
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
    .language-hint { margin: 0; color: #53657d; font-size: 13px; line-height: 1.7; }
    .article-tabs { display: flex; flex-wrap: wrap; gap: 8px; padding-bottom: 12px; border-bottom: 1px solid #dbe3ec; }
    .article-tabs button { padding: 10px 16px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: #53657d; font: 600 13px/1.5 Inter, system-ui, sans-serif; cursor: pointer; }
    .article-tabs button[aria-selected="true"] { color: #2455d6; background: #edf3ff; border-color: #cbdafa; }
    .article-tabs button:focus-visible { outline: 2px solid #8ea9ff; outline-offset: 3px; }
    .article-panel { display: grid; gap: 18px; min-width: 0; }
    .article-panel[hidden] { display: none; }
    .form-field { display: grid; gap: 8px; font-size: 13px; font-weight: 600; }
    .form-field > input, .form-field > textarea { width: 100%; padding: 11px 12px; border: 1px solid #c9d5e3; border-radius: 8px; color: #162438; font: 14px/1.6 Inter, system-ui, sans-serif; background: #fff; }
    .form-field > textarea { resize: vertical; }
    .form-field > input:focus, .form-field > textarea:focus { outline: 2px solid #8ea9ff; outline-offset: 1px; }
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
      <p class="language-hint">Bản gốc <strong>tiếng Việt</strong>. Viết xong, bấm <strong>Dịch sang các ngôn ngữ khác</strong> để tạo bản <strong>tiếng Anh</strong>, rồi <strong>Áp dụng</strong> để điền cả hai tab.</p>
      <div class="article-tabs" role="tablist" aria-label="Ngôn ngữ bài viết">
        <button id="article-tab-vi" type="button" role="tab" aria-selected="true" aria-controls="article-vi" data-article-tab="vi">Tiếng Việt</button>
        <button id="article-tab-en" type="button" role="tab" aria-selected="false" aria-controls="article-en" data-article-tab="en" tabindex="-1">English</button>
      </div>
      ${previewLocales.map(articleFields).join('\n')}
    </form>
    <p id="applied" role="status"></p>
  </main>
  <script id="widget-defaults" type="application/json">${defaults}</script>
  <script src="/widget/v1/ai-writer.js"></script>
  <script src="/preview/editor.js" defer></script>
</body>
</html>`
}
