import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';

const { outputFiles } = await build({
  stdin: { contents: `import * as Api from './web/src/api'; import * as Proof from './web/src/browser-proof';
    globalThis.fixture = { ...Api, ...Proof };`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, format: 'iife', platform: 'browser', write: false,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

type Fetcher = (target: string, options: RequestInit) => Promise<Response>;
async function fixture(fetcher: Fetcher) {
  // A synthetic existing IndexedDB key, with real nonextractable WebCrypto signing.
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const exported = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const key = { ...pair, publicJwk: { kty: 'EC', crv: 'P-256', x: exported.x, y: exported.y } };
  const db = { close() {}, transaction() { return { objectStore() { return { get() {
    const request: any = { result: key };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } }; } }; } };
  const indexedDB = { open() {
    const request: any = { result: db };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  } };
  const window = Object.assign(new EventTarget(), { location: { origin: 'https://crm.test' } });
  let expired = 0;
  window.addEventListener('crm-session-expired', () => { expired++; });
  const context = vm.createContext({
    window, crypto: webcrypto, indexedDB, fetch: fetcher, Headers, Response, URL, Event,
    TextEncoder, TextDecoder, btoa, console,
  });
  vm.runInContext(outputFiles[0].text, context);
  const api = context.fixture;
  api.setBrowserSession({ browser_binding: 'a'.repeat(43), server_time: Date.now() });
  api.setCsrfToken('synthetic-csrf');
  return { api, expired: () => expired };
}

const errorResponse = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status });
const sessionResponse = () => Response.json({ username: 'synthetic-admin', csrf_token: 'rotated-csrf', browser_binding: 'b'.repeat(43), server_time: Date.now() });
const changed = (error: any) => error.code === 'browser_session_changed' && error.status === 409;

test('late GET/SSE 401 cannot expire a newer login or password session', async t => {
  for (const rotation of ['/login', '/password']) {
    for (const path of ['/jobs', '/jobs/synthetic/events']) {
      await t.test(`${rotation} with pending ${path}`, async () => {
        const oldResponse = deferred<Response>();
        const started = deferred<void>();
        const f = await fixture(async target => {
          if (target === `/api/crm${rotation}`) return sessionResponse();
          started.resolve();
          return oldResponse.promise;
        });
        const pending = f.api.signedFetch(path).catch((error: Error) => error);
        await started.promise;
        const oldGeneration = f.api.getBrowserSessionGeneration();
        await f.api.mutate(rotation, 'POST', rotation === '/login'
          ? { username: 'synthetic-admin', password: 'synthetic-password' }
          : { current_password: 'synthetic-password', new_password: 'synthetic-new-password' });
        assert.equal(f.api.getBrowserSessionGeneration(), oldGeneration + 1);
        oldResponse.resolve(errorResponse(401, 'browser_proof_invalid'));
        assert.ok(changed(await pending));
        assert.equal(f.expired(), 0);
      });
    }
  }
});

test('401 belonging to the current session still expires it', async () => {
  const f = await fixture(async () => errorResponse(401, 'session_required'));
  await assert.rejects(f.api.request('/jobs'), (error: any) => error.status === 401 && error.code === 'session_required');
  assert.equal(f.expired(), 1);
});

test('a stale SSE response cancels its unread stream', async () => {
  const response = deferred<Response>();
  const started = deferred<void>();
  let canceled = false;
  const f = await fixture(async () => { started.resolve(); return response.promise; });
  const pending = f.api.signedFetch('/jobs/synthetic/events');
  const rejected = assert.rejects(pending, changed);
  await started.promise;
  f.api.setBrowserSession({ browser_binding: 'b'.repeat(43), server_time: Date.now() });
  response.resolve(new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  await rejected;
  assert.equal(canceled, true);
});

test('competing same-tab session changes never send concurrent Set-Cookie requests', async () => {
  const response = deferred<Response>();
  const started = deferred<void>();
  const requests: string[] = [];
  const f = await fixture(async target => { requests.push(target); started.resolve(); return response.promise; });
  const first = f.api.mutate('/password', 'POST', { current_password: 'synthetic-password', new_password: 'synthetic-new-password' });
  await started.promise;
  const second = f.api.mutate('/logout', 'POST');
  const rejected = assert.rejects(second, changed);
  response.resolve(sessionResponse());
  await first;
  await rejected;
  assert.deepEqual(requests, ['/api/crm/password']);
});

test('rotation during asynchronous signing stops an old mutation before fetch', async () => {
  let requests = 0;
  const f = await fixture(async () => { requests++; return Response.json({ ok: true }); });
  const pending = f.api.mutate('/jobs', 'POST', { title: 'Synthetic article' });
  f.api.setBrowserSession({ browser_binding: 'b'.repeat(43), server_time: Date.now() });
  await assert.rejects(pending, changed);
  assert.equal(requests, 0);
});

test('late old 403 does not prompt for a sensitive action in a new session', async () => {
  const oldResponse = deferred<Response>();
  const started = deferred<void>();
  let prompts = 0;
  const f = await fixture(async () => { started.resolve(); return oldResponse.promise; });
  f.api.setReauthenticationHandler(async () => { prompts++; return 'synthetic-password'; });
  const pending = f.api.mutate('/providers/synthetic', 'PATCH', { name: 'Synthetic' });
  const rejected = assert.rejects(pending, changed);
  await started.promise;
  f.api.setBrowserSession({ browser_binding: 'b'.repeat(43), server_time: Date.now() });
  oldResponse.resolve(errorResponse(403, 'reauthentication_required'));
  await rejected;
  assert.equal(prompts, 0);
});

test('a sensitive action waiting in the prompt queue is canceled after rotation', async () => {
  const password = deferred<string>();
  const prompted = deferred<void>();
  const secondResponse = deferred<void>();
  let prompts = 0;
  let authorizations = 0;
  const f = await fixture(async target => {
    if (target === '/api/crm/session/authorize') authorizations++;
    if (target === '/api/crm/providers/second') secondResponse.resolve();
    return errorResponse(403, 'reauthentication_required');
  });
  f.api.setReauthenticationHandler(() => { prompts++; prompted.resolve(); return password.promise; });
  const first = f.api.mutate('/providers/first', 'PATCH', { name: 'First' });
  const firstRejected = assert.rejects(first, changed);
  await prompted.promise;
  const second = f.api.mutate('/providers/second', 'PATCH', { name: 'Second' });
  const secondRejected = assert.rejects(second, changed);
  await secondResponse.promise;
  // Let its 403 finish parsing so the second action waits behind the first prompt.
  await new Promise<void>(resolve => setImmediate(resolve));
  f.api.setBrowserSession({ browser_binding: 'b'.repeat(43), server_time: Date.now() });
  password.resolve('synthetic-password');
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(prompts, 1);
  assert.equal(authorizations, 0);
});

test('stale session-changing completions cannot install or clear local bindings', async t => {
  for (const path of ['/login', '/password', '/logout']) {
    await t.test(path, async () => {
      const response = deferred<Response>();
      const started = deferred<void>();
      const f = await fixture(async () => { started.resolve(); return response.promise; });
      const pending = f.api.mutate(path, 'POST', path === '/login'
        ? { username: 'synthetic-admin', password: 'synthetic-password' }
        : {});
      const rejected = assert.rejects(pending, changed);
      await started.promise;
      f.api.setBrowserSession({ browser_binding: 'c'.repeat(43), server_time: Date.now() });
      const generation = f.api.getBrowserSessionGeneration();
      response.resolve(path === '/logout' ? new Response(null, { status: 204 }) : sessionResponse());
      await rejected;
      assert.equal(f.api.getBrowserSessionGeneration(), generation);
      assert.equal(f.expired(), 0);
    });
  }
});

test('rotation while reading response JSON cannot dispatch stale expiry or install a session', async t => {
  for (const status of [200, 401]) {
    await t.test(String(status), async () => {
      const body = deferred<any>();
      const reading = deferred<void>();
      const f = await fixture(async () => ({
        status, ok: status === 200,
        json() { reading.resolve(); return body.promise; },
      } as Response));
      const pending = f.api.mutate(status === 200 ? '/login' : '/jobs', 'POST', { username: 'synthetic-admin', password: 'synthetic-password' });
      const rejected = assert.rejects(pending, changed);
      await reading.promise;
      f.api.setBrowserSession({ browser_binding: 'c'.repeat(43), server_time: Date.now() });
      const generation = f.api.getBrowserSessionGeneration();
      body.resolve(status === 200 ? { browser_binding: 'b'.repeat(43), server_time: Date.now() } : { error: { code: 'session_required' } });
      await rejected;
      assert.equal(f.api.getBrowserSessionGeneration(), generation);
      assert.equal(f.expired(), 0);
    });
  }
});
