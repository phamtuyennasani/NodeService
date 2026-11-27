/** Use a result's localized focus keyword without confusing it with related keywords. */
export function articleFocusKeyword(article: unknown, fallback: string): string {
  if (!article || typeof article !== 'object' || Array.isArray(article)) return fallback
  const keyword = (article as Record<string, unknown>).FocusKeyword
  return typeof keyword === 'string' && keyword.trim() ? keyword.trim() : fallback
}
