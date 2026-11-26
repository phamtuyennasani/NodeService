import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { registerPublic } from '../src/api/public.js'
import { registerCustomers } from '../src/api/crm-customers.js'
import { installErrorHandler } from '../src/api/errors.js'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { digest } from '../src/security.js'
import { normalizeInternalUrl, rankInternalLinkCandidates, refreshInternalLinkCandidates, selectInternalLinkCandidates, siteContentSearchTerms } from '../src/site-content.js'
import { ContentCatalogError, type CatalogSyncOptions } from '../src/site-content-pull.js'

type Row = Record<string, any>
type Tables = Record<string, Row[]>

function memoryDatabase(tables: Tables) {
  const calls: { table: string, action: string, filter: Row, session?: unknown }[] = []
  let onTransaction: (() => void) | undefined
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((branch: Row) => matches(row, branch))
    const actual = row[key]
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$exists' in value && Object.hasOwn(row, key) !== value.$exists) return false
      if ('$lt' in value && !(actual < value.$lt)) return false
      if ('$lte' in value && !(actual <= value.$lte)) return false
      if ('$gt' in value && !(actual > value.$gt)) return false
      if ('$ne' in value && actual === value.$ne) return false
      if ('$in' in value && !(Array.isArray(actual) ? actual.some(item => value.$in.includes(item)) : value.$in.includes(actual))) return false
      if ('$nin' in value && value.$nin.includes(actual)) return false
      return true
    }
    return actual === value
  })
  const apply = (row: Row, update: Row) => {
    Object.assign(row, structuredClone(update.$set ?? {}))
    for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(value)
    for (const key of Object.keys(update.$unset ?? {})) delete row[key]
  }
  const session = {
    async withTransaction<T>(run: () => Promise<T>) {
      onTransaction?.()
      onTransaction = undefined
      const before = structuredClone(tables)
      try { return await run() } catch (error) {
        for (const key of Object.keys(tables)) delete tables[key]
        Object.assign(tables, before)
        throw error
      }
    },
    async endSession() {},
  }
  const db = { client: { async connect() {}, startSession: () => session }, db: { collection(name: string) {
    const rows = () => tables[name] ??= []
    return {
      async findOne(filter: Row, options: Row = {}) {
        calls.push({ table: name, action: 'findOne', filter, session: options.session })
        return structuredClone(rows().find(row => matches(row, filter)) ?? null)
      },
      find(filter: Row, options: Row = {}) {
        calls.push({ table: name, action: 'find', filter, session: options.session })
        let order: Row = {}; let take = Infinity
        const query = {
          sort(value: Row) { order = value; return query },
          limit(value: number) { take = value; return query },
          async toArray() {
            return structuredClone(rows().filter(row => matches(row, filter)).sort((a, b) => {
              for (const [key, direction] of Object.entries(order)) {
                if (a[key] < b[key]) return -Number(direction)
                if (a[key] > b[key]) return Number(direction)
              }
              return 0
            }).slice(0, take))
          },
        }
        return query
      },
      async updateOne(filter: Row, update: Row, options: Row = {}) {
        calls.push({ table: name, action: 'updateOne', filter, session: options.session })
        let row = rows().find(row => matches(row, filter))
        if (!row && options.upsert) {
          row = { ...filter, ...structuredClone(update.$setOnInsert ?? {}) }
          rows().push(row!)
        }
        if (!row) return { matchedCount: 0 }
        apply(row!, update)
        if (name === 'site_content' && rows().some(other => other !== row && other.site_id === row.site_id && other.customer_id === row.customer_id && (other.external_id === row.external_id || other.url === row.url))) throw Object.assign(new Error('Duplicate'), { code: 11000 })
        return { matchedCount: 1 }
      },
      async findOneAndUpdate(filter: Row, update: Row, options: Row = {}) {
        calls.push({ table: name, action: 'findOneAndUpdate', filter, session: options.session })
        const row = rows().find(row => matches(row, filter))
        if (!row) return null
        apply(row, update)
        return structuredClone(row)
      },
      async insertMany(documents: Row[], options: Row = {}) {
        calls.push({ table: name, action: 'insertMany', filter: {}, session: options.session })
        rows().push(...structuredClone(documents))
        return { insertedCount: documents.length }
      },
      async insertOne(row: Row) { rows().push(structuredClone(row)); return { insertedId: row._id } },
      async countDocuments(filter: Row) { return rows().filter(row => matches(row, filter)).length },
      async deleteOne(filter: Row, options: Row = {}) {
        calls.push({ table: name, action: 'deleteOne', filter, session: options.session })
        const index = rows().findIndex(row => matches(row, filter))
        if (index < 0) return { deletedCount: 0 }
        rows().splice(index, 1); return { deletedCount: 1 }
      },
      async deleteMany(filter: Row, options: Row = {}) {
        calls.push({ table: name, action: 'deleteMany', filter, session: options.session })
        const keep = rows().filter(row => !matches(row, filter)); const deletedCount = rows().length - keep.length
        tables[name] = keep; return { deletedCount }
      },
    }
  } } } as unknown as Database
  return { db, calls, session, beforeTransaction(fn: () => void) { onTransaction = fn } }
}

