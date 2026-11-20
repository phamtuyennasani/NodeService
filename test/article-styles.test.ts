import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeArticleStyle } from '../src/article-styles.js'
import { cleanArticle, generateArticle, type GenerateInput } from '../src/worker/provider.js'

const article = {
  Title: 'Bài viết có bảng',
  Content: '<p>Nội dung.</p>',
  Slug: 'bai-viet-co-bang',
  Desc: 'Mô tả ngắn.',
  Desction: 'Mô tả SEO.',
  'Từ khóa': ['bảng'],
}

test('article style filter keeps table, typography and spacing declarations', () => {
  const declarations = [
    'width: 100%', 'max-width: 100%', 'border-collapse: collapse',
    'border: 1px solid #e2e8f0', 'border-bottom: 2px solid rgb(20, 30, 40)',
    'border-radius: 8px', 'border-spacing: 0', 'table-layout: fixed',
    'padding: 12px 16px', 'margin: 1.5rem auto', 'padding-left: 1em',
    'color: #334155', 'background-color: rgba(240, 245, 250, 0.5)',
    'background: #f8fafc', 'font-family: Arial, sans-serif',
    'font-size: 16px', 'font-weight: 600', 'line-height: 1.7',
    'text-align: left !important', 'vertical-align: top', 'overflow-wrap: anywhere',
  ]
  const clean = sanitizeArticleStyle(declarations.join('; '))
  for (const declaration of declarations) {
    const separator = declaration.indexOf(':')
    assert.ok(clean.includes(`${declaration.slice(0, separator)}:${declaration.slice(separator + 1).trim()}`), declaration)
  }
  assert.equal(sanitizeArticleStyle(clean), clean, 'filter is stable when a source article is cleaned again')
})

test('article style filter rejects remote resources, executable values and CSS parser tricks', () => {
  const dirty = [
    'color: #123456',
    'position: fixed', 'inset: 0', 'z-index: 9999', 'opacity: 0',
    'background: url(https://example.test/track)',
    'background-image: url(https://example.test/track)',
    'width: expression(alert(1))', 'color: var(--unsafe)',
    'behavior: url(test.htc)', '-moz-binding: url(test.xml)',
    'font-family: url(https://example.test/font)',
    'background-color: e/**/xpression(alert(1))',
    'color: r\\65 d', 'padding: -999px', 'margin: calc(100% - 1px)',
    '--custom: red', '__proto__: red', 'constructor: red',
    'text-align: left !important !important', 'border: 1px solid url(test)',
    'font-size: 16px\n!important',
  ].join(';')
  assert.equal(sanitizeArticleStyle(dirty), 'color:#123456')
  assert.equal(sanitizeArticleStyle('color:' + 'a'.repeat(8_001)), '')
})

test('cleanArticle retains safe inline styles and strips unsafe HTML before persistence', () => {
  const cleaned = cleanArticle({ ...article, Content: `
    <style>body { display:none }</style><script>alert(1)</script>
    <p style="font-size:16px;line-height:1.7;position:fixed">Nội dung.</p>
    <table style="width:100%;border-collapse:collapse" onclick="alert(1)">
      <thead style="background-color:#f1f5f9"><tr style="background:#fff">
        <th scope="col" colspan="2" style="padding:12px;text-align:left !important">Tiêu chí</th>
      </tr></thead>
      <tbody><tr style="background-color:#f8fafc">
        <td rowspan="2" style="border:1px solid #ddd;padding:10px;color:#333;background-image:url(https://example.test/track)">Giá trị</td>
      </tr></tbody>
    </table>
    <a href="javascript:alert(1)" style="color:#2563eb;behavior:url(test.htc)">Liên kết</a>
    <img src="https://example.test/track" onerror="alert(1)">
  ` })
  assert.match(cleaned.Content, /<table style="width:100%;border-collapse:collapse">/)
  assert.match(cleaned.Content, /<tr style="background:#fff">/)
  assert.match(cleaned.Content, /<th scope="col" colspan="2" style="padding:12px;text-align:left !important">/)
  assert.match(cleaned.Content, /<td rowspan="2" style="border:1px solid #ddd;padding:10px;color:#333">/)
  assert.match(cleaned.Content, /<p style="font-size:16px;line-height:1.7">/)
  assert.doesNotMatch(cleaned.Content, /<style|<script|<img|onclick|onerror|javascript:|position|behavior|background-image|url\(/i)
  assert.equal(cleanArticle(cleaned).Content, cleaned.Content.trim())
})

test('streamed article preserves inline CSS and sends explicit styling instructions to AI', async () => {
  const instructions = 'Viết CSS inline cho table, td và tr để bài viết đẹp.'
  const content = '<table style="width:100%;border-collapse:collapse"><tr style="background:#f8fafc"><td style="padding:12px;border:1px solid #ddd">Nội dung</td></tr></table>'
  let request: Record<string, any> | undefined
  const input: GenerateInput = {
    provider: 'openai-compatible', key: 'fixture-key', model: 'fixture-model', baseUrl: 'https://example.test/v1',
    keyword: 'bảng', tone: 'Chuyên nghiệp', style: 'SEO', length: 1000,
    instructions, source: null, signal: new AbortController().signal,
  }
  const result = await generateArticle(input, async (_url, init) => {
    request = JSON.parse(String(init?.body))
    const data = JSON.stringify({ ...article, Content: content })
    const chunks = [
      { choices: [{ delta: { content: data } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
    return new Response(chunks, { headers: { 'content-type': 'text/event-stream' } })
  })
  assert.equal(request?.stream, true)
  assert.equal(JSON.parse(request?.messages[1].content).yêu_cầu_bổ_sung, instructions)
  assert.match(request?.messages[0].content, /phải đặt CSS inline bằng thuộc tính style/)
  assert.match(request?.messages[0].content, /Không dùng thẻ script, iframe, form, thẻ <style>/)
  assert.equal(result.article.Content, content)
})
