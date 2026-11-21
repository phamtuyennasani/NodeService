import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerPrices } from '../src/api/crm-prices.js'
import { installErrorHandler } from '../src/api/errors.js'
import { priceUsage } from '../src/worker/pricing.js'

type Row = Record<string, any>

async function fixture(t: test.TestContext, usdToVnd = 25_000) {
  const prices: Row[] = []
  const models: Row[] = [{ _id: 'gpt-test', provider: 'openai' }]
  const db = {
    collection(name: string) {
      const rows = name === 'model_prices' ? prices : name === 'ai_models' ? models : []
      const matches = (row: Row, filter: Row) => Object.entries(filter).every(([key, value]) => row[key] === value)
      return {
        async findOne(filter: Row) { return structuredClone(rows.find(row => matches(row, filter)) ?? null) },
        async insertOne(row: Row) { rows.push(structuredClone(row)); return { insertedId: row._id } },
        find(filter: Row) {
          const cursor = {
            sort() { return cursor },
            async toArray() { return structuredClone(rows.filter(row => matches(row, filter))) },
          }
          return cursor
        },
      }
    },
  }
  const config = { usdToVnd } as Config
  const app = Fastify()
  installErrorHandler(app)
  registerPrices(app, { db } as unknown as Database, config)
  await app.ready()
  t.after(() => app.close())
  const create = (total_vnd: string | number) => app.inject({
    method: 'POST', url: '/prices', payload: {
      provider: 'openai', model: 'gpt-test', source_url: 'https://example.com/prices',
      effective_at: '2026-11-21T00:00:00Z', total_vnd,
    },
  })
  return { app, config, prices, create }
}

test('CRM manually entered VND prices retain exact fractional amounts across exchange-rate changes', async t => {
  const { app, config, prices, create } = await fixture(t, 27_123)
  const response = await create('0.1234567891')
  assert.equal(response.statusCode, 201, response.body)
  assert.equal(response.json().total_vnd, '0.1234567891')
  assert.equal(prices[0].rates.totalVnd, '0.1234567891')
  assert.equal(prices[0].rates.total, '0.000004551738')
  assert.equal(prices[0].rates.exchange_rate, 27_123)
  assert.equal(prices[0].rates.currency, 'USD')
  assert.equal(priceUsage('openai', prices[0].rates, { input: 1_000_000 }).amount, '0.000004551738')

  config.usdToVnd = 30_000
  const listed = await app.inject({ method: 'GET', url: '/prices' })
  assert.equal(listed.statusCode, 200, listed.body)
  assert.equal(listed.json().data[0].total_vnd, '0.1234567891')
})

test('CRM preserves zero VND prices and rejects positive values below USD billing precision', async t => {
  const { create } = await fixture(t)
  for (const amount of [0, '0.000000025']) {
    const response = await create(amount)
    assert.equal(response.statusCode, 201, response.body)
    assert.equal(response.json().total_vnd, String(amount))
  }
  const tooSmall = await create('0.0000000001')
  assert.equal(tooSmall.statusCode, 400, tooSmall.body)
  assert.equal(tooSmall.json().error.code, 'price_below_precision')
})

test('CRM displays legacy manual prices using their recorded exchange rate', async t => {
  const { app, prices } = await fixture(t, 30_000)
  prices.push({
    _id: randomUUID(), provider: 'openai', model: 'legacy', effective_at: new Date('2026-11-20T00:00:00Z'),
    rates: { total: '0.000004', currency: 'USD', exchange_rate: 25_000 },
  })
  const response = await app.inject({ method: 'GET', url: '/prices' })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().data[0].total_vnd, '0.1')
})

test('CRM converts imported USD price amounts with the configured rate without rounding tiny values to zero', async t => {
  const { app, config, prices, create } = await fixture(t, 27_123)
  for (const [model, rates] of [
    ['provider-total', { total: '0.123456789123' }],
    ['legacy-input', { input: '0.000000000001' }],
    ['provider-zero', { total: 0 }],
    ['missing-price', {}],
  ] as const) prices.push({ _id: randomUUID(), provider: 'openai', model, effective_at: new Date('2026-11-20T00:00:00Z'), rates })
  const listed = async () => {
    const response = await app.inject({ method: 'GET', url: '/prices' })
    assert.equal(response.statusCode, 200, response.body)
    return Object.fromEntries(response.json().data.map((row: Row) => [row.model, row.total_vnd]))
  }
  assert.deepEqual(await listed(), {
    'provider-total': '3348.518491383129', 'legacy-input': '0.000000027123',
    'provider-zero': '0', 'missing-price': null,
  })
  const copied = await create((await listed())['provider-total'])
  assert.equal(copied.statusCode, 201, copied.body)
  assert.equal(copied.json().total_vnd, '3348.518491383129')
  assert.equal(prices.at(-1)!.rates.total, '0.123456789123')
  config.usdToVnd = 25_000
  assert.equal((await listed())['provider-total'], '3086.419728075')
})
