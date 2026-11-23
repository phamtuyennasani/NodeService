import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { sanitizeArticleContent } from './article-html.js'
import { sanitizeArticleStyle } from './article-styles.js'
import { visibleText } from './worker/seo.js'

export class JobPdfError extends Error {
  constructor(readonly code: 'empty' | 'busy' | 'limit' | 'unavailable', message?: string) {
    super(message ?? `PDF export ${code}`)
  }
}

export interface JobPdfInput { id: string; article: unknown; outline?: unknown }

const MAX_CONTENT = 180_000
const MAX_PAGES = 60
const MAX_BYTES = 20 * 1024 * 1024
const TIMEOUT_MS = 25_000
// A rejected request never joins an unbounded browser-launch queue.
let activeExports = 0

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!)
function text(value: unknown, max = 6_000): string {
  if (typeof value !== 'string') return ''
  if (value.length > max) throw new JobPdfError('limit')
  return value.trim()
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) return []
  if (value.length > max) throw new JobPdfError('limit')
  return value
}

/** Print on finite paper: discard extreme dimensions, retain ordinary inline formatting. */
export function sanitizePdfStyle(style: string): string {
  return sanitizeArticleStyle(style).split(';').filter(declaration => {
    const separator = declaration.indexOf(':')
    const property = declaration.slice(0, separator)
    const value = declaration.slice(separator + 1).replace(/\s*!important$/i, '')
    if (property === 'line-height' && /^\d+(?:\.\d+)?$/.test(value)) return Number(value) >= .8 && Number(value) <= 3
    if (property === 'font-size' && /^(?:small|medium|large|smaller|larger)$/i.test(value)) return true
    if (!/^(?:font-size|line-height|letter-spacing|vertical-align|width|height|min-width|max-width|margin(?:-.+)?|padding(?:-.+)?|border(?:-.+)?)$/.test(property)) return true
    return [...value.matchAll(/(\d+(?:\.\d+)?|\.\d+)(px|pt|em|rem|%)/g)].every(([, amount, unit]) => {
      const number = Number(amount)
      if (unit === '%') return number <= (property === 'font-size' ? 400 : property === 'line-height' ? 300 : 100)
      const points = number * (unit === 'px' ? .75 : unit === 'em' || unit === 'rem' ? 12 : 1)
      const max = property === 'font-size' ? 48 : property === 'line-height' ? 60
        : property === 'letter-spacing' ? 4 : /^(?:min-width|max-width|width)$/.test(property) ? 460
        : property === 'height' ? 180 : property.startsWith('border') ? 24 : 72
      return points <= max && (property !== 'font-size' || points >= 6)
    })
  }).join(';')
}

function boundRelativeFonts(html: string): string {
  // These are already-sanitized style attributes. CSS clamps the computed size
  // at every nesting level, keeping ordinary relative typography intact.
  return html.replace(/style="([^"]*)"/g, (_attribute, style: string) => `style="${style.replace(
    /(^|;)font-size:((?:\d+(?:\.\d+)?|\.\d+)(?:em|rem|%)|smaller|larger)(\s*!important)?(?=;|$)/gi,
    (_declaration, separator: string, size: string, important = '') => `${separator}font-size:clamp(6pt,${size === 'larger' ? '1.2em' : size === 'smaller' ? '0.833333em' : size},48pt)${important}`,
  )}"`)
}

