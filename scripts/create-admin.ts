import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { assertTransactionSupport, close, collection, connect } from '../src/db.js';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../src/security.js';
import { migrate } from '../src/migrate.js';
import { z } from 'zod';

const username = process.argv[2]?.trim().toLowerCase();
if (!username || !/^[\w.@-]{3,100}$/.test(username)) {
  throw new Error('Usage: npm run admin -- <username>');
}
const email = process.env.CRM_ADMIN_EMAIL?.trim().toLowerCase();
if (email && !z.email().max(254).safeParse(email).success) throw new Error('CRM_ADMIN_EMAIL must be a valid email address');

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
    { $setOnInsert: { _id: randomUUID(), username, role: 'root', password_hash: await hashPassword(password), created_at: new Date(),
      ...(email ? { email, email_verified_at: new Date(), email_revision: 1 } : {}),
    } },
    { upsert: true },
  );
  if (!result.upsertedCount) throw new Error('That CRM user already exists');
  console.log(`CRM user created: ${username}`);
  if (!email) console.log('No login email provisioned. Set a verified account email before enabling email OTP sign-in.');
} finally {
  await close(db);
}
// @ts-nocheck
