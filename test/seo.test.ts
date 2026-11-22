import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateSeoFields, seoPromptGuidance, type SeoCriterion, type SeoInput, type SeoReport } from '../src/worker/seo.js'

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

test('SEO generation guidance prioritizes people and treats mechanical ranges as editorial hints', () => {
  const guidance = seoPromptGuidance(1_200).join('\n')
  assert.match(guidance, /nhu cầu và ý định tìm kiếm của người đọc/)
  assert.match(guidance, /chính xác, liên quan và có giá trị bổ sung/)
  assert.match(guidance, /1200 từ/)
  assert.match(guidance, /Không thêm câu cho đủ số từ, không cắt phần cần thiết/)
  assert.match(guidance, /không kéo dài hoặc cắt ý chỉ để đạt một số ký tự cố định/)
  assert.match(guidance, /không giật tít/)
  assert.match(guidance, /không bắt buộc lặp nguyên cụm từ khóa/iu)
  assert.match(guidance, /không nhồi từ khóa hoặc viết để đạt mật độ cố định/)
  assert.match(guidance, /không phải yêu cầu của Google/)
  assert.match(guidance, /người biên tập kiểm tra tính chính xác trước khi xuất bản/)
  assert.doesNotMatch(guidance, /Title dài 41|Description dài 155|mật độ từ khóa chính khoảng 1%/)
})

test('mechanical SEO warnings retain checklist metrics without triggering automatic repair', () => {
  const report = evaluateSeoFields({
    ...article,
    title: 'Hướng dẫn',
    description: 'Cách chọn thức uống phù hợp.',
    slug: 'huong-dan',
    contentHtml: '<h2>Chọn thức uống</h2><p>Chọn hương vị theo sở thích.</p><p>Ưu tiên nguyên liệu có thông tin rõ ràng.</p>',
  })
  const advisoryKeys = [
    'keywordInTitle', 'titleStartWithKeyword', 'lengthTitle', 'keywordInMetaDescription',
    'lengthMetaDescription', 'keywordInPermalink', 'keywordIn10Percent', 'keywordInContent',
    'lengthContent', 'keywordInSubheadings', 'keywordDensity',
  ] as const
  for (const key of advisoryKeys) {
    const advisory = finding(report, key)
    assert.equal(advisory.applicable, true, key)
    assert.equal(advisory.passed, false, key)
    assert.equal(advisory.repairable, false, key)
    assert.ok(report.warnings.some(warning => warning.key === key), key)
  }
  assert.equal(report.metrics.titleCharacters, Array.from('Hướng dẫn').length)
  assert.equal(report.metrics.keywordOccurrences, 0)
  assert.equal(report.metrics.keywordDensity, 0)
  assert.equal(report.score, Math.ceil(report.passed / report.applicable * 100))
  assert.equal(report.warnings.some(warning => warning.repairable), false)
})

test('only malformed slugs and readability issues remain automatically repairable', () => {
  for (const slug of ['', 'Cách chọn cà phê']) {
    const slugFinding = finding(evaluateSeoFields({ ...article, slug }), 'lengthPermalink')
    assert.equal(slugFinding.passed, false, slug)
    assert.equal(slugFinding.repairable, true, slug)
  }
  const longSlug = finding(evaluateSeoFields({ ...article, slug: 'a'.repeat(76) }), 'lengthPermalink')
  assert.equal(longSlug.passed, false)
  assert.equal(longSlug.repairable, false)

  const longParagraph = finding(evaluateSeoFields({
    ...article,
    contentHtml: '<p>' + 'từ '.repeat(91) + '</p><p>Một đoạn khác.</p>',
  }), 'contentHasShortParagraphs')
  assert.equal(longParagraph.passed, false)
  assert.equal(longParagraph.repairable, true)
})

test('internal link finding states presence without claiming destination verification', () => {
  const report = evaluateSeoFields({ ...article, contentHtml: '<p><a href="/bai-viet">Tìm hiểu thêm về chủ đề</a></p>' })
  const link = finding(report, 'linksHasInternal')
  assert.equal(link.passed, true)
  assert.equal(link.repairable, false)
  assert.match(link.message, /chưa xác minh URL hoạt động hoặc nội dung trang đích phù hợp/)
})
