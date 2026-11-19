import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { connect } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { hashPassword } from '../src/security.js';
import { runWriterOnce } from '../src/worker/writer.js';
import { runWebhookOnce } from '../src/worker/delivery.js';
import { generateArticle, type GenerateInput, WorkerError } from '../src/worker/provider.js';

const article = {
  Title: 'Chọn máy lọc nước', Content: '<p>Chọn theo nguồn nước.</p>',
  Slug: 'chon-may-loc-nuoc', Desc: 'Hướng dẫn chọn máy', Desction: 'Mô tả SEO',
  'Từ khóa': ['máy lọc nước', 'nguồn nước'],
};
const writing = { model: 'gpt-4.1', keyword: 'máy lọc nước', tone: 'Thân thiện', style: 'Hướng dẫn', length: 800 };
const providerLimit = { concurrency: 10, requestsPerMinute: 100, tokensPerMinute: 1_000_000 };

async function unusedPort() {
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function gateway(input: GenerateInput) {
  const expected: Record<string, string> = { openai: 'api.openai.com', anthropic: 'api.anthropic.com', xai: 'api.x.ai', 'openai-compatible': 'compatible.example.com' };
  return generateArticle(input, async (url, options) => {
    const body = JSON.parse(String(options?.body));
    assert.equal(new URL(String(url)).hostname, expected[input.provider]);
    assert.equal(body.model, input.model);
    if (input.provider === 'anthropic') {
      assert.equal(new Headers(options?.headers).get('x-api-key'), input.key);
      return Response.json({ content: [{ type: 'text', text: JSON.stringify(article) }], usage: { input_tokens: 900, output_tokens: 100 } });
    }
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer ' + input.key);
    const usage = {
      input_tokens: 1000, input_tokens_details: { cached_tokens: 100 }, output_tokens: 100,
      cost_in_usd_ticks: input.provider === 'xai' ? 23000000 : undefined,
    };
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(article) }] }], usage });
  });
}

test('OpenAI-compatible provider uses configured base URL and chat completions format', async () => {
  const input: GenerateInput = {
    provider: 'openai-compatible', key: 'compatible-key', baseUrl: 'https://llm.example.test/v1', model: 'qwen-max',
    keyword: 'máy lọc nước', tone: 'Thân thiện', style: 'Hướng dẫn', length: 800,
    instructions: null, source: null, signal: AbortSignal.timeout(5_000),
  }
  const result = await generateArticle(input, async (url, options) => {
    assert.equal(String(url), 'https://llm.example.test/v1/chat/completions')
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer compatible-key')
    const body = JSON.parse(String(options?.body))
    assert.equal(body.model, 'qwen-max')
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[1].role, 'user')
    assert.deepEqual(body.response_format, { type: 'json_object' })
    return Response.json({
      id: 'compatible-response', model: 'qwen-max',
      choices: [{ message: { role: 'assistant', content: JSON.stringify(article) } }],
      usage: { prompt_tokens: 900, completion_tokens: 100 },
    })
  })
  assert.deepEqual(result.article, article)
  assert.equal(result.responseId, 'compatible-response')
  assert.deepEqual(result.usage, { input: 900, output: 100, cachedInput: 0, reasoning: undefined, costTicks: undefined })
})

