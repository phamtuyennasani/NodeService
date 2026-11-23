import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveServiceKey, serviceKeyState } from '../src/provider-key.js'
import { seal } from '../src/security.js'

const encryptionKey = Buffer.alloc(32, 11)
const config = { encryptionKey, serviceKeys: { openai: 'environment-fixture-key', 'openai-compatible': 'legacy-fixture-key' } }

test('saved service credentials take precedence and corrupt ciphertext never borrows an environment key', () => {
  const saved = seal('saved-fixture-key', encryptionKey)
  assert.equal(resolveServiceKey('openai', saved, config), 'saved-fixture-key')
  assert.equal(serviceKeyState('openai', saved, config), 'ready')
  const incompatible = seal('other-process-fixture-key', Buffer.alloc(32, 12))
  assert.throws(() => resolveServiceKey('openai', incompatible, config))
  assert.equal(serviceKeyState('openai', incompatible, config), 'unreadable')
  assert.equal(serviceKeyState('openai', 'malformed-fixture-ciphertext', config), 'unreadable')
})

test('only built-in connections may use their own environment fallback', () => {
  assert.equal(resolveServiceKey('openai', null, config), 'environment-fixture-key')
  assert.equal(serviceKeyState('anthropic', undefined, config), 'missing')
  assert.equal(resolveServiceKey('openai-compatible', null, config), 'legacy-fixture-key')
  const custom = 'openai-compatible-10000000-0000-4000-8000-000000000001'
  assert.equal(resolveServiceKey(custom, null, config), undefined)
  assert.equal(serviceKeyState(custom, null, config), 'missing')
  assert.equal(serviceKeyState(custom, seal('', encryptionKey), config), 'missing')
})
