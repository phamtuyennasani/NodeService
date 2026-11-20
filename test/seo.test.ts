import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateSeoFields, type SeoCriterion, type SeoInput, type SeoReport } from '../src/worker/seo.js'

const article: SeoInput = {
  keyword: 'cà phê',
  title: 'Cà phê và cách chọn hương vị phù hợp tại nhà',
  description: ('Mẹo chọn cà phê cho người mới. ' + 'à'.repeat(129)).slice(0, 155),
  slug: 'cach-chon-ca-phe',
  contentHtml: '<p>Một ly cà phê tốt bắt đầu với nước sạch.</p><p>Dùng cân để dễ kiểm soát tỷ lệ.</p>',
  siteUrl: 'example.vn',
}

function finding(report: SeoReport, key: SeoCriterion) {
  const selected = report.findings.find(item => item.key === key)
  assert.ok(selected)
  return selected
}

test('SEO uses the displayed title and meta ranges, including Vietnamese code points', () => {
  for (const [length, passed] of [[40, false], [41, true], [70, true], [71, false]] as const) {
    const report = evaluateSeoFields({ ...article, title: 'ấ'.repeat(length).normalize('NFD') })
    assert.equal(report.metrics.titleCharacters, length)
    assert.equal(finding(report, 'lengthTitle').passed, passed)
  }
  for (const [length, passed] of [[154, false], [155, true], [159, true], [160, true], [161, false]] as const) {
    const report = evaluateSeoFields({ ...article, description: 'ứ'.repeat(length) })
    assert.equal(finding(report, 'lengthMetaDescription').passed, passed)
  }
  assert.equal(finding(evaluateSeoFields(article), 'titleStartWithKeyword').passed, true)
  const lateKeyword = evaluateSeoFields({ ...article, title: 'Những cách chọn thức uống khi dùng cà phê buổi sáng' })
  assert.equal(finding(lateKeyword, 'keywordInTitle').passed, true)
  assert.equal(finding(lateKeyword, 'titleStartWithKeyword').passed, false)
})

test('SEO checks the first tenth of visible words with entire keyword matches', () => {
  const buildContent = (introWords: number) =>
    '<!-- cà phê --><script>cà phê</script><p>' + 'nhà&nbsp;'.repeat(introWords) +
    '<strong>cà</strong>&nbsp;<em>phê</em> ' + 'bạn '.repeat(598 - introWords) + '</p>'
  const within = evaluateSeoFields({ ...article, contentHtml: buildContent(58) })
  const outside = evaluateSeoFields({ ...article, contentHtml: buildContent(59) })
  assert.equal(within.metrics.words, 600)
  assert.equal(within.metrics.keywordOccurrences, 1)
  assert.equal(finding(within, 'lengthContent').passed, true)
  assert.equal(finding(within, 'keywordIn10Percent').passed, true)
  assert.equal(finding(outside, 'keywordIn10Percent').passed, false)
  assert.equal(finding(outside, 'keywordInContent').passed, true)
  assert.equal(finding(outside, 'keywordDensity').repairable, false)
  assert.equal(finding(outside, 'contentHasShortParagraphs').passed, false)

  const partial = evaluateSeoFields({ ...article, keyword: 'cà', contentHtml: '<h2>Càu</h2><p>Nhìn vào vết cào</p>' })
  assert.equal(partial.metrics.keywordOccurrences, 0)
  assert.equal(finding(partial, 'keywordInSubheadings').passed, false)
})

test('SEO counts real paragraph lengths and reads across HTML blocks', () => {
  const articles = [
    { contentHtml: '<p>' + 'từ '.repeat(90) + '</p><p>Một đoạn khác.</p>', expected: true },
    { contentHtml: '<p>' + 'từ '.repeat(91) + '</p><p>Một đoạn khác.</p>', expected: false },
    { contentHtml: '<p>Một đoạn văn.</p><p>&nbsp;</p>', expected: false },
  ]
  for (const { contentHtml, expected } of articles) {
    assert.equal(finding(evaluateSeoFields({ ...article, contentHtml }), 'contentHasShortParagraphs').passed, expected)
  }
  const long = '<p>' + 'từ '.repeat(75) + '</p>'
  const report = evaluateSeoFields({ ...article, contentHtml: long.repeat(20) })
  assert.equal(report.metrics.words, 1_500)
  assert.equal(finding(report, 'lengthContent').passed, true)
  assert.equal(finding(report, 'contentHasShortParagraphs').passed, true)
})

test('SEO validates normalized slugs and recognizes only same-site web links', () => {
  const siteUrl = 'https://www.example.vn'
  const textWithLink = (href: string) => '<p><a href="' + href + '">Hướng dẫn liên quan</a></p>'
  for (const href of ['https://example.vn/bai-viet', '//example.vn/bai-viet', '/bai-viet', 'bai-viet']) {
    const report = evaluateSeoFields({ ...article, siteUrl, contentHtml: textWithLink(href) })
    assert.equal(finding(report, 'linksHasInternal').passed, true, href)
  }
  for (const href of ['#muc-luc', 'https://example.vn.invalid/khac', 'mailto:info@example.vn', 'ftp://example.vn/bai-viet']) {
    const report = evaluateSeoFields({ ...article, siteUrl, contentHtml: textWithLink(href) })
    assert.equal(finding(report, 'linksHasInternal').passed, false, href)
  }
  assert.equal(finding(evaluateSeoFields(article), 'keywordInPermalink').passed, true)
  assert.equal(finding(evaluateSeoFields(article), 'lengthPermalink').passed, true)
  assert.equal(finding(evaluateSeoFields({ ...article, slug: 'cach-chon-ca-pheo' }), 'keywordInPermalink').passed, false)
  assert.equal(finding(evaluateSeoFields({ ...article, slug: 'Cách chọn cà phê' }), 'lengthPermalink').passed, false)
  assert.equal(finding(evaluateSeoFields({ ...article, slug: 'a'.repeat(76) }), 'lengthPermalink').passed, false)
})

test('deferred images are excluded and missing site context cannot force an internal link', () => {
  const report = evaluateSeoFields({ ...article, siteUrl: null })
  assert.equal(report.applicable, 14)
  assert.equal(finding(report, 'linksHasInternal').applicable, false)
  for (const key of ['keywordInImageAlt', 'contentHasAssets'] as const) {
    assert.equal(finding(report, key).applicable, false)
    assert.equal(report.warnings.some(warning => warning.key === key), false)
  }
  assert.equal(evaluateSeoFields({ ...article, keyword: '' }).score, 0)
})
