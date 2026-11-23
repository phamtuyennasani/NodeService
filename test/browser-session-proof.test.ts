import assert from 'node:assert/strict';
import { hashPassword } from '../src/security.js';
import { registerSessions } from '../src/api/crm-session.js';
import { installErrorHandler } from '../src/api/errors.js';
import type { Config } from '../src/config.js';
import type { Database } from '../src/db.js';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import test from 'node:test';
import { createServer } from 'node:net';

type Row = Record<string, any>;
// An isolated synthetic database and localhost server; no actual CRM data is read.
function memory() {
  const tables: Record<string, Row[]> = {};
  const matches = (row: Row, filter: Row): boolean => Object.entries(filter).every(([key, expected]) => {
    if (key === '$or') return expected.some((branch: Row) => matches(row, branch));
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      return Object.entries(expected).every(([operator, value]) => operator === '$gt' ? row[key] > (value as any)
        : operator === '$gte' ? row[key] >= (value as any) : operator === '$lte' ? row[key] <= (value as any)
        : operator === '$lt' ? row[key] < (value as any) : operator === '$ne' ? row[key] !== value
        : operator === '$in' ? (value as unknown[]).includes(row[key])
        : operator === '$exists' ? Object.hasOwn(row, key) === value : false);
    }
    return row[key] === expected;
  });
  const database = { collection(name: string) {
    const rows = () => tables[name] ??= [];
    const update = (row: Row, changes: Row, inserted = false) => {
      Object.assign(row, structuredClone(changes.$set ?? {}));
      if (inserted) Object.assign(row, structuredClone(changes.$setOnInsert ?? {}));
      for (const [key, value] of Object.entries(changes.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(value);
      for (const [key, value] of Object.entries(changes.$max ?? {})) if (!row[key] || row[key] < (value as any)) row[key] = structuredClone(value);
      for (const key of Object.keys(changes.$unset ?? {})) delete row[key];
    };
    return {
      async findOne(filter: Row) { return structuredClone(rows().find(row => matches(row, filter)) ?? null); },
      async insertOne(row: Row) {
        if (rows().some(saved => saved._id === row._id)) throw Object.assign(new Error('Duplicate fixture'), { code: 11000 });
        rows().push(structuredClone(row)); return { insertedId: row._id };
      },
      async updateOne(filter: Row, changes: Row) {
        const row = rows().find(row => matches(row, filter));
        if (row) update(row, changes);
        return { matchedCount: row ? 1 : 0 };
      },
      async findOneAndUpdate(filter: Row, changes: Row, options: Row) {
        let row = rows().find(row => matches(row, filter));
        const inserted = !row;
        if (!row && options?.upsert) { row = { ...filter }; rows().push(row); }
        if (row) update(row, changes, inserted);
        return structuredClone(row ?? null);
      },
      async findOneAndDelete(filter: Row) {
        const index = rows().findIndex(row => matches(row, filter));
        return index < 0 ? null : rows().splice(index, 1)[0];
      },
      async deleteOne(filter: Row) {
        const index = rows().findIndex(row => matches(row, filter));
        if (index >= 0) rows().splice(index, 1);
      },
      async deleteMany(filter: Row) { tables[name] = rows().filter(row => !matches(row, filter)); },
    };
  } };
  return { tables, db: { db: database, client: { async connect() {}, startSession() { return {
    async withTransaction<T>(fn: () => Promise<T>) { return fn(); }, async endSession() {},
  }; } } } as unknown as Database };
}

test('real browser login binds the session to a persistent nonextractable signing key', async t => {
  const { outputFiles } = await build({
    stdin: { contents: `import * as Api from './web/src/api'; import * as Proof from './web/src/browser-proof';
      window.fixture = { ...Api, ...Proof };`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', write: false,
  });
  const store = memory();
  const password = 'synthetic-browser-password';
  store.tables.users = [{ _id: 'fixture-admin', username: 'fixture-admin', password_hash: await hashPassword(password),
    email: 'synthetic-browser@example.test', email_verified_at: new Date(), email_revision: 0 }];
  const mailbox: { code: string; purpose: string }[] = [];
  const app = Fastify();
  installErrorHandler(app);
  await app.register(cookie);
  const portProbe = createServer();
  await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const settings = { origin, production: false, secureCookies: false, encryptionKey: Buffer.alloc(32, 63) } as Config;
  let mutations = 0;
  await app.register(async crm => {
    registerSessions(crm, store.db, settings, { sendOtp: async (_config, message) => { mailbox.push(message); } });
    crm.get('/test-read', async () => ({ ok: true }));
    crm.patch('/providers/fixture', async () => ({ mutations: ++mutations }));
  }, { prefix: '/api/crm' });
  app.get('/', async (_request, reply) => reply.type('text/html').send('<!doctype html><meta charset="utf-8"><script src="/fixture.js"></script>'));
  app.get('/fixture.js', async (_request, reply) => reply.type('text/javascript').send(outputFiles[0].text));
  await app.listen({ host: '127.0.0.1', port });
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(origin);
    await t.test('password login and subsequent signed requests succeed', async () => {
      const challenge = await page.evaluate(async password => {
        return (window as any).fixture.mutate('/login', 'POST', { username: 'fixture-admin', password });
      }, password);
      assert.equal(challenge.otp_required, true);
      assert.equal(store.tables.sessions?.length ?? 0, 0, 'password login cannot establish a session before email verification');
      assert.equal(mailbox.length, 1);
      const result = await page.evaluate(async ({ challengeId, code }) => {
        const f = (window as any).fixture;
        const session = await f.mutate('/login/verify', 'POST', { challenge_id: challengeId, code, trust_device: false });
        f.setCsrfToken(session.csrf_token);
        const read = await f.request('/session');
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('crm-browser-security', 1); req.onsuccess = () => resolve(req.result); req.onerror = reject; });
        const key = await new Promise<any>((resolve, reject) => { const req = db.transaction('keys').objectStore('keys').get('session-signing-v1'); req.onsuccess = () => resolve(req.result); req.onerror = reject; });
        db.close();
        let exportBlocked = false;
        try { await crypto.subtle.exportKey('jwk', key.privateKey); } catch { exportBlocked = true; }
        return { username: read.username, binding: typeof session.browser_binding === 'string', exportBlocked, extractable: key.privateKey.extractable };
      }, { challengeId: challenge.challenge_id, code: mailbox[0].code });
      assert.deepEqual(result, { username: 'fixture-admin', binding: true, exportBlocked: true, extractable: false });
    });
    await t.test('captured proofs cannot be replayed or retargeted to another URL or query', async () => {
      let proof: string | undefined;
      const capture = (request: any) => { if (request.url().endsWith('/api/crm/test-read?x=1')) proof = request.headers()['x-crm-proof']; };
      page.on('request', capture);
      await page.evaluate(async () => { await (window as any).fixture.request('/test-read?x=1'); });
      page.off('request', capture);
      assert.ok(proof);
      const cookieHeader = (await context.cookies()).filter(value => value.name === 'crm_session').map(value => `${value.name}=${value.value}`).join('; ');
      for (const url of ['/api/crm/test-read?x=1', '/api/crm/test-read?x=2', '/api/crm/session']) {
        assert.equal((await app.inject({ url, headers: { cookie: cookieHeader, 'x-crm-proof': proof! } })).statusCode, 401);
      }
    });
    await t.test('copying every cookie to another browser does not authenticate it', async () => {
      const stolen = await browser.newContext();
      try {
        await stolen.addCookies(await context.cookies());
        const otherPage = await stolen.newPage();
        await otherPage.goto(origin);
        const result = await otherPage.evaluate(async () => {
          const f = (window as any).fixture;
          const raw = await fetch('/api/crm/session');
          const bootstrap = await (await fetch('/api/crm/session/bootstrap')).json();
          let noKey = '';
          try { await f.request('/session'); } catch (error) { noKey = (error as any).code; }
          await f.prepareBrowserLogin();
          let otherKey = 0;
          try { await f.request('/session'); } catch (error) { otherKey = (error as any).status; }
          return { raw: raw.status, bootstrapKeys: Object.keys(bootstrap).sort(), noKey, otherKey };
        });
        assert.deepEqual(result, { raw: 401, bootstrapKeys: ['browser_binding', 'server_time'], noKey: 'browser_key_missing', otherKey: 401 });
      } finally { await stolen.close(); }
    });
    await t.test('reload and a second tab keep the original key and can still sign', async () => {
      await page.reload();
      assert.equal(await page.evaluate(async () => (await (window as any).fixture.request('/session')).username), 'fixture-admin');
      const secondTab = await context.newPage();
      try {
        await secondTab.goto(origin);
        assert.equal(await secondTab.evaluate(async () => (await (window as any).fixture.request('/session')).username), 'fixture-admin');
      } finally { await secondTab.close(); }
    });
    await t.test('sensitive changes prompt once and authorize exactly one matching request', async () => {
      const result = await page.evaluate(async password => {
        const f = (window as any).fixture;
        f.setCsrfToken((await f.request('/session')).csrf_token);
        let prompts = 0;
        f.setReauthenticationHandler(async () => { prompts++; return password; });
        const first = await f.mutate('/providers/fixture', 'PATCH', { display_name: 'Fixture' });
        const second = await f.mutate('/providers/fixture', 'PATCH', { display_name: 'Fixture again' });
        f.setReauthenticationHandler(async () => null);
        let canceled = '';
        try { await f.mutate('/providers/fixture', 'PATCH', { display_name: 'Canceled' }); } catch (error) { canceled = (error as any).code; }
        return { first: first.mutations, second: second.mutations, prompts, canceled };
      }, password);
      assert.deepEqual(result, { first: 1, second: 2, prompts: 2, canceled: 'reauthentication_canceled' });
      assert.equal(mutations, 2);
    });
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); await app.close(); }
});
