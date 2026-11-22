import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanArticle } from '../src/worker/provider.js'
import { enforceInternalLinks, extractArticleLinks, prepareInternalLinkCandidates } from '../src/worker/internal-links.js'
import type { InternalLinkCandidate } from '../src/site-content.js'

const candidates: InternalLinkCandidate[] = [
  { id: 'a', url: 'https://example.vn/huong-dan', title: 'Hướng dẫn chọn thiết bị', summary: 'Các bước lựa chọn phù hợp.' },
  { id: 'b', url: 'https://example.vn/bao-quan', title: 'Bảo quản thiết bị', summary: 'Cách vệ sinh và bảo quản.' },
  { id: 'c', url: 'https://example.vn/so-sanh?loai=a&hang=b', title: 'So sánh các loại thiết bị', summary: '' },
  { id: 'd', url: 'https://example.vn/thong-so', title: 'Thông số thiết bị', summary: '' },
]
const options = { candidates, siteDomain: 'example.vn' }

test('link enforcement canonicalizes only approved targets and preserves HTML, text, entities and inline styles', () => {
  const html = '<table style="width:100%"><tbody><tr><td style="padding:8px"><p>A &amp; B: '
    + '<a STYLE="color: #123456" href = "/huong-dan" title="Giữ nguyên"><strong>hướng dẫn chọn thiết bị</strong></a>.</p></td></tr></tbody></table>'
  const result = enforceInternalLinks(html, options)
  assert.equal(result.content, html.replace('href = "/huong-dan"', 'href="https://example.vn/huong-dan"'))
  assert.deepEqual(result.used, [{ url: candidates[0].url, anchor: 'hướng dẫn chọn thiết bị' }])
  assert.equal(result.removed, 0)
  assert.deepEqual(enforceInternalLinks(result.content, options), result, 'enforcement is idempotent')
})

test('unapproved links become text and preserve inline formatting across article cleanup', () => {
  const html = '<p style="line-height:1.5">Xem <a href="https://other.example/unknown" style="color:red"><em>hướng dẫn hữu ích</em></a> &amp; lưu lại.</p>'
  const result = enforceInternalLinks(html, options)
  assert.equal(result.content, '<p style="line-height:1.5">Xem <span style="color:red"><em>hướng dẫn hữu ích</em></span> &amp; lưu lại.</p>')
  assert.equal(result.removed, 1)
  assert.deepEqual(result.used, [])
  const cleaned = cleanArticle({ Title: 'Bài thử', Content: result.content, Slug: 'bai-thu', Desc: 'Tóm tắt', Description: 'Mô tả', Keywords: ['thử'] })
  assert.equal(cleaned.Content, result.content)
})

test('same-site URL checks reject guessed URLs, other tenants, credentials and dangerous schemes', () => {
  const hrefs = [
    '/tu-doan-url', 'https://other.example/huong-dan', 'https://example.vn.invalid/huong-dan',
    'https://user:password@example.vn/huong-dan', 'javascript:alert(1)', 'data:text/html,test',
    'mailto:info@example.vn', '//other.example/huong-dan', '\\other.example\\huong-dan',
    'java&#x09;script:alert(1)', '/huong-dan#tu-doan', '/huong-dan?utm_source=ai',
  ]
  const html = hrefs.map(href => `<p><a href="${href}">Hướng dẫn chọn thiết bị</a></p>`).join('')
  const result = enforceInternalLinks(html, options)
  assert.equal(result.removed, hrefs.length)
  assert.deepEqual(result.used, [])
  assert.equal(result.content.includes('<a'), false)
  assert.equal(result.content, '<p>Hướng dẫn chọn thiết bị</p>'.repeat(hrefs.length))
})

test('meaningful query parameters and fragments remain exact rather than silently stripped', () => {
  const html = '<p><a href="/so-sanh?loai=a&amp;hang=b">So sánh các loại thiết bị</a>'
    + '<a href="/so-sanh?loai=khac&amp;hang=b">So sánh thiết bị khác</a>'
    + '<a href="/so-sanh?hang=b&amp;loai=a">So sánh thứ tự query khác</a></p>'
  const result = enforceInternalLinks(html, options)
  assert.equal(result.removed, 2)
  assert.deepEqual(result.used, [{ url: candidates[2].url, anchor: 'So sánh các loại thiết bị' }])
  assert.match(result.content, /href="https:\/\/example.vn\/so-sanh\?loai=a&amp;hang=b"/)
  const fragment = { ...candidates[0], url: candidates[0].url + '#lua-chon' }
  assert.equal(enforceInternalLinks('<p><a href="/huong-dan#lua-chon">Hướng dẫn chọn thiết bị</a></p>', { ...options, candidates: [fragment] }).used.length, 1)
})

