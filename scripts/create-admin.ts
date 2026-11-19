import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { connect } from '../src/db.js';
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
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before creating a user');
const db = connect(process.env.DATABASE_URL);
try {
  await migrate(db);
  const { rowCount } = await db.query(
    'INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING',
    [username, await hashPassword(password)],
  );
  if (rowCount === 0) throw new Error('That CRM user already exists');
  console.log(`CRM user created: ${username}`);
} finally {
  await db.end();
}
