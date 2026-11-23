import type { Config } from './config.js'
import { collection, type Database } from './db.js'
import { seal, unseal } from './security.js'

const contextId = 'encryption-context-v1'
const expected = 'node-content-crm:shared-encryption-context:v1'

export class EncryptionContextError extends Error {
  readonly code: 'ENCRYPTION_KEY_MISMATCH' | 'ENCRYPTION_CONTEXT_MISSING'

  constructor(code: EncryptionContextError['code']) {
    super(code === 'ENCRYPTION_CONTEXT_MISSING'
      ? 'Start the CRM API with the existing ENCRYPTION_KEY before starting workers or widget preview.'
      : 'ENCRYPTION_KEY does not match this database. Restore the original key and restart every API and worker; do not generate a new key.')
    this.name = 'EncryptionContextError'
    this.code = code
  }
}

/** Only an API boot may establish the context. Never overwrite an existing one. */
export async function assertEncryptionContext(
  db: Database, config: Pick<Config, 'encryptionKey'>, initialize = false,
) {
  const contexts = collection(db, 'service_security')
  if (initialize) {
    await contexts.updateOne({ _id: contextId }, { $setOnInsert: {
      check: seal(expected, config.encryptionKey), created_at: new Date(),
    } }, { upsert: true })
  }
  // Re-read the winner of a concurrent first boot instead of trusting our write.
  const row = await contexts.findOne({ _id: contextId }, { projection: { check: 1 } })
  if (!row) throw new EncryptionContextError('ENCRYPTION_CONTEXT_MISSING')
  try {
    if (typeof row.check !== 'string' || unseal(row.check, config.encryptionKey) !== expected) throw new Error('Invalid check')
  } catch { throw new EncryptionContextError('ENCRYPTION_KEY_MISMATCH') }
}
