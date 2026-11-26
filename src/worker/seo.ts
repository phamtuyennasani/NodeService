import { Parser } from 'htmlparser2'

// Editorial checklist thresholds retained for CRM/widget API compatibility.
// They are not Google requirements or evidence of search ranking or content quality.
export const SEO_LIMITS = {
  title: { min: 41, max: 70 },
  metaDescription: { min: 155, max: 160 },
  contentWords: { min: 600, max: 2_500 },
  slugMax: 75,
  openingFraction: 0.1,
  titleKeywordFraction: 1 / 3,
  paragraphMaxWords: 90,
  density: { min: 0.75, max: 2.5 },
} as const

export const SEO_CRITERIA = {
  keywordNotUsed: 'Có từ khóa chính',
  keywordInTitle: 'Từ khóa chính trong tiêu đề SEO',
  titleStartWithKeyword: 'Từ khóa chính gần đầu tiêu đề SEO',
  lengthTitle: 'Độ dài tiêu đề SEO',
  keywordInMetaDescription: 'Từ khóa chính trong mô tả SEO',
  lengthMetaDescription: 'Độ dài mô tả SEO',
  keywordInPermalink: 'Từ khóa chính trong slug',
  lengthPermalink: 'Độ dài và định dạng slug',
  keywordIn10Percent: 'Từ khóa chính trong 10% đầu bài',
  keywordInContent: 'Từ khóa chính trong nội dung',
  lengthContent: 'Độ dài nội dung',
  linksHasInternal: 'Liên kết nội bộ',
  keywordInSubheadings: 'Từ khóa chính trong tiêu đề phụ',
  keywordInImageAlt: 'Từ khóa chính trong văn bản thay thế của ảnh',
  keywordDensity: 'Mật độ từ khóa chính',
  contentHasShortParagraphs: 'Các đoạn văn ngắn',
  contentHasAssets: 'Ảnh minh họa',
} as const

export type SeoCriterion = keyof typeof SEO_CRITERIA
export interface SeoFinding {
  key: SeoCriterion
  label: string
  applicable: boolean
  passed: boolean
  message: string
  repairable: boolean
}

export interface SeoReport {
  score: number
  passed: number
  applicable: number
  keywordPresent: boolean
  findings: SeoFinding[]
  warnings: SeoFinding[]
  metrics: {
    words: number
    titleCharacters: number
    metaDescriptionCharacters: number
    slugCharacters: number
    keywordOccurrences: number
    keywordDensity: number
    longestParagraphWords: number
  }
}

type SeoArticle = { Title: string; Description: string; Slug: string; Content: string }
export interface SeoInput {
  keyword: string
  title: string
  description: string
  slug: string
  contentHtml: string
  siteUrl?: string | null
  locale?: string
  /** Requested article budget; omitted by existing CMS integrations. */
  targetWords?: number
}

export function seoWordRange(targetWords?: number): { min: number; max: number } {
  const limits = SEO_LIMITS.contentWords
  if (!targetWords || !Number.isFinite(targetWords)) return { ...limits }
  const target = Math.max(limits.min, Math.min(limits.max, Math.round(targetWords)))
  return { min: Math.max(limits.min, Math.ceil(target * 85 / 100)), max: Math.min(limits.max, Math.floor(target * 115 / 100)) }
}

