import { z } from 'zod'

export const keywordMarkets = {
  VN: { name: 'Việt Nam', country: 'Vietnam', location: 2704 },
  US: { name: 'Hoa Kỳ', country: 'United States', location: 2840 },
  JP: { name: 'Nhật Bản', country: 'Japan', location: 2392 },
  KR: { name: 'Hàn Quốc', country: 'South Korea', location: 2410 },
  CN: { name: 'Trung Quốc', country: 'China', location: 2156 },
  LA: { name: 'Lào', country: 'Laos', location: 2418 },
  KH: { name: 'Campuchia', country: 'Cambodia', location: 2116 },
  RU: { name: 'Nga', country: 'Russia', location: 2643 },
} as const
export const keywordLanguages = {
  vi: { name: 'Tiếng Việt', source: 'Vietnamese' }, en: { name: 'English', source: 'English' },
  ja: { name: '日本語', source: 'Japanese' }, ko: { name: '한국어', source: 'Korean' },
  'zh-CN': { name: '简体中文', source: 'Chinese Simplified (China)' },
  lo: { name: 'ລາວ', source: 'Lao' }, km: { name: 'ខ្មែរ', source: 'Khmer' }, ru: { name: 'Русский', source: 'Russian' },
} as const
export const keywordInputSchema = z.object({
  website_id: z.string().uuid(), client_request_id: z.string().uuid(),
  seed: z.string().trim().min(1).max(80),
  business: z.string().trim().max(1500).default(''),
  audience: z.string().trim().max(300).default(''),
  country: z.enum(Object.keys(keywordMarkets) as [keyof typeof keywordMarkets, ...(keyof typeof keywordMarkets)[]]).default('VN'),
  locale: z.enum(Object.keys(keywordLanguages) as [keyof typeof keywordLanguages, ...(keyof typeof keywordLanguages)[]]).default('vi'),
  type: z.enum(['suggestions', 'questions', 'prepositions']).default('suggestions'),
  ai_model: z.string().trim().min(1).max(160).optional(),
}).strict()
export type KeywordInput = z.infer<typeof keywordInputSchema>
export interface KeywordCandidate {
  id: string; keyword: string; source_rank: number
  volume: number | null; trend: number | null; ads_competition: number | null
  bid_low: number | null; bid_high: number | null
  metrics_status: 'available' | 'unavailable'
}
export interface KeywordSuggestion {
  candidate_id: string; related_ids: string[]; title: string; intent: string; angle: string; reason: string
}
export interface KeywordSourceResult {
  candidates: KeywordCandidate[]; total_count: number; partial: boolean
  source: 'keywordtool_guest' | 'keywordtool_api'; fetched_at: string
  country: string; language: string
  metrics_scope: 'unverified_cache' | 'requested_market'
}
export interface KeywordAnalysisView {
  id: string; website_id: string; customer_id: string; input: KeywordInput
  status: 'queued' | 'running' | 'ready' | 'partial' | 'failed' | 'canceled'
  stage: 'source' | 'ai' | 'done'; created_at: string; completed_at: string | null
  result: KeywordSourceResult | null; suggestions: KeywordSuggestion[]
  error: string | null; ai_note: string | null; reused: boolean
  source_cost: 'free' | 'subscription'; ai_cost_usd: string | null; ai_called: boolean
}
export const keywordAiSchema = z.object({
  suggestions: z.array(z.object({
    candidate_id: z.string().max(80), related_ids: z.array(z.string().max(80)).max(4),
    title: z.string().trim().min(1).max(240), intent: z.string().trim().min(1).max(160),
    angle: z.string().trim().min(1).max(350), reason: z.string().trim().min(1).max(500),
  }).strict()).min(1).max(20),
}).strict()
