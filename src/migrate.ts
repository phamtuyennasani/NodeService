import { pathToFileURL } from 'node:url'
import { connect, close, collection, type Database } from './db.js'

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

export async function migrate(db: Database) {
  await db.client.connect()
  const database = db.db
  await Promise.all([
    database.createCollection('schema_migrations').catch(() => undefined),
    database.createCollection('users').catch(() => undefined),
    database.createCollection('sessions').catch(() => undefined),
    database.createCollection('customers').catch(() => undefined),
    database.createCollection('sites').catch(() => undefined),
    database.createCollection('jobs').catch(() => undefined),
    database.createCollection('quota_reservations').catch(() => undefined),
    database.createCollection('model_prices').catch(() => undefined),
    database.createCollection('ai_attempts').catch(() => undefined),
    database.createCollection('provider_limits').catch(() => undefined),
    database.createCollection('webhook_deliveries').catch(() => undefined),
    database.createCollection('webhook_attempts').catch(() => undefined),
    database.createCollection('ai_providers').catch(() => undefined),
    database.createCollection('ai_models').catch(() => undefined),
  ])

  await Promise.all([
    collection(db, 'users').createIndex({ username: 1 }, { unique: true }),
    collection(db, 'sessions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    collection(db, 'sites').createIndex({ token_hash: 1 }, { unique: true, sparse: true }),
    collection(db, 'sites').createIndex({ customer_id: 1 }),
    collection(db, 'jobs').createIndex({ site_id: 1, client_request_id: 1 }, { unique: true }),
    collection(db, 'jobs').createIndex({ status: 1, available_at: 1 }),
    collection(db, 'jobs').createIndex({ status: 1, lease_expires_at: 1 }),
    collection(db, 'jobs').createIndex({ site_id: 1, scheduled_at: 1, _id: 1 }),
    collection(db, 'jobs').createIndex({ site_id: 1, completed_at: -1, _id: -1 }),
    collection(db, 'jobs').createIndex({ customer_id: 1, created_at: -1, _id: -1 }),
    collection(db, 'quota_reservations').createIndex({ job_id: 1 }, { unique: true }),
    collection(db, 'quota_reservations').createIndex({ customer_id: 1, quota_day: 1, status: 1 }),
    collection(db, 'quota_reservations').createIndex({ customer_id: 1, quota_month: 1, status: 1 }),
    collection(db, 'model_prices').createIndex({ provider: 1, model: 1, effective_at: -1 }),
    collection(db, 'ai_attempts').createIndex({ job_id: 1, requested_at: 1 }),
    collection(db, 'ai_attempts').createIndex({ provider: 1, finished_at: 1 }),
    collection(db, 'webhook_deliveries').createIndex({ job_id: 1, event: 1 }, { unique: true }),
    collection(db, 'webhook_deliveries').createIndex({ status: 1, next_attempt_at: 1 }),
    collection(db, 'webhook_deliveries').createIndex({ status: 1, lease_expires_at: 1 }),
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
    await migrate(db)
    console.log('MongoDB indexes and seed data applied')
  } finally {
    await close(db)
  }
}
// @ts-nocheck