export function seoPromptGuidance(length: number): string[] {
  const { title, metaDescription, paragraphMaxWords, slugMax } = SEO_LIMITS
  const budget = seoWordRange(length)
  return [
    'Ưu tiên trả lời đúng nhu cầu và ý định tìm kiếm của người đọc bằng nội dung chính xác, liên quan và có giá trị bổ sung; không viết chỉ để đạt điểm SEO hoặc thu hút lượt tìm kiếm.',
    'Đáp ứng checklist biên tập của CRM bằng lời văn tự nhiên: Title dài ' + title.min + '–' + title.max + ' ký tự, Description dài ' + metaDescription.min + '–' + metaDescription.max + ' ký tự (tính cả khoảng trắng, đếm ký tự Unicode sau chuẩn hóa NFC). Title mô tả trung thực nội dung, rõ ràng, riêng biệt và không giật tít. Desc tóm tắt hữu ích cho người đọc. Description tóm tắt chính xác điều bài viết giải đáp; diễn đạt lại trọn câu để đúng khoảng ký tự, không cắt giữa câu hoặc thêm lời hứa thiếu căn cứ.',
    'Ngân sách TOÀN BỘ Content là ' + length + ' từ; phạm vi chấp nhận ' + budget.min + '–' + budget.max + ' từ, bao gồm mở bài, đề mục, bảng, danh sách và kết luận. Đếm từng đơn vị chữ/số cách nhau bằng khoảng trắng hoặc dấu câu; tiếng Việt “tên miền” được tính là 2 từ. Bám ngân sách từng phần của dàn ý, không nhân ngân sách cho từng H3. Giữ giải thích và ví dụ cụ thể, rút phần lặp nếu quá dài; bổ sung hướng dẫn hữu ích nếu quá ngắn. Không thêm câu cho đủ số từ hoặc cắt mất ý chính. Chia thành ít nhất hai đoạn p, mỗi đoạn không quá ' + paragraphMaxWords + ' từ.',
    'Dùng nguyên cụm từ khóa chính một lần trong Title, đặt ở đầu hoặc trong một phần ba đầu; một lần trong Description; trong đoạn mở thuộc 10% đầu Content; và trong ít nhất một h2 hoặc h3 mô tả đúng nội dung. Có thể đổi chữ hoa/thường nhưng không bỏ từ của cụm chính. Ở các đoạn còn lại dùng biến thể ngữ nghĩa tự nhiên, không nhồi từ khóa hoặc viết để đạt mật độ cố định. Nếu cụm từ khóa quá dài khiến các yêu cầu không thể đồng thời đạt, ưu tiên tiêu đề có nghĩa và tính chính xác; không bóp méo nội dung để che cảnh báo.',
    'Slug ngắn gọn, tối đa ' + slugMax + ' ký tự, chứa cụm từ khóa chính đã chuyển không dấu khi vừa giới hạn, viết thường và ngăn cách từ bằng dấu gạch ngang. Chỉ chèn liên kết nội bộ có thật, liên quan và giúp người đọc tìm hiểu thêm; dùng văn bản liên kết mô tả rõ trang đích. Không có URL phù hợp được cung cấp thì không tự tạo liên kết để lấy điểm.',
    'Tự kiểm tra độ dài metadata, tổng số từ, vị trí cụm từ khóa và đoạn văn trước khi trả JSON. Đây là checklist biên tập của sản phẩm, không phải yêu cầu của Google, kiểm chứng chất lượng hay bảo đảm thứ hạng. Mật độ từ khóa chỉ là số liệu tham khảo; không lặp cụm từ để đạt một tỷ lệ. Nội dung và metadata cần được người biên tập kiểm tra tính chính xác trước khi xuất bản.',
  ]
}

export function normalize(value: string, locale = 'vi'): string {
  const text = value.normalize('NFC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim()
  try {
    return text.toLocaleLowerCase(locale)
  } catch {
    return text.toLowerCase()
  }
}

export function slugify(value: string): string {
  return value.normalize('NFD').toLowerCase().replace(/(\p{Script=Latin})\p{Mark}+/gu, '$1').replace(/đ/g, 'd')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-').replace(/(^|-)\p{Mark}+/gu, '$1').replace(/^-+|-+$/g, '').normalize('NFC')
}

const blockTags = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'caption', 'dd', 'div', 'dl', 'dt',
  'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
])
const invisibleTags = new Set(['head', 'iframe', 'noscript', 'script', 'style', 'template'])
const isHeading = (tag: string) => /^h[2-6]$/.test(tag)