async function fixture(t: test.TestContext, catalogDependencies: Pick<CatalogSyncOptions, 'fetchCatalog'> = {}) {
  const token = 'site-content-fixture-token'
  const otherToken = 'other-site-fixture-token'
  const siteId = randomUUID(); const customerId = randomUUID(); const otherSiteId = randomUUID()
  const tables: Tables = {
    sites: [
      { _id: siteId, customer_id: customerId, token_hash: digest(token), domain: 'example.vn', name: 'Fixture', webhook_url: 'http://127.0.0.1/hook' },
      { _id: otherSiteId, customer_id: 'other-customer', token_hash: digest(otherToken), domain: 'other.example', name: 'Other' },
    ],
    customers: [{ _id: customerId, key_mode: 'own' }, { _id: 'other-customer', key_mode: 'service' }],
    site_content: [], jobs: [],
  }
  const memory = memoryDatabase(tables)
  const app = Fastify({ bodyLimit: 1024 * 1024 })
  installErrorHandler(app)
  const config = { encryptionKey: Buffer.alloc(32, 5), allowLocalWebhooks: true, serviceKeys: {} } as Config
  registerPublic(app, memory.db, config)
  registerCustomers(app, memory.db, config, catalogDependencies)
  await app.ready(); t.after(() => app.close())
  const headers = { authorization: 'Bearer ' + token }
  const post = (items: Row[], extra?: Row) => app.inject({ method: 'POST', url: '/v1/site-content', headers, payload: { items, ...extra } })
  return { app, tables, ...memory, headers, post, token, otherToken, siteId, customerId, otherSiteId }
}

const item = (id = 'post:1', url = 'https://example.vn/cach-chon-may-loc-nuoc') => ({ id, url, title: 'Cách chọn máy lọc nước', summary: 'Chọn máy lọc nước theo nhu cầu gia đình.', categories: ['Thiết bị gia đình'] })

test('site content upserts published metadata without replacing the tenant catalog or consuming quota', async t => {
  const f = await fixture(t)
  assert.equal((await f.post([item()])).statusCode, 200)
  assert.equal((await f.post([item('post:2', 'https://example.vn/bao-duong')])).statusCode, 200)
  assert.equal((await f.post([{ ...item(), title: 'Máy lọc nước gia đình', summary: '' }])).statusCode, 200)
  assert.equal(f.tables.site_content.length, 2)
  assert.ok(f.tables.sites[0]!.site_content_synced_at instanceof Date)
  assert.equal(f.tables.site_content.find(row => row.external_id === 'post:1')!.summary, '')
  for (const row of f.tables.site_content) {
    assert.equal(row.site_id, f.siteId); assert.equal(row.customer_id, f.customerId)
    assert.ok(row.created_at instanceof Date); assert.ok(row.updated_at instanceof Date)
    assert.ok(row.search_terms.includes('loc'))
  }
  assert.equal(f.calls.some(call => ['quota_reservations', 'ai_attempts'].includes(call.table)), false)
  const catalogWrites = f.calls.filter(call => call.table === 'site_content' && call.action === 'updateOne')
  assert.ok(catalogWrites.every(call => call.session === f.session))
})

