import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerProviders } from '../src/api/crm-providers.js'
import { installErrorHandler } from '../src/api/errors.js'
import { seal, unseal } from '../src/security.js'

type Row = Record<string, any>
type Tables = Record<string, Row[]>

function memoryDatabase(tables: Tables): Database {
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((branch: Row) => matches(row, branch))
    const actual = row[key]
    if (value && typeof value === 'object' && '$in' in value) {
      return Array.isArray(actual) ? actual.some(item => value.$in.includes(item)) : value.$in.includes(actual)
    }
    return Array.isArray(actual) ? actual.includes(value) : actual === value
  })
  return { db: { collection(name: string) {
    const rows = () => tables[name] ??= []
    return {
      async findOne(filter: Row) { return structuredClone(rows().find(row => matches(row, filter)) ?? null) },
      find(filter: Row) { return { async toArray() { return structuredClone(rows().filter(row => matches(row, filter))) } } },
      async insertOne(row: Row) {
        if (rows().some(item => item._id === row._id || (name === 'ai_models' && row.upstream_model && item.provider === row.provider && item.upstream_model === row.upstream_model))) {
          throw Object.assign(new Error('Duplicate fixture row'), { code: 11000 })
        }
        rows().push(structuredClone(row)); return { insertedId: row._id }
      },
      async findOneAndUpdate(filter: Row, update: Row) {
        const row = rows().find(item => matches(item, filter))
        if (!row) return null
        Object.assign(row, structuredClone(update.$set)); return structuredClone(row)
      },
      async deleteOne(filter: Row) {
        const index = rows().findIndex(item => matches(item, filter))
        if (index < 0) return { deletedCount: 0 }
        rows().splice(index, 1); return { deletedCount: 1 }
      },
    }
  } } } as unknown as Database
}

async function fixture(t: test.TestContext, fetcher?: typeof fetch) {
  const encryptionKey = Buffer.alloc(32, 7)
  const tables: Tables = {
    ai_providers: [
      { _id: 'xai', display_name: 'xAI', enabled: true },
      { _id: 'openai-compatible', display_name: 'OpenAI Compatible', enabled: true, base_url: 'https://8.8.8.8/legacy/v1', encrypted_api_key: seal('legacy-fixture-key', encryptionKey) },
      { _id: 'openai', display_name: 'OpenAI', enabled: true },
      { _id: 'anthropic', display_name: 'Anthropic', enabled: true },
    ],
    ai_models: [{ _id: 'legacy-model', provider: 'openai-compatible', display_name: 'Legacy model', enabled: true }],
  }
  const config = { encryptionKey, serviceKeys: { openai: 'native-fixture-key' } } as Config
  const app = Fastify()
  installErrorHandler(app)
  registerProviders(app, memoryDatabase(tables), config, fetcher)
  await app.ready()
  t.after(() => app.close())
  const create = async (name: string, base_url = 'https://8.8.8.8/' + name + '/v1', api_key = name + '-fixture-key') => {
    const response = await app.inject({ method: 'POST', url: '/providers', payload: { display_name: name, base_url, api_key } })
    assert.equal(response.statusCode, 201, response.body)
    return response.json<Row>()
  }
  const model = async (provider: string, upstream = 'shared/model-v1') => {
    const response = await app.inject({ method: 'POST', url: '/providers/' + provider + '/models', payload: { model: upstream, display_name: 'Shared model' } })
    assert.equal(response.statusCode, 201, response.body)
    return response.json<Row>()
  }
  return { app, tables, config, create, model }
}

