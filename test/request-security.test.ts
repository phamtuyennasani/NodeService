import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createConnection } from 'node:net';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import type { Database } from '../src/db.js';
import { clientAddress, installRequestSecurity, RequestGate, securityOptions } from '../src/request-security.js';

function config(overrides: Partial<Config['security']> = {}): Config {
  return { production: false, secureCookies: false, security: { ...securityOptions({} as Config), ...overrides } } as Config;
}
const entered = (result: ReturnType<RequestGate['enter']>) => {
  assert.equal(result.allowed, true);
  if (!result.allowed) throw new Error('Expected request admission');
  return result;
};

test('normalizes IPv4 mappings and groups IPv6 /64 interfaces into the same client', () => {
  assert.equal(clientAddress('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(clientAddress('2001:db8:1234:5678::1'), clientAddress('2001:db8:1234:5678:ffff:ffff:ffff:ffff'));
  assert.notEqual(clientAddress('2001:db8:1234:5678::1'), clientAddress('2001:db8:1234:5679::1'));
  assert.equal(clientAddress('attacker supplied non-IP'), 'unknown');
});

test('all URLs and methods share per-IP counters and API writes have a stricter lane', () => {
  let now = 1_000;
  const gate = new RequestGate(config({ requestsPerMinute: 4, apiRequestsPerMinute: 3, writeRequestsPerMinute: 1 }).security, () => now);
  entered(gate.enter('192.0.2.1', true, true)).release();
  assert.deepEqual(gate.enter('192.0.2.1', true, true), { allowed: false, status: 429, retryAfter: 60 });
  entered(gate.enter('192.0.2.1', true, false)).release();
  entered(gate.enter('192.0.2.1', false, false)).release();
  assert.equal(gate.enter('192.0.2.1', false, false).allowed, false);
  entered(gate.enter('192.0.2.2', false, false)).release();
  now += 60_000;
  entered(gate.enter('192.0.2.1', true, true)).release();
});

test('instance request budget bounds a rotating-IP flood', () => {
  const gate = new RequestGate(config({ totalRequestsPerMinute: 2 }).security, () => 100);
  entered(gate.enter('192.0.2.1', false, false)).release();
  entered(gate.enter('192.0.2.2', false, false)).release();
  assert.deepEqual(gate.enter('192.0.2.3', false, false), { allowed: false, status: 429, retryAfter: 60 });
});

test('already limited senders cannot consume the instance budget reserved for other clients', () => {
  const gate = new RequestGate(config({ requestsPerMinute: 1, totalRequestsPerMinute: 3 }).security);
  entered(gate.enter('192.0.2.1', false, false)).release();
  for (let repeat = 0; repeat < 100; repeat++) assert.equal(gate.enter('192.0.2.1', false, false).allowed, false);
  entered(gate.enter('192.0.2.2', false, false)).release();
  entered(gate.enter('192.0.2.3', false, false)).release();
  assert.equal(gate.enter('192.0.2.4', false, false).allowed, false);
});

test('bounded client map refuses cache flooding without evicting live counters', () => {
  let now = 100;
  const gate = new RequestGate(config({ maxTrackedIps: 2, requestsPerMinute: 1 }).security, () => now);
  entered(gate.enter('192.0.2.1', false, false)).release();
  entered(gate.enter('192.0.2.2', false, false)).release();
  assert.deepEqual(gate.enter('192.0.2.3', false, false), { allowed: false, status: 503, retryAfter: 1 });
  assert.equal(gate.trackedClients, 2);
  assert.equal(gate.enter('192.0.2.1', false, false).allowed, false, 'old IP counter is not reset through eviction');
  now += 60_000;
  entered(gate.enter('192.0.2.3', false, false)).release();
  assert.equal(gate.trackedClients, 1);
});

test('concurrent request slots stay capped per client and globally and release once', () => {
  const gate = new RequestGate(config({ maxConcurrentRequests: 2, maxConcurrentPerIp: 1 }).security);
  const first = entered(gate.enter('192.0.2.1', true, false));
  assert.equal(gate.enter('192.0.2.1', true, false).allowed, false);
  const second = entered(gate.enter('192.0.2.2', true, false));
  assert.equal(gate.enter('192.0.2.3', true, false).allowed, false);
  first.release(); first.release();
  const third = entered(gate.enter('192.0.2.3', true, false));
  assert.equal(gate.enter('192.0.2.4', true, false).allowed, false, 'duplicate release cannot create a free extra slot');
  second.release(); third.release();
});

test('early guard rejects over-limit bodies before parsing or business handler and limits random 404s', async t => {
  const app = Fastify();
  installRequestSecurity(app, config({ requestsPerMinute: 2 }));
  let writes = 0;
  app.post('/v1/test', async () => { writes++; return { ok: true }; });
  t.after(() => app.close());
  assert.equal((await app.inject('/random-missing-one')).statusCode, 404);
  assert.equal((await app.inject('/random-missing-two')).statusCode, 404);
  const limited = await app.inject({ method: 'POST', url: '/v1/test', headers: { 'content-type': 'application/json' }, payload: '{malformed' });
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal(limited.json().error.code, 'rate_limit');
  assert.equal(limited.headers['retry-after'], '60');
  assert.equal(writes, 0);
});

test('raw hijacked responses retain their slot until the actual response finishes', async t => {
  const app = Fastify();
  installRequestSecurity(app, config({ maxConcurrentRequests: 1 }));
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  app.get('/events', async (_request, reply) => {
    reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.raw.write('event: ready\ndata: {}\n\n');
    finish = () => reply.raw.end(); started();
  });
  app.get('/ok', async () => ({ ok: true }));
  t.after(() => app.close());
  const stream = app.inject('/events');
  void stream.then(() => {});
  await ready;
  assert.equal((await app.inject({ url: '/ok', remoteAddress: '192.0.2.7' })).statusCode, 503);
  finish(); await stream;
  assert.equal((await app.inject('/ok')).statusCode, 200);
});

test('rejects oversized URLs and sends browser defenses without blocking embedded widget resources', async t => {
  const app = Fastify();
  installRequestSecurity(app, { ...config(), production: true, secureCookies: true });
  app.get('/widget/v1/ai-writer.js', async () => 'widget');
  app.get('/api/test', async () => ({ ok: true }));
  t.after(() => app.close());
  const response = await app.inject('/api/test');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['x-frame-options'], 'DENY');
  assert.match(String(response.headers['content-security-policy']), /script-src 'self'/);
  assert.match(String(response.headers['content-security-policy']), /style-src 'self' 'unsafe-inline'/);
  assert.equal(response.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(response.headers['cache-control'], 'no-store');
  const widget = await app.inject('/widget/v1/ai-writer.js');
  assert.equal(widget.statusCode, 200);
  assert.equal(widget.headers['cross-origin-resource-policy'], undefined);
  assert.equal((await app.inject('/api/test?q=' + 'x'.repeat(2048))).statusCode, 414);
});

test('buildApp ignores spoofed forwarded IP by default and only trusts explicitly configured proxy addresses', async t => {
  const db = { db: { command: async () => ({ ok: 1 }) } } as unknown as Database;
  for (const trusted of [false, true]) {
    const app = await buildApp(db, config({ requestsPerMinute: 1, trustedProxies: trusted ? ['127.0.0.1/32'] : [] }), false);
    t.after(() => app.close());
    const first = await app.inject({ url: '/health', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.1' } });
    const second = await app.inject({ url: '/health', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.2' } });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, trusted ? 200 : 429, second.body);
    const untrusted = await app.inject({ url: '/health', remoteAddress: '198.51.100.1', headers: { 'x-forwarded-for': '192.0.2.3' } });
    const untrustedRepeat = await app.inject({ url: '/health', remoteAddress: '198.51.100.1', headers: { 'x-forwarded-for': '192.0.2.4' } });
    assert.equal(untrusted.statusCode, 200);
    assert.equal(untrustedRepeat.statusCode, 429, 'untrusted peer cannot choose its request IP');
    assert.equal(app.server.requestTimeout, 15_000);
    assert.equal(app.server.headersTimeout, 10_000);
    assert.equal(app.server.keepAliveTimeout, 5_000);
    assert.equal(app.server.maxRequestsPerSocket, 100);
    assert.equal(app.server.maxHeadersCount, 64);
    assert.equal(app.server.maxConnections, 1_000);
  }
});

test('native HTTP server closes slow headers and bodies before they reach business handlers', { timeout: 10_000 }, async t => {
  const db = { db: { command: async () => ({ ok: 1 }) } } as unknown as Database;
  const app = await buildApp(db, config({ requestTimeoutMs: 200, headersTimeoutMs: 100, connectionTimeoutMs: 5_000 }), false);
  let handled = 0;
  app.post('/slow-fixture', async () => { handled++; return { ok: true }; });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const partialRequest = (payload: string) => new Promise<string>((resolve, reject) => {
    let response = '';
    const socket = createConnection({ host: '127.0.0.1', port: address.port }, () => socket.write(payload));
    socket.setEncoding('utf8');
    socket.setTimeout(8_000, () => { socket.destroy(); reject(new Error('Slow request was not closed')); });
    socket.on('data', chunk => { response += chunk; });
    socket.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); });
    socket.on('close', () => resolve(response));
  });
  const [headers, body] = await Promise.all([
    partialRequest('GET /health HTTP/1.1\r\nHost: localhost\r\nX-Slow: '),
    partialRequest('POST /slow-fixture HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"'),
  ]);
  assert.match(headers, /HTTP\/1\.1 408/);
  assert.match(body, /HTTP\/1\.1 408/);
  assert.equal(handled, 0);
});

test('native HTTP parser rejects oversized headers before application work', { timeout: 10_000 }, async t => {
  let dbCalls = 0;
  const db = { db: { command: async () => { dbCalls++; return { ok: 1 }; } } } as unknown as Database;
  const app = await buildApp(db, config(), false);
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await new Promise<string>((resolve, reject) => {
    let content = '';
    const socket = createConnection({ host: '127.0.0.1', port: address.port }, () => socket.write('GET /health HTTP/1.1\r\nHost: localhost\r\nX-Oversized: ' + 'x'.repeat(17_000) + '\r\n\r\n'));
    socket.setEncoding('utf8');
    socket.setTimeout(5_000, () => { socket.destroy(); reject(new Error('Oversized request was not closed')); });
    socket.on('data', chunk => { content += chunk; });
    socket.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); });
    socket.on('close', () => resolve(content));
  });
  assert.match(response, /HTTP\/1\.1 431/);
  assert.equal(dbCalls, 0);
});

