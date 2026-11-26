export interface LanguageConfig {
  source: string
  targets: string[]
}

/** Canonical BCP 47 tags, with a bounded set of content locales (no extensions). */
export function languageTag(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/i.test(value)) {
    throw new Error('Mã ngôn ngữ không hợp lệ. Dùng mã như en, vi, en-US hoặc zh-Hant.')
  }
  const locale = Intl.getCanonicalLocales(value)[0]
  if (!locale || /^(und|zxx)(-|$)/i.test(locale)) throw new Error('Cần một ngôn ngữ nội dung cụ thể.')
  return locale
}

export function languageConfig(value: unknown): LanguageConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Cần cấu hình languages.source và languages.targets.')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some(key => !['source', 'targets'].includes(key)) || !Array.isArray(input.targets) || input.targets.length > 10) {
    throw new Error('Cấu hình ngôn ngữ chỉ gồm source và tối đa 10 targets.')
  }
  const source = languageTag(input.source)
  const targets = input.targets.map(languageTag)
  if (new Set([source, ...targets]).size !== targets.length + 1) throw new Error('Ngôn ngữ gốc và các ngôn ngữ đích không được trùng nhau.')
  return { source, targets }
}
