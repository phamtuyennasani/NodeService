import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluateSeoFields, seoPromptGuidance, seoWordRange, type SeoCriterion, type SeoInput, type SeoReport } from '../src/worker/seo.js'

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
  assert.equal(report.applicable, 6)
  assert.equal(finding(report, 'linksHasInternal').applicable, false)
  for (const key of ['keywordInImageAlt', 'contentHasAssets'] as const) {
    assert.equal(finding(report, key).applicable, false)
    assert.equal(report.warnings.some(warning => warning.key === key), false)
  }
  assert.equal(evaluateSeoFields({ ...article, keyword: '' }).score, 0)
})

test('SEO guidance aligns the CRM checklist with the requested budget without keyword stuffing', () => {
  const guidance = seoPromptGuidance(1_200).join('\n')
  assert.match(guidance, /nhu cầu và ý định tìm kiếm của người đọc/)
  assert.match(guidance, /chính xác, liên quan và có giá trị bổ sung/)
  assert.match(guidance, /1200 từ/)
  assert.match(guidance, /1020–1380 từ/)
  assert.match(guidance, /Không thêm câu cho đủ số từ hoặc cắt mất ý chính/)
  assert.match(guidance, /Không kéo dài hoặc cắt câu chỉ để khớp mốc ký tự/)
  assert.match(guidance, /không giật tít/)
  assert.match(guidance, /không bắt buộc lặp nguyên cụm trong Title/)
  assert.match(guidance, /Mở bài trả lời câu hỏi chính ngay/)
  assert.match(guidance, /thay cho lời dẫn chung chung/)
  assert.match(guidance, /Không nhồi từ khóa hoặc viết để đạt mật độ cố định/)
  assert.match(guidance, /không phải số từ Google ưu tiên/)
  assert.match(guidance, /người biên tập kiểm tra tính chính xác trước khi xuất bản/)
  assert.match(guidance, /Title 41–70/)
  assert.match(guidance, /Description 155–160/)
  assert.doesNotMatch(guidance, /mật độ từ khóa chính khoảng 1%/)
})

test('exact-match placement and legacy character counts are advisory and never trigger repair', () => {
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
    'keywordInSubheadings',
  ] as const
  for (const key of advisoryKeys) {
    const item = finding(report, key)
    assert.equal(item.applicable, false, key)
    assert.equal(item.passed, false, key)
    assert.equal(item.repairable, false, key)
    assert.equal(item.advisory, true, key)
    assert.ok(!report.warnings.some(warning => warning.key === key), key)
  }
  assert.equal(finding(report, 'lengthContent').repairable, true)
  assert.equal(report.metrics.titleCharacters, Array.from('Hướng dẫn').length)
  assert.equal(report.metrics.keywordOccurrences, 0)
  assert.equal(report.metrics.keywordDensity, 0)
  assert.equal(report.score, Math.ceil(report.passed / report.applicable * 100))
  assert.equal(finding(report, 'keywordDensity').repairable, false)
  assert.equal(finding(report, 'linksHasInternal').repairable, false)
})

test('natural metadata and synonyms receive the same score as exact-match wording', () => {
  const exact = evaluateSeoFields(article)
  const natural = evaluateSeoFields({ ...article, title: 'Chọn hương vị cho cốc uống buổi sáng', description: 'Tìm loại hạt và phương pháp pha phù hợp với sở thích.', slug: 'chon-huong-vi' })
  assert.equal(exact.score, natural.score)
  assert.equal(exact.applicable, natural.applicable)
  assert.equal(natural.version, 2)
  assert.equal(finding(natural, 'keywordInTitle').passed, false)
  assert.equal(finding(natural, 'keywordInTitle').advisory, true)
})