test('site catalog list and idempotent delete isolate site and customer and page by stable external id', async t => {
  const f = await fixture(t)
  await f.post([item('post:2'), item('post:1', 'https://example.vn/other')])
  const foreign = { ...f.tables.site_content[0], _id: randomUUID(), site_id: f.otherSiteId, customer_id: 'other-customer', url: 'https://other.example/page' }
  f.tables.site_content.push(foreign)
  const first = await f.app.inject({ url: '/v1/site-content?limit=1', headers: f.headers })
  assert.equal(first.statusCode, 200)
  assert.equal(first.json().data[0].id, 'post:1'); assert.equal(first.json().next_cursor, 'post:1')
  assert.equal(first.json().total, 2)
  assert.ok(first.json().synced_at)
  assert.equal(Object.hasOwn(first.json().data[0], 'site_id'), false)
  const second = await f.app.inject({ url: '/v1/site-content?limit=1&cursor=post%3A1', headers: f.headers })
  assert.equal(second.json().data[0].id, 'post:2'); assert.equal(second.json().next_cursor, null)
  for (let repeat = 0; repeat < 2; repeat++) assert.equal((await f.app.inject({ method: 'DELETE', url: '/v1/site-content/post%3A2', headers: f.headers })).statusCode, 204)
  assert.ok(f.tables.site_content.includes(foreign))
  assert.equal((await f.app.inject('/v1/site-content')).statusCode, 401)
  const foreignList = await f.app.inject({ url: '/v1/site-content', headers: { authorization: 'Bearer ' + f.otherToken } })
  assert.equal(foreignList.json().data.length, 1)
})

test('invalid or conflicting complete batches never partially mutate the catalog', async t => {
  const f = await fixture(t)
  await f.post([item()])
  const before = structuredClone(f.tables.site_content)
  for (const items of [
    [item('new', 'https://example.vn/new'), item('bad', 'https://other.example/cross-tenant')],
    [item('same'), item('same', 'https://example.vn/other')],
    [item('one'), item('two')],
    [{ ...item('bad'), title: '<script>bad</script>' }],
    [{ ...item('bad'), summary: 'x'.repeat(1201) }],
    [{ ...item('bad'), categories: Array(11).fill('category') }],
    Array.from({ length: 101 }, (_, i) => item(String(i), 'https://example.vn/' + i)),
  ]) {
    assert.equal((await f.post(items)).statusCode, 400)
    assert.deepEqual(f.tables.site_content, before)
  }
  const collision = await f.post([item('new', 'https://example.vn/new'), item('steal')])
  assert.equal(collision.statusCode, 409)
  assert.deepEqual(f.tables.site_content, before)
  assert.equal((await f.post([item()], { site_id: f.otherSiteId })).statusCode, 400)
  assert.equal((await f.app.inject({ url: '/v1/site-content?limit=101', headers: f.headers })).statusCode, 400)
})

test('transaction rechecks token rotation, ownership and deletion before any catalog mutation or response', async t => {
  for (const action of ['rotate', 'delete', 'owner'] as const) {
    const f = await fixture(t)
    f.beforeTransaction(() => {
      if (action === 'rotate') f.tables.sites[0]!.token_hash = digest('rotated-fixture-token')
      if (action === 'delete') f.tables.sites.splice(0, 1)
      if (action === 'owner') f.tables.sites[0]!.customer_id = 'new-customer'
    })
    const response = await f.post([item()])
    assert.equal(response.statusCode, 401, action)
    assert.equal(f.tables.site_content.length, 0)
  }
  const f = await fixture(t)
  await f.post([item()])
  f.beforeTransaction(() => { f.tables.sites[0]!.token_hash = digest('rotated-fixture-token') })
  assert.equal((await f.app.inject({ url: '/v1/site-content', headers: f.headers })).statusCode, 401)
})

