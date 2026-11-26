import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { registerIntegrations } from '../src/api/crm-integrations.js'
import { registerSessions } from '../src/api/crm-session.js'
import { installErrorHandler } from '../src/api/errors.js'
import { digest } from '../src/security.js'
import { browserProofFixture } from './crm-proof-fixture.js'

async function fixture(t: test.TestContext, authenticated = false) {
  const root = await mkdtemp(join(tmpdir(), 'crm-integrations-'))
  const bytes = Buffer.from('PK\x03\x04synthetic-package')
  const catalog = { data: ['laravel', 'php'].map(platform => ({ platform, version: '1.0.0', filename: `${platform}-crm-ai-1.0.0.zip`,
    compatibility: platform === 'laravel' ? 'Laravel 10–13' : 'PHP 8.2+', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) }
  await writeFile(join(root, 'releases.json'), JSON.stringify(catalog))
  for (const release of catalog.data) await writeFile(join(root, release.filename), bytes)
  const app = Fastify()
  installErrorHandler(app)
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }) })
  const origin = 'https://crm.example.test'
  const browser = browserProofFixture(origin)
  const token = randomBytes(32).toString('base64url')
  const session = { _id: digest(token), user_id: 'integration-admin', csrf_token: 'fixture-csrf', expires_at: new Date(Date.now() + 60_000), ...browser.sessionFields() }
  const proofs = new Set<string>()
  const db = { db: { collection(name: string) { return {
    async findOne(filter: any) {
      if (name === 'sessions' && filter._id === session._id) return structuredClone(session)
      if (name === 'users' && filter._id === session.user_id) return { _id: session.user_id, username: session.user_id }
      return null
    },
    async insertOne(row: any) {
      assert.equal(name, 'crm_request_proofs')
      if (proofs.has(row._id)) throw Object.assign(new Error('Duplicate proof'), { code: 11000 })
      proofs.add(row._id)
      return { insertedId: row._id }
    },
    async updateOne() { return { matchedCount: 1 } },
  } } } } as unknown as Database
  if (authenticated) {
    await app.register(cookie)
    await app.register(async crm => {
      registerSessions(crm, db, { origin, secureCookies: false } as Config)
      registerIntegrations(crm, root)
    }, { prefix: '/api/crm' })
  } else registerIntegrations(app, root)
  await app.ready()
  const headers = (target: string) => ({ cookie: `crm_session=${token}`, 'x-crm-proof': browser.proof('GET', target) })
  return { app, root, bytes, catalog, headers, browser, token }
}

test('integration catalog downloads exactly the selected version and filename', async t => {
  const f = await fixture(t)
  const catalog = await f.app.inject('/integrations')
  assert.equal(catalog.statusCode, 200)
  assert.equal(catalog.headers['cache-control'], 'no-store')
  assert.deepEqual(catalog.json(), f.catalog)
  for (const release of f.catalog.data) {
    const response = await f.app.inject(`/integrations/${release.platform}/${release.version}/download`)
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'application/zip')
    assert.equal(response.headers['content-disposition'], `attachment; filename="${release.filename}"`)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(response.rawPayload, f.bytes)
  }
  for (const path of ['/integrations/windows/1.0.0/download', '/integrations/php/9.9.9/download', '/integrations/php/not-a-version/download', '/integrations/php/%2E%2E/download']) {
    assert.equal((await f.app.inject(path)).statusCode, 404, path)
  }
})

test('missing or corrupted integration files fail without sending an invalid ZIP', async t => {
  const f = await fixture(t)
  const release = f.catalog.data[0]
  const path = `/integrations/${release.platform}/${release.version}/download`
  await writeFile(join(f.root, release.filename), Buffer.alloc(f.bytes.length))
  assert.equal((await f.app.inject(path)).statusCode, 503)
  await rm(join(f.root, release.filename))
  assert.equal((await f.app.inject(path)).statusCode, 503)
  release.filename = '../private.zip'
  await writeFile(join(f.root, 'releases.json'), JSON.stringify(f.catalog))
  assert.equal((await f.app.inject(path)).statusCode, 503)
  await rm(join(f.root, 'releases.json'))
  assert.equal((await f.app.inject('/integrations')).statusCode, 503)
})

test('integration downloads require CRM login and a fresh proof from the bound browser', async t => {
  const f = await fixture(t, true)
  for (const path of ['/api/crm/integrations', '/api/crm/integrations/laravel/1.0.0/download']) {
    assert.equal((await f.app.inject(path)).statusCode, 401)
    assert.equal((await f.app.inject({ url: path, headers: { cookie: `crm_session=${f.token}` } })).statusCode, 401)
    const other = browserProofFixture('https://crm.example.test')
    assert.equal((await f.app.inject({ url: path, headers: { cookie: `crm_session=${f.token}`, 'x-crm-proof': other.proof('GET', path) } })).statusCode, 401)
    const headers = f.headers(path)
    assert.equal((await f.app.inject({ url: path, headers })).statusCode, 200)
    assert.equal((await f.app.inject({ url: path, headers })).statusCode, 401)
  }
})

test('current built integration releases have the declared size and SHA-256', async () => {
  const catalog = JSON.parse(await readFile('dist/packages/releases.json', 'utf8'))
  for (const release of catalog.data) {
    const bytes = await readFile(`dist/packages/${release.filename}`)
    assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304')
    assert.equal(bytes.length, release.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), release.sha256)
  }
})
