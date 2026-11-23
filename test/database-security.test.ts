import assert from 'node:assert/strict'
import test from 'node:test'
import { close, connect } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import type { Database } from '../src/db.js'

test('MongoDB pool and unavailable-server waits are bounded without connecting', async () => {
  const db = connect('mongodb://127.0.0.1:27017', 'unit_security', 7)
  try {
    const options = db.client.options
    assert.equal(options.maxPoolSize, 7)
    assert.equal(options.maxConnecting, 2)
    assert.equal(options.waitQueueTimeoutMS, 5_000)
    assert.equal(options.serverSelectionTimeoutMS, 10_000)
    assert.equal(options.connectTimeoutMS, 10_000)
    assert.equal(options.socketTimeoutMS, 45_000)
  } finally { await close(db) }
})

test('migration expires security buckets and indexes session revocation by user', async () => {
  const indexes: { name: string; key: object; options: object }[] = []
  const collections = new Set<string>()
  const db = {
    client: { connect: async () => {} },
    db: {
      async createCollection(name: string) { collections.add(name) },
      collection(name: string) {
        return {
          async createIndex(key: object, options: object = {}) { indexes.push({ name, key, options }) },
          async indexes() { return [] }, async findOne() { return null },
          async updateMany() {}, async updateOne() {},
        }
      },
    },
  } as unknown as Database
  await migrate(db)
  assert.ok(collections.has('security_rate_limits'))
  assert.ok(indexes.some(index => index.name === 'security_rate_limits' &&
    JSON.stringify(index.key) === JSON.stringify({ expires_at: 1 }) &&
    (index.options as { expireAfterSeconds?: number }).expireAfterSeconds === 0))
  assert.ok(indexes.some(index => index.name === 'sessions' &&
    JSON.stringify(index.key) === JSON.stringify({ user_id: 1 })))
})
