import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import test from 'node:test'
import type { HTTPMethods } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { collection, connect, type Database } from '../src/db.js'
import { migrate } from '../src/migrate.js'
import { assertEncryptionContext } from '../src/encryption-context.js'
import { browserBodyHash } from '../src/crm-proof.js'
import { crmSessionCookieName } from '../src/api/crm-session.js'
import { digest, hashPassword, verifyPassword } from '../src/security.js'
import { DatabaseJobEvents, publishJobEvent } from '../src/job-events.js'
import { partnerConfig, partnerDatabase } from '../src/workspaces.js'
import { effectiveConfig } from '../src/runtime-settings.js'
import { runWriterOnce } from '../src/worker/writer.js'
import { siteProofMessage } from '../src/site-proof.js'
import { browserProofFixture } from './crm-proof-fixture.js'

test('live events keep root and partner groups isolated even when job IDs match', async () => {
  const root = {} as Database
  const first = { partnerId: randomUUID() } as Database
  const second = { partnerId: randomUUID() } as Database
  const rows = [root, first, second].map(db => ({ db, source: new DatabaseJobEvents(db), events: [] as unknown[] }))
  try {
    for (const row of rows) row.source.subscribe(event => row.events.push(event))
    for (const [index, row] of rows.entries()) {
      publishJobEvent(row.db, { type: 'job.updated', job_id: 'same-job-id', status: String(index) })
    }
    for (const [index, row] of rows.entries()) assert.deepEqual(row.events, [{ type: 'job.updated', job_id: 'same-job-id', status: String(index) }])
  } finally { await Promise.all(rows.map(row => row.source.close())) }
})