test('only distinct relevant anchors use the quota and duplicate destinations are unwrapped', () => {
  const html = '<p><a href="/huong-dan">Xem thêm</a><a href="/huong-dan">Hướng dẫn chọn thiết bị</a>'
    + '<a href="https://www.example.vn/huong-dan">Các bước chọn thiết bị</a>'
    + '<a href="/bao-quan">Cách bảo quản thiết bị</a>'
    + '<a href="/so-sanh?loai=a&amp;hang=b">So sánh các loại thiết bị</a>'
    + '<a href="/thong-so">Thông số kỹ thuật</a></p>'
  const result = enforceInternalLinks(html, options)
  assert.equal(result.removed, 3)
  assert.equal(result.used.length, 3)
  assert.deepEqual(result.used.map(row => row.url), candidates.slice(0, 3).map(row => row.url))
  assert.equal(extractArticleLinks(result.content).length, 3)
  assert.equal(enforceInternalLinks(html, { ...options, maxLinks: 1 }).used.length, 1)
  assert.equal(enforceInternalLinks(html, { ...options, maxLinks: 50 }).used.length, 3)
  assert.equal(enforceInternalLinks(html, { ...options, maxLinks: 0 }).used.length, 0)
})

test('headings, code, pre, hidden text, empty and generic anchors cannot receive new links', () => {
  const html = '<h2><a href="/huong-dan">Hướng dẫn chọn thiết bị</a></h2>'
    + '<pre><a href="/huong-dan">Hướng dẫn chọn thiết bị</a></pre>'
    + '<p><code><a href="/huong-dan">Hướng dẫn chọn thiết bị</a></code></p>'
    + '<p style="display: none"><a href="/huong-dan">Hướng dẫn chọn thiết bị</a></p>'
    + '<p><a href="/huong-dan">&nbsp;</a><a href="/huong-dan">Tại đây!</a>'
    + '<a href="/huong-dan">https://example.vn/huong-dan</a><a href="/huong-dan">&#x200B;</a></p>'
  const result = enforceInternalLinks(html, options)
  assert.equal(result.removed, 8)
  assert.equal(extractArticleLinks(result.content).length, 0)
  assert.deepEqual(result.used, [])
  assert.match(result.content, /<h2>Hướng dẫn chọn thiết bị<\/h2>/)
  assert.match(result.content, /<code>Hướng dẫn chọn thiết bị<\/code>/)
  assert.equal(enforceInternalLinks('<a href="/huong-dan"><h2>Hướng dẫn chọn thiết bị</h2></a>', options).removed, 1)
})

test('nested and malformed anchors are safely unwrapped without nested anchors or lost text', () => {
  const nested = '<p><a href="/huong-dan">Chọn <strong>thiết bị <a href="/bao-quan">và bảo quản</a></strong> phù hợp</a>.</p>'
  const result = enforceInternalLinks(nested, options)
  assert.equal(result.content, '<p>Chọn <strong>thiết bị và bảo quản</strong> phù hợp.</p>')
  assert.equal(result.removed, 2)
  assert.deepEqual(result.used, [])
  assert.equal(enforceInternalLinks('<p><a href="/huong-dan">Hướng dẫn chưa đóng', options).content, '<p>Hướng dẫn chưa đóng')
})

