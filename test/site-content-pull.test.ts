import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { request as httpsRequest } from 'node:https'
import type { Database } from '../src/db.js'
import { ContentCatalogError, fetchContentCatalog, syncSiteContentCatalog, validateContentCatalogUrl, type CatalogFetchOptions } from '../src/site-content-pull.js'

type Row = Record<string, any>
const page = (id = 'post:1', url = 'https://example.vn/page') => ({ id, url, title: 'Hướng dẫn chọn website', summary: 'Nội dung giúp chọn website phù hợp.', categories: ['Website'] })
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }]

function network(body: unknown, status = 200, headers: Row = { 'content-type': 'application/json' }) {
  const observations: Row[] = []
  const request = ((url: URL, options: Row, receive: (value: unknown) => void) => {
    observations.push({ url, options })
    const connection = new EventEmitter() as EventEmitter & { end: () => void }
    connection.end = () => {
      queueMicrotask(() => {
        if (options.signal.aborted) { connection.emit('error', options.signal.reason); return }
        const response = Readable.from([typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)]) as Readable & { statusCode: number; headers: Row }
        response.statusCode = status; response.headers = headers
        receive(response)
      })
    }
    return connection
  }) as typeof httpsRequest
  return { request, observations }
}
async function fetchFixture(body: unknown, options: { status?: number; headers?: Row; resolve?: CatalogFetchOptions['resolve'] } = {}) {
  const fixture = network(body, options.status ?? 200, options.headers)
  const items = await fetchContentCatalog('https://example.vn/api/ai/catalog', 'example.vn', { request: fixture.request, resolve: options.resolve ?? publicDns })
  return { items, ...fixture }
}

test('catalog endpoint requires HTTPS and the exact website domain/port with no private destinations', () => {
  assert.equal(validateContentCatalogUrl('https://www.example.vn/api/catalog?lang=vi', 'example.vn').hostname, 'www.example.vn')
  for (const input of [
    'http://example.vn/api/catalog', 'https://elsewhere.example/catalog', 'https://example.vn.evil.com/catalog',
    'https://example.vn:8443/catalog', 'https://user:password@example.vn/catalog', 'https://example.vn/catalog#all',
    'https://example.vn/catalog#', 'https://example.vn/white space', 'https://example.vn\\@evil.com/catalog',
  ]) assert.throws(() => validateContentCatalogUrl(input, 'example.vn'), ContentCatalogError, input)
  for (const host of ['127.0.0.1', '10.0.0.1', '[::1]', '[::ffff:127.0.0.1]', 'localhost', 'service.internal']) assert.throws(() => validateContentCatalogUrl('https://' + host + '/catalog', host), ContentCatalogError)
})

test('fetch reads a complete bounded JSON catalog through one pinned public address without credentials', async () => {
  const f = await fetchFixture({ items: [page()] })
  assert.deepEqual(f.items, [page()])
  const request = f.observations[0]!
  assert.equal(request.options.method, 'GET'); assert.equal(request.options.agent, false)
  assert.deepEqual(request.options.headers, { accept: 'application/json', 'accept-encoding': 'identity' })
  let pinned: unknown[] = []
  request.options.lookup('example.vn', {}, (...values: unknown[]) => { pinned = values })
  assert.deepEqual(pinned, [null, '93.184.216.34', 4])
  assert.deepEqual((await fetchFixture([])).items, [])
  assert.deepEqual((await fetchFixture({ items: [], total: 0, next_cursor: null })).items, [])
  assert.deepEqual((await fetchFixture([page()], { headers: { 'content-type': 'application/vnd.catalog+json; charset=utf-8' } })).items, [page()])
})

test('fetch refuses DNS private/mixed/mapped targets before issuing a request', async () => {
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [{ address: '::ffff:10.0.0.1', family: 6 }], [...await publicDns(), { address: '192.168.1.5', family: 4 }]]) {
    const fixture = network({ items: [page()] })
    await assert.rejects(fetchContentCatalog('https://example.vn/catalog', 'example.vn', { resolve: async () => addresses, request: fixture.request }), { code: 'CONTENT_CATALOG_DESTINATION' })
    assert.equal(fixture.observations.length, 0)
  }
  await assert.rejects(fetchFixture([], { resolve: async () => { throw new Error('private resolver secret') } }), { code: 'CONTENT_CATALOG_DNS' })
})