function inspectHtml(html: string) {
  const text: string[] = []
  const paragraphs: string[] = []
  const headings: string[] = []
  const links: string[] = []
  const sections: { tag: string; text: string[] }[] = []
  let hiddenDepth = 0

  function append(value: string) {
    text.push(value)
    for (const section of sections) section.text.push(value)
  }

  new Parser({
    onopentag(tag, attrs) {
      if (hiddenDepth || invisibleTags.has(tag) || Object.hasOwn(attrs, 'hidden')) {
        hiddenDepth += 1
        if (hiddenDepth === 1 && blockTags.has(tag)) append(' ')
        return
      }
      if (blockTags.has(tag)) append(' ')
      if (tag === 'a' && attrs.href) links.push(attrs.href)
      if (tag === 'p' || isHeading(tag)) sections.push({ tag, text: [] })
    },
    ontext(value) {
      if (!hiddenDepth) append(value)
    },
    onclosetag(tag) {
      if (hiddenDepth) {
        hiddenDepth -= 1
        return
      }
      if (tag === 'p' || isHeading(tag)) {
        const section = sections.pop()
        if (section) (tag === 'p' ? paragraphs : headings).push(section.text.join(''))
      }
      if (blockTags.has(tag)) append(' ')
    },
  }).end(html)

  return { text: text.join('').replace(/\s+/g, ' ').trim(), paragraphs, headings, links }
}

export function visibleText(html: string): string {
  return inspectHtml(html).text
}

function* words(text: string, locale = 'vi'): Generator<{ index: number }> {
  if (/^(ja|zh|th|lo|km|my)(-|$)/i.test(locale)) {
    for (const item of new Intl.Segmenter(locale, { granularity: 'word' }).segment(text)) {
      if (item.isWordLike) yield { index: item.index }
    }
  } else {
    for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)) yield { index: match.index }
  }
}
const size = (text: string) => Array.from(text.trim().normalize('NFC')).length
const inRange = (value: number, bounds: { min: number; max: number }) => value >= bounds.min && value <= bounds.max

function keywordPattern(keyword: string): RegExp | null {
  if (!keyword) return null
  const escaped = keyword.replace(/[.*+?^{}()|[\]\\$]/g, '\\$&')
  return new RegExp('(?<![\\p{L}\\p{M}\\p{N}])' + escaped + '(?![\\p{L}\\p{M}\\p{N}])', 'gu')
}

function linkUrl(href: string, base?: URL) {
  try {
    const url = new URL(href, base)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null
  } catch {
    return null
  }
}

function siteAddress(value?: string | null) {
  if (!value?.trim()) return null
  const site = value.trim()
  if (site.startsWith('//')) return linkUrl('https:' + site)
  return linkUrl(site.includes('://') ? site : 'https://' + site)
}

