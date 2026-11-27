import { pathToFileURL } from 'node:url'
import { MongoServerError } from 'mongodb'
import { assertTransactionSupport, connect, close, collection, type Database } from './db.js'

const providers = [
  { _id: 'openai', display_name: 'OpenAI', enabled: true },
  { _id: 'anthropic', display_name: 'Anthropic', enabled: true },
  { _id: 'xai', display_name: 'xAI', enabled: true },
  { _id: 'openai-compatible', display_name: 'OpenAI Compatible', enabled: false },
]
const models = [
  { _id: 'gpt-4.1', provider: 'openai', display_name: 'GPT-4.1', enabled: true },
  { _id: 'claude-sonnet-4-6', provider: 'anthropic', display_name: 'Claude Sonnet 4.6', enabled: false },
  { _id: 'grok-4.3', provider: 'xai', display_name: 'Grok 4.3', enabled: false },
]

async function migrateWebsiteTokens(db: Database) {
  const sites = collection(db, 'sites')
  await sites.createIndex({ token_hash: 1 }, {
    name: 'unique_site_token_hash',
    unique: true,
    partialFilterExpression: { token_hash: { $type: 'string' } },
  })
  const legacy = (await sites.indexes()).find(index => index.name === 'token_hash_1' && index.unique && index.sparse &&
    index.key.token_hash === 1 && Object.keys(index.key).length === 1)
  if (legacy) {
    try {
      await sites.dropIndex('token_hash_1')
    } catch (error) {
      if (!(error instanceof MongoServerError) || error.codeName !== 'IndexNotFound') throw error
    }
  }
  await sites.updateMany({ token_hash: { $type: 'null' } }, { $unset: { token_hash: '' } })
}

async function removeLegacyJobKeys(db: Database) {
  const migrations = collection(db, 'schema_migrations')
  const id = 'mongodb-remove-plaintext-job-keys'
  if (await migrations.findOne({ _id: id })) return
  await collection(db, 'jobs').updateMany({ keyAI: { $exists: true } }, { $unset: { keyAI: '' } })
  await migrations.updateOne({ _id: id }, { $setOnInsert: { applied_at: new Date(), version: 2 } }, { upsert: true })
}