test('fetch rejects redirects, non-JSON, oversized/compressed responses and incomplete or invalid snapshots', async () => {
  for (const status of [204, 301, 302, 307, 401, 500]) await assert.rejects(fetchFixture({}, { status }), { code: 'CONTENT_CATALOG_HTTP' })
  for (const headers of [
    {}, { 'content-type': 'text/html' }, { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024 + 1) },
  ]) await assert.rejects(fetchFixture({}, { headers }), { code: 'CONTENT_CATALOG_RESPONSE' })
  await assert.rejects(fetchFixture('x'.repeat(5 * 1024 * 1024 + 1)), { code: 'CONTENT_CATALOG_RESPONSE' })
  await assert.rejects(fetchFixture('not json containing private content'), { code: 'CONTENT_CATALOG_RESPONSE' })
  for (const body of [
    { items: [page()], next_cursor: 'next' }, { items: [page()], total: 2 }, { data: [page()] },
    [page(), page()], [page(), page('other')], [{ ...page(), title: '<b>HTML</b>' }],
    [{ ...page(), url: 'https://elsewhere.example/page' }], [{ ...page(), categories: Array(11).fill('category') }],
    Array.from({ length: 2001 }, (_, i) => page(String(i), 'https://example.vn/' + i)),
  ]) await assert.rejects(fetchFixture(body), { code: 'CONTENT_CATALOG_INVALID' })
})

test('fetch stops waiting on DNS when caller cancels without exposing upstream details', async () => {
  const controller = new AbortController()
  const pending = fetchContentCatalog('https://example.vn/catalog', 'example.vn', { signal: controller.signal, resolve: () => new Promise(() => {}) })
  controller.abort(new Error('secret caller error'))
  await assert.rejects(pending, (error: unknown) => error instanceof ContentCatalogError && error.code === 'CONTENT_CATALOG_CANCELED' && !error.message.includes('secret'))
})

function database() {
  const tables: Record<string, Row[]> = {
    sites: [{ _id: 'site', customer_id: 'customer', domain: 'example.vn', content_catalog_url: 'https://example.vn/catalog' }],
    site_content: [{ _id: 'old', site_id: 'site', customer_id: 'customer', external_id: 'old', url: 'https://example.vn/old' }, { _id: 'foreign', site_id: 'other', customer_id: 'other', external_id: 'foreign', url: 'https://other.example/page' }],
  }
  const calls: Row[] = []; let failInsert = false
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((branch: Row) => matches(row, branch))
    const actual = row[key]
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('$exists' in value && Object.hasOwn(row, key) !== value.$exists) return false
      if ('$lte' in value && !(actual <= value.$lte)) return false
      if ('$gt' in value && !(actual > value.$gt)) return false
      return true
    }
    return value === null ? actual == null : actual === value
  })
  const apply = (row: Row, update: Row) => {
    Object.assign(row, structuredClone(update.$set ?? {}))
    for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(value)
    for (const key of Object.keys(update.$unset ?? {})) delete row[key]
  }
  const session = { async withTransaction<T>(run: () => Promise<T>) {
    const snapshot = structuredClone(tables)
    try { return await run() } catch (error) { Object.assign(tables, snapshot); throw error }
  }, async endSession() {} }
  const db = { client: { async connect() {}, startSession: () => session }, db: { collection(name: string) {
    const rows = () => tables[name] ??= []
    return {
      async findOne(filter: Row) { return structuredClone(rows().find(row => matches(row, filter)) ?? null) },
      async findOneAndUpdate(filter: Row, update: Row) { const row = rows().find(row => matches(row, filter)); if (!row) return null; apply(row, update); return structuredClone(row) },
      async updateOne(filter: Row, update: Row, options: Row = {}) { calls.push({ name, action: 'updateOne', filter, options }); const row = rows().find(row => matches(row, filter)); if (!row) return { matchedCount: 0 }; apply(row, update); return { matchedCount: 1 } },
      async deleteMany(filter: Row, options: Row) { calls.push({ name, action: 'deleteMany', filter, options }); tables[name] = rows().filter(row => !matches(row, filter)); return { acknowledged: true } },
      async insertMany(documents: Row[], options: Row) { calls.push({ name, action: 'insertMany', options }); if (failInsert) throw new Error('raw storage private detail'); rows().push(...structuredClone(documents)); return { acknowledged: true } },
    }
  } } } as unknown as Database
  return { db, tables, calls, session, failInsert: () => { failInsert = true } }
}

