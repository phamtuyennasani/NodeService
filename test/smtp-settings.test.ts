import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import nodemailer from 'nodemailer';
import type { Config } from '../src/config.js';
import type { Database } from '../src/db.js';
import { installErrorHandler } from '../src/api/errors.js';
import { registerCrmMailSettings } from '../src/api/crm-mail-settings.js';
import { resolveCrmMailConfig, smtpSettingsCollection, smtpSettingsId } from '../src/smtp-settings.js';
import { unseal } from '../src/security.js';

type Row = Record<string, any>;
const values = { host: 'smtp.example.test', port: 465, secure: true, from: 'crm@example.test', user: 'synthetic-smtp-user' };
const secret = 'synthetic-smtp-password-not-a-real-secret';
const config = (mail?: Config['mail']) => ({ production: false, encryptionKey: Buffer.alloc(32, 9), mail }) as Config;
function memory() {
  const rows: Row[] = [];
  let unavailable = false;
  const db = { db: { collection(name: string) {
    assert.equal(name, smtpSettingsCollection, 'SMTP secrets use a dedicated collection');
    return {
      async findOne(filter: Row) {
        if (unavailable) throw new Error('synthetic database unavailable');
        return structuredClone(rows.find(row => Object.entries(filter).every(([key, value]) => row[key] === value)) ?? null);
      },
      async insertOne(row: Row) {
        if (rows.some(item => item._id === row._id)) throw Object.assign(new Error('Duplicate'), { code: 11000 });
        rows.push(structuredClone(row));
        return { insertedId: row._id };
      },
      async updateOne(filter: Row, update: Row) {
        const row = rows.find(item => Object.entries(filter).every(([key, value]) => item[key] === value));
        if (!row) return { matchedCount: 0 };
        Object.assign(row, structuredClone(update.$set ?? {}));
        for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] += Number(value);
        return { matchedCount: 1 };
      },
    };
  } } } as unknown as Database;
  return { db, rows, setUnavailable: (value: boolean) => { unavailable = value; } };
}
async function fixture(t: test.TestContext, base = config()) {
  const store = memory();
  const app = Fastify();
  installErrorHandler(app);
  await app.register(rateLimit, { global: false });
  registerCrmMailSettings(app, store.db, base);
  await app.ready();
  t.after(() => app.close());
  return { ...store, base, app,
    read: () => app.inject('/settings/smtp'),
    save: (revision: number, input: Row) => app.inject({ method: 'PUT', url: '/settings/smtp', payload: { revision, values: input } }),
    verify: (revision: number, extra: Row = {}) => app.inject({ method: 'POST', url: '/settings/smtp/test', payload: { revision, ...extra } }),
  };
}

test('SMTP settings expose none defaults or redacted environment fallback without persisting secrets', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.read()).json(), { values: { host: '', port: 465, secure: true, from: '', user: '' },
    revision: 0, password_configured: false, configured: false, source: 'none', updated_at: null });
  f.base.mail = { ...values, password: secret, allowInsecureLocal: false };
  const response = await f.read();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().values, values);
  assert.equal(response.json().source, 'environment');
  assert.equal(response.json().password_configured, true);
  assert.ok(!response.body.includes(secret));
  assert.equal(f.rows.length, 0);
  assert.equal((await resolveCrmMailConfig(f.db, f.base))?.password, secret);
});

test('SMTP saves a separately encrypted secret and resolves database changes immediately without leaking it', async t => {
  const f = await fixture(t, config({ ...values, host: 'old.example.test', password: 'synthetic-env-secret', allowInsecureLocal: false }));
  const saved = await f.save(0, { ...values, password: secret });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().source, 'database');
  assert.equal(saved.json().revision, 1);
  assert.equal(saved.json().configured, true);
  assert.equal(saved.json().password_configured, true);
  assert.ok(!saved.body.includes(secret));
  const row = f.rows[0];
  assert.equal(row._id, smtpSettingsId);
  assert.deepEqual(row.values, values);
  assert.equal(unseal(row.password_encrypted, f.base.encryptionKey), secret);
  assert.ok(!JSON.stringify(row).includes(secret));
  assert.ok(!saved.body.includes(row.password_encrypted));
  assert.ok(!JSON.stringify((await f.read()).json()).includes(row.password_encrypted));
  assert.equal((await resolveCrmMailConfig(f.db, f.base))?.password, secret);
  row.values.from = 'changed@example.test';
  assert.equal((await resolveCrmMailConfig(f.db, f.base))?.from, 'changed@example.test');
});

test('blank secrets retain the saved or environment password only for the same connection identity', async t => {
  const f = await fixture(t, config({ ...values, password: secret, allowInsecureLocal: false }));
  const copied = await f.save(0, values);
  assert.equal(copied.statusCode, 200, copied.body);
  assert.equal((await resolveCrmMailConfig(f.db, f.base))?.password, secret);
  const fromChanged = await f.save(1, { ...values, from: 'changed@example.test', password: '' });
  assert.equal(fromChanged.statusCode, 200, fromChanged.body);
  assert.equal((await resolveCrmMailConfig(f.db, f.base))?.password, secret);
  for (const changed of [{ host: 'new.example.test' }, { port: 587 }, { secure: false }, { user: 'another-synthetic-user' }]) {
    const denied = await f.save(2, { ...values, ...changed, password: '' });
    assert.equal(denied.statusCode, 400, denied.body);
  }
  assert.equal(f.rows[0].revision, 2);
  const rotated = await f.save(2, { ...values, host: 'new.example.test', password: 'synthetic-rotated-password' });
  assert.equal(rotated.statusCode, 200, rotated.body);
  assert.equal((await resolveCrmMailConfig(f.db, f.base))?.password, 'synthetic-rotated-password');
  const cleared = await f.save(3, { ...values, user: '', password: 'ignored-when-auth-disabled' });
  assert.equal(cleared.statusCode, 200, cleared.body);
  assert.equal(cleared.json().password_configured, false);
  assert.equal(f.rows[0].password_encrypted, null);
  assert.equal((await resolveCrmMailConfig(f.db, f.base))?.password, undefined);
  assert.equal((await resolveCrmMailConfig(f.db, f.base))?.user, undefined);
});