test('website domain changes and deletion remove only that site catalog in their transaction', async t => {
  const f = await fixture(t)
  await f.post([item()])
  f.tables.site_content.push({ ...f.tables.site_content[0], _id: randomUUID(), site_id: f.otherSiteId })
  const changed = await f.app.inject({ method: 'PATCH', url: '/websites/' + f.siteId, payload: { domain: 'new.example.vn' } })
  assert.equal(changed.statusCode, 200, changed.body)
  assert.equal(f.tables.site_content.length, 1); assert.equal(f.tables.site_content[0]!.site_id, f.otherSiteId)
  assert.equal(f.tables.sites[0]!.site_content_synced_at, undefined)
  f.tables.site_content.push({ ...f.tables.site_content[0], _id: randomUUID(), site_id: f.siteId })
  const removed = await f.app.inject({ method: 'DELETE', url: '/websites/' + f.siteId })
  assert.equal(removed.statusCode, 204, removed.body)
  assert.equal(f.tables.site_content.length, 1)
  assert.ok(f.calls.filter(call => call.table === 'site_content' && call.action === 'deleteMany').every(call => call.session === f.session))
})

test('website configuration persists, preserves and clears its catalog URL with cache invalidation', async t => {
  const f = await fixture(t)
  const url = 'https://example.vn/api/ai/content-catalog'
  await f.post([item()])
  const patch = (payload: Row) => f.app.inject({ method: 'PATCH', url: '/websites/' + f.siteId, payload })
  const configured = await patch({ content_catalog_url: url })
  assert.equal(configured.statusCode, 200, configured.body)
  assert.equal(f.tables.sites[0]!.content_catalog_url, url)
  assert.equal(f.tables.site_content.length, 0)
  f.tables.sites[0]!.site_content_synced_at = new Date()
  f.tables.sites[0]!.content_catalog_checked_at = new Date()
  f.tables.sites[0]!.content_catalog_count = 5
  f.tables.sites[0]!.content_catalog_error = 'old error'
  assert.equal((await patch({ name: 'Đổi tên' })).statusCode, 200)
  assert.equal(f.tables.sites[0]!.content_catalog_url, url)
  assert.equal(f.tables.sites[0]!.content_catalog_count, 5)
  const listed = await f.app.inject({ url: '/websites?id=' + f.siteId })
  assert.equal(listed.json().data[0].content_catalog_url, url)
  assert.equal(listed.json().data[0].content_catalog_count, 5)
  assert.equal(listed.json().data[0].content_catalog_error, 'old error')
  assert.ok(listed.json().data[0].content_catalog_synced_at)
  assert.equal((await f.post([item()])).statusCode, 409, 'pull URL is authoritative')
  assert.equal((await f.app.inject({ method: 'DELETE', url: '/v1/site-content/post:1', headers: f.headers })).statusCode, 409)
  for (const bad of ['http://example.vn/catalog', 'https://other.vn/catalog', 'https://user:pass@example.vn/catalog', 'https://example.vn/catalog#fragment', 'https://127.0.0.1/catalog']) {
    assert.equal((await patch({ content_catalog_url: bad })).statusCode, 400, bad)
    assert.equal(f.tables.sites[0]!.content_catalog_url, url)
  }
  assert.equal((await patch({ content_catalog_url: null })).statusCode, 200)
  assert.equal(f.tables.sites[0]!.content_catalog_url, null)
  for (const key of ['site_content_synced_at', 'content_catalog_checked_at', 'content_catalog_count', 'content_catalog_error']) assert.equal(f.tables.sites[0]![key], undefined)
})

test('website catalog check forces a full remote sync and returns safe errors', async t => {
  const calls: string[] = []
  let fail = false
  const f = await fixture(t, { fetchCatalog: async (url, domain) => {
    calls.push(url)
    assert.equal(domain, 'example.vn')
    if (fail) throw new ContentCatalogError('CONTENT_CATALOG_HTTP', 'Không đọc được danh mục.')
    return [item()]
  } })
  const check = () => f.app.inject({ method: 'POST', url: '/websites/' + f.siteId + '/content-catalog/check' })
  assert.equal((await check()).statusCode, 400)
  f.tables.sites[0]!.content_catalog_url = 'https://example.vn/catalog'
  const first = await check()
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().status, 'synced')
  assert.equal(first.json().count, 1)
  assert.equal((await check()).statusCode, 200)
  assert.equal(calls.length, 2, 'manual check bypasses fresh cache')
  fail = true
  const failed = await check()
  assert.equal(failed.statusCode, 422, failed.body)
  assert.equal(failed.json().error.code, 'CONTENT_CATALOG_HTTP')
  assert.equal(f.tables.site_content.length, 1, 'failed check preserves last complete snapshot')
  assert.equal((await f.app.inject({ method: 'POST', url: '/websites/' + randomUUID() + '/content-catalog/check' })).statusCode, 404)
})