test('trusted source links including duplicates stay intact without using new-link quota', () => {
  const old = '<p><a href="https://source.example/a?x=1&amp;y=2">Xem thêm</a> '
    + '<a href="https://source.example/a?x=1&amp;y=2">Nguồn cũ</a> <a href="/old-page">Bài cũ</a></p>'
  const preserveUrls = extractArticleLinks(old)
  assert.deepEqual(preserveUrls, ['https://source.example/a?x=1&y=2', 'https://source.example/a?x=1&y=2', '/old-page'])
  const html = old + '<p><a href="https://unknown.example/a">Nguồn tự thêm</a>'
    + '<a href="/huong-dan">Hướng dẫn chọn thiết bị</a><a href="/bao-quan">Cách bảo quản thiết bị</a>'
    + '<a href="/so-sanh?loai=a&amp;hang=b">So sánh các loại thiết bị</a></p>'
  const result = enforceInternalLinks(html, { ...options, preserveUrls })
  assert.ok(result.content.startsWith(old))
  assert.equal(result.used.length, 3)
  assert.equal(result.removed, 1)
  assert.equal(extractArticleLinks(result.content).length, 6)
  const extraCopy = enforceInternalLinks(old + '<p><a href="https://source.example/a?x=1&amp;y=2">Bản tự lặp thêm</a></p>', { ...options, preserveUrls })
  assert.equal(extraCopy.removed, 1, 'preservation must not allow AI to add unlimited copies of source links')
  assert.equal(extractArticleLinks(extraCopy.content).length, 3)
  const sourceCatalog = enforceInternalLinks('<p><a href="/huong-dan">Bản cũ</a><a href="/huong-dan">Bản trùng mới</a></p>', { ...options, preserveUrls: ['/huong-dan'] })
  assert.equal(sourceCatalog.removed, 1)
  assert.deepEqual(sourceCatalog.used, [])
  const unsafe = enforceInternalLinks('<p><a href="javascript:alert(1)">Nguồn cũ</a></p>', { ...options, preserveUrls: ['javascript:alert(1)'] })
  assert.equal(unsafe.removed, 1)
})

test('empty catalog denies new links and missing site context fails closed', () => {
  const html = '<p><a href="/huong-dan">Hướng dẫn chọn thiết bị</a></p>'
  assert.deepEqual(enforceInternalLinks(html, { candidates: [], siteDomain: 'example.vn' }), { content: '<p>Hướng dẫn chọn thiết bị</p>', used: [], removed: 1 })
  assert.equal(enforceInternalLinks(html, { candidates }).used.length, 0)
  assert.equal(enforceInternalLinks('<p>Bài không có liên kết.</p>', options).removed, 0)
})

test('mailto is retained only as an exact existing source link with its original count', () => {
  const original = '<p><a href="mailto:editor@example.vn?subject=Hoi%20bai">Liên hệ biên tập viên</a></p>'
  const html = original + original + '<p><a href="mailto:other@example.vn">Liên hệ khác</a></p>'
  const result = enforceInternalLinks(html, { ...options, preserveUrls: extractArticleLinks(original) })
  assert.ok(result.content.startsWith(original))
  assert.equal(result.removed, 2)
  assert.deepEqual(result.used, [])
  assert.deepEqual(extractArticleLinks(result.content), ['mailto:editor@example.vn?subject=Hoi%20bai'])
  const unsafe = enforceInternalLinks('<p><a href="mailto:editor@example.vn\n?subject=bad">Liên hệ</a></p>', { ...options, preserveUrls: ['mailto:editor@example.vn\n?subject=bad'] })
  assert.equal(unsafe.removed, 1)
})

test('shortlist normalization caps prompt data and rejects foreign or invalid candidates', () => {
  const oversized = Array.from({ length: 12 }, (_, index) => ({ id: String(index), url: `https://example.vn/bai-${index}`, title: 'Tiêu đề '.repeat(100), summary: 'Mô tả '.repeat(500), categories: ['a'.repeat(100), 'b', 'c', 'd', 'e'] }))
  const shortlist = prepareInternalLinkCandidates([{ ...candidates[0], url: 'https://foreign.example/a' }, { ...candidates[0], url: 'javascript:alert(1)' }, ...oversized], 'https://www.example.vn')
  assert.equal(shortlist.length, 8)
  assert.ok(shortlist.every(candidate => candidate.title.length <= 200 && candidate.summary.length <= 400 && candidate.categories?.length === 4 && candidate.categories[0].length === 80))
  assert.equal(prepareInternalLinkCandidates(candidates).length, 0)
  assert.equal(prepareInternalLinkCandidates([candidates[0], { ...candidates[0], url: 'https://www.example.vn/huong-dan' }], 'example.vn').length, 1)
})
