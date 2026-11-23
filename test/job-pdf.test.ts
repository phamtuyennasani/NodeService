import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import { buildJobPdfHtml, JobPdfError, renderJobPdf, sanitizePdfStyle } from '../src/job-pdf.js'

const id = '12850dc1-a858-42dd-881a-48daff6bb34a'
const article = { Title: 'Bài viết tiếng Việt', Slug: 'bài-viết-tiếng-Việt', Desc: 'Tóm tắt bài viết.',
  Content: '<h2 style="color:#15456c">Tiêu đề nội dung</h2><p>Giữ <strong>chữ đậm</strong> và <em>chữ nghiêng</em>.</p><ol><li>Mục thứ nhất</li><li>Mục thứ hai</li></ol><table style="width:100%;border-collapse:collapse"><thead><tr><th colspan="2">Bảng so sánh</th></tr></thead><tbody><tr><td rowspan="2" style="color:#176744;padding:12px;text-align:center">Tiêu chí</td><td>Giá trị một</td></tr><tr><td>Giá trị hai</td></tr></tbody></table><p>KẾT THÚC NỘI DUNG TIẾNG VIỆT</p>' }
const outline = { title: 'Dàn ý tiếng Việt', searchIntent: 'Tìm hiểu thông tin', audience: 'Người đọc Việt Nam', angle: 'Góc nhìn thực tế', questions: ['Câu hỏi cần trả lời?'], sections: [{ heading: 'Bố cục đầu tiên', purpose: 'Mục đích của phần này.', estimatedWords: 250, subheadings: ['Tiêu đề phụ H3'], evidence: [{ sourceIndex: 2, fact: 'Dữ kiện tham khảo đã lưu.' }] }] }
const pageCount = (bytes: Buffer) => bytes.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length ?? 0
const errorCode = (code: JobPdfError['code']) => (error: unknown) => error instanceof JobPdfError && error.code === code

test('PDF HTML preserves article structure, complete outline order and safe inline formatting', () => {
  const document = buildJobPdfHtml({ id, article, outline })
  assert.equal(document.hasOutline, true)
  assert.equal(document.filename, 'bai-viet-tieng-viet-12850dc1-a85.pdf')
  for (const text of ['Tìm hiểu thông tin', 'Người đọc Việt Nam', 'Góc nhìn thực tế', 'Câu hỏi cần trả lời?', 'Bố cục đầu tiên', 'Mục đích của phần này.', '250 từ dự kiến', 'Tiêu đề phụ H3', 'Nguồn 2: Dữ kiện tham khảo đã lưu.']) assert.ok(document.html.includes(text), text)
  assert.ok(document.html.indexOf('Dàn ý tiếng Việt') < document.html.indexOf('<article'))
  assert.match(document.html, /article class="article after-outline"/)
  for (const preserved of ['<strong>chữ đậm</strong>', '<em>chữ nghiêng</em>', '<ol><li>Mục thứ nhất', 'colspan="2"', 'rowspan="2"', 'color:#176744;padding:12px;text-align:center']) assert.ok(document.html.includes(preserved), preserved)
  const legacy = buildJobPdfHtml({ id, article: { Content: '<p>Bài cũ thiếu metadata.</p>' }, outline: {} })
  assert.equal(legacy.hasOutline, false)
  assert.match(legacy.html, /<article class="article"/)
  assert.equal(legacy.filename, 'bai-viet-12850dc1-a85.pdf')
})

test('PDF HTML escapes all text fields and removes active markup and remote styles', () => {
  const injection = '</style><script>globalThis.attacked=true</script><img src="https://example.test/track">'
  const document = buildJobPdfHtml({ id: '\r\nunsafe/id', article: { ...article, Title: injection, Desc: injection,
    Content: `<script>alert(1)</script><iframe src="https://example.test"></iframe><img src="https://example.test/track"><p onclick="alert(1)" style="color:#123456;background:url(https://example.test/track);position:fixed">Nội dung an toàn.</p>` },
    outline: { ...outline, title: injection, questions: [injection] } })
  assert.doesNotMatch(document.html, /<script|<iframe|<img|onclick=|background:url|position:fixed/i)
  assert.match(document.html, /&lt;script&gt;/)
  assert.match(document.html, /style="color:#123456"/)
  assert.doesNotMatch(document.filename, /[\r\n/]/)
})

