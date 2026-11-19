import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { connect, transaction, type Database } from './db.js';

export async function migrate(db: Database) {
  const directory = new URL('../migrations/', pathToFileURL(process.cwd() + '/src/'));
  const files = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  await transaction(db, async client => {
    await client.query('SELECT pg_advisory_xact_lock(8312671)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const applied = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(row => row.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      await client.query(await readFile(new URL(file, directory), 'utf8'));
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running migrations');
  const db = connect(process.env.DATABASE_URL);
  try {
    await migrate(db);
    console.log('PostgreSQL migrations applied');
  } finally {
    await db.end();
  }
}