test('security environment defaults are bounded and blanket proxy trust cannot be configured', () => {
  const previous = process.env;
  process.env = { MONGODB_URI: 'mongodb://127.0.0.1:27017', ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') };
  try {
    assert.equal(loadConfig().security.requestsPerMinute, 600);
    assert.deepEqual(loadConfig().security.trustedProxies, []);
    assert.equal(loadConfig().maxPendingJobsPerCustomer, 100);
    for (const value of ['file:///tmp/crm', 'javascript:alert(1)', 'https://user:password@example.com', 'http://user@example.com', 'not-a-url']) {
      process.env.APP_ORIGIN = value;
      assert.throws(loadConfig, /APP_ORIGIN/);
    }
    process.env.APP_ORIGIN = 'https://crm.example.com/nested';
    assert.equal(loadConfig().origin, 'https://crm.example.com');
    delete process.env.APP_ORIGIN;
    process.env.TRUSTED_PROXIES = '127.0.0.1/32,::1/128';
    assert.deepEqual(loadConfig().security.trustedProxies, ['127.0.0.1/32', '::1/128']);
    for (const value of ['true', '*', '1', '0.0.0.0/0', '::/0', '192.0.2.1/33', '127.0.0.1,']) {
      process.env.TRUSTED_PROXIES = value;
      assert.throws(loadConfig, /TRUSTED_PROXIES/);
    }
    delete process.env.TRUSTED_PROXIES;
    for (const name of ['RATE_LIMIT_PER_IP', 'HTTP_REQUEST_TIMEOUT_MS', 'HTTP_HEADERS_TIMEOUT_MS', 'MAX_PENDING_JOBS_PER_CUSTOMER']) {
      for (const value of ['0', '-1', '1.5', '999999999', 'invalid']) {
        process.env[name] = value;
        assert.throws(loadConfig, new RegExp(name));
      }
      delete process.env[name];
    }
  } finally { process.env = previous; }
});
