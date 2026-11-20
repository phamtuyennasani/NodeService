import { Parser } from 'htmlparser2'

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

type SeoArticle = { Title: string; Desction: string; Slug: string; Content: string }
export interface SeoInput {
  keyword: string
  title: string
  description: string
  slug: string
  contentHtml: string
  siteUrl?: string | null
  locale?: string
}

export function seoPromptGuidance(length: number): string[] {
  const { title, metaDescription, contentWords, slugMax, openingFraction, paragraphMaxWords } = SEO_LIMITS
  return [
    'Dùng nguyên cụm từ khóa chính tự nhiên trong Title, Desction, Slug, Content và ít nhất một tiêu đề phụ h2, h3 hoặc h4. Dùng biến thể ngữ nghĩa ở các phần khác khi phù hợp, tránh nhồi từ khóa.',
    'Title dài ' + title.min + '–' + title.max + ' ký tự và khớp ý định tìm kiếm. Đặt từ khóa chính trong một phần ba đầu Title. Desc là tóm tắt hữu ích cho người đọc. Desction dài ' + metaDescription.min + '–' + metaDescription.max + ' ký tự và nêu rõ bài giải đáp gì.',
    'Content dài ' + contentWords.min + '–' + contentWords.max + ' từ, nên gần ' + length + ' từ nếu chủ đề phù hợp. Đặt từ khóa chính trong ' + (openingFraction * 100) + '% số từ đầu bài. Viết ít nhất hai đoạn p có nội dung, mỗi đoạn tối đa ' + paragraphMaxWords + ' từ.',
    'Slug chứa từ khóa chính ở dạng không dấu, viết thường, ngăn cách từ bằng dấu gạch ngang, dài tối đa ' + slugMax + ' ký tự.',
    'Tham khảo mật độ từ khóa chính khoảng 1% theo số lần xuất hiện trên tổng số từ. Chỉ thêm từ khóa ở vị trí có ích, dùng biến thể liên quan khi phù hợp; không lặp câu hoặc làm giảm độ tự nhiên để đạt tỷ lệ.',
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
  return value.normalize('NFD').toLowerCase().replace(/\p{Mark}/gu, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
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

const words = (text: string) => text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)
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
  const { title: titleLimit, metaDescription, contentWords, slugMax, openingFraction, titleKeywordFraction, paragraphMaxWords, density } = SEO_LIMITS
  const keyword = normalize(input.keyword, locale)
  const keywordPresent = Boolean(keyword)
  const pattern = keywordPattern(keyword)
  const matches = (value: string) => pattern ? Array.from(value.matchAll(pattern)) : []
  const html = inspectHtml(input.contentHtml)
  const content = normalize(html.text, locale)
  const contentTokens = Array.from(words(content))
  const openingEnd = contentTokens[Math.ceil(contentTokens.length * openingFraction)]?.index ?? content.length
  const contentMatches = matches(content)
  const normalizedTitle = normalize(title, locale)
  const titleMatch = matches(normalizedTitle)[0]
  const titleKeywordIndex = titleMatch ? Array.from(normalizedTitle.slice(0, titleMatch.index)).length : -1
  const titleKeywordCutoff = Math.ceil(size(normalizedTitle) * titleKeywordFraction)
  const slug = rawSlug.trim()
  const normalizedSlug = slugify(slug)
  const keywordSlug = slugify(keyword)
  const site = siteAddress(input.siteUrl)
  const hasInternalLink = html.links.some(href => isInternalLink(href, site))
  const paragraphWords = html.paragraphs.map(text => Array.from(words(text)).length).filter(Boolean)
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
    finding('keywordInTitle', Boolean(titleMatch), 'Đặt nguyên cụm từ khóa chính trong tiêu đề SEO.', keywordPresent),
    finding('titleStartWithKeyword', titleKeywordIndex >= 0 && titleKeywordIndex < titleKeywordCutoff, 'Đặt từ khóa chính trong một phần ba đầu tiêu đề SEO.', keywordPresent),
    finding('lengthTitle', inRange(metrics.titleCharacters, titleLimit), 'Tiêu đề SEO có ' + metrics.titleCharacters + ' ký tự. Mục tiêu là ' + titleLimit.min + '–' + titleLimit.max + ' ký tự.'),
    finding('keywordInMetaDescription', matches(normalize(description, locale)).length > 0, 'Đặt nguyên cụm từ khóa chính trong mô tả SEO.', keywordPresent),
    finding('lengthMetaDescription', inRange(metrics.metaDescriptionCharacters, metaDescription), 'Mô tả SEO có ' + metrics.metaDescriptionCharacters + ' ký tự. Mục tiêu là ' + metaDescription.min + '–' + metaDescription.max + ' ký tự.'),
    finding('keywordInPermalink', Boolean(keywordSlug) && ('-' + normalizedSlug + '-').includes('-' + keywordSlug + '-'), 'Thêm từ khóa chính không dấu vào slug.', Boolean(keywordSlug)),
    finding('lengthPermalink', Boolean(slug) && normalizedSlug === slug && metrics.slugCharacters <= slugMax, 'Slug có ' + metrics.slugCharacters + ' ký tự. Dùng 1–' + slugMax + ' ký tự không dấu, viết thường và ngăn từ bằng dấu gạch ngang.'),
    finding('keywordIn10Percent', contentMatches.some(match => match.index + match[0].length <= openingEnd), 'Đặt cụm từ khóa chính trong ' + (openingFraction * 100) + '% số từ đầu bài.', keywordPresent),
    finding('keywordInContent', contentMatches.length > 0, 'Dùng nguyên cụm từ khóa chính ở vị trí phù hợp trong nội dung.', keywordPresent),
    finding('lengthContent', inRange(metrics.words, contentWords), 'Nội dung có ' + metrics.words + ' từ. Mục tiêu là ' + contentWords.min + '–' + contentWords.max + ' từ.'),
    finding('linksHasInternal', hasInternalLink, hasInternalLink ? 'Đã có liên kết nội bộ.' : site ? 'Thêm liên kết đến một trang có thật và liên quan trên cùng website.' : 'Chưa có thông tin tên miền để kiểm tra liên kết.', false, Boolean(site || hasInternalLink)),
    finding('keywordInSubheadings', html.headings.some(heading => matches(normalize(heading, locale)).length > 0), 'Đặt từ khóa chính tự nhiên trong một tiêu đề phụ.', keywordPresent),
    finding('keywordInImageAlt', false, 'Chưa chấm văn bản thay thế của ảnh.', false, false),
    finding('keywordDensity', inRange(metrics.keywordDensity, density), 'Mật độ từ khóa hiện là ' + metrics.keywordDensity + '% (' + metrics.keywordOccurrences + ' lần). Tham khảo khoảng ' + density.min + '–' + density.max + '%, ưu tiên câu văn tự nhiên.', false, keywordPresent && metrics.words > 0),
    finding('contentHasShortParagraphs', paragraphWords.length >= 2 && metrics.longestParagraphWords <= paragraphMaxWords, 'Dùng ít nhất hai đoạn văn có nội dung, mỗi đoạn tối đa ' + paragraphMaxWords + ' từ. Đoạn dài nhất hiện có ' + metrics.longestParagraphWords + ' từ.'),
    finding('contentHasAssets', false, 'Chưa chấm ảnh minh họa.', false, false),
  ]
  const applicable = findings.filter(item => item.applicable).length
  const passed = findings.filter(item => item.passed).length
  const warnings = findings.filter(item => item.applicable && !item.passed)
  const score = keywordPresent && applicable ? Math.ceil(passed / applicable * 100) : 0
  return { score, passed, applicable, keywordPresent, findings, warnings, metrics }
}

export function evaluateSeo(article: SeoArticle, options: Pick<SeoInput, 'keyword' | 'siteUrl' | 'locale'>): SeoReport {
  return evaluateSeoFields({
    ...options,
    title: article.Title,
    description: article.Desction,
    slug: article.Slug,
    contentHtml: article.Content,
  })
}
