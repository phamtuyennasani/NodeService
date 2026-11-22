import test from 'node:test'
import assert from 'node:assert/strict'
import { backoff } from '../src/worker/lease.js'
import { priceUsage } from '../src/worker/pricing.js'
import { usageOf } from '../src/worker/provider.js'

test('MongoDB worker backoff grows with attempts', () => {
  assert.equal(backoff(1, 2_000), 2_000)
  assert.equal(backoff(3, 2_000), 8_000)
})

test('pricing calculates catalog cost', () => {
  const result = priceUsage('openai', { input: 1, output: 2 }, { input: 1_000_000, output: 500_000 })
  assert.equal(result.source, 'estimated')
  assert.equal(result.amount, '2.000000000000')
})

test('blended pricing counts each token once, including cached input and reasoning output', () => {
  const usage = usageOf('openai', {
    input_tokens: 900_000, input_tokens_details: { cached_tokens: 100_000 },
    output_tokens: 100_000, output_tokens_details: { reasoning_tokens: 30_000 },
  })
  assert.equal(usage?.reasoning, 30_000)
  const result = priceUsage('openai', { total: '3.5' }, usage)
  assert.equal(result.amount, '3.500000000000')
  assert.equal(result.source, 'estimated')
})

test('xAI reported cost takes precedence over a blended token estimate', () => {
  const usage = usageOf('xai', {
    input_tokens: 300, output_tokens: 100, output_tokens_details: { reasoning_tokens: 60 },
    cost_in_usd_ticks: '1350000',
  })
  assert.deepEqual(priceUsage('xai', { total: '3.5' }, usage), { amount: '0.000135000000', source: 'provider' })
})