test('multiple compatible providers keep independent encrypted connections and a stable catalog', async t => {
  const f = await fixture(t)
  const second = await f.create('Zulu')
  const first = await f.create('Alpha')
  assert.match(first.provider, /^openai-compatible-[0-9a-f-]{36}$/)
  assert.notEqual(first.provider, second.provider)
  assert.equal(first.kind, 'openai-compatible')
  assert.equal(first.enabled, true)
  assert.equal(first.api_key_configured, true)
  assert.deepEqual(first.models, [])
  const saved = f.tables.ai_providers.find(row => row._id === first.provider)!
  assert.notEqual(saved.encrypted_api_key, 'Alpha-fixture-key')
  assert.equal(unseal(saved.encrypted_api_key, f.config.encryptionKey), 'Alpha-fixture-key')
  const response = await f.app.inject('/providers')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json<Row>().data.map((row: Row) => row.provider), ['openai', 'anthropic', 'xai', 'openai-compatible', first.provider, second.provider])
  assert.equal(response.json<Row>().data[0].service_key_configured, true)
  assert.equal(response.json<Row>().data[3].models[0].model, 'legacy-model')
  assert.equal(response.json<Row>().data[3].models[0].upstream_model, 'legacy-model')
  for (const secret of ['Alpha-fixture-key', 'Zulu-fixture-key', 'legacy-fixture-key', 'native-fixture-key', saved.encrypted_api_key]) assert.ok(!response.body.includes(secret))
})

test('provider creation validates destinations and unknown providers cannot be configured', async t => {
  const f = await fixture(t)
  const valid = { display_name: 'Fixture', base_url: 'https://8.8.8.8/v1', api_key: 'fixture-key' }
  for (const payload of [
    { ...valid, display_name: ' ' }, { ...valid, api_key: '' }, { ...valid, kind: 'anthropic' },
    { ...valid, base_url: 'http://8.8.8.8/v1' }, { ...valid, base_url: 'https://127.0.0.1/v1' },
    { ...valid, base_url: 'https://user:password@8.8.8.8/v1' }, { ...valid, base_url: 'https://8.8.8.8/v1?key=secret' },
  ]) assert.equal((await f.app.inject({ method: 'POST', url: '/providers', payload })).statusCode, 400)
  assert.equal(f.tables.ai_providers.length, 4)
  const unknown = 'openai-compatible-' + randomUUID()
  for (const [method, path, payload] of [
    ['PATCH', '', { display_name: 'Unknown' }], ['POST', '/models', { model: 'model' }], ['POST', '/check', undefined],
  ] as const) assert.equal((await f.app.inject({ method, url: '/providers/' + unknown + path, ...(payload ? { payload } : {}) })).statusCode, 404)
  assert.equal((await f.app.inject({ method: 'PATCH', url: '/providers/openai', payload: { base_url: valid.base_url } })).statusCode, 400)
  assert.equal((await f.app.inject({ method: 'POST', url: '/providers/not-a-provider/models', payload: { model: 'model' } })).statusCode, 400)
})

test('the same upstream model belongs to two connections without sharing internal identity or mutations', async t => {
  const f = await fixture(t)
  const first = await f.create('First')
  const second = await f.create('Second')
  const a = await f.model(first.provider)
  const b = await f.model(second.provider)
  assert.match(a.model, /^model-[0-9a-f-]{36}$/)
  assert.notEqual(a.model, b.model)
  assert.equal(a.upstream_model, 'shared/model-v1')
  assert.equal(b.upstream_model, a.upstream_model)
  const duplicate = await f.app.inject({ method: 'POST', url: '/providers/' + first.provider + '/models', payload: { model: a.upstream_model } })
  assert.equal(duplicate.statusCode, 409)
  const edit = await f.app.inject({ method: 'PATCH', url: '/providers/' + first.provider + '/models/' + a.model, payload: { display_name: 'Only first' } })
  assert.equal(edit.statusCode, 200)
  assert.equal(edit.json<Row>().upstream_model, a.upstream_model)
  const wrongScope = '/providers/' + second.provider + '/models/' + a.model
  assert.equal((await f.app.inject({ method: 'PATCH', url: wrongScope, payload: { enabled: false } })).statusCode, 404)
  assert.equal((await f.app.inject({ method: 'DELETE', url: wrongScope })).statusCode, 404)
  const catalog = (await f.app.inject('/providers')).json<Row>().data
  assert.equal(catalog.find((row: Row) => row.provider === first.provider).models[0].display_name, 'Only first')
  assert.equal(catalog.find((row: Row) => row.provider === second.provider).models[0].display_name, 'Shared model')
  const legacy = await f.model('openai-compatible', 'another-legacy-model')
  assert.equal(legacy.model, 'another-legacy-model')
  assert.equal((await f.app.inject({ method: 'POST', url: '/providers/openai-compatible/models', payload: { model: 'legacy-model' } })).statusCode, 409)
})