test('CRM, website API, queue, pricing and webhook work against PostgreSQL', { timeout: 30_000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), 'content-service-test-'));
  const port = await unusedPort();
  const password = randomBytes(18).toString('hex');
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'db'), port, persistent: true, password, onLog: () => {},
  });
  let started = false;
  let closeService: (() => Promise<void>) | undefined;
  context.after(async () => {
    await closeService?.();
    if (started) await postgres.stop();
    await rm(directory, { recursive: true, force: true });
  });
  await postgres.initialise();
  await postgres.start();
  started = true;

  const config: Config = {
    databaseUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
    encryptionKey: randomBytes(32), origin: 'http://localhost:3210', production: false,
    secureCookies: false, allowLocalWebhooks: true, host: '127.0.0.1', port: 3210, poolSize: 12,
    workerConcurrency: 5, webhookConcurrency: 5, workerPollMs: 20, aiTimeoutMs: 5_000, leaseMs: 12_000,
    providerLimits: { openai: providerLimit, anthropic: providerLimit, xai: providerLimit, 'openai-compatible': providerLimit },
    serviceKeys: { openai: 'fake-service-key', anthropic: undefined, xai: undefined, 'openai-compatible': undefined },
  };
  const db = connect(config.databaseUrl);
  closeService = () => db.end();
  const app = await buildApp(db, config, false);
  const webhookRequests: { headers: Record<string, unknown>; raw: string }[] = [];
  const receiver = createServer(async (request, reply) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    webhookRequests.push({ headers: request.headers, raw: Buffer.concat(chunks).toString() });
    reply.writeHead(webhookRequests.length === 1 ? 503 : 204).end();
  }).listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  closeService = async () => {
    await app.close();
    await db.end();
    await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
  };
  const webhookUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/webhook`;
  await Promise.all([migrate(db), migrate(db)]);
  const adminPassword = 'Test password 123';
  await db.query('INSERT INTO users(username,password_hash) VALUES($1,$2)', ['operator', await hashPassword(adminPassword)]);

  const login = await app.inject({
    method: 'POST', url: '/api/crm/login', payload: { username: 'operator', password: adminPassword },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const csrf = login.json().csrf_token;
  assert.equal((await app.inject('/api/crm/customers')).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/crm/customers', headers: { cookie }, payload: { name: 'Blocked' } })).statusCode, 403);

  const crm = async (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, status: number, payload?: object) => {
    const response = await app.inject({ method, url: '/api/crm' + path, headers: { cookie, 'x-csrf-token': csrf }, payload });
    assert.equal(response.statusCode, status, response.body);
    return response.body ? response.json() : undefined;
  };
  const providerCatalog = (await crm('GET', '/providers', 200)).data;
  assert.deepEqual(providerCatalog.map((item: { provider: string }) => item.provider), ['openai', 'anthropic', 'xai', 'openai-compatible']);
  assert.equal(providerCatalog[0].models.find((item: { model: string }) => item.model === writing.model).enabled, true);
  await crm('POST', '/providers/anthropic/models', 201, { model: 'claude-test', display_name: 'Claude test' });
  await crm('POST', '/providers/xai/models', 201, { model: 'grok-test', display_name: 'Grok test' });
  await crm('POST', '/providers/openai-compatible/models', 201, { model: 'bee/gemini-3.8-flash', display_name: 'Gemini 3.8 Flash' });
  await crm('POST', '/providers/openai/models', 409, { model: 'grok-test' });
  const onboard = async (id: string, name: string) => {
    const site = await crm('POST', '/websites', 201, { customer_id: id, name, domain: name + '.example.com', webhook_url: webhookUrl });
    const { token } = await crm('POST', `/websites/${site.id}/token`, 200);
    const { secret } = await crm('POST', `/websites/${site.id}/webhook-secret`, 200);
    return { id: site.id, token: String(token), secret: String(secret) };
  };
  const customer = await crm('POST', '/customers', 201, {
    name: 'Gói một bài', key_mode: 'service', daily_limit: 1, monthly_limit: 1, allowed_models: [writing.model],
  });
  const renamed = await crm('PATCH', `/customers/${customer.id}`, 200, { name: 'Gói đã cập nhật' });
  assert.equal(renamed.key_mode, 'service');
  const [siteA, siteB] = await Promise.all([onboard(customer.id, 'site-a'), onboard(customer.id, 'site-b')]);
  const sites = (await crm('GET', '/websites', 200)).data;
  assert.equal(sites.length, 2);
  assert.ok(sites.every((site: object) => !Object.hasOwn(site, 'token') && !Object.hasOwn(site, 'webhook_secret')));

  const api = (
    token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string,
    payload?: object, extra?: Record<string, string>,
  ) => app.inject({ method, url, payload, headers: { authorization: 'Bearer ' + token, ...extra } });
  const schedule = { ...writing, scheduled_at: '2040-11-22T09:00:00+07:00' };
  const create = (token: string, payload: object, key: string = randomUUID()) =>
    api(token, 'POST', '/v1/article-jobs', payload, { 'idempotency-key': key });
  const listedModels = async (token: string) => {
    const response = await api(token, 'GET', '/v1/models');
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data.map((item: { model: string }) => item.model).sort();
  };
  const gptModel = '/providers/openai/models/' + writing.model;
  assert.deepEqual(await listedModels(siteA.token), [writing.model]);

  const [first, second] = await Promise.all([create(siteA.token, schedule, 'schedule-a'), create(siteB.token, schedule, 'schedule-b')]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [202, 429]);
  const winner = first.statusCode === 202 ? siteA : siteB;
  const loser = first.statusCode === 202 ? siteB : siteA;
  const job = (first.statusCode === 202 ? first : second).json();
  const requestKey = first.statusCode === 202 ? 'schedule-a' : 'schedule-b';
  await crm('PATCH', gptModel, 200, { enabled: false });
  assert.deepEqual(await listedModels(winner.token), []);
  assert.equal((await create(winner.token, writing)).json().error.code, 'model_unavailable');
  const edited = await crm('PATCH', `/customers/${customer.id}`, 200, { notes: 'Lịch đã được tiếp nhận' });
  assert.deepEqual(edited.allowed_models, [writing.model]);
  await crm('POST', '/customers', 400, {
    name: 'Gói mới', key_mode: 'service', daily_limit: 1, monthly_limit: 1, allowed_models: [writing.model],
  });
  assert.equal((await create(winner.token, schedule, requestKey)).json().job_id, job.job_id);
  assert.equal((await create(winner.token, { ...schedule, length: 801 }, requestKey)).statusCode, 409);
  assert.equal((await api(loser.token, 'GET', `/v1/article-jobs/${job.job_id}`)).statusCode, 404);

  const oldSchedule = `/v1/schedules/${job.job_id}`;
  const when = '2040-11-25T09:00:00+07:00';
  const moved = await api(winner.token, 'PATCH', oldSchedule, { scheduled_at: when }, { 'if-match': '"1"' });
  assert.equal(moved.statusCode, 200, moved.body);
  assert.equal(moved.json().job_id, job.job_id);
  assert.equal(moved.json().scheduled_at, new Date(when).toISOString());
  assert.equal((await api(winner.token, 'PATCH', oldSchedule, { length: 801 }, { 'if-match': '"1"' })).statusCode, 412);
  const reserved = (await api(winner.token, 'GET', '/v1/usage?date=2040-11-25')).json();
  assert.equal(reserved.day.reserved, 1);
  assert.equal(reserved.month.reserved, 1);
  assert.equal((await api(winner.token, 'GET', '/v1/usage?date=2040-11-22')).json().day.reserved, 0);

  await crm('PATCH', gptModel, 200, { enabled: true });
  const december = await create(loser.token, { ...schedule, scheduled_at: '2040-12-01T09:00:00+07:00' });
  assert.equal(december.statusCode, 202, december.body);
  assert.equal((await api(winner.token, 'PATCH', oldSchedule, { scheduled_at: '2040-12-02T09:00:00+07:00' }, { 'if-match': '"2"' })).statusCode, 429);
  assert.equal((await api(winner.token, 'GET', '/v1/schedules')).json().data[0].scheduled_at, new Date(when).toISOString());
  const decemberRoute = `/v1/schedules/${december.json().job_id}`;
  for (let i = 0; i < 2; i += 1) assert.equal((await api(loser.token, 'DELETE', decemberRoute)).statusCode, 204);
  assert.equal((await api(loser.token, 'GET', '/v1/usage?date=2040-12-01')).json().month.reserved, 0);
  assert.equal(await runWriterOnce(db, config, { generate: gateway }), false);

  const price = {
    provider: 'openai', model: writing.model, source_url: 'https://openai.com/api/pricing/',
    input_usd: '1', cached_input_usd: '0.5', output_usd: '3',
  };
  const oldPrice = await crm('POST', '/prices', 201, { ...price, effective_at: '2020-01-01T00:00:00Z' });
  await crm('PATCH', '/providers/openai', 200, { enabled: false });
  await db.query('UPDATE jobs SET available_at=now() WHERE id=$1', [job.job_id]);
  let newPrice: { id: string } | undefined;
  assert.equal(await runWriterOnce(db, config, { generate: async input => {
    assert.equal(input.key, config.serviceKeys.openai);
    assert.equal(input.source, null);
    assert.equal((await api(winner.token, 'PATCH', oldSchedule, { length: 801 }, { 'if-match': '"2"' })).statusCode, 409);
    await setTimeout(15);
    newPrice = await crm('POST', '/prices', 201, { ...price, input_usd: '2', output_usd: '8', effective_at: new Date().toISOString() });
    return gateway(input);
  } }), true);
  assert.ok(newPrice);
  const ready = await api(winner.token, 'GET', `/v1/article-jobs/${job.job_id}/result`);
  assert.equal(ready.statusCode, 200, ready.body);
  assert.deepEqual(ready.json(), [article]);
  assert.equal((await api(winner.token, 'GET', '/v1/usage?date=2040-11-25')).json().month.used, 1);
  assert.equal((await api(loser.token, 'GET', '/v1/articles')).json().data.length, 0);

  assert.equal(await runWebhookOnce(db, config), true);
  const retried = await db.query('UPDATE webhook_deliveries SET next_attempt_at=now() WHERE job_id=$1 AND status=$2 RETURNING id', [job.job_id, 'pending']);
  assert.equal(retried.rowCount, 1);
  assert.equal(await runWebhookOnce(db, config), true);
  assert.equal(webhookRequests.length, 2);
  for (const { raw, headers } of webhookRequests) {
    const signingMessage = [headers['x-timestamp'], 'article.ready', retried.rows[0].id, job.job_id, requestKey, raw].join('\n');
    assert.equal(headers['x-signature'], 'sha256=' + createHmac('sha256', winner.secret).update(signingMessage).digest('hex'));
    assert.deepEqual(JSON.parse(raw), [article]);
  }
  assert.equal((await api(winner.token, 'GET', `/v1/article-jobs/${job.job_id}`)).json().delivery_status, 'delivered');

  const rewriteRoute = `/v1/articles/${job.job_id}/rewrites`;
  assert.equal((await api(loser.token, 'POST', rewriteRoute, {}, { 'idempotency-key': 'rewrite' })).statusCode, 404);
  const unavailableRewrite = await api(winner.token, 'POST', rewriteRoute, {}, { 'idempotency-key': 'rewrite-unavailable' });
  assert.equal(unavailableRewrite.json().error.code, 'model_unavailable');
  assert.deepEqual(await listedModels(winner.token), []);
  assert.equal((await api(winner.token, 'GET', '/v1/usage')).json().day.reserved, 0);
  await crm('PATCH', '/providers/openai', 200, { enabled: true });
  assert.deepEqual(await listedModels(winner.token), [writing.model]);
  const rewrite = await api(winner.token, 'POST', rewriteRoute, { instructions: 'Thêm FAQ' }, { 'idempotency-key': 'rewrite' });
  assert.equal(rewrite.statusCode, 202, rewrite.body);
  assert.equal(rewrite.json().source_article_id, job.job_id);
  assert.equal((await api(winner.token, 'POST', rewriteRoute, { instructions: 'Thêm FAQ' }, { 'idempotency-key': 'rewrite' })).json().job_id, rewrite.json().job_id);
  assert.equal(await runWriterOnce(db, config, { generate: input => {
    assert.deepEqual(input.source, article);
    assert.equal(input.keyword, writing.keyword);
    assert.equal(input.instructions, 'Thêm FAQ');
    return gateway(input);
  } }), true);
  assert.equal((await api(winner.token, 'GET', '/v1/usage')).json().month.used, 1);
  const page = (await api(winner.token, 'GET', '/v1/articles?limit=1')).json();
  assert.equal(page.data[0].article_id, rewrite.json().job_id);
  assert.equal((await api(winner.token, 'GET', '/v1/articles?limit=1&cursor=' + page.next_cursor)).json().data[0].article_id, job.job_id);
  const attempts = (await db.query(`SELECT job_id,pricing_id,cost_usd FROM ai_attempts ORDER BY requested_at`)).rows;
  assert.deepEqual(attempts, [
    { job_id: job.job_id, pricing_id: oldPrice.id, cost_usd: '0.001250000000' },
    { job_id: rewrite.json().job_id, pricing_id: newPrice.id, cost_usd: '0.002650000000' },
  ]);

  const own = await crm('POST', '/customers', 201, { name: 'Dùng khóa riêng' });
  const ownSite = await onboard(own.id, 'own');
  const secret = 'private-grok-test-key';
  assert.deepEqual(await listedModels(ownSite.token), ['claude-test', writing.model, 'grok-test']);
  const offCatalog = await create(ownSite.token, { ...writing, model: 'gpt-unlisted', keyAI: secret });
  assert.equal(offCatalog.json().error.code, 'model_unavailable');
  const privateJob = await create(ownSite.token, { ...writing, model: 'grok-test', keyAI: secret });
  assert.equal(privateJob.statusCode, 202, privateJob.body);
  const getPrivate = () => db.query('SELECT encrypted_key, status, lease_token FROM jobs WHERE id=$1', [privateJob.json().job_id]);
  assert.ok((await getPrivate()).rows[0].encrypted_key);
  assert.ok(!(await getPrivate()).rows[0].encrypted_key.includes(secret));
  await db.query(`UPDATE jobs SET status='writing',lease_token=gen_random_uuid(),lease_expires_at=now()-interval '1 second' WHERE id=$1`, [privateJob.json().job_id]);
  assert.equal(await runWriterOnce(db, config), true);
  assert.equal((await getPrivate()).rows[0].status, 'queued');
  await db.query('UPDATE jobs SET available_at=now() WHERE id=$1', [privateJob.json().job_id]);
  assert.equal(await runWriterOnce(db, config, { generate: input => {
    assert.equal(input.key, secret);
    return gateway(input);
  } }), true);
  assert.deepEqual((await getPrivate()).rows[0], { encrypted_key: null, status: 'ready', lease_token: null });
  const xai = (await db.query('SELECT cost_usd,cost_source FROM ai_attempts WHERE job_id=$1', [privateJob.json().job_id])).rows[0];
  assert.deepEqual(xai, { cost_usd: '0.002300000000', cost_source: 'provider' });
  await crm('PATCH', '/providers/xai/models/grok-test', 200, { enabled: false });
  await crm('PATCH', '/providers/xai', 200, { enabled: false });
  await crm('PATCH', '/providers/xai', 200, { enabled: true });
  assert.deepEqual(await listedModels(ownSite.token), ['claude-test', writing.model]);
  const privateRewrite = await api(ownSite.token, 'POST', `/v1/articles/${privateJob.json().job_id}/rewrites`,
    { keyAI: secret }, { 'idempotency-key': 'private-rewrite-unavailable' });
  assert.equal(privateRewrite.json().error.code, 'model_unavailable');

  const claude = await create(ownSite.token, { ...writing, model: 'claude-test', keyAI: 'private-claude-test-key' });
  assert.equal(claude.statusCode, 202, claude.body);
  assert.equal(await runWriterOnce(db, config, { generate: gateway }), true);
  assert.deepEqual((await api(ownSite.token, 'GET', `/v1/article-jobs/${claude.json().job_id}/result`)).json(), [article]);

  await crm('PATCH', `/customers/${customer.id}`, 200, { daily_limit: 2, monthly_limit: 2 });
  const failing = await create(winner.token, writing);
  assert.equal(failing.statusCode, 202, failing.body);
  await runWriterOnce(db, config, { generate: async () => { throw new WorkerError('AI_AUTH', 'Key lỗi', false); } });
  assert.equal((await api(winner.token, 'GET', `/v1/article-jobs/${failing.json().job_id}`)).json().status, 'failed');
  assert.equal((await api(winner.token, 'GET', '/v1/usage')).json().month.reserved, 0);
  assert.equal((await api(winner.token, 'GET', '/v1/usage')).json().month.used, 1);
  const { metrics } = await crm('GET', '/dashboard', 200);
  assert.equal(metrics.articles, 4);
  assert.equal(metrics.delivered, 1);
  assert.equal(Number(metrics.service_cost_usd), 0.0039);
  assert.equal(Number(metrics.customer_cost_usd), 0.0023);

  await crm('DELETE', `/websites/${winner.id}/token`, 204);
  assert.equal((await api(winner.token, 'GET', '/v1/articles')).statusCode, 401);
});
