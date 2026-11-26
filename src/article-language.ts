import { z } from 'zod'
import { languageConfig, languageTag, type LanguageConfig } from './language-config.js'

export const languageConfigSchema = z.unknown().transform((value, ctx) => {
  try { return languageConfig(value) }
  catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER }
})
export const localeSchema = z.string().transform((value, ctx) => {
  try { return languageTag(value) }
  catch (error) { ctx.addIssue({ code: 'custom', message: (error as Error).message }); return z.NEVER }
})
export const translationSourceSchema = z.object({
  Title: z.string().trim().min(1).max(350),
  Content: z.string().trim().min(1).max(120_000),
  Desc: z.string().max(1_000).optional(),
  Description: z.string().max(1_000).optional(),
  Keywords: z.array(z.string().trim().min(1).max(300)).max(50).optional(),
}).strict()
export type TranslationSource = z.infer<typeof translationSourceSchema>
export interface LanguageWriting {
  languages?: LanguageConfig
  locale?: string
  translation_source?: TranslationSource
}

export function validateWritingLanguage(input: LanguageWriting, rewrite = false): void {
  if (!input.languages) {
    if (input.locale || input.translation_source) throw new Error('Cần gửi languages cùng locale hoặc translation_source.')
    return
  }
  const locale = input.locale ?? input.languages.source
  if (![input.languages.source, ...input.languages.targets].includes(locale)) throw new Error('Ngôn ngữ viết phải thuộc danh sách ngôn ngữ của website.')
  if (locale === input.languages.source && input.translation_source) throw new Error('Bản gốc không nhận dữ liệu chuyển ngữ.')
  if (locale !== input.languages.source && !input.translation_source && !rewrite) throw new Error('Cần nội dung bản gốc đã duyệt để tạo bản dịch.')
}

export function articleLocale(input: LanguageWriting): string {
  return input.locale ?? input.languages?.source ?? 'vi'
}

export function languageMetadata(input: LanguageWriting): LanguageWriting {
  return { ...languageSummary(input), ...(input.translation_source ? { translation_source: input.translation_source } : {}) }
}

/** Status polling must never echo the entire source article on every request. */
export function languageSummary(input: LanguageWriting): Pick<LanguageWriting, 'languages' | 'locale'> {
  return input.languages ? { languages: input.languages, locale: articleLocale(input) } : {}
}