test('connection checks and model pings use only the selected provider key, base URL and upstream model', async t => {
  const calls: { url: string, key: string | null, body?: Row }[] = []
  const f = await fixture(t, async (url, init) => {
    calls.push({ url: String(url), key: new Headers(init?.headers).get('authorization'), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    return new Response('{}', { status: 200 })
  })
  const first = await f.create('First')
  const second = await f.create('Second', 'https://1.1.1.1/second/v1/', 'second-fixture-key')
  const a = await f.model(first.provider)
  const b = await f.model(second.provider)
  for (const item of [first, second]) assert.equal((await f.app.inject({ method: 'POST', url: '/providers/' + item.provider + '/check' })).statusCode, 200)
  for (const [provider, model] of [[first.provider, a.model], [second.provider, b.model], ['openai-compatible', 'legacy-model']]) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/providers/' + provider + '/models/' + model + '/ping' })).statusCode, 200)
  }
  assert.deepEqual(calls.map(row => [row.url, row.key, row.body?.model]), [
    ['https://8.8.8.8/First/v1/models', 'Bearer First-fixture-key', undefined],
    ['https://1.1.1.1/second/v1/models', 'Bearer second-fixture-key', undefined],
    ['https://8.8.8.8/First/v1/chat/completions', 'Bearer First-fixture-key', 'shared/model-v1'],
    ['https://1.1.1.1/second/v1/chat/completions', 'Bearer second-fixture-key', 'shared/model-v1'],
    ['https://8.8.8.8/legacy/v1/chat/completions', 'Bearer legacy-fixture-key', 'legacy-model'],
  ])
  assert.equal((await f.app.inject({ method: 'POST', url: '/providers/' + second.provider + '/models/' + a.model + '/ping' })).statusCode, 404)
  assert.equal(calls.length, 5)
  assert.equal((await f.app.inject({ method: 'POST', url: '/providers/openai/check' })).statusCode, 400)
  assert.equal((await f.app.inject({ method: 'POST', url: '/providers/openai/models/model/ping' })).statusCode, 400)
})

test('editing one provider preserves its key unless replaced and keeps assigned-model guards', async t => {
  const f = await fixture(t)
  const first = await f.create('First')
  const second = await f.create('Second')
  const model = await f.model(first.provider)
  const saved = f.tables.ai_providers.find(row => row._id === first.provider)!
  const encrypted = saved.encrypted_api_key
  const patch = await f.app.inject({ method: 'PATCH', url: '/providers/' + first.provider, payload: { display_name: 'Renamed', base_url: first.base_url, enabled: true } })
  assert.equal(patch.statusCode, 200)
  assert.equal(patch.json<Row>().kind, 'openai-compatible')
  assert.equal(saved.encrypted_api_key, encrypted)
  assert.equal(f.tables.ai_providers.find(row => row._id === second.provider)!.base_url, second.base_url)
  const replace = await f.app.inject({ method: 'PATCH', url: '/providers/' + first.provider, payload: { api_key: 'replacement-fixture-key' } })
  assert.equal(replace.statusCode, 200)
  assert.equal(unseal(saved.encrypted_api_key, f.config.encryptionKey), 'replacement-fixture-key')
  assert.ok(!replace.body.includes('replacement-fixture-key'))
  f.tables.customers = [{ _id: randomUUID(), key_mode: 'service', allowed_models: [model.model] }]
  assert.equal((await f.app.inject({ method: 'PATCH', url: '/providers/' + first.provider, payload: { enabled: false } })).statusCode, 409)
  assert.equal((await f.app.inject({ method: 'PATCH', url: '/providers/' + first.provider + '/models/' + model.model, payload: { enabled: false } })).statusCode, 409)
  assert.equal((await f.app.inject({ method: 'DELETE', url: '/providers/' + first.provider + '/models/' + model.model })).statusCode, 409)
  assert.equal((await f.app.inject({ method: 'PATCH', url: '/providers/' + second.provider, payload: { enabled: false } })).statusCode, 200)
})

test('provider endpoint changes require an explicit key and never forward the retained credential to a new destination', async t => {
  // Memory-only database and fake fetcher: no requests reach either host.
  const originalKey = 'original-host-fixture-key'
  const replacementKey = 'replacement-host-fixture-key'
  const calls: { url: string, originalKey: boolean, replacementKey: boolean }[] = []
  const f = await fixture(t, async (url, init) => {
    const authorization = new Headers(init?.headers).get('authorization')
    calls.push({ url: String(url), originalKey: authorization === `Bearer ${originalKey}`, replacementKey: authorization === `Bearer ${replacementKey}` })
    return new Response('{}', { status: 200 })
  })
  const provider = await f.create('Host change', 'https://8.8.8.8/original/v1', originalKey)
  const saved = f.tables.ai_providers.find(row => row._id === provider.provider)!
  const before = structuredClone(saved)
  for (const base_url of ['https://1.1.1.1/changed/v1', 'https://8.8.8.8/changed/v1']) {
    const rejected = await f.app.inject({ method: 'PATCH', url: '/providers/' + provider.provider, payload: { base_url, display_name: 'Rejected rename', enabled: false } })
    assert.equal(rejected.statusCode, 400)
    assert.equal(rejected.json<Row>().error.code, 'provider_key_required')
    assert.deepEqual(saved, before)
  }
  assert.equal(calls.length, 0)
  assert.equal((await f.app.inject({ method: 'POST', url: '/providers/' + provider.provider + '/check' })).statusCode, 200)
  assert.deepEqual(calls, [{ url: 'https://8.8.8.8/original/v1/models', originalKey: true, replacementKey: false }])

  const patch = await f.app.inject({ method: 'PATCH', url: '/providers/' + provider.provider, payload: { base_url: 'https://1.1.1.1/changed/v1', api_key: replacementKey } })
  assert.equal(patch.statusCode, 200)
  assert.ok(saved.encrypted_api_key !== before.encrypted_api_key)
  assert.ok(!patch.body.includes(replacementKey))
  assert.equal((await f.app.inject({ method: 'POST', url: '/providers/' + provider.provider + '/check' })).statusCode, 200)
  assert.deepEqual(calls[1], { url: 'https://1.1.1.1/changed/v1/models', originalKey: false, replacementKey: true })
})

test('equivalent normalized provider URLs preserve the existing endpoint and encrypted key', async t => {
  const f = await fixture(t)
  const provider = await f.create('Normalized', 'https://provider.example.com/original/v1')
  const saved = f.tables.ai_providers.find(row => row._id === provider.provider)!
  const before = structuredClone(saved)
  for (const base_url of ['https://provider.example.com/original/v1/', 'https://PROVIDER.example.com:443/original/./v1///']) {
    const response = await f.app.inject({ method: 'PATCH', url: '/providers/' + provider.provider, payload: { base_url } })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(saved, before)
    assert.equal(response.json<Row>().base_url, before.base_url)
  }
})

test('provider errors do not expose upstream payloads or encrypted credentials', async t => {
  const f = await fixture(t, async () => new Response('upstream-private-fixture-body', { status: 401 }))
  const provider = await f.create('Fixture')
  const model = await f.model(provider.provider)
  for (const suffix of ['/check', '/models/' + model.model + '/ping']) {
    const response = await f.app.inject({ method: 'POST', url: '/providers/' + provider.provider + suffix })
    assert.equal(response.statusCode, 422)
    assert.equal(response.json<Row>().error.code, 'provider_auth_failed')
    assert.ok(!response.body.includes('upstream-private-fixture-body'))
    assert.ok(!response.body.includes('Fixture-fixture-key'))
  }
  f.tables.ai_providers.find(row => row._id === provider.provider)!.encrypted_api_key = 'unreadable-fixture-ciphertext'
  assert.equal((await f.app.inject({ method: 'POST', url: '/providers/' + provider.provider + '/check' })).json<Row>().error.code, 'provider_key_unavailable')
})