export async function migrate(db: Database) {
  await db.client.connect()
  const database = db.db
  if (!db.partnerId) {
    await database.createCollection('partners').catch(() => undefined)
    await database.createCollection('partner_sites').catch(() => undefined)
    await collection(db, 'partner_sites').createIndex({ token_hash: 1 }, {
      unique: true, partialFilterExpression: { token_hash: { $type: 'string' } },
    })
    await collection(db, 'partner_sites').createIndex({ partner_id: 1 })
  }
  await Promise.all([
    database.createCollection('schema_migrations').catch(() => undefined),
    database.createCollection('users').catch(() => undefined),
    database.createCollection('sessions').catch(() => undefined),
    database.createCollection('security_rate_limits').catch(() => undefined),
    database.createCollection('crm_request_proofs').catch(() => undefined),
    database.createCollection('site_request_proofs').catch(() => undefined),
    database.createCollection('crm_action_tokens').catch(() => undefined),
    database.createCollection('crm_login_challenges').catch(() => undefined),
    database.createCollection('crm_email_challenges').catch(() => undefined),
    database.createCollection('crm_trusted_devices').catch(() => undefined),
    database.createCollection('customers').catch(() => undefined),
    database.createCollection('sites').catch(() => undefined),
    database.createCollection('site_content').catch(() => undefined),
    ...['keyword_analyses', 'keyword_attempts', 'keyword_quota_reservations', 'keyword_settings', 'keyword_source_limits'].map(name => database.createCollection(name).catch(() => undefined)),
    database.createCollection('jobs').catch(() => undefined),
    database.createCollection('quota_reservations').catch(() => undefined),
    database.createCollection('model_prices').catch(() => undefined),
    database.createCollection('ai_attempts').catch(() => undefined),
    database.createCollection('provider_limits').catch(() => undefined),
    database.createCollection('webhook_deliveries').catch(() => undefined),
    database.createCollection('webhook_attempts').catch(() => undefined),
    database.createCollection('ai_providers').catch(() => undefined),
    database.createCollection('ai_models').catch(() => undefined),
    database.createCollection('runtime_settings').catch(() => undefined),
    database.createCollection('crm_mail_settings').catch(() => undefined),
    database.createCollection('runtime_maintenance').catch(() => undefined),
    database.createCollection('worker_heartbeats').catch(() => undefined),
  ])

  await Promise.all([
    collection(db, 'users').createIndex({ username: 1 }, { unique: true }),
    // Older accounts without a verified email are deliberately excluded. Never
    // backfill verification or silently merge existing account identities.
    collection(db, 'users').createIndex({ email: 1 }, {
      name: 'unique_verified_user_email', unique: true,
      partialFilterExpression: { email: { $type: 'string' }, email_verified_at: { $type: 'date' } },
    }),
    collection(db, 'sessions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    collection(db, 'sessions').createIndex({ user_id: 1 }),
    collection(db, 'security_rate_limits').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    collection(db, 'crm_request_proofs').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    collection(db, 'site_request_proofs').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    collection(db, 'crm_action_tokens').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    collection(db, 'crm_login_challenges').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    collection(db, 'crm_login_challenges').createIndex({ user_id: 1 }),
    collection(db, 'crm_login_challenges').createIndex({ user_id: 1, last_sent_at: -1 }),
    collection(db, 'crm_email_challenges').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    collection(db, 'crm_email_challenges').createIndex({ user_id: 1 }),
    collection(db, 'crm_trusted_devices').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    collection(db, 'crm_trusted_devices').createIndex({ user_id: 1 }),
    collection(db, 'worker_heartbeats').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    collection(db, 'jobs').createIndex({ status: 1, retention_checked_at: 1, completed_at: 1, updated_at: 1, _id: 1 }),
    collection(db, 'jobs').createIndex({ source_article_id: 1, status: 1 }),
    collection(db, 'webhook_deliveries').createIndex({ status: 1, updated_at: 1, delivered_at: 1, _id: 1 }),
    migrateWebsiteTokens(db),
    collection(db, 'sites').updateMany({ proof_required: { $exists: false } }, { $set: { proof_required: true } }),
    removeLegacyJobKeys(db),
    collection(db, 'sites').createIndex({ customer_id: 1 }),
    collection(db, 'site_content').createIndex({ site_id: 1, customer_id: 1, external_id: 1 }, { unique: true }),
    collection(db, 'keyword_analyses').createIndex({ site_id: 1, 'input.client_request_id': 1 }, { unique: true }),
    collection(db, 'keyword_analyses').createIndex({ cache_key: 1, created_at: -1 }),
    collection(db, 'keyword_analyses').createIndex({ cache_key: 1 }, { unique: true, name: 'one_active_keyword_analysis', partialFilterExpression: { status: { $in: ['queued', 'running'] } } }),
    collection(db, 'keyword_analyses').createIndex({ site_id: 1, created_at: -1 }),
    collection(db, 'keyword_analyses').createIndex({ status: 1, available_at: 1 }),
    collection(db, 'keyword_attempts').createIndex({ analysis_id: 1 }),
    collection(db, 'keyword_quota_reservations').createIndex({ customer_id: 1, month: 1, status: 1 }),
    collection(db, 'site_content').createIndex({ site_id: 1, customer_id: 1, url: 1 }, { unique: true }),
    collection(db, 'site_content').createIndex({ site_id: 1, customer_id: 1, search_terms: 1, updated_at: -1 }),
    collection(db, 'jobs').createIndex({ site_id: 1, client_request_id: 1 }, { unique: true }),
    collection(db, 'ai_models').createIndex({ provider: 1, upstream_model: 1 }, { unique: true, partialFilterExpression: { upstream_model: { $type: 'string' } } }),
    collection(db, 'jobs').createIndex({ status: 1, available_at: 1 }),
    collection(db, 'jobs').createIndex({ status: 1, lease_expires_at: 1 }),
    collection(db, 'jobs').createIndex({ site_id: 1, scheduled_at: 1, _id: 1 }),
    collection(db, 'jobs').createIndex({ scheduled_at: 1, status: 1 }),
    collection(db, 'jobs').createIndex({ status: 1, completed_at: 1 }),
    collection(db, 'jobs').createIndex({ site_id: 1, completed_at: -1, _id: -1 }),
    collection(db, 'jobs').createIndex({ customer_id: 1, created_at: -1, _id: -1 }),
    collection(db, 'jobs').createIndex({ site_id: 1, customer_id: 1, article_ref: 1, created_at: 1 }),
    collection(db, 'jobs').createIndex({ site_id: 1, customer_id: 1, article_group_id: 1, created_at: 1 }),
    collection(db, 'jobs').createIndex({ translation_of_job_id: 1 }),
    collection(db, 'jobs').createIndex({ original_job_id: 1 }),
    collection(db, 'jobs').createIndex({ site_id: 1, status: 1, completed_at: -1, _id: -1 }),
    collection(db, 'jobs').createIndex({ customer_id: 1, status: 1, completed_at: -1, _id: -1 }),
    collection(db, 'jobs').createIndex({ status: 1, created_at: -1, _id: -1 }),
    collection(db, 'quota_reservations').createIndex({ job_id: 1 }, { unique: true }),
    collection(db, 'quota_reservations').createIndex({ customer_id: 1, quota_day: 1, status: 1 }),
    collection(db, 'quota_reservations').createIndex({ customer_id: 1, quota_month: 1, status: 1 }),
    collection(db, 'model_prices').createIndex({ provider: 1, model: 1, effective_at: -1 }),
    collection(db, 'ai_attempts').createIndex({ job_id: 1, requested_at: 1 }),
    collection(db, 'ai_attempts').createIndex({ requested_at: 1, job_id: 1 }),
    collection(db, 'ai_attempts').createIndex({ provider: 1, finished_at: 1 }),
    collection(db, 'webhook_deliveries').createIndex({ job_id: 1, event: 1 }, { unique: true }),
    collection(db, 'webhook_deliveries').createIndex({ status: 1, next_attempt_at: 1 }),
    collection(db, 'webhook_deliveries').createIndex({ status: 1, lease_expires_at: 1 }),
    collection(db, 'webhook_deliveries').createIndex({ event: 1, status: 1, delivered_at: 1 }),
    collection(db, 'webhook_attempts').createIndex({ delivery_id: 1, attempted_at: 1 }),
  ])

  for (const provider of providers) {
    await collection(db, 'ai_providers').updateOne({ _id: provider._id }, { $setOnInsert: provider }, { upsert: true })
  }
  for (const model of models) {
    await collection(db, 'ai_models').updateOne({ _id: model._id }, { $setOnInsert: model }, { upsert: true })
  }
  await collection(db, 'schema_migrations').updateOne(
    { _id: 'mongodb-initial' },
    { $set: { applied_at: new Date(), version: 1 } },
    { upsert: true },
  )
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const uri = process.env.MONGODB_URI
  if (!uri) throw new Error('Set MONGODB_URI before running migrations')
  const db = connect(uri, process.env.MONGODB_DATABASE || 'node_service')
  try {
    await assertTransactionSupport(db)
    await migrate(db)
    console.log('MongoDB indexes and seed data applied')
  } finally {
    await close(db)
  }
}
// @ts-nocheck
