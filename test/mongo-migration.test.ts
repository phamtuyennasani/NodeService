import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { MongoServerError } from 'mongodb'
import { registerCustomers } from '../src/api/crm-customers.js'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import { digest } from '../src/security.js'

test('MongoDB migration replaces the legacy sparse index and only scrubs the plaintext job field', async () => {
  const legacy = { name: 'token_hash_1', key: { token_hash: 1 }, unique: true, sparse: true }
  const indexes = new Map<string, object>([[legacy.name, legacy]])
  const sites: { token_hash?: string | null }[] = [{ token_hash: 'active-hash' }, { token_hash: null }, {}]
  const job: { keyAI?: string, encrypted_key: string, status: string } = {
    keyAI: 'fake-legacy-key', encrypted_key: 'encrypted-value', status: 'scheduled',
  }
  const markers = new Map<string, { applied_at: Date }>()
  let keyUpdates = 0
  let drops = 0
  const other = { createIndex: async () => {}, updateOne: async () => {} }
  const tables = {
    sites: {
      async createIndex(key: object, options?: { name?: string }) {
        if (options?.name) indexes.set(options.name, { key, ...options })
      },
      async indexes() { return [...indexes.values()] },
      async dropIndex(name: string) {
        assert.ok(indexes.has('unique_site_token_hash'))
        if (!indexes.delete(name)) throw new MongoServerError({ code: 27, codeName: 'IndexNotFound' })
        drops++
      },
      async updateMany(filter: object, update: object) {
        assert.deepEqual(filter, { token_hash: { $type: 'null' } })
        assert.deepEqual(update, { $unset: { token_hash: '' } })
        for (const site of sites) if (site.token_hash === null) delete site.token_hash
      },
    },
    schema_migrations: {
      async findOne({ _id }: { _id: string }) { return markers.get(_id) },
      async updateOne({ _id }: { _id: string }, { $setOnInsert }: { $setOnInsert?: { applied_at: Date } }) {
        if ($setOnInsert && !markers.has(_id)) markers.set(_id, $setOnInsert)
      },
    },
    jobs: {
      async updateMany(filter: object, update: object) {
        assert.deepEqual(filter, { keyAI: { $exists: true } })
        assert.deepEqual(update, { $unset: { keyAI: '' } })
        delete job.keyAI
        keyUpdates++
      },
    },
  }
  const db = {
    client: { connect: async () => {} },
    db: {
      createCollection: async () => {},
      collection(name: keyof typeof tables) { return { ...other, ...tables[name] } },
    },
  } as unknown as Database

  await Promise.all([migrate(db), migrate(db)])
  assert.equal(drops, 1)
  assert.deepEqual([...indexes.values()], [{
    key: { token_hash: 1 }, name: 'unique_site_token_hash', unique: true,
    partialFilterExpression: { token_hash: { $type: 'string' } },
  }])
  assert.deepEqual(sites, [{ token_hash: 'active-hash' }, {}, {}])
  assert.deepEqual(job, { encrypted_key: 'encrypted-value', status: 'scheduled' })
  const marker = markers.get('mongodb-remove-plaintext-job-keys')
  assert.ok(marker)
  const completedUpdates = keyUpdates
  await migrate(db)
  assert.equal(drops, 1)
  assert.equal(keyUpdates, completedUpdates)
  assert.equal(markers.get('mongodb-remove-plaintext-job-keys'), marker)
})

test('CRM creates and revokes multiple website tokens without writing null token hashes', async t => {
  type Site = { _id: string, token_hash?: string, token_prefix?: string }
  const sites = new Map<string, Site>()
  const customerId = 'aa9a15c2-61f0-4cb4-9956-f96dcf560ee0'
  const session = {
    async withTransaction<T>(run: () => Promise<T>) { return run() },
    async endSession() {},
  }
  const db = {
    client: { async connect() {}, startSession() { return session } },
    db: { collection: (name: string) => name === 'customers' ? {
      async updateOne({ _id }: { _id: string }, update: object, options: { session?: unknown }) {
        assert.equal(options.session, session)
        assert.deepEqual(update, { $inc: { relation_version: 1 } })
        return { matchedCount: Number(_id === customerId) }
      },
    } : ({
      async insertOne(site: Site, options: { session?: unknown }) {
        assert.equal(options.session, session)
        sites.set(site._id, site)
      },
      async updateOne({ _id }: { _id: string }, { $set, $unset }: { $set: Partial<Site>, $unset?: Partial<Site> }) {
        const site = sites.get(_id)
        if (!site) return { matchedCount: 0 }
        Object.assign(site, $set)
        for (const field of Object.keys($unset ?? {}) as (keyof Site)[]) delete site[field]
        return { matchedCount: 1 }
      },
    }) },
  } as unknown as Database
  const app = Fastify()
  t.after(() => app.close())
  registerCustomers(app, db, { allowLocalWebhooks: true, encryptionKey: Buffer.alloc(32, 17) } as Config)

  for (const name of ['Website A', 'Website B']) {
    const response = await app.inject({
      method: 'POST', url: '/websites',
      payload: { customer_id: customerId, name, domain: 'example.com', webhook_url: 'http://127.0.0.1/webhook' },
    })
    assert.equal(response.statusCode, 201, response.body)
    assert.equal(Object.hasOwn(sites.get(response.json().id)!, 'token_hash'), false)
  }
  for (const [id, site] of sites) {
    const issued = await app.inject({ method: 'POST', url: `/websites/${id}/token` })
    assert.equal(issued.statusCode, 200, issued.body)
    assert.equal(site.token_hash, digest(issued.json().token))
  }
  for (const [id, site] of sites) {
    const revoked = await app.inject({ method: 'DELETE', url: `/websites/${id}/token` })
    assert.equal(revoked.statusCode, 204, revoked.body)
    assert.equal(Object.hasOwn(site, 'token_hash'), false)
    assert.equal(Object.hasOwn(site, 'token_prefix'), false)
  }
})
