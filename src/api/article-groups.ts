import type { Database } from '../db.js'
import { collection } from '../db.js'
import { articleLocale } from '../article-language.js'

type Row = Record<string, any>

/** Positive projection keeps source HTML, tokens and provider credentials out of group listings. */
export async function articleGroupRows(db: Database, scope: { customer_id?: string; website_id?: string }) {
  const [jobs, sites, customers] = await Promise.all([
    collection<Row>(db, 'jobs').find({
      ...(scope.customer_id ? { customer_id: scope.customer_id } : {}),
      ...(scope.website_id ? { site_id: scope.website_id } : {}),
    }, { projection: {
      _id: 1, site_id: 1, customer_id: 1, article_group_id: 1, article_ref: 1, original_locale: 1,
      translation_of_job_id: 1, original_job_id: 1, source_article_id: 1, retry_of_job_id: 1, languages: 1, locale: 1,
      'translation_source.Title': 1, 'result.Title': 1, status: 1, mode: 1, keyword: 1,
      provider: 1, model: 1, tone: 1, style: 1, length: 1, key_mode: 1, writing_stage: 1,
      created_at: 1, updated_at: 1, completed_at: 1, scheduled_at: 1, started_at: 1,
    } }).toArray(),
    collection<Row>(db, 'sites').find(scope.website_id ? { _id: scope.website_id } : {}, { projection: { _id: 1, name: 1, domain: 1 } }).toArray(),
    collection<Row>(db, 'customers').find(scope.customer_id ? { _id: scope.customer_id } : {}, { projection: { _id: 1, name: 1 } }).toArray(),
  ])
  const siteMap = new Map(sites.map(row => [row._id, row]))
  const customerMap = new Map(customers.map(row => [row._id, row]))
  return jobs.map(row => ({ ...row, site: siteMap.get(row.site_id), customer: customerMap.get(row.customer_id) }))
}

const stamp = (value: unknown) => value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) || 0 : 0
const iso = (value: number) => new Date(value).toISOString()

/** Group before pagination so interleaved websites and request order cannot split an article. */
export function groupArticleRows(rows: Row[], report: (row: Row) => unknown) {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const groupId = row.article_group_id ?? row._id
    const key = `${row.customer_id}:${row.site_id}:${groupId}`
    const existing = groups.get(key) ?? []
    existing.push(row)
    groups.set(key, existing)
  }
  return [...groups.entries()].map(([key, members]) => {
    const chronological = [...members].sort((a, b) => stamp(a.created_at) - stamp(b.created_at) || String(a._id).localeCompare(String(b._id)))
    const first = chronological[0]
    const sourceLocale = first.original_locale ?? first.languages?.source ?? articleLocale(first)
    const originals = chronological.filter(row => articleLocale(row) === sourceLocale && !row.translation_source && !row.translation_of_job_id)
    const original = originals[0]
    const sourceSnapshot = chronological.find(row => row.translation_source?.Title)?.translation_source
    const latestSource = chronological.filter(row => row.translation_source?.Title || (articleLocale(row) === sourceLocale && row.result?.[0]?.Title)).at(-1)
    const latest = new Map<string, Row>()
    for (const row of chronological) latest.set(articleLocale(row), row)
    const locales = [...latest.keys()].sort((a, b) => a === sourceLocale ? -1 : b === sourceLocale ? 1 : a.localeCompare(b))
    const versions = [...chronological].sort((a, b) => locales.indexOf(articleLocale(a)) - locales.indexOf(articleLocale(b)) || stamp(a.created_at) - stamp(b.created_at))
    const groupId = first.article_group_id ?? first._id
    return {
      group_key: key, article_group_id: groupId, article_ref: chronological.find(row => row.article_ref)?.article_ref ?? null,
      website_id: first.site_id, website_name: first.site?.name ?? '', website_domain: first.site?.domain ?? '',
      customer_id: first.customer_id, customer_name: first.customer?.name ?? '', original_locale: sourceLocale,
      original_job_id: original?._id ?? null,
      original_title: latestSource?.translation_source?.Title ?? latestSource?.result?.[0]?.Title ?? original?.result?.[0]?.Title ?? sourceSnapshot?.Title ?? original?.keyword ?? first.keyword,
      source_kind: original ? 'crm' : 'website', legacy: !first.article_group_id && !first.article_ref,
      versions: members.length,
      locales: locales.map(locale => ({ locale, job_id: latest.get(locale)!._id, status: latest.get(locale)!.status === 'ready' ? 'completed' : latest.get(locale)!.status })),
      jobs: versions.slice(0, 50).map(report),
      created_at: iso(stamp(first.created_at)), updated_at: iso(members.reduce((latest, row) => Math.max(latest, stamp(row.updated_at ?? row.created_at)), 0)),
      cursor_at: iso(stamp(first.created_at)), cursor_id: groupId,
    }
  })
}
