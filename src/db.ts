import { MongoClient, type ClientSession, type Collection, type Db, type Document } from 'mongodb'

export interface Database {
  client: MongoClient
  db: Db
  root?: Database
  partnerId?: string
  resolve?: () => Database
}

export interface TransactionContext {
  db: Db
  session: ClientSession
  root?: Database
  partnerId?: string
}

export type MongoSource = Database | TransactionContext

export function resolveDatabase(db: Database): Database {
  return db.resolve ? db.resolve() : db
}

export function rootDatabase(db: Database): Database {
  const resolved = resolveDatabase(db)
  return resolved.root ?? resolved
}

export function workspaceId(db: Database): string | undefined {
  return resolveDatabase(db).partnerId
}

export function connect(uri: string, databaseName = 'node_service', maxPoolSize = 20): Database {
  // Bound connection and pool waits so request floods or an unavailable database
  // cannot leave an unbounded queue of pending HTTP handlers in memory.
  const client = new MongoClient(uri, {
    maxPoolSize, maxConnecting: 2, waitQueueTimeoutMS: 5_000,
    serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000,
    socketTimeoutMS: 45_000, maxIdleTimeMS: 60_000,
  })
  return { client, db: client.db(databaseName) }
}

type StringIdDocument<T> = any

export function collection<T = Record<string, unknown>>(source: MongoSource, name: string): Collection<StringIdDocument<T>> {
  return source.db.collection(name) as Collection<StringIdDocument<T>>
}

export function sessionOf(source: MongoSource): ClientSession | undefined {
  return 'session' in source ? source.session : undefined
}

export async function transaction<T>(db: Database, fn: (context: TransactionContext) => Promise<T>): Promise<T> {
  db = resolveDatabase(db)
  await db.client.connect()
  const session = db.client.startSession()
  try {
    return await session.withTransaction(() => fn({ db: db.db, session, root: db.root, partnerId: db.partnerId }))
  } finally {
    await session.endSession()
  }
}

export async function assertTransactionSupport(db: Database) {
  const hello = await db.db.command({ hello: 1 })
  if (hello.logicalSessionTimeoutMinutes == null || (!hello.setName && hello.msg !== 'isdbgrid')) {
    throw new Error('MONGODB_URI must point to a MongoDB replica set or sharded cluster to support transactions.')
  }
}

export async function close(db: Database) {
  await db.client.close()
}
// @ts-nocheck
