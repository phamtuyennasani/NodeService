import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeOwnConnection, encodeOwnConnection } from '../src/own-connection.js'
import { seal } from '../src/security.js'

test('personal endpoint and key are authenticated and encrypted together', () => {
  const key = Buffer.alloc(32, 19)
  const encrypted = encodeOwnConnection('fixture-private-key', 'https://api.example.com/api/v1/', key)
  assert.doesNotMatch(encrypted, /fixture-private-key|example/)
  assert.deepEqual(decodeOwnConnection(encrypted, key), { apiKey: 'fixture-private-key', baseUrl: 'https://api.example.com/api/v1' })
  assert.throws(() => decodeOwnConnection(encrypted, Buffer.alloc(32, 20)))
  assert.deepEqual(decodeOwnConnection(seal('queued-legacy-key', key), key), { apiKey: 'queued-legacy-key' })
})

test('malformed connection envelopes fail closed without disclosing credential data', () => {
  const key = Buffer.alloc(32, 19)
  for (const plain of ['{"api_key":"fixture-private-key"}', JSON.stringify({ type: 'openai-compatible', api_key: 'fixture-private-key', base_url: 'https://127.0.0.1/v1' }), '{not-valid-json']) {
    assert.throws(() => decodeOwnConnection(seal(plain, key), key), error => error instanceof Error && error.message === 'Invalid encrypted AI connection')
  }
})