test('the checklist catches repeated paragraphs and skipped or duplicate heading levels', () => {
  const paragraph = '<p>Kiểm tra nguồn nước và chọn loại hạt phù hợp trước khi pha.</p>'
  const repeated = evaluateSeoFields({ ...article, contentHtml: paragraph.repeat(2) })
  assert.equal(finding(repeated, 'distinctParagraphs').passed, false)
  assert.equal(finding(repeated, 'distinctParagraphs').repairable, true)
  for (const headings of ['<h1>Tiêu đề lặp</h1>', '<h4>Bước đầu</h4>', '<h2> </h2>', '<h2>Bước đầu</h2><h4>Bước cuối</h4>', '<h2>Bước đầu</h2><h2>Bước đầu</h2>']) {
    assert.equal(finding(evaluateSeoFields({ ...article, contentHtml: headings + paragraph }), 'headingStructure').passed, false)
  }
  assert.equal(finding(evaluateSeoFields({ ...article, contentHtml: '<h2>Chuẩn bị</h2><h3>Chọn hạt</h3>' + paragraph }), 'headingStructure').passed, true)
})

test('slug length and readability can be repaired without forcing impossible keyword slugs', () => {
  for (const slug of ['', 'Cách chọn cà phê']) {
    const slugFinding = finding(evaluateSeoFields({ ...article, slug }), 'lengthPermalink')
    assert.equal(slugFinding.passed, false, slug)
    assert.equal(slugFinding.repairable, true, slug)
  }
  const longSlug = finding(evaluateSeoFields({ ...article, slug: 'a'.repeat(76) }), 'lengthPermalink')
  assert.equal(longSlug.passed, false)
  assert.equal(longSlug.repairable, true)
  const longKeyword = finding(evaluateSeoFields({ ...article, keyword: 'rất dài '.repeat(20) }), 'keywordInPermalink')
  assert.equal(longKeyword.passed, false)
  assert.equal(longKeyword.repairable, false)

  const longParagraph = finding(evaluateSeoFields({
    ...article,
    contentHtml: '<p>' + 'từ '.repeat(91) + '</p><p>Một đoạn khác.</p>',
  }), 'contentHasShortParagraphs')
  assert.equal(longParagraph.passed, false)
  assert.equal(longParagraph.repairable, true)
})

test('requested word budget uses inclusive integer bounds and keeps legacy limits when absent', () => {
  assert.deepEqual(seoWordRange(), { min: 600, max: 2500 })
  assert.deepEqual(seoWordRange(NaN), { min: 600, max: 2500 })
  assert.deepEqual(seoWordRange(1500), { min: 1275, max: 1725 })
  assert.deepEqual(seoWordRange(600), { min: 600, max: 690 })
  assert.deepEqual(seoWordRange(2500), { min: 2125, max: 2500 })
  for (const [count, passed] of [[1274, false], [1275, true], [1725, true], [1726, false]] as const) {
    const report = evaluateSeoFields({ ...article, targetWords: 1500, contentHtml: '<p>' + 'từ '.repeat(count) + '</p>' })
    assert.equal(report.metrics.words, count)
    assert.equal(finding(report, 'lengthContent').passed, passed, String(count))
    assert.match(finding(report, 'lengthContent').message, /Yêu cầu 1500 từ/)
  }
  const legacy = evaluateSeoFields({ ...article, contentHtml: '<p>' + 'từ '.repeat(2000) + '</p>' })
  const requested = evaluateSeoFields({ ...article, targetWords: 1500, contentHtml: '<p>' + 'từ '.repeat(2000) + '</p>' })
  assert.equal(finding(legacy, 'lengthContent').passed, true)
  assert.equal(finding(requested, 'lengthContent').passed, false)
})

test('internal link finding states presence without claiming destination verification', () => {
  const report = evaluateSeoFields({ ...article, contentHtml: '<p><a href="/bai-viet">Tìm hiểu thêm về chủ đề</a></p>' })
  const link = finding(report, 'linksHasInternal')
  assert.equal(link.passed, true)
  assert.equal(link.repairable, false)
  assert.match(link.message, /chưa xác minh URL hoạt động hoặc nội dung trang đích phù hợp/)
})
