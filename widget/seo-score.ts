import { evaluateSeoFields, normalize, SEO_CRITERIA, SEO_LIMITS, slugify, visibleText } from '../src/worker/seo.js'

const text = (value: unknown) => value === null || value === undefined ? '' : String(value)

function evaluate(value?: unknown) {
  const fields = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const keyword = text(fields.keyword).trim()
  const report = evaluateSeoFields({
    keyword,
    title: text(fields.title),
    description: text(fields.description),
    slug: text(fields.slug),
    contentHtml: text(fields.contentHtml),
    siteUrl: text(fields.siteHost),
    locale: text(fields.locale) || 'vi',
  })
  const { metrics } = report
  return {
    ...report,
    keyword,
    stats: {
      titleLength: metrics.titleCharacters,
      descriptionLength: metrics.metaDescriptionCharacters,
      contentLength: metrics.words,
      permalinkLength: metrics.slugCharacters,
      keywordOccurrences: metrics.keywordOccurrences,
      keywordDensity: metrics.keywordDensity,
    },
    summary: report.keywordPresent ? 'Xem các gợi ý tối ưu bên dưới.' : 'Nhập từ khóa chính để bắt đầu đánh giá.',
  }
}

const api = {
  criteria: Object.entries(SEO_CRITERIA).map(([key, label]) => ({ key, label })),
  limits: SEO_LIMITS,
  normalize: (value: unknown, locale?: string) => normalize(text(value), locale),
  slugify: (value: unknown) => slugify(text(value)),
  visibleText: (value: unknown) => visibleText(text(value)),
  evaluate,
}

Object.assign(typeof window === 'undefined' ? globalThis : window, { SeoScore: api })
