import { collection, sessionOf, type MongoSource } from '../db.js'
import { ApiError } from '../api/errors.js'
import type { KeywordAnalysis } from './service.js'

export interface KeywordSelection { analysis_id: string; candidate_id: string }
export interface KeywordBrief {
  analysis_id: string; keyword: string; locale: string; country: string; related_keywords: string[]
  title: string | null; intent: string | null; angle: string | null; source: string
}
export async function loadKeywordBrief(db: MongoSource, siteId: string, customerId: string, selection: KeywordSelection,
  keyword: string, locale: string): Promise<KeywordBrief> {
  const row = await collection<KeywordAnalysis>(db, 'keyword_analyses').findOne({ _id: selection.analysis_id,
    site_id: siteId, customer_id: customerId, status: { $in: ['ready', 'partial'] },
  }, { session: sessionOf(db) })
  const candidate = row?.result?.candidates.find(c => c.id === selection.candidate_id)
  if (!row || !candidate || candidate.keyword.normalize('NFC') !== keyword.trim().normalize('NFC') || row.input.locale !== locale) {
    throw new ApiError(409, 'keyword_selection_changed', 'Đề xuất không thuộc website, ngôn ngữ hoặc từ khóa đang viết. Hãy chọn lại hoặc bỏ liên kết đề xuất.')
  }
  const suggestion = row.suggestions.find(s => s.candidate_id === candidate.id)
  return { analysis_id: row._id, keyword: candidate.keyword, locale, country: row.input.country,
    related_keywords: row.result!.candidates.filter(c => suggestion?.related_ids.includes(c.id)).map(c => c.keyword),
    title: suggestion?.title ?? null, intent: suggestion?.intent ?? null, angle: suggestion?.angle ?? null,
    source: row.result!.source }
}
