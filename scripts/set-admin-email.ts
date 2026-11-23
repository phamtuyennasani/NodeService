import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { z } from 'zod';
import { assertTransactionSupport, close, collection, connect, sessionOf, transaction } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { verifyPassword } from '../src/security.js';

// Operator-only recovery/provisioning, never invoked by an HTTP endpoint.
// The operator must have verified ownership of the destination mailbox first.
const username = process.argv[2]?.trim().toLowerCase();
const email = process.env.CRM_ADMIN_EMAIL?.trim().toLowerCase();
if (!username || !/^[\w.@-]{3,100}$/.test(username) || !email || !z.email().max(254).safeParse(email).success) {
  throw new Error('Usage: set CRM_ADMIN_EMAIL to an operator-verified mailbox, then npm run admin:email -- <username>');
}
let password = process.env.CRM_ADMIN_PASSWORD;
if (!password) {
  if (!process.stdin.isTTY) throw new Error('Set CRM_ADMIN_PASSWORD to the existing account password for non-interactive use');
  const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    process.stdout.write('Mật khẩu CRM hiện tại: ');
    password = await input.question('');
    process.stdout.write('\n');
  } finally { input.close(); }
}
if (!password || password.length > 256) throw new Error('The existing CRM password is required');
const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('Set MONGODB_URI before provisioning an account email');
const db = connect(uri, process.env.MONGODB_DATABASE || 'node_service');
try {
  await assertTransactionSupport(db);
  await migrate(db);
  const user = await collection(db, 'users').findOne({ username });
  if (!user || !(await verifyPassword(password, user.password_hash))) throw new Error('The account or existing password is invalid');
  await transaction(db, async source => {
    const options = { session: sessionOf(source) };
    const updated = await collection(source, 'users').updateOne({ _id: user._id, password_hash: user.password_hash,
      email_revision: user.email_revision ?? { $exists: false },
    }, {
      $set: { email, email_verified_at: new Date(), email_revision: (Number(user.email_revision) || 0) + 1, updated_at: new Date() },
      $inc: { auth_revision: 1 },
    }, options);
    if (!updated.matchedCount) throw new Error('The account changed during provisioning. Try again.');
    for (const name of ['sessions', 'crm_trusted_devices', 'crm_login_challenges', 'crm_email_challenges']) {
      await collection(source, name).deleteMany({ user_id: user._id }, options);
    }
  });
  console.log('Account email provisioned. Previous sessions and trusted devices have been revoked. Sign in again with email OTP.');
} finally { await close(db); }
