import test from 'node:test'
import assert from 'node:assert/strict'
import { backoff } from '../src/worker/lease.js'
import { priceUsage } from '../src/worker/pricing.js'

test('MongoDB worker backoff grows with attempts', () => {
  assert.equal(backoff(1, 2_000), 2_000)
  assert.equal(backoff(3, 2_000), 8_000)
})

test('pricing calculates catalog cost', () => {
  const result = priceUsage('openai', { input: 1, output: 2 }, { input: 1_000_000, output: 500_000 })
  assert.equal(result.source, 'estimated')
  assert.equal(result.amount, '2.000000000000')
})

test('pricing calculates a single total-token rate', () => {
  const result = priceUsage('openai', { total: '3.5' }, { input: 800_000, cachedInput: 100_000, output: 100_000 })
  assert.equal(result.amount, '3.500000000000')
  assert.equal(result.source, 'estimated')
})