test('public create, schedule edits and rewrites preserve explicit content exclusions with legacy defaults', async t => {
  const f = await fixture(t)
  f.tables.sites[0]!.webhook_secret = 'fixture-secret'
  f.tables.ai_models = [{ _id: 'fixture-model', provider: 'openai', enabled: true }]
  f.tables.ai_providers = [{ _id: 'openai', enabled: true }]
  const writing = { model: 'fixture-model', keyword: 'máy lọc nước', tone: 'Thân thiện', style: 'Hướng dẫn', length: 800, base_url: 'https://personal-ai.example.com/v1', api_key: 'fixture-key', use_research: false }
  const create = (body: Row) => f.app.inject({ method: 'POST', url: '/v1/article-jobs', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: body })
  const scheduled = await create({ ...writing, scheduled_at: '2030-01-01T00:00:00Z', exclude_content_ids: ['post:1', 'post:1'] })
  assert.equal(scheduled.statusCode, 202, scheduled.body)
  const job = f.tables.jobs[0]!
  assert.deepEqual(job.exclude_content_ids, ['post:1'])
  const patch = (body: Row) => f.app.inject({ method: 'PATCH', url: '/v1/schedules/' + job._id, headers: { ...f.headers, 'if-match': String(job.version) }, payload: body })
  assert.equal((await patch({ tone: 'Chuyên nghiệp' })).statusCode, 200)
  assert.deepEqual(job.exclude_content_ids, ['post:1'])
  assert.equal(job.use_research, false)
  assert.equal((await patch({ exclude_content_ids: [] })).statusCode, 200)
  assert.deepEqual(job.exclude_content_ids, [])
  const legacy = await create({ ...writing, mode: 'preview' })
  assert.equal(legacy.statusCode, 202)
  const original = f.tables.jobs[1]!
  assert.deepEqual(original.exclude_content_ids, [])
  original.status = 'ready'; original.exclude_content_ids = ['post:self']
  const rewrite = (body: Row) => f.app.inject({ method: 'POST', url: '/v1/articles/' + original._id + '/rewrites', headers: { ...f.headers, 'idempotency-key': randomUUID() }, payload: { base_url: 'https://personal-ai.example.com/v1', api_key: 'fixture-key', ...body } })
  assert.equal((await rewrite({})).statusCode, 202)
  assert.deepEqual(f.tables.jobs[2]!.exclude_content_ids, ['post:self'])
  assert.equal((await rewrite({ exclude_content_ids: [] })).statusCode, 202)
  assert.deepEqual(f.tables.jobs[3]!.exclude_content_ids, [])
  assert.equal((await create({ ...writing, exclude_content_ids: Array(21).fill('post:1') })).statusCode, 400)
  assert.equal((await create({ ...writing, exclude_content_ids: ['../not-an-id'] })).statusCode, 400)
})

test('canonical internal URLs keep path slash/query semantics and reject deceptive or unsafe URLs', () => {
  assert.equal(normalizeInternalUrl('https://www.example.vn/a/?q=1&x=2', 'example.vn'), 'https://www.example.vn/a/?q=1&x=2')
  assert.equal(normalizeInternalUrl('http://example.vn/a', 'example.vn'), 'http://example.vn/a')
  for (const value of ['/a', '//example.vn/a', 'https://example.vn.evil/a', 'https://user:pass@example.vn/a', 'https://example.vn/a#part', 'https://example.vn/a#', 'javascript:alert(1)', 'https://example.vn:4430/a', 'https://example.vn/white space', 'https://example.vn\\@evil.test/a']) assert.equal(normalizeInternalUrl(value, 'example.vn'), null, value)
  assert.equal(normalizeInternalUrl('https://example.vn/a', null), null)
})