test('SMTP validates strict schemas and always stores TLS without allowing plaintext or arbitrary transport options', async t => {
  const f = await fixture(t);
  for (const invalid of [
    { host: '' }, { host: 'smtp://user:secret@example.test' }, { host: 'smtp.example.test\r\nBcc:evil@example.test' },
    { port: 0 }, { port: 65536 }, { secure: 'false' }, { from: 'CRM <crm@example.test>' }, { user: 'bad\nuser' },
    { password: undefined }, { password: '' }, { allowInsecureLocal: true }, { tls: { rejectUnauthorized: false } },
    { password_encrypted: 'must-not-be-trusted' },
  ]) {
    const response = await f.save(0, { ...values, password: secret, ...invalid });
    assert.equal(response.statusCode, 400, response.body);
    assert.ok(!response.body.includes(secret));
  }
  assert.equal((await f.app.inject({ method: 'PUT', url: '/settings/smtp', payload: { revision: 0, values: { ...values, password: secret }, other: true } })).statusCode, 400);
  assert.equal(f.rows.length, 0);
  const saved = await f.save(0, { ...values, port: 587, secure: false, password: secret });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await resolveCrmMailConfig(f.db, f.base))?.allowInsecureLocal, false);
});

test('SMTP CAS rejects stale first and later writes and a stale connection test before network work', async t => {
  const f = await fixture(t);
  const first = await Promise.all([f.save(0, { ...values, password: secret }), f.save(0, { ...values, from: 'other@example.test', password: secret })]);
  assert.deepEqual(first.map(response => response.statusCode).sort(), [200, 409]);
  const updates = await Promise.all([f.save(1, { ...values, from: 'new@example.test' }), f.save(1, { ...values, from: 'other-new@example.test' })]);
  assert.deepEqual(updates.map(response => response.statusCode).sort(), [200, 409]);
  assert.equal(f.rows[0].revision, 2);
  const stale = await f.verify(1);
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, 'settings_conflict');
});

test('saved corruption and DB failures never fall back to the environment SMTP password', async t => {
  const f = await fixture(t, config({ ...values, password: 'synthetic-env-password', allowInsecureLocal: false }));
  assert.equal((await f.save(0, { ...values, password: secret })).statusCode, 200);
  const cipher = f.rows[0].password_encrypted;
  f.rows[0].password_encrypted = 'corrupt-ciphertext';
  await assert.rejects(resolveCrmMailConfig(f.db, f.base), error => (error as { code?: string }).code === 'mail_unavailable');
  const failed = await f.read();
  assert.equal(failed.statusCode, 503);
  assert.ok(!failed.body.includes('corrupt-ciphertext'));
  assert.ok(!failed.body.includes(secret));
  f.rows[0].password_encrypted = cipher;
  f.setUnavailable(true);
  await assert.rejects(resolveCrmMailConfig(f.db, f.base), /synthetic database unavailable/);
});

test('SMTP test uses only the saved effective config, verifies without sending and is rate bounded', async t => {
  const f = await fixture(t);
  assert.equal((await f.save(0, { ...values, password: secret })).statusCode, 200);
  const options: Row[] = [];
  let verified = 0; let closed = 0;
  t.mock.method(nodemailer, 'createTransport', ((input: Row) => {
    options.push(input);
    return { async verify() { verified++; return true; }, close() { closed++; }, sendMail() { assert.fail('connection test must never send mail'); } };
  }) as unknown as typeof nodemailer.createTransport);
  const extra = await f.verify(1, { to: 'not-a-real-recipient@example.test' });
  assert.equal(extra.statusCode, 400);
  assert.equal(verified, 0);
  const ok = await f.verify(1);
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json(), { ok: true });
  assert.equal(verified, 1);
  assert.equal(closed, 1);
  assert.equal(options[0].host, values.host);
  assert.equal(options[0].auth.pass, secret);
  assert.equal(options[0].requireTLS, true);
  assert.equal(options[0].ignoreTLS, false);
  assert.equal(options[0].tls.rejectUnauthorized, true);
  assert.equal(options[0].tls.minVersion, 'TLSv1.2');
  assert.equal(options[0].logger, false);
  assert.equal(options[0].debug, false);
  assert.equal(options[0].forceAuth, true);
  assert.equal((await f.verify(1)).statusCode, 200);
  const limited = await f.verify(1);
  assert.equal(limited.statusCode, 429);
  assert.equal(verified, 2);
});

test('SMTP verification errors expose no transport response or stored secret', async t => {
  const f = await fixture(t);
  assert.equal((await f.save(0, { ...values, password: secret })).statusCode, 200);
  let closed = false;
  t.mock.method(nodemailer, 'createTransport', (() => ({
    async verify() { throw new Error(`535 synthetic SMTP rejection ${secret}`); },
    close() { closed = true; },
  })) as unknown as typeof nodemailer.createTransport);
  const failed = await f.verify(1);
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.json().error.code, 'mail_unavailable');
  assert.ok(!failed.body.includes(secret));
  assert.ok(!failed.body.includes('535'));
  assert.ok(!failed.body.includes(f.rows[0].password_encrypted));
  assert.equal(closed, true);
});
