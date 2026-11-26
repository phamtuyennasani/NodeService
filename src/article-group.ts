import { z } from 'zod'
import { collection, sessionOf, type TransactionContext } from './db.js'
import { ApiError, idSchema, notFound } from './api/errors.js'
import { articleLocale, type LanguageWriting } from './article-language.js'

export const articleRefSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/)
export interface ArticleIdentity {
  article_ref?: string | null
  article_group_id?: string
  original_locale?: string
  original_job_id?: string | null
  translation_of_job_id?: string | null
}
export const articleIdentityFields = {
  article_ref: articleRefSchema.optional(),
  translation_of_job_id: idSchema.optional(),
}

export function articleIdentity(row: ArticleIdentity & LanguageWriting & { _id?: string }) {
  return {
    article_group_id: row.article_group_id ?? row._id,
    article_ref: row.article_ref ?? null,
    original_locale: row.original_locale ?? row.languages?.source ?? articleLocale(row),
    original_job_id: row.original_job_id ?? null,
    translation_of_job_id: row.translation_of_job_id ?? null,
  }
}

/** Caller holds both site and customer write locks, including across API replicas. */
export async function resolveArticleIdentity(
  source: TransactionContext, site: { id: string; customer_id: string }, jobId: string,
  writing: LanguageWriting & ArticleIdentity, sourceId?: string, retryId?: string,
): Promise<ArticleIdentity> {
  const jobs = collection<any>(source, 'jobs')
  const session = sessionOf(source)
  const scope = { site_id: site.id, customer_id: site.customer_id }
  if (writing.translation_of_job_id && !writing.translation_source) throw new ApiError(400, 'invalid_translation_parent', 'Chỉ bản dịch mới được chỉ định lần viết gốc.')
  const ids = [sourceId, retryId, writing.translation_of_job_id].filter((id): id is string => Boolean(id))
  const ancestors = await Promise.all(ids.map(id => jobs.findOne({ _id: id, ...scope }, { session })))
  if (ancestors.some(row => !row)) throw notFound()
  const original = writing.translation_of_job_id ? ancestors[ids.indexOf(writing.translation_of_job_id)] : null
  const sourceLocale = writing.languages?.source ?? ancestors[0]?.original_locale ?? ancestors[0]?.languages?.source ?? 'vi'
  if (original && (original.status !== 'ready' || articleLocale(original) !== sourceLocale || original.translation_source)) {
    throw new ApiError(409, 'invalid_translation_parent', 'Lần viết gốc phải hoàn tất và thuộc ngôn ngữ gốc của bài.')
  }
  const inherited = ancestors[0]
  const reference = writing.article_ref ?? inherited?.article_ref ?? null
  const existing = reference ? await jobs.findOne({ ...scope, article_ref: reference }, { session }) : null
  const related = [...ancestors, ...(existing ? [existing] : [])]
  // Old retries already have an explicit rewrite parent, but predate group IDs.
  const relatedById = new Map(related.map(row => [row._id, row]))
  const groupOf = (row: any) => {
    const seen = new Set<string>()
    while (!row.article_group_id && row.source_article_id && relatedById.has(row.source_article_id) && !seen.has(row._id)) {
      seen.add(row._id)
      row = relatedById.get(row.source_article_id)
    }
    return row.article_group_id ?? row._id
  }
  const groups = new Set(related.map(groupOf))
  if (groups.size > 1 || related.some(row => row.article_ref && reference && row.article_ref !== reference)) {
    throw new ApiError(409, 'article_group_conflict', 'Mã bài và lần viết gốc đang thuộc các nhóm bài khác nhau.')
  }
  if (related.some(row => (row.original_locale ?? row.languages?.source ?? articleLocale(row)) !== sourceLocale)) {
    throw new ApiError(409, 'article_language_conflict', 'Ngôn ngữ gốc của nhóm bài đã được xác định. Hãy dùng lại ngôn ngữ gốc đó.')
  }
  const groupId = related.length ? groupOf(related[0]) : jobId
  const firstOriginal = related.length ? await jobs.findOne({ ...scope, article_group_id: groupId, locale: sourceLocale, translation_source: { $exists: false } }, { session }) : null
  const root = firstOriginal?.original_job_id ?? firstOriginal?._id ?? existing?.original_job_id ?? inherited?.original_job_id
    ?? (original ? original._id : sourceId && inherited && !inherited.translation_source ? inherited._id : null)
    ?? (!writing.translation_source && (writing.locale ?? sourceLocale) === sourceLocale ? jobId : null)
  return {
    article_group_id: groupId,
    article_ref: reference,
    original_locale: sourceLocale,
    original_job_id: root,
    translation_of_job_id: original?._id ?? null,
  }
}
