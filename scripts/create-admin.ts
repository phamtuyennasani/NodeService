import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { assertTransactionSupport, close, collection, connect } from '../src/db.js';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/security.js';
import { migrate } from '../src/migrate.js';

const username = process.argv[2]?.trim().toLowerCase();
if (!username || !/^[\w.@-]{3,100}$/.test(username)) {
  throw new Error('Usage: npm run admin -- <username>');
}

let password = process.env.CRM_ADMIN_PASSWORD;
if (!password) {
  if (!process.stdin.isTTY) throw new Error('Set CRM_ADMIN_PASSWORD for non-interactive use');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    process.stdout.write('Mật khẩu CRM: ');
    password = await input.question('');
    process.stdout.write('\n');
  } finally {
    input.close();
  }
}
if (password.length < 12 || password.length > 256) throw new Error('Use a password of 12–256 characters');
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('Set MONGODB_URI before creating a user');
const db = connect(uri, process.env.MONGODB_DATABASE || 'node_service');
try {
  await assertTransactionSupport(db);
  await migrate(db);
  const result = await collection(db, 'users').updateOne(
    { username },
    { $setOnInsert: { _id: randomUUID(), username, password_hash: await hashPassword(password), created_at: new Date() } },
    { upsert: true },
  );
  if (!result.upsertedCount) throw new Error('That CRM user already exists');
  console.log(`CRM user created: ${username}`);
} finally {
  await close(db);
}
// @ts-nocheck
