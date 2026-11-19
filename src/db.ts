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

export function connect(uri: string, databaseName = 'node_service'): Database {
  const client = new MongoClient(uri, { maxPoolSize: 20 })
  return { client, db: client.db(databaseName) }
}

export function collection<T extends Document>(source: MongoSource, name: string): Collection<T> {
  return source.db.collection<T>(name)
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

export async function close(db: Database) {
  await db.client.close()
}
