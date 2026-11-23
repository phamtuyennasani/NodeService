import { MongoClient, type ClientSession, type Collection, type Db, type Document } from 'mongodb'

export interface Database {
  client: MongoClient
  db: Db
}

export interface TransactionContext {
  db: Db
  session: ClientSession
}

export type MongoSource = Database | TransactionContext

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
  await db.client.connect()
  const session = db.client.startSession()
  try {
    return await session.withTransaction(() => fn({ db: db.db, session }))
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