test('partner accounts isolate CRM, public APIs, configuration and worker results in MongoDB', {
  skip: !process.env.CRM_TEST_MONGODB_URI,
  timeout: 120_000,
}, async t => {
  const databaseName = `crm_partner_test_${randomBytes(10).toString('hex')}`
  const root = connect(process.env.CRM_TEST_MONGODB_URI!, databaseName)
  let app: Awaited<ReturnType<typeof buildApp>>
  t.after(async () => {
    try {
      await app?.close()
      for (const partner of await collection(root, 'partners').find({}).toArray()) {
        await partnerDatabase(root, partner._id).db.dropDatabase()
      }
      assert.ok(root.db.databaseName.startsWith('crm_partner_test_'))
      await root.db.dropDatabase()
    } finally { await root.client.close() }
  })
  const config = { ...loadConfig(), mongodbDatabase: databaseName, origin: 'http://localhost:3210',
    production: false, secureCookies: false, encryptionKey: randomBytes(32),
    serviceKeys: { openai: 'fixture-root-key', anthropic: undefined, xai: undefined, 'openai-compatible': undefined },
    mail: { host: 'root-smtp.example.test', port: 465, secure: true, from: 'root@example.test', allowInsecureLocal: false },
  }
  await migrate(root)
  await assertEncryptionContext(root, config, true)
  app = await buildApp(root, config, false)
  const password = 'Fixture-partner-password-123'
  const passwordHash = await hashPassword(password)
  const rootId = randomUUID()
  await collection(root, 'users').insertOne({ _id: rootId, username: 'legacy-root', password_hash: passwordHash,
    email: 'root@example.test', email_verified_at: new Date(), email_revision: 1 })
  async function actor(userId: string) {
    const user = await collection(root, 'users').findOne({ _id: userId })
    const token = randomBytes(32).toString('base64url')
    const proof = browserProofFixture(config.origin)
    const csrf = randomUUID()
    await collection(root, 'sessions').insertOne({ _id: digest(token), user_id: userId,
      csrf_token: csrf, ...proof.sessionFields(), credential_version: digest(user!.password_hash),
      email_revision: user!.email_revision, expires_at: new Date(Date.now() + 3_600_000) })
    return { token, proof, csrf }
  }
  type Actor = Awaited<ReturnType<typeof actor>>
  async function crm(who: Actor, method: HTTPMethods, path: string, payload?: unknown) {
    const url = '/api/crm' + path
    const body = payload === undefined ? '' : JSON.stringify(payload)
    const actionToken = method === 'PUT' && path.startsWith('/settings') ? randomBytes(32).toString('base64url') : undefined
    if (actionToken) await collection(root, 'crm_action_tokens').insertOne({ _id: digest(actionToken), session_id: digest(who.token),
      method, target: url, body_hash: browserBodyHash(body), expires_at: new Date(Date.now() + 60_000) })
    return app.inject({ method, url, headers: {
      cookie: `${crmSessionCookieName(config)}=${who.token}`, 'x-csrf-token': who.csrf,
      'x-crm-proof': who.proof.proof(method, url, body), ...(actionToken ? { 'x-crm-action-token': actionToken } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    }, ...(body ? { payload: body } : {}) })
  }
  async function ok(who: Actor, method: HTTPMethods, path: string, payload?: unknown, expected = 200) {
    const response = await crm(who, method, path, payload)
    assert.equal(response.statusCode, expected, `${method} ${path}: ${response.body}`)
    return expected === 204 ? undefined : response.json()
  }
  const admin = await actor(rootId)
  const createPartner = async (suffix: string) => ok(admin, 'POST', '/partners', {
    name: `Partner ${suffix}`, username: `partner-${suffix.toLowerCase()}`, email: `${suffix.toLowerCase()}@example.test`, password,
  }, 201)
  const first = await createPartner('A')
  const second = await createPartner('B')
  const dbA = partnerDatabase(root, first.id)
  const dbB = partnerDatabase(root, second.id)
  const userA = await collection(root, 'users').findOne({ partner_id: first.id })
  const userB = await collection(root, 'users').findOne({ partner_id: second.id })
  const a = await actor(userA!._id)
  const b = await actor(userB!._id)
  let customerA: any
  let customerB: any
  let siteA: string
  let siteB: string
  let tokenA: string
  let tokenB: string
  const signingKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const publicKey = signingKey.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  async function publicApi(token: string, siteId: string, method: HTTPMethods, path: string, payload?: unknown) {
    const body = payload === undefined ? '' : JSON.stringify(payload)
    const created = String(Math.floor(Date.now() / 1000))
    const nonce = randomBytes(16).toString('hex')
    const id = randomUUID()
    const message = siteProofMessage({ id: siteId, token_hash: digest(token) }, method, path, '', body, id, '', created, nonce)
    const signature = sign('sha256', Buffer.from(message), signingKey.privateKey).toString('base64url')
    return app.inject({ method, url: path, headers: { authorization: `Bearer ${token}`, 'idempotency-key': id,
      'x-site-proof': `${created}.${nonce}.${signature}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { payload: body } : {}) })
  }
  await t.test('root provisions accounts and providers cannot manage accounts or choose another group', async () => {
    assert.equal((await ok(admin, 'GET', '/session')).role, 'root')
    const identity = await ok(a, 'GET', '/session')
    assert.equal(identity.role, 'provider')
    assert.equal(identity.partner.id, first.id)
    assert.equal((await crm(a, 'GET', '/partners')).statusCode, 403)
    assert.equal((await crm(a, 'POST', '/partners', { name: 'Intruder' })).statusCode, 403)
    assert.equal((await crm(a, 'GET', `/customers?workspace=${second.id}`)).statusCode, 403)
    assert.equal((await crm(a, 'GET', '/customers?workspace=root')).statusCode, 403)
    assert.equal((await crm(admin, 'GET', `/customers?workspace=${first.id}&workspace=${second.id}`)).statusCode, 400)
    assert.ok(await verifyPassword(password, userA!.password_hash))
  })
  await t.test('concurrent CRM writes, reads and statistics stay in the signed workspace', async () => {
    const customers = await Promise.all([
      ok(admin, 'POST', '/customers', { name: 'Root customer', key_mode: 'own' }, 201),
      ok(a, 'POST', '/customers', { name: 'Customer A', key_mode: 'own' }, 201),
      ok(b, 'POST', '/customers', { name: 'Customer B', key_mode: 'own' }, 201),
    ])
    customerA = customers[1]; customerB = customers[2]
    for (const [who, name] of [[admin, 'Root customer'], [a, 'Customer A'], [b, 'Customer B']] as const) {
      assert.deepEqual((await ok(who, 'GET', '/customers')).data.map((row: any) => row.name), [name])
    }
    assert.deepEqual((await ok(admin, 'GET', `/customers?workspace=${first.id}`)).data.map((row: any) => row.name), ['Customer A'])
    assert.equal((await crm(a, 'PATCH', `/customers/${customerB.id}`, { name: 'Overwritten' })).statusCode, 404)
    assert.equal((await crm(a, 'GET', `/customers/${customerB.id}/usage`)).statusCode, 404)
    assert.equal((await crm(a, 'POST', '/customers', { name: 'Injected', partner_id: second.id })).statusCode, 400)
    for (const who of [a, b]) assert.equal((await crm(who, 'GET', '/dashboard')).statusCode, 200)
  })
  await t.test('AI credentials, SMTP, prices and runtime settings do not inherit another group', async () => {
    const providersA = await ok(a, 'GET', '/providers')
    assert.equal(providersA.data.find((row: any) => row.provider === 'openai').api_key_configured, false)
    await ok(a, 'PATCH', '/providers/openai', { api_key: 'fixture-partner-a-key' })
    assert.equal((await ok(b, 'GET', '/providers')).data.find((row: any) => row.provider === 'openai').api_key_configured, false)
    assert.equal((await ok(admin, 'GET', '/providers')).data.find((row: any) => row.provider === 'openai').api_key_configured, true)
    assert.equal((await ok(b, 'GET', '/settings/smtp')).source, 'none')
    await ok(a, 'PUT', '/settings/smtp', { revision: 0, values: { host: 'partner-smtp.example.test', port: 465,
      secure: true, from: 'partner@example.test', user: 'partner', password: 'fixture-smtp-password' } })
    assert.equal((await ok(b, 'GET', '/settings/smtp')).configured, false)
    assert.equal((await ok(admin, 'GET', '/settings/smtp')).values.host, 'root-smtp.example.test')
    for (const [who, rate] of [[a, 27001], [b, 28002]] as const) {
      const settings = await ok(who, 'GET', '/settings')
      await ok(who, 'PUT', '/settings', { revision: settings.revision, values: { ...settings.values,
        usd_to_vnd: rate, writer_concurrency: 1, research_enabled: false } })
    }
    const rates = await Promise.all([dbA, dbB, root].map(async db => (await effectiveConfig(db, db === root ? config : partnerConfig(config))).usdToVnd))
    assert.deepEqual(rates, [27001, 28002, config.usdToVnd])
    assert.equal((await ok(admin, 'GET', `/settings?workspace=${first.id}`)).values.usd_to_vnd, 27001)
    assert.equal((await ok(a, 'GET', '/prices')).data.length, 0)
    const id = randomUUID()
    await collection(dbA, 'model_prices').insertOne({ _id: id, provider: 'openai', model: 'gpt-4.1', effective_at: new Date(), total_vnd: 1000, input_usd: '1', output_usd: '1' })
    assert.equal((await ok(b, 'GET', '/prices')).data.length, 0)
    assert.equal((await collection(root, 'model_prices').countDocuments({})), 0)
  })
  await t.test('website routing, signed API calls, token rotation and widget grants respect the owning partner', async () => {
    siteA = (await ok(a, 'POST', '/websites', { customer_id: customerA.id, name: 'A site', domain: 'a.example.com', webhook_url: 'https://a.example.com/webhook' }, 201)).id
    siteB = (await ok(b, 'POST', '/websites', { customer_id: customerB.id, name: 'B site', domain: 'b.example.com', webhook_url: 'https://b.example.com/webhook' }, 201)).id
    tokenA = (await ok(a, 'POST', `/websites/${siteA}/token`)).token
    tokenB = (await ok(b, 'POST', `/websites/${siteB}/token`)).token
    for (const [who, id] of [[a, siteA], [b, siteB]] as const) await ok(who, 'PUT', `/websites/${id}/signing-key`, { public_key: publicKey, expected_fingerprint: null })
    assert.equal((await publicApi(tokenA, siteA, 'GET', '/v1/usage')).statusCode, 200)
    assert.equal((await publicApi(tokenB, siteA, 'GET', '/v1/usage')).statusCode, 401)
    assert.equal((await crm(a, 'POST', `/websites/${siteB}/token`)).statusCode, 404)
    const oldToken = tokenA
    tokenA = (await ok(a, 'POST', `/websites/${siteA}/token`)).token
    assert.equal((await publicApi(oldToken, siteA, 'GET', '/v1/usage')).statusCode, 401)
    assert.equal((await publicApi(tokenA, siteA, 'GET', '/v1/usage')).statusCode, 200)
    const expires = String(Math.floor(Date.now() / 1000) + 300)
    const origin = 'https://a.example.com'
    const signature = createHmac('sha256', digest(tokenA)).update(`widget\n${siteA}\n${origin}\n${expires}`).digest('hex')
    const headers = { origin, 'x-widget-expires': expires, 'x-widget-signature': signature }
    assert.equal((await app.inject({ url: `/v1/widget/${siteA}/models`, headers })).statusCode, 200)
    assert.equal((await app.inject({ url: `/v1/widget/${siteB}/models`, headers })).statusCode, 403)
  })
  await t.test('the writer processes only its group with that group configuration', async () => {
    const response = await publicApi(tokenA, siteA, 'POST', '/v1/article-jobs', {
      model: 'fixture-model', keyword: 'Nội dung nhóm A', tone: 'rõ ràng', style: 'hướng dẫn', length: 800,
      base_url: 'https://ai.example.com/v1', api_key: 'fixture-personal-key', use_research: false,
    })
    assert.equal(response.statusCode, 202, response.body)
    const jobId = response.json().job_id
    assert.equal((await crm(b, 'GET', `/jobs/${jobId}`)).statusCode, 404)
    assert.equal((await publicApi(tokenB, siteB, 'GET', `/v1/article-jobs/${jobId}`)).statusCode, 404)
    assert.equal(await runWriterOnce(dbB, await effectiveConfig(dbB, partnerConfig(config))), false)
    const article = { Title: 'Nội dung nhóm A', Content: '<p>Bài viết của nhóm A.</p>', Desc: 'Mô tả A', Description: 'Mô tả A', Keywords: ['nhóm A'], Slug: 'noi-dung-nhom-a' }
    let calls = 0
    const handled = await runWriterOnce(dbA, await effectiveConfig(dbA, partnerConfig(config)), {
      async outline() { throw new Error('Fixture outline unavailable') },
      async generate(input) { calls++; assert.equal(input.key, 'fixture-personal-key'); return { article, usage: null, responseId: null, model: input.model } },
      async repair() { throw new Error('Fixture repair unavailable') },
    })
    assert.equal(handled, true)
    assert.equal(calls, 1)
    assert.equal((await collection(dbA, 'jobs').findOne({ _id: jobId }))!.status, 'ready')
    assert.equal(await collection(dbB, 'jobs').countDocuments({}), 0)
    assert.equal(await collection(root, 'jobs').countDocuments({}), 0)
  })
  await t.test('token revocation and website deletion remove public access and routing together', async () => {
    const id = (await ok(a, 'POST', '/websites', { customer_id: customerA.id, name: 'Temporary A site', domain: 'temporary.example.com', webhook_url: 'https://temporary.example.com/webhook' }, 201)).id
    await ok(a, 'PUT', `/websites/${id}/signing-key`, { public_key: publicKey, expected_fingerprint: null })
    const token = (await ok(a, 'POST', `/websites/${id}/token`)).token
    assert.equal((await publicApi(token, id, 'GET', '/v1/usage')).statusCode, 200)
    await ok(a, 'DELETE', `/websites/${id}/token`, undefined, 204)
    assert.equal((await publicApi(token, id, 'GET', '/v1/usage')).statusCode, 401)
    const route = await collection(root, 'partner_sites').findOne({ _id: id })
    assert.equal(route!.partner_id, first.id)
    assert.equal(route!.token_hash, undefined)
    const replacement = (await ok(a, 'POST', `/websites/${id}/token`)).token
    assert.equal((await publicApi(replacement, id, 'GET', '/v1/usage')).statusCode, 200)
    await ok(a, 'DELETE', `/websites/${id}`, undefined, 204)
    assert.equal(await collection(root, 'partner_sites').findOne({ _id: id }), null)
    assert.equal((await publicApi(replacement, id, 'GET', '/v1/usage')).statusCode, 401)
    assert.equal((await publicApi(tokenB, siteB, 'GET', '/v1/usage')).statusCode, 200)
  })
  await t.test('root can disable and restore a group and reset its account without affecting another', async () => {
    await ok(admin, 'PATCH', `/partners/${first.id}`, { enabled: false })
    assert.equal((await crm(a, 'GET', '/customers')).statusCode, 401)
    assert.equal((await publicApi(tokenA, siteA, 'GET', '/v1/usage')).statusCode, 403)
    assert.equal((await crm(b, 'GET', '/customers')).statusCode, 200)
    assert.equal((await crm(admin, 'GET', `/customers?workspace=${first.id}`)).statusCode, 200)
    await ok(admin, 'PATCH', `/partners/${first.id}`, { enabled: true })
    assert.equal((await publicApi(tokenA, siteA, 'GET', '/v1/usage')).statusCode, 200)
    const newPassword = 'Another-fixture-password-123'
    await ok(admin, 'POST', `/partners/${second.id}/password`, { password: newPassword }, 204)
    assert.equal((await crm(b, 'GET', '/customers')).statusCode, 401)
    assert.ok(await verifyPassword(newPassword, (await collection(root, 'users').findOne({ _id: userB!._id }))!.password_hash))
  })
})