function isInternalLink(value: string, site: URL | null): boolean {
  const href = value.replace(/[\t\n\r]/g, '').trim()
  if (!href || /^[#?]/.test(href)) return false
  if (!site) {
    // An absolute URL cannot be compared without the site's hostname.
    const placeholder = new URL('https://example.invalid')
    return !/^(?:[a-z][a-z\d+.-]*:|[\\/]{2})/i.test(href) && linkUrl(href, placeholder)?.origin === placeholder.origin
  }
  const url = linkUrl(href, site)
  const hostname = (address: URL) => address.hostname.replace(/^www\./, '').replace(/\.$/, '')
  return Boolean(url && hostname(url) === hostname(site) && url.port === site.port)
}

function finding(key: SeoCriterion, passed: boolean, message: string, repairable = true, applicable = true): SeoFinding {
  return { key, label: SEO_CRITERIA[key], applicable, passed: applicable && passed, message, repairable: applicable && repairable }
}

export function evaluateSeoFields(input: SeoInput): SeoReport {
  const { locale, title, description, slug: rawSlug } = input
  const { title: titleLimit, metaDescription, slugMax, openingFraction, titleKeywordFraction, paragraphMaxWords, density } = SEO_LIMITS
  const contentWords = seoWordRange(input.targetWords)
  const keyword = normalize(input.keyword, locale)
  const keywordPresent = Boolean(keyword)
  const pattern = keywordPattern(keyword)
  const matches = (value: string) => pattern ? Array.from(value.matchAll(pattern)) : []
  const html = inspectHtml(input.contentHtml)
  const content = normalize(html.text, locale)
  const contentTokens = Array.from(words(content, locale))
  const openingEnd = contentTokens[Math.ceil(contentTokens.length * openingFraction)]?.index ?? content.length
  const contentMatches = matches(content)
  const normalizedTitle = normalize(title, locale)
  const titleMatch = matches(normalizedTitle)[0]
  const titleKeywordIndex = titleMatch ? Array.from(normalizedTitle.slice(0, titleMatch.index)).length : -1
  const titleKeywordCutoff = Math.ceil(size(normalizedTitle) * titleKeywordFraction)
  const slug = rawSlug.trim()
  const normalizedSlug = slugify(slug)
  const hasValidSlugFormat = Boolean(slug) && normalizedSlug === slug
  const keywordSlug = slugify(keyword)
  const site = siteAddress(input.siteUrl)
  const hasInternalLink = html.links.some(href => isInternalLink(href, site))
  const paragraphWords = html.paragraphs.map(text => Array.from(words(text, locale)).length).filter(Boolean)
  const metrics = {
    words: contentTokens.length,
    titleCharacters: size(title),
    metaDescriptionCharacters: size(description),
    slugCharacters: size(slug),
    keywordOccurrences: contentMatches.length,
    keywordDensity: contentTokens.length ? Number(((contentMatches.length / contentTokens.length) * 100).toFixed(2)) : 0,
    longestParagraphWords: paragraphWords.reduce((max, count) => Math.max(max, count), 0),
  }

  const findings = [
    finding('keywordNotUsed', keywordPresent, keywordPresent ? 'Đã có từ khóa chính.' : 'Nhập từ khóa chính để kiểm tra và tối ưu bài viết.', false),
    finding('keywordInTitle', Boolean(titleMatch), 'Checklist CRM: đặt nguyên cụm từ khóa chính trong tiêu đề mô tả đúng nội dung, dùng câu văn tự nhiên.'),
    finding('titleStartWithKeyword', titleKeywordIndex >= 0 && titleKeywordIndex < titleKeywordCutoff, 'Checklist CRM: đặt cụm từ khóa chính trong một phần ba đầu tiêu đề, giữ tiêu đề rõ nghĩa.'),
    finding('lengthTitle', inRange(metrics.titleCharacters, titleLimit), 'Tiêu đề SEO có ' + metrics.titleCharacters + ' ký tự. Mục tiêu CRM là ' + titleLimit.min + '–' + titleLimit.max + ' ký tự; diễn đạt lại tiêu đề đầy đủ, chính xác. Đây không phải giới hạn của Google.'),
    finding('keywordInMetaDescription', matches(normalize(description, locale)).length > 0, 'Checklist CRM: dùng nguyên cụm từ khóa chính một lần trong mô tả SEO đúng nội dung.'),
    finding('lengthMetaDescription', inRange(metrics.metaDescriptionCharacters, metaDescription), 'Mô tả SEO có ' + metrics.metaDescriptionCharacters + ' ký tự. Mục tiêu CRM là ' + metaDescription.min + '–' + metaDescription.max + ' ký tự; viết lại trọn câu, không cắt giữa câu hoặc thêm ý thiếu căn cứ. Đây không phải giới hạn của Google.'),
    finding('keywordInPermalink', Boolean(keywordSlug) && ('-' + normalizedSlug + '-').includes('-' + keywordSlug + '-'), 'Checklist CRM: dùng cụm từ khóa chính không dấu trong slug khi vừa giới hạn độ dài.', keywordSlug.length <= slugMax),
    finding('lengthPermalink', hasValidSlugFormat && metrics.slugCharacters <= slugMax, 'Slug có ' + metrics.slugCharacters + ' ký tự. Dùng slug có nội dung, không dấu, viết thường, ngăn từ bằng dấu gạch ngang và tối đa ' + slugMax + ' ký tự theo checklist CRM.'),
    finding('keywordIn10Percent', contentMatches.some(match => match.index + match[0].length <= openingEnd), 'Checklist CRM: dùng nguyên cụm từ khóa chính trong ' + (openingFraction * 100) + '% đầu bài, ở câu mở đầu trả lời đúng chủ đề.'),
    finding('keywordInContent', contentMatches.length > 0, 'Checklist CRM: đưa nguyên cụm từ khóa chính vào nội dung trong ngữ cảnh hữu ích, không lặp máy móc.'),
    finding('lengthContent', inRange(metrics.words, contentWords), 'Nội dung có ' + metrics.words + ' từ. ' + (input.targetWords ? 'Yêu cầu ' + input.targetWords + ' từ, phạm vi chấp nhận ' : 'Mục tiêu CRM là ') + contentWords.min + '–' + contentWords.max + ' từ. Giữ hướng dẫn và ví dụ hữu ích, loại phần lặp hoặc bổ sung giải thích cần thiết; không thêm nội dung đệm. Đây là ngân sách biên tập, không phải yêu cầu của Google.'),
    finding('linksHasInternal', hasInternalLink, hasInternalLink ? 'Phát hiện liên kết cùng website; chưa xác minh URL hoạt động hoặc nội dung trang đích phù hợp.' : site ? 'Chỉ thêm liên kết đến trang có thật, liên quan trên cùng website khi giúp ích cho người đọc; kiểm tra trang đích trước khi xuất bản.' : 'Chưa có thông tin tên miền để kiểm tra liên kết.', false, Boolean(site || hasInternalLink)),
    finding('keywordInSubheadings', html.headings.some(heading => matches(normalize(heading, locale)).length > 0), 'Checklist CRM: dùng nguyên cụm từ khóa chính trong ít nhất một h2 hoặc h3 mô tả đúng phần nội dung; không lặp ở mọi đề mục.'),
    finding('keywordInImageAlt', false, 'Chưa chấm văn bản thay thế của ảnh.', false, false),
    finding('keywordDensity', inRange(metrics.keywordDensity, density), 'Mật độ từ khóa hiện là ' + metrics.keywordDensity + '% (' + metrics.keywordOccurrences + ' lần). Khoảng ' + density.min + '–' + density.max + '% là ngưỡng tham khảo nội bộ, không phải mục tiêu bắt buộc hay yêu cầu của Google; ưu tiên câu văn tự nhiên.', false, keywordPresent && metrics.words > 0),
    finding('contentHasShortParagraphs', paragraphWords.length >= 2 && metrics.longestParagraphWords <= paragraphMaxWords, 'Gợi ý dễ đọc của CRM: chia ít nhất hai đoạn văn có nội dung, ưu tiên mỗi đoạn không quá ' + paragraphMaxWords + ' từ và giữ trọn ý. Đoạn dài nhất hiện có ' + metrics.longestParagraphWords + ' từ; đây không phải yêu cầu của Google.'),
    finding('contentHasAssets', false, 'Chưa chấm ảnh minh họa.', false, false),
  ]
  const applicable = findings.filter(item => item.applicable).length
  const passed = findings.filter(item => item.passed).length
  const warnings = findings.filter(item => item.applicable && !item.passed)
  const score = keywordPresent && applicable ? Math.ceil(passed / applicable * 100) : 0
  return { score, passed, applicable, keywordPresent, findings, warnings, metrics }
}

export function evaluateSeo(article: SeoArticle, options: Pick<SeoInput, 'keyword' | 'siteUrl' | 'locale' | 'targetWords'>): SeoReport {
  return evaluateSeoFields({
    ...options,
    title: article.Title,
    description: article.Description,
    slug: article.Slug,
    contentHtml: article.Content,
  })
}