function outlineHtml(value: unknown): string {
  const outline = record(value)
  const title = text(outline.title)
  const metadata = [
    ['Ý định tìm kiếm', text(outline.searchIntent)], ['Đối tượng đọc', text(outline.audience)], ['Góc tiếp cận', text(outline.angle)],
  ].filter(([, value]) => value)
  const questions = array(outline.questions, 24).map(item => text(item)).filter(Boolean)
  const sections = array(outline.sections, 32).map(value => {
    const section = record(value)
    const heading = text(section.heading)
    const purpose = text(section.purpose)
    const subheadings = array(section.subheadings, 24).map(item => text(item)).filter(Boolean)
    const evidence = array(section.evidence, 16).map(value => {
      const item = record(value)
      const fact = text(item.fact)
      const source = typeof item.sourceIndex === 'number' && Number.isSafeInteger(item.sourceIndex) && item.sourceIndex > 0 ? `Nguồn ${item.sourceIndex}: ` : ''
      return fact ? `<li>${escape(source + fact)}</li>` : ''
    }).join('')
    if (!heading && !purpose && !subheadings.length && !evidence) return ''
    const words = typeof section.estimatedWords === 'number' && Number.isSafeInteger(section.estimatedWords) && section.estimatedWords > 0
      ? `<span class="word-count">${section.estimatedWords.toLocaleString('vi-VN')} từ dự kiến</span>` : ''
    return `<li><h3>${escape(heading)}</h3>${words}${purpose ? `<p>${escape(purpose)}</p>` : ''}${subheadings.length ? `<strong>Tiêu đề phụ (H3)</strong><ul>${subheadings.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}${evidence ? `<div class="evidence"><strong>Dữ kiện tham khảo</strong><ul>${evidence}</ul></div>` : ''}</li>`
  }).filter(Boolean)
  if (!title && !metadata.length && !questions.length && !sections.length) return ''
  return `<section class="outline" aria-label="Dàn ý bài viết"><div class="section-label">Dàn ý bài viết</div>${title ? `<h1>${escape(title)}</h1>` : ''}${metadata.length ? `<dl>${metadata.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>` : ''}${questions.length ? `<h2>Câu hỏi cần giải đáp</h2><ul>${questions.map(item => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}${sections.length ? `<h2>Bố cục bài viết</h2><ol class="outline-sections">${sections.join('')}</ol>` : ''}</section>`
}

export function jobPdfFilename(id: string, slug: string): string {
  const name = slug.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/đ/gi, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100).replace(/-+$/g, '')
  const suffix = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) || 'crm'
  return `${name || 'bai-viet'}-${suffix}.pdf`
}

export function buildJobPdfHtml(input: JobPdfInput, fonts = ''): { html: string; filename: string; hasOutline: boolean } {
  const article = record(input.article)
  const rawContent = text(article.Content, MAX_CONTENT)
  const content = boundRelativeFonts(sanitizeArticleContent(rawContent, sanitizePdfStyle, true))
  // The visible-content gate also supports old articles without modern SEO metadata.
  const visible = visibleText(content).replace(/[\s\u00ad\u200b-\u200d\ufeff]/g, '')
  if (!visible) throw new JobPdfError('empty')
  const title = text(article.Title) || 'Bài viết'
  const description = text(article.Desc)
  const outline = outlineHtml(input.outline)
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>
${fonts}
@page { size: A4; margin: 18mm 17mm; }
* { box-sizing: border-box; }
html { font-size: 11pt; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #202631; font-family: 'CRM PDF', Arial, sans-serif; line-height: 1.55; overflow-wrap: anywhere; }
h1 { font-size: 22pt; line-height: 1.25; margin: 0 0 14pt; }
h2 { font-size: 16pt; line-height: 1.35; margin: 18pt 0 8pt; }
h3 { font-size: 13pt; line-height: 1.4; margin: 13pt 0 6pt; }
h4 { font-size: 11.5pt; margin: 10pt 0 5pt; }
h1,h2,h3,h4,dt { break-after: avoid; }
p { margin: 0 0 9pt; orphans: 3; widows: 3; }
ul,ol { padding-left: 22pt; margin: 6pt 0 11pt; }
li { margin-bottom: 4pt; }
li > p:last-child { margin-bottom: 0; }
a { color: #2563eb; text-decoration: underline; }
blockquote { margin: 12pt 0; padding: 6pt 12pt; border-left: 3pt solid #cbd5e1; color: #475569; }
hr { border: 0; border-top: 1pt solid #e2e8f0; margin: 14pt 0; }
pre,code { font-family: 'Courier New', monospace; font-size: .9em; white-space: pre-wrap !important; overflow-wrap: anywhere !important; }
pre { padding: 9pt; background: #f1f5f9; border: 1pt solid #e2e8f0; }
.article-content * { max-width: 100% !important; min-width: 0 !important; overflow-wrap: anywhere !important; }
.article-content [style*="white-space"] { white-space: pre-wrap !important; }
table { display: table !important; width: 100%; max-width: 100% !important; table-layout: fixed; border-collapse: collapse; margin: 12pt 0; }
thead { display: table-header-group; } tbody { display: table-row-group; }
tr { break-inside: auto; } th,td { padding: 6pt 8pt; border: 1pt solid #cbd5e1; vertical-align: top; overflow-wrap: anywhere !important; white-space: normal !important; }
th { text-align: left; background: #f1f5f9; font-weight: 700; }
.summary { color: #475569; font-size: 11.5pt; margin-bottom: 18pt; white-space: pre-line; }
.section-label { color: #64748b; font-size: 9pt; font-weight: 700; margin-bottom: 10pt; }
.article.after-outline { break-before: page; page-break-before: always; }
dl { margin: 0 0 14pt; font-size: 10pt; } dl > div { margin-bottom: 5pt; }
dt { display: inline; font-weight: 700; } dt::after { content: ': '; } dd { display: inline; margin: 0; }
.outline { font-size: 10pt; } .outline h1 { font-size: 20pt; } .outline h2 { font-size: 13pt; margin-top: 14pt; }
.outline h3 { display: inline; font-size: 11pt; } .outline-sections > li { padding-left: 3pt; margin-bottom: 11pt; }
.outline-sections > li > p { margin-top: 4pt; } .word-count { display: block; color: #64748b; font-size: 9pt; margin-top: 2pt; }
.evidence { color: #475569; } .outline ul { margin-bottom: 6pt; }
</style></head><body>${outline}<article class="article${outline ? ' after-outline' : ''}" aria-label="Bài viết"><div class="section-label">Bài viết</div><h1>${escape(title)}</h1>${description ? `<p class="summary">${escape(description)}</p>` : ''}<div class="article-content">${content}</div></article></body></html>`
  if (html.length > 1_500_000) throw new JobPdfError('limit')
  return { html, filename: jobPdfFilename(input.id, text(article.Slug, 1_000)), hasOutline: Boolean(outline) }
}

let fontCss: Promise<string> | undefined
async function loadFonts(): Promise<string> {
  if (!fontCss) {
    const root = dirname(createRequire(import.meta.url).resolve('@fontsource/inter/package.json'))
    fontCss = Promise.all([
      ['latin', 'U+0000-00FF,U+0131,U+0152-0153,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'],
      ['latin-ext', 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'],
      ['vietnamese', 'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB'],
    ].flatMap(([subset, range]) => [[400, 'normal'], [700, 'normal'], [400, 'italic']].map(async ([weight, style]) => {
      const data = await readFile(join(root, 'files', `inter-${subset}-${weight}-${style}.woff2`))
      return `@font-face{font-family:'CRM PDF';font-style:${style};font-weight:${weight};src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2');unicode-range:${range};}`
    }))).then(parts => parts.join('\n')).catch(error => { fontCss = undefined; throw error })
  }
  return fontCss
}

export async function renderJobPdf(input: JobPdfInput, signal?: AbortSignal): Promise<{ bytes: Buffer; filename: string }> {
  // Validate content before reserving a browser slot or launching Chromium.
  const output = buildJobPdfHtml(input)
  if (signal?.aborted) throw new JobPdfError('unavailable')
  if (activeExports >= 2) throw new JobPdfError('busy')
  activeExports += 1
  let browser: Browser | undefined
  let rendering: Promise<{ bytes: Buffer; filename: string }> | undefined
  let stopped = false
  let stop: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => {
      stopped = true
      void browser?.close().catch(() => {})
      reject(new JobPdfError('unavailable'))
    }
  })
  const timeout = setTimeout(stop, TIMEOUT_MS)
  timeout.unref()
  signal?.addEventListener('abort', stop, { once: true })
  try {
    rendering = (async () => {
      const fonts = await loadFonts()
      if (stopped) throw new JobPdfError('unavailable')
      browser = await chromium.launch({ headless: true, timeout: 12_000 })
      if (stopped) { await browser.close(); throw new JobPdfError('unavailable') }
      const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', offline: true, locale: 'vi-VN', viewport: { width: 665, height: 980 }, acceptDownloads: false })
      await context.route('**/*', route => route.abort())
      const page = await context.newPage()
      page.setDefaultTimeout(10_000)
      await page.emulateMedia({ media: 'print' })
      await page.setContent(output.html.replace('<style>', `<style>${fonts}`), { waitUntil: 'load', timeout: 10_000 })
      await page.evaluate(() => document.fonts.ready.then(() => undefined))
      const height = await page.evaluate(() => document.documentElement.scrollHeight)
      if (height > 985 * MAX_PAGES) throw new JobPdfError('limit')
      const bytes = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true, tagged: true, outline: true })
      const pages = bytes.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0
      if (!pages || pages > MAX_PAGES || bytes.byteLength > MAX_BYTES) throw new JobPdfError('limit')
      return { bytes, filename: output.filename }
    })()
    return await Promise.race([cancelled, rendering])
  } catch (error) {
    throw error instanceof JobPdfError ? error : new JobPdfError('unavailable')
  } finally {
    stopped = true
    clearTimeout(timeout)
    signal?.removeEventListener('abort', stop)
    await browser?.close().catch(() => {})
    // A launch already in progress may finish after cancellation; keep its slot
    // until that browser has also been closed by the stopped check above.
    await rendering?.catch(() => {})
    activeExports -= 1
  }
}