test('candidate selection folds Vietnamese, excludes self and foreign pages, bounds output and filters before retrieval', async () => {
  assert.deepEqual(siteContentSearchTerms('Cách chọn máy lọc nước và the máy'), ['cach', 'chon', 'may', 'loc', 'nuoc'])
  const candidates = Array.from({ length: 12 }, (_, i) => ({ ...item(String(i), 'https://example.vn/' + i), id: String(i) }))
  candidates.push(item('foreign', 'https://other.example/foreign'), { ...item('weak', 'https://example.vn/weak'), title: 'Máy tính', summary: 'Máy tính để bàn', categories: [] })
  const options = { siteId: 'site', customerId: 'customer', siteDomain: 'example.vn', keyword: 'chọn máy lọc nước', excludeIds: ['0'], excludeTitles: ['Cách chọn máy lọc nước khác'] }
  const ranked = rankInternalLinkCandidates(candidates, options)
  assert.equal(ranked.length, 8)
  assert.ok(ranked.every(row => !['0', 'foreign', 'weak'].includes(row.id)))
  assert.deepEqual(rankInternalLinkCandidates(candidates, { ...options, keyword: 'the và là' }), [])
  const tables: Tables = { site_content: [
    ...candidates.map(row => ({ ...row, external_id: row.id, site_id: 'site', customer_id: 'customer', search_terms: siteContentSearchTerms(row.title + ' ' + row.summary), updated_at: new Date() })),
    { ...item('secret'), external_id: 'secret', site_id: 'other', customer_id: 'other', search_terms: ['chon', 'loc', 'nuoc'] },
  ] }
  const memory = memoryDatabase(tables)
  const selected = await selectInternalLinkCandidates(memory.db, options)
  assert.equal(selected.length, 8)
  assert.equal(selected.some(row => row.id === 'secret'), false)
  const filter = memory.calls.find(call => call.action === 'find')!.filter
  assert.equal(filter.site_id, 'site'); assert.equal(filter.customer_id, 'customer')
  assert.deepEqual(filter.external_id, { $nin: ['0'] })
})

test('meaningful short keywords match complete words instead of accidental word fragments', () => {
  for (const keyword of ['SEO', 'API', 'CRM', 'PHP']) {
    const rows = [
      { ...item('exact', 'https://example.vn/exact'), title: 'Hướng dẫn ' + keyword, summary: '', categories: [] },
      { ...item('partial', 'https://example.vn/partial'), title: 'Hướng dẫn ' + keyword + 'P', summary: '', categories: [] },
    ]
    assert.deepEqual(rankInternalLinkCandidates(rows, { siteDomain: 'example.vn', keyword }).map(row => row.id), ['exact'])
  }
})

test('revalidation drops unpublished, retargeted, excluded and moved-site candidates without substitution', async () => {
  const candidates = [item('kept', 'https://example.vn/kept'), item('gone', 'https://example.vn/gone'), item('retargeted', 'https://example.vn/old'), item('excluded', 'https://example.vn/excluded')]
  const tables: Tables = { sites: [{ _id: 'site', customer_id: 'customer', domain: 'example.vn' }], site_content: [
    { ...candidates[0], external_id: 'kept', site_id: 'site', customer_id: 'customer', title: 'Updated title' },
    { ...candidates[2], external_id: 'retargeted', site_id: 'site', customer_id: 'customer', url: 'https://example.vn/new' },
    { ...candidates[3], external_id: 'excluded', site_id: 'site', customer_id: 'customer' },
    { ...item('new', 'https://example.vn/new-page'), external_id: 'new', site_id: 'site', customer_id: 'customer' },
  ] }
  const memory = memoryDatabase(tables)
  const options = { siteId: 'site', customerId: 'customer', siteDomain: 'example.vn', candidates, excludeIds: ['excluded'] }
  const refreshed = await refreshInternalLinkCandidates(memory.db, options)
  assert.deepEqual(refreshed.map(row => row.id), ['kept'])
  assert.equal(refreshed[0]!.title, 'Updated title')
  tables.sites[0]!.domain = 'new.example.vn'
  assert.deepEqual(await refreshInternalLinkCandidates(memory.db, options), [])
  tables.sites[0]!.domain = 'example.vn'; tables.sites[0]!.customer_id = 'other'
  assert.deepEqual(await refreshInternalLinkCandidates(memory.db, options), [])
})