test('PDF content gate rejects empty, invisible or excessive content without a browser', () => {
  for (const Content of ['', '  ', '<script>hidden()</script>', '<p>&nbsp;&#160;&#xA0;&#32;</p>', '<span>\u200b\ufeff</span>']) {
    assert.throws(() => buildJobPdfHtml({ id, article: { Content } }), errorCode('empty'))
  }
  assert.throws(() => buildJobPdfHtml({ id, article: { Content: 'x'.repeat(180_001) } }), errorCode('limit'))
  assert.throws(() => buildJobPdfHtml({ id, article, outline: { sections: Array(33).fill({}) } }), errorCode('limit'))
  assert.equal(sanitizePdfStyle('font-size:9999px;height:9999px;padding:9999%;width:9999%;color:#123456;font-size:16px;line-height:1.7'), 'color:#123456;font-size:16px;line-height:1.7')
})

test('PDF relative font sizing stays bounded through nesting while normal sizes remain', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage()
  const Content = '<span style="font-size:400%">'.repeat(8) + '<span style="font-size:4em">Nội dung</span>' + '</span>'.repeat(8) + '<p style="font-size:16px">Cỡ chữ bình thường</p>'
  await page.setContent(buildJobPdfHtml({ id, article: { ...article, Content } }).html)
  const sizes = await page.locator('.article-content [style]').evaluateAll(elements => elements.map(element => parseFloat(getComputedStyle(element).fontSize)))
  assert.ok(sizes.every(size => size <= 64), JSON.stringify(sizes))
  assert.equal(sizes.at(-1), 16)
})

test('real PDF has separate outline/article pages, omits absent outline and preserves long content flow', { timeout: 60_000 }, async () => {
  const withOutline = await renderJobPdf({ id, article, outline })
  assert.equal(withOutline.bytes.subarray(0, 5).toString(), '%PDF-')
  assert.equal(pageCount(withOutline.bytes), 2)
  const withoutOutline = await renderJobPdf({ id, article })
  assert.equal(pageCount(withoutOutline.bytes), 1)
  const Content = Array.from({ length: 80 }, (_, index) => `<p>Đoạn ${index + 1}. ${'Nội dung đầy đủ cần được giữ khi xuất PDF. '.repeat(8)}</p>`).join('') + '<p>ĐOẠN CUỐI KHÔNG BỊ CẮT</p>'
  const long = await renderJobPdf({ id, article: { ...article, Content }, outline })
  assert.ok(pageCount(long.bytes) > 2)
  assert.ok(pageCount(long.bytes) < 60)
})

test('PDF rendering never fetches article resources and export capacity recovers after cancellation', { timeout: 60_000 }, async t => {
  let requests = 0
  const server = createServer((_request, response) => { requests += 1; response.end('unexpected') })
  server.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/track`
  const controller = new AbortController()
  const first = renderJobPdf({ id, article: { ...article, Content: `<script>fetch('${url}')</script><img src="${url}"><p style="background:url(${url})">Nội dung an toàn.</p>` } }, controller.signal)
  const aborted = assert.rejects(first, errorCode('unavailable'))
  const second = renderJobPdf({ id, article })
  await assert.rejects(renderJobPdf({ id, article }), errorCode('busy'))
  controller.abort()
  await aborted
  await second
  await renderJobPdf({ id, article: { ...article, Content: `<img src="${url}"><p style="background:url(${url})">Đã phục hồi sau hủy.</p>` } })
  assert.equal(requests, 0)
  await assert.rejects(renderJobPdf({ id, article }, AbortSignal.abort()), errorCode('unavailable'))
})
