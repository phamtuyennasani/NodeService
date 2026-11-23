import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: { contents: `import * as Api from './web/src/api'; import * as Proof from './web/src/browser-proof'; globalThis.fixture = { ...Api, ...Proof };`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'iife', platform: 'browser', write: false,
});
const id = 'c'.repeat(43);
const challenge = () => Response.json({ otp_required: true, challenge_id: id, email_hint: 't***@example.test', expires_in: 600, resend_after: 60, server_time: Date.now() });
const session = () => Response.json({ username: 'synthetic', csrf_token: 'synthetic-csrf', browser_binding: 'b'.repeat(43), server_time: Date.now() });

async function fixture(fetcher: (path: string, options: RequestInit) => Promise<Response>) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const exported = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const key = { ...pair, publicJwk: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y } };
  const db = { close() {}, transaction() { return { objectStore() { return { get() {
    const request: any = { result: key }; queueMicrotask(() => request.onsuccess?.()); return request;
  } }; } }; } };
  const indexedDB = { open() { const request: any = { result: db }; queueMicrotask(() => request.onsuccess?.()); return request; } };
  const window = Object.assign(new EventTarget(), { location: { origin: 'https://crm.example.test' } });
  let expired = 0;
  window.addEventListener('crm-session-expired', () => expired++);
  const context = vm.createContext({ window, crypto: webcrypto, indexedDB, fetch: fetcher, Headers, Response, URL, Event, TextEncoder, TextDecoder, btoa });
  vm.runInContext(outputFiles[0].text, context);
  return { api: context.fixture, expired: () => expired };
}

test('pre-session login OTP uses challenge proofs without CSRF or session bootstrap and only final verification installs session', async () => {
  const seen: string[] = [];
  let previousNonce = '';
  const f = await fixture(async (path, options) => {
    seen.push(path);
    assert.equal(new Headers(options.headers).has('X-CSRF-Token'), false);
    const [header, payload] = new Headers(options.headers).get('X-CRM-Proof')!.split('.');
    assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString()).alg, 'ES256');
    const proof = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(proof.htu, path); assert.equal(proof.htm, 'POST'); assert.notEqual(proof.jti, previousNonce); previousNonce = proof.jti;
    const body = JSON.parse(String(options.body));
    if (path === '/api/crm/login') {
      const publicKey = body.browser_public_key;
      const expected = createHash('sha256').update(JSON.stringify({ kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y })).digest('base64url');
      assert.equal(proof.sid, expected);
      return challenge();
    }
    assert.equal(proof.sid, id);
    if (path === '/api/crm/login/resend') return challenge();
    return session();
  });
  f.api.setCsrfToken('old-session-token');
  const first = await f.api.mutate('/login', 'POST', { username: 'synthetic', password: 'synthetic-password', remember_me: false });
  assert.equal(first.otp_required, true);
  const generation = f.api.getBrowserSessionGeneration();
  await f.api.mutate('/login/resend', 'POST', { challenge_id: id });
  assert.equal(f.api.getBrowserSessionGeneration(), generation);
  await f.api.mutate('/login/verify', 'POST', { challenge_id: id, code: '12345678', trust_device: false });
  assert.equal(f.api.getBrowserSessionGeneration(), generation + 1);
  assert.deepEqual(seen, ['/api/crm/login', '/api/crm/login/resend', '/api/crm/login/verify']);
  await assert.rejects(f.api.mutate('/login/verify', 'POST', { challenge_id: id, code: '12345678' }), (error: any) => error.code === 'login_challenge_required');
});

test('OTP failure remains on login and canceling invalidates the in-memory challenge', async () => {
  let fetches = 0;
  const f = await fixture(async path => {
    fetches++;
    return path === '/api/crm/login' ? challenge() : Response.json({ error: { code: 'otp_invalid', message: 'Mã OTP không đúng.' } }, { status: 401 });
  });
  await f.api.mutate('/login', 'POST', { username: 'synthetic', password: 'synthetic-password' });
  await assert.rejects(f.api.mutate('/login/verify', 'POST', { challenge_id: id, code: '00000000' }), (error: any) => error.code === 'otp_invalid');
  assert.equal(f.expired(), 0);
  f.api.cancelLoginChallenge();
  await assert.rejects(f.api.mutate('/login/resend', 'POST', { challenge_id: id }), (error: any) => error.code === 'login_challenge_required');
  assert.equal(fetches, 2);
});
