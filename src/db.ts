import pg from 'pg';
import type { PoolClient } from 'pg';

export type Database = pg.Pool;

export function connect(connectionString: string, max = 12): Database {
  const pool = new pg.Pool({ connectionString, max });
  pool.on('error', error => console.error('PostgreSQL connection error', error.message));
  return pool;
}

export async function transaction<T>(db: Database, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