test('sync atomically replaces a tenant snapshot and supports an authoritative empty catalog', async () => {
  const f = database()
  const first = await syncSiteContentCatalog(f.db, 'site', { fetchCatalog: async () => [page()] })
  assert.equal(first.status, 'synced'); assert.equal(first.count, 1); assert.ok(first.synced_at)
  assert.deepEqual(f.tables.site_content!.map(row => row.external_id), ['foreign', 'post:1'])
  const row = f.tables.site_content![1]!
  assert.equal(row.site_id, 'site'); assert.equal(row.customer_id, 'customer'); assert.ok(row.search_terms.includes('website'))
  assert.ok(f.calls.filter(call => call.name === 'site_content').every(call => call.options.session === f.session))
  assert.equal(f.tables.sites![0]!.content_catalog_lease_token, undefined)
  assert.equal(f.tables.sites![0]!.content_catalog_error, null)
  const cached = await syncSiteContentCatalog(f.db, 'site', { fetchCatalog: async () => { assert.fail('Cache must avoid network') } })
  assert.equal(cached.status, 'cached')
  const empty = await syncSiteContentCatalog(f.db, 'site', { force: true, fetchCatalog: async () => [] })
  assert.equal(empty.count, 0); assert.equal(empty.status, 'synced')
  assert.deepEqual(f.tables.site_content!.map(row => row.external_id), ['foreign'])
  assert.ok(f.tables.sites![0]!.site_content_synced_at instanceof Date)
})

test('sync preserves old data and safe error on fetch/schema/storage failure and suppresses repeated outage fetches', async () => {
  for (const failure of ['network', 'schema', 'storage']) {
    const f = database(); const old = structuredClone(f.tables.site_content)
    if (failure === 'storage') f.failInsert()
    await assert.rejects(syncSiteContentCatalog(f.db, 'site', { fetchCatalog: async () => {
      if (failure === 'network') throw new Error('private upstream body https://user:secret@example.vn')
      return failure === 'schema' ? [{ ...page(), title: '<script>bad</script>' }] : [page()]
    } }), ContentCatalogError)
    assert.deepEqual(f.tables.site_content, old)
    assert.doesNotMatch(f.tables.sites![0]!.content_catalog_error, /private|secret|script|user:/)
    assert.equal(f.tables.sites![0]!.content_catalog_lease_token, undefined)
    await assert.rejects(syncSiteContentCatalog(f.db, 'site', { fetchCatalog: async () => { assert.fail('Recent failure must avoid repeated fetch') } }), { code: 'CONTENT_CATALOG_UNAVAILABLE' })
  }
})

test('sync lease serializes requests and accepts a forced retry after failure', async () => {
  const f = database(); let finish: (value: ReturnType<typeof page>[]) => void = () => {}
  const one = syncSiteContentCatalog(f.db, 'site', { fetchCatalog: () => new Promise(resolve => { finish = resolve }) })
  await new Promise(resolve => setImmediate(resolve))
  const two = await syncSiteContentCatalog(f.db, 'site', { force: true, fetchCatalog: async () => { assert.fail('Busy sync cannot fetch') } })
  assert.equal(two.status, 'busy'); finish([page()]); assert.equal((await one).status, 'synced')
  f.tables.sites![0]!.content_catalog_error = 'Trước đó không kết nối được.'
  const retry = await syncSiteContentCatalog(f.db, 'site', { force: true, fetchCatalog: async () => [page()] })
  assert.equal(retry.status, 'synced'); assert.equal(f.tables.sites![0]!.content_catalog_error, null)
})

test('sync refuses stale website expectations and never overwrites changed configuration or lease owner', async () => {
  for (const expectations of [{ expectedCustomerId: 'other' }, { expectedDomain: 'other.example' }, { expectedUrl: 'https://example.vn/other' }]) {
    const f = database()
    await assert.rejects(syncSiteContentCatalog(f.db, 'site', { ...expectations, fetchCatalog: async () => { assert.fail('Stale expectation cannot fetch') } }), { code: 'CONTENT_CATALOG_CHANGED' })
  }
  for (const change of ['url', 'domain', 'owner', 'deleted', 'lease']) {
    const f = database(); const old = structuredClone(f.tables.site_content)
    await assert.rejects(syncSiteContentCatalog(f.db, 'site', { fetchCatalog: async () => {
      const site = f.tables.sites![0]!
      if (change === 'url') site.content_catalog_url = 'https://example.vn/new'
      if (change === 'domain') site.domain = 'new.example.vn'
      if (change === 'owner') site.customer_id = 'other'
      if (change === 'deleted') f.tables.sites = []
      if (change === 'lease') site.content_catalog_lease_token = 'new-worker'
      return [page()]
    } }), { code: 'CONTENT_CATALOG_CHANGED' })
    assert.deepEqual(f.tables.site_content, old, change)
    if (change === 'lease') assert.equal(f.tables.sites![0]!.content_catalog_lease_token, 'new-worker')
    if (f.tables.sites![0]) assert.equal(f.tables.sites![0]!.content_catalog_error, undefined)
  }
})

test('sync without a configured endpoint remains compatible and never fetches', async () => {
  const f = database(); delete f.tables.sites![0]!.content_catalog_url
  assert.equal((await syncSiteContentCatalog(f.db, 'site', { fetchCatalog: async () => { assert.fail('No URL cannot fetch') } })).status, 'not_configured')
})
