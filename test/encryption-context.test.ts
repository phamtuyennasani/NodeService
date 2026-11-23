import assert from 'node:assert/strict'
import test from 'node:test'
import type { Database } from '../src/db.js'
import { assertEncryptionContext, EncryptionContextError } from '../src/encryption-context.js'

function fixture() {
  let row: Record<string, unknown> | null = null
  let writes = 0
  const db = { db: { collection(name: string) {
    assert.equal(name, 'service_security')
    return {
      async updateOne(filter: Record<string, unknown>, update: { $setOnInsert: object }, options: object) {
        assert.deepEqual(options, { upsert: true })
        assert.deepEqual(Object.keys(update), ['$setOnInsert'])
        if (!row) { row = { ...filter, ...structuredClone(update.$setOnInsert) }; writes += 1 }
      },
      async findOne() { return structuredClone(row) },
    }
  } } } as unknown as Database
  return { db, row: () => row, writes: () => writes }
}

const first = { encryptionKey: Buffer.alloc(32, 3) }
const different = { encryptionKey: Buffer.alloc(32, 7) }

test('only API initialization establishes an encrypted database context', async () => {
  const f = fixture()
  await assert.rejects(assertEncryptionContext(f.db, first), (error: unknown) =>
    error instanceof EncryptionContextError && error.code === 'ENCRYPTION_CONTEXT_MISSING')
  assert.equal(f.writes(), 0)
  await assertEncryptionContext(f.db, first, true)
  await assertEncryptionContext(f.db, first)
  assert.equal(f.writes(), 1)
  assert.equal(typeof f.row()?.check, 'string')
  assert.ok(!String(f.row()?.check).includes('node-content-crm'))
})

test('wrong API or worker encryption key cannot overwrite the trusted context', async () => {
  const f = fixture()
  await assertEncryptionContext(f.db, first, true)
  const original = structuredClone(f.row())
  for (const initialize of [false, true]) {
    await assert.rejects(assertEncryptionContext(f.db, different, initialize), (error: unknown) =>
      error instanceof EncryptionContextError && error.code === 'ENCRYPTION_KEY_MISMATCH'
        && !error.message.includes(String(f.row()?.check)))
  }
  assert.deepEqual(f.row(), original)
  assert.equal(f.writes(), 1)
  await assertEncryptionContext(f.db, first)
})

test('concurrent API boots validate the same atomic winner', async () => {
  const f = fixture()
  const results = await Promise.allSettled([
    assertEncryptionContext(f.db, first, true), assertEncryptionContext(f.db, different, true),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.equal(rejected.reason.code, 'ENCRYPTION_KEY_MISMATCH')
  assert.equal(f.writes(), 1)
})
