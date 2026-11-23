import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { crmSessionCookieName, registerSessions } from '../src/api/crm-session.js'
import { installErrorHandler } from '../src/api/errors.js'
import { registerCrmMailSettings } from '../src/api/crm-mail-settings.js'
import { digest, hashPassword, verifyPassword } from '../src/security.js'
import { browserBodyHash, type BrowserPublicKey } from '../src/crm-proof.js'

type Row = Record<string, any>
const origin = 'https://crm.example.vn'
const password = 'secure-test-password-123'
const passwordHash = await hashPassword(password)
const matches = (row: Row, filter: Row) => Object.entries(filter).every(([key, value]) => {
  if (key === '$or') return (value as Row[]).some(branch => matches(row, branch))
  if (key === '$and') return (value as Row[]).every(branch => matches(row, branch))
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.entries(value).every(([op, bound]) => {
      if (op === '$gt') return row[key] > (bound as any)
      if (op === '$gte') return row[key] >= (bound as any)
      if (op === '$lt') return row[key] < (bound as any)
      if (op === '$lte') return row[key] <= (bound as any)
      if (op === '$exists') return Object.hasOwn(row, key) === bound
      if (op === '$ne') return row[key] !== bound
      if (op === '$in') return (bound as unknown[]).includes(row[key])
      if (op === '$nin') return !(bound as unknown[]).includes(row[key])
      return false
    })
  }
  return row[key] === value
})

function memory() {
  const tables: Record<string, Row[]> = { users: [{ _id: 'admin', username: 'admin', password_hash: passwordHash,
    email: 'synthetic-admin@example.test', email_verified_at: new Date(), email_revision: 0 }], sessions: [], security_rate_limits: [] }
  let failLimit = false
  let beforeUserUpdate: (() => void) | undefined
  let duplicateLimitOnce = false
  let userLookups = 0
  let proofFailure = false
  let beforeSessionTouch: (() => void) | undefined
  let transactionTail: Promise<void> = Promise.resolve()
  const transactionOptions: any[] = []
  const db = {
    client: {
      async connect() {},
      startSession() {
        const session = { async endSession() {}, async withTransaction<T>(fn: () => Promise<T>) {
          // Every auth transaction writes the same user row before its security
          // state. Serialize callbacks to model MongoDB write-conflict retries.
          const previous = transactionTail
          let release!: () => void
          transactionTail = new Promise<void>(resolve => { release = resolve })
          await previous
          try { return await fn() } finally { release() }
        } }
        return session
      },
    },
    db: { collection(name: string) {
      const rows = () => tables[name] ??= []
      const apply = (row: Row, update: Row, inserted = false) => {
        if (inserted) Object.assign(row, structuredClone(update.$setOnInsert ?? {}))
        Object.assign(row, structuredClone(update.$set ?? {}))
        for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(value)
        for (const [key, value] of Object.entries(update.$max ?? {})) if (row[key] === undefined || row[key] < (value as any)) row[key] = structuredClone(value)
        for (const key of Object.keys(update.$unset ?? {})) delete row[key]
      }
      return {
        async findOne(filter: Row) {
          if (name === 'users') userLookups++
          return structuredClone(rows().find(row => matches(row, filter)) ?? null)
        },
        find(filter: Row = {}) {
          let results = rows().filter(row => matches(row, filter))
          const cursor = {
            sort(order: Row) {
              results.sort((a, b) => {
                for (const [key, direction] of Object.entries(order)) {
                  if (a[key] < b[key]) return -Number(direction)
                  if (a[key] > b[key]) return Number(direction)
                }
                return 0
              })
              return cursor
            },
            limit(count: number) { results = results.slice(0, count); return cursor },
            async toArray() { return structuredClone(results) },
          }
          return cursor
        },
        async findOneAndUpdate(filter: Row, update: Row, options: Row = {}) {
          if (name === 'security_rate_limits' && failLimit) throw new Error('Rate store unavailable')
          if (name === 'security_rate_limits' && duplicateLimitOnce) {
            duplicateLimitOnce = false
            throw Object.assign(new Error('First concurrent upsert'), { code: 11000 })
          }
          let row = rows().find(row => matches(row, filter))
          const inserted = !row
          if (!row && !options.upsert) return null
          if (!row) { row = Object.fromEntries(Object.entries(filter).filter(([key,value]) => !key.startsWith('$') && (value === null || typeof value !== 'object' || value instanceof Date))); rows().push(row) }
          const previous = structuredClone(row)
          apply(row, update, inserted)
          return options.returnDocument === 'after' ? structuredClone(row) : previous
        },
        async updateOne(filter: Row, update: Row, options?: Row) {
          if (name === 'users') { beforeUserUpdate?.(); beforeUserUpdate = undefined }
          if (name === 'sessions') { beforeSessionTouch?.(); beforeSessionTouch = undefined }
          let row = rows().find(row => matches(row, filter))
          const inserted = !row
          if (!row && !options?.upsert) return { matchedCount: 0 }
          if (!row) { row = Object.fromEntries(Object.entries(filter).filter(([key,value]) => !key.startsWith('$') && (value === null || typeof value !== 'object' || value instanceof Date))); rows().push(row) }
          if (options?.session) transactionOptions.push(options.session)
          apply(row, update, inserted)
          return { matchedCount: Number(!inserted), upsertedCount: Number(inserted), upsertedId: inserted ? row._id : undefined }
        },
        async insertOne(row: Row, options?: Row) {
          if (name === 'crm_request_proofs' && proofFailure) throw new Error('Proof store unavailable')
          if (options?.session) transactionOptions.push(options.session)
          if (rows().some(existing => existing._id === row._id)) throw Object.assign(new Error('Duplicate key'), { code: 11000 })
          rows().push(structuredClone(row))
          return { insertedId: row._id }
        },
        async deleteOne(filter: Row, options?: Row) {
          if (options?.session) transactionOptions.push(options.session)
          const index = rows().findIndex(row => matches(row, filter))
          if (index >= 0) rows().splice(index, 1)
          return { deletedCount: Number(index >= 0) }
        },
        async findOneAndDelete(filter: Row) {
          const index = rows().findIndex(row => matches(row, filter))
          if (index < 0) return null
          return structuredClone(rows().splice(index, 1)[0])
        },
        async deleteMany(filter: Row, options?: Row) {
          if (options?.session) transactionOptions.push(options.session)
          const before = rows().length
          tables[name] = rows().filter(row => !matches(row, filter))
          return { deletedCount: before - tables[name].length }
        },
      }
    } },
  } as unknown as Database
  return { db, tables, transactionOptions, getUserLookups: () => userLookups,
    failLimit: () => { failLimit = true }, duplicateLimitOnce: () => { duplicateLimitOnce = true },
    beforeUserUpdate: (fn: () => void) => { beforeUserUpdate = fn },
    failProof: () => { proofFailure = true }, beforeSessionTouch: (fn: () => void) => { beforeSessionTouch = fn } }
}

function browserKeys() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const exported = keys.publicKey.export({ format: 'jwk' })
  return { privateKey: keys.privateKey, publicKey: { kty: 'EC', crv: 'P-256', x: exported.x!, y: exported.y! } as BrowserPublicKey }
}

function requestProof(privateKey: KeyObject, binding: string, options: Row, claims: Row = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'crm-pop+jwt' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    aud: origin, htm: options.method || 'GET', htu: options.url,
    bth: browserBodyHash(typeof options.payload === 'string' ? options.payload : options.payload === undefined ? '' : JSON.stringify(options.payload)),
    sid: binding, iat: Math.floor(Date.now() / 1_000), jti: randomBytes(24).toString('base64url'),
    ikh: String(options.headers?.['idempotency-key'] || ''), ...claims,
  })).toString('base64url')
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `${header}.${payload}.${signature}`
}

async function fixture(t: test.TestContext, store = memory(), overrides: Partial<Config> = {}) {
  const app = Fastify()
  t.after(() => app.close())
  installErrorHandler(app)
  await app.register(cookie)
  let handled = 0
  const mailbox: { to: string; code: string; purpose: string }[] = []
  const mailConfigs: Config['mail'][] = []
  await app.register(async crm => {
    registerSessions(crm, store.db, { origin, secureCookies: true, encryptionKey: Buffer.alloc(32, 71), ...overrides } as Config,
      { sendOtp: async (effective, message) => { mailConfigs.push(structuredClone(effective.mail)); mailbox.push(message) } })
    registerCrmMailSettings(crm, store.db, { origin, secureCookies: true, encryptionKey: Buffer.alloc(32, 71), ...overrides } as Config)
    for (const [method, url] of [['PUT', '/settings'], ['DELETE', '/jobs/:id'], ['POST', '/providers/:provider'], ['PATCH', '/customers/:id'], ['POST', '/jobs']] as const) {
      crm.route({ method, url, handler: async () => { handled++; return { ok: true } } })
    }
  }, { prefix: '/api/crm' })
  const keys = browserKeys()
  const bound = new Map<string, string>()
  const rawInject = (options: Row) => app.inject(options)
  const sessionToken = (headers: Row = {}) => {
    const name = crmSessionCookieName({ production: !!overrides.production })
    return String(headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1)
  }
  const signRequest = (options: Row, claims: Row = {}) => {
    const token = sessionToken(options.headers)
    const binding = token && bound.get(token)
    if (!binding) throw new Error('No browser key for the fixture session')
    return { ...options, headers: { ...options.headers, 'x-crm-proof': requestProof(keys.privateKey, binding, options, claims) } }
  }
  const inject = async (options: Row) => {
    const token = sessionToken(options.headers)
    const shouldSign = token && bound.has(token) && !options.headers?.['x-crm-proof'] && !options.url?.endsWith('/login')
    const response = await rawInject(shouldSign ? signRequest(options) : options)
    if (response.statusCode === 200 && response.cookies.length && response.json().browser_binding) {
      bound.set(response.cookies[0].value, response.json().browser_binding)
    }
    return response
  }
  const loginRequest = (username = 'admin', entered = password, extraHeaders: Row = {}, fields: Row = {}) => ({ method: 'POST', url: '/api/crm/login', headers: { origin, ...extraHeaders }, payload: { username, password: entered, browser_public_key: keys.publicKey, ...fields } })
  const challengeRequest = (path: '/login/verify' | '/login/resend', challengeId: string, fields: Row = {}, signingKey = keys.privateKey, headers: Row = {}) => {
    const request = { method: 'POST', url: `/api/crm${path}`, headers: { origin, ...headers }, payload: { challenge_id: challengeId, ...fields } }
    return { ...request, headers: { ...request.headers, 'x-crm-proof': requestProof(signingKey, challengeId, request) } }
  }
  const beginLogin = (username = 'admin', entered = password, extraHeaders: Row = {}, fields: Row = {}) => inject(loginRequest(username, entered, extraHeaders, fields))
  const verifyOtp = (challenge: any, code = mailbox.at(-1)?.code ?? '', trustDevice = false, headers: Row = {}) => inject(challengeRequest('/login/verify', typeof challenge === 'string' ? challenge : challenge.json().challenge_id, { code, trust_device: trustDevice }, keys.privateKey, headers))
  const login = async (username = 'admin', entered = password, extraHeaders: Row = {}, fields: Row = {}) => {
    const response = await beginLogin(username, entered, extraHeaders, fields)
    if (response.statusCode !== 200 || !response.json().otp_required) return response
    return verifyOtp(response, undefined, false, extraHeaders)
  }
  return { ...store, app: { inject }, rawInject, signRequest, keys, login, beginLogin, loginRequest, challengeRequest, verifyOtp, mailbox, mailConfigs, getHandled: () => handled }
}

function authHeaders(response: any) {
  return { origin, cookie: response.cookies.map((value: any) => `${value.name}=${value.value}`).join('; '), 'x-csrf-token': response.json().csrf_token }
}

test('password verification accepts generated hashes and safely rejects malformed or oversized inputs', async () => {
  assert.equal(await verifyPassword(password, passwordHash), true)
  assert.equal(await verifyPassword(password + 'wrong', passwordHash), false)
  for (const hash of ['', 'a.b', passwordHash + '.extra', passwordHash + '=', 'a'.repeat(20_000)]) {
    assert.equal(await verifyPassword(password, hash), false)
  }
  assert.equal(await verifyPassword('a'.repeat(257), passwordHash), false)
  await assert.rejects(hashPassword('a'.repeat(257)), /length/)
})

test('login rotates session, sets secure cookie and never exposes credential hashes', async t => {
  const f = await fixture(t)
  f.tables.users[0].display_name = 'Quản trị thử nghiệm'
  const first = await f.login()
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(first.json().display_name, 'Quản trị thử nghiệm', 'OTP login includes the saved display name')
  assert.match(String(first.headers['set-cookie']), /HttpOnly/)
  assert.match(String(first.headers['set-cookie']), /Secure/)
  assert.match(String(first.headers['set-cookie']), /SameSite=Strict/)
  assert.match(String(first.headers['set-cookie']), /Path=\/api\/crm/)
  assert.equal(first.cookies[0].name, 'crm_session')
  assert.equal(f.tables.sessions[0].credential_version, digest(passwordHash))
  assert.equal(first.headers['cache-control'], 'no-store')
  assert.ok(!first.body.includes(passwordHash))
  const next = await f.login('admin', password, { cookie: authHeaders(first).cookie })
  assert.equal(next.statusCode, 200, next.body)
  assert.equal(f.tables.sessions.length, 1)
  assert.notEqual(first.cookies[0].value, next.cookies[0].value)
  assert.ok(f.transactionOptions.length >= 4)
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: authHeaders(first) })).statusCode, 401)
})

test('signed session reload reads the current display name and falls back to the username', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  assert.equal(loggedIn.json().display_name, 'admin')
  const reload = () => f.app.inject({ url: '/api/crm/session', headers: authHeaders(loggedIn) })
  for (const [stored, expected] of [
    ['Tên hiển thị đã lưu', 'Tên hiển thị đã lưu'],
    ['  Tên đã cập nhật  ', 'Tên đã cập nhật'],
    ['', 'admin'], ['  ', 'admin'], [null, 'admin'], [42, 'admin'],
  ]) {
    f.tables.users[0].display_name = stored
    const response = await reload()
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.json().username, 'admin')
    assert.equal(response.json().display_name, expected)
  }
  assert.equal(Object.hasOwn(f.tables.sessions[0], 'display_name'), false, 'display names are read from the current account rather than cached in session storage')
})

test('production uses a host-prefixed cookie and never authenticates through the legacy name', async t => {
  assert.equal(crmSessionCookieName({ production: true }), '__Host-crm_session')
  assert.equal(crmSessionCookieName({ production: false }), 'crm_session')
  const f = await fixture(t, memory(), { production: true, secureCookies: false })
  const response = await f.login()
  assert.equal(response.statusCode, 200, response.body)
  const setCookie = String(response.headers['set-cookie'])
  assert.equal(response.cookies[0].name, '__Host-crm_session')
  assert.match(setCookie, /^__Host-crm_session=/)
  assert.match(setCookie, /(?:^|; )Path=\/(?:;|$)/)
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /Secure/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.doesNotMatch(setCookie, /Domain=/i)
  const token = response.cookies[0].value
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: { cookie: `crm_session=${token}` } })).statusCode, 401)
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/crm/logout', headers: { cookie: `crm_session=${token}`, 'x-csrf-token': response.json().csrf_token } })).statusCode, 401)
  const validHeaders = { ...authHeaders(response), cookie: `crm_session=${'z'.repeat(43)}; __Host-crm_session=${token}` }
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: validHeaders })).statusCode, 200)
  const rotated = await f.login('admin', password, validHeaders)
  assert.equal(rotated.statusCode, 200)
  assert.equal(f.tables.sessions.length, 1, 'rotation removes the previous host-prefixed session')
  const loggedOut = await f.app.inject({ method: 'POST', url: '/api/crm/logout', headers: authHeaders(rotated) })
  assert.equal(loggedOut.statusCode, 204)
  assert.match(String(loggedOut.headers['set-cookie']), /^__Host-crm_session=/)
  assert.match(String(loggedOut.headers['set-cookie']), /(?:^|; )Path=\/(?:;|$)/)
  assert.match(String(loggedOut.headers['set-cookie']), /Secure/)
  assert.equal(f.tables.sessions.length, 0)
})

test('production rejects unknown, tampered, expired and server-deleted session cookies', async t => {
  const f = await fixture(t, memory(), { production: true })
  const request = (token: string) => f.app.inject({
    url: '/api/crm/session', headers: { cookie: `__Host-crm_session=${token}` },
  })
  assert.equal((await request('r'.repeat(43))).statusCode, 401, 'a correctly shaped random value has no authenticated session')
  const loggedIn = await f.login()
  assert.equal(loggedIn.statusCode, 200)
  const token = loggedIn.cookies[0].value
  const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1)
  assert.equal((await request(tampered)).statusCode, 401, 'changing one byte does not find the saved digest')
  assert.equal((await request(token)).statusCode, 200, 'the unmodified session is still valid')
  const row = f.tables.sessions.find(row => row._id === digest(token))!
  row.expires_at = new Date(Date.now() - 1)
  assert.equal((await request(token)).statusCode, 401, 'expiration is enforced even before TTL cleanup')
  row.expires_at = new Date(Date.now() + 60_000)
  assert.equal((await request(token)).statusCode, 200)
  f.tables.sessions.splice(f.tables.sessions.indexOf(row), 1)
  assert.equal((await request(token)).statusCode, 401, 'a cookie is unusable after the server deletes its session')
})

test('production login rotates an attacker-chosen session value instead of adopting it', async t => {
  const f = await fixture(t, memory(), { production: true })
  const chosen = 'f'.repeat(43)
  f.tables.sessions.push({
    _id: digest(chosen), token_hash: digest(chosen), user_id: 'admin', csrf_token: 'fixture-csrf',
    credential_version: digest(passwordHash), expires_at: new Date(Date.now() + 60_000),
    browser_public_key: f.keys.publicKey, browser_binding: 'b'.repeat(43), last_active_at: new Date(),
  })
  const chosenHeaders = { cookie: `__Host-crm_session=${chosen}` }
  assert.equal((await f.rawInject({ url: '/api/crm/session', headers: { ...chosenHeaders, 'x-crm-proof': requestProof(f.keys.privateKey, 'b'.repeat(43), { url: '/api/crm/session' }) } })).statusCode, 200)
  const loggedIn = await f.login('admin', password, chosenHeaders)
  assert.equal(loggedIn.statusCode, 200)
  assert.ok(loggedIn.cookies[0].value !== chosen, 'successful login always issues fresh random session material')
  assert.equal(f.tables.sessions.length, 1)
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: chosenHeaders })).statusCode, 401, 'the pre-login session is revoked')
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: authHeaders(loggedIn) })).statusCode, 200)
})

test('a copied production cookie cannot read identity, obtain CSRF or logout from another client', async t => {
  const store = memory()
  const owner = await fixture(t, store, { production: true })
  const otherClient = await fixture(t, store, { production: true })
  const loggedIn = await owner.login('admin', password, { 'user-agent': 'Owner browser' })
  assert.equal(loggedIn.statusCode, 200)
  const copiedCookie = `__Host-crm_session=${loggedIn.cookies[0].value}`
  const replay = () => otherClient.app.inject({
    url: '/api/crm/session', remoteAddress: '198.51.100.71',
    headers: { cookie: copiedCookie, 'user-agent': 'Separate client' },
  })
  const session = await replay()
  assert.equal(session.statusCode, 401, 'cookie possession without the browser private key is insufficient')
  assert.equal(session.json().error.code, 'browser_proof_required')
  assert.ok(!session.body.includes('csrf_token'))
  const withoutCsrf = await otherClient.app.inject({
    method: 'POST', url: '/api/crm/logout', remoteAddress: '198.51.100.71',
    headers: { origin, cookie: copiedCookie, 'user-agent': 'Separate client' },
  })
  assert.equal(withoutCsrf.statusCode, 403)
  const copiedCsrf = await otherClient.app.inject({
    method: 'POST', url: '/api/crm/logout', remoteAddress: '198.51.100.71',
    headers: { origin, cookie: copiedCookie, 'user-agent': 'Separate client', 'x-csrf-token': loggedIn.json().csrf_token },
  })
  assert.equal(copiedCsrf.statusCode, 401, 'even the cookie and CSRF together cannot authenticate a write')
  assert.equal((await owner.app.inject({ url: '/api/crm/session', headers: authHeaders(loggedIn) })).statusCode, 200, 'failed proofs must not revoke the owner session')
  const loggedOut = await owner.app.inject({ method: 'POST', url: '/api/crm/logout', headers: authHeaders(loggedIn) })
  assert.equal(loggedOut.statusCode, 204)
  assert.equal((await replay()).statusCode, 401)
  assert.equal((await owner.app.inject({ url: '/api/crm/session', headers: authHeaders(loggedIn) })).statusCode, 401, 'the original browser shares that revocation')
})

test('production password change retains the browser key and revokes every earlier session binding', async t => {
  const store = memory()
  const owner = await fixture(t, store, { production: true })
  const otherClient = await fixture(t, store, { production: true })
  const first = await owner.login()
  const second = await owner.login()
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  const copiedCookies = [first, second].map(response => `__Host-crm_session=${response.cookies[0].value}`)
  const replay = (cookie: string) => otherClient.app.inject({
    url: '/api/crm/session', remoteAddress: '203.0.113.52',
    headers: { cookie, 'user-agent': 'Replayed browser' },
  })
  for (const cookie of copiedCookies) assert.equal((await replay(cookie)).statusCode, 401)
  const previousBindings = owner.tables.sessions.map(row => row.browser_binding)
  const cannotChangeWithoutPassword = await owner.app.inject({
    method: 'POST', url: '/api/crm/password', headers: authHeaders(first),
    payload: { current_password: 'incorrect-password', new_password: 'replacement-password-value' },
  })
  assert.equal(cannotChangeWithoutPassword.statusCode, 400, 'a copied session alone does not satisfy password reauthentication')
  const changed = await owner.app.inject({
    method: 'POST', url: '/api/crm/password', headers: authHeaders(first),
    payload: { current_password: password, new_password: 'replacement-password-value' },
  })
  assert.equal(changed.statusCode, 200)
  assert.deepEqual(owner.tables.sessions[0].browser_public_key, owner.keys.publicKey)
  assert.ok(!previousBindings.includes(changed.json().browser_binding))
  for (const cookie of copiedCookies) assert.equal((await replay(cookie)).statusCode, 401)
  assert.equal((await owner.app.inject({ url: '/api/crm/session', headers: authHeaders(changed) })).statusCode, 200, 'the replacement session is usable')
})

test('cross-origin and sibling-subdomain requests are rejected before touching accounts', async t => {
  const f = await fixture(t)
  for (const headers of [
    { origin: 'https://evil.example.vn' }, { origin: 'null' }, { origin: origin + '/' },
    { origin, 'sec-fetch-site': 'cross-site' }, { origin, 'sec-fetch-site': 'same-site' },
  ]) {
    const response = await f.login('admin', password, headers)
    assert.equal(response.statusCode, 403, response.body)
  }
  const refererOnly = await f.app.inject({ method: 'POST', url: '/api/crm/login', headers: { referer: 'https://evil.example.vn/' }, payload: { username: 'admin', password } })
  assert.equal(refererOnly.statusCode, 403)
  assert.equal(f.getUserLookups(), 0)
  assert.equal(f.tables.security_rate_limits.length, 0)
  assert.equal((await f.login('admin', password, { 'sec-fetch-site': 'same-origin' })).statusCode, 200)
})

test('account guessing budget is shared across replicas and cannot be bypassed by changing IP', async t => {
  const store = memory()
  const first = await fixture(t, store)
  const second = await fixture(t, store)
  for (let i = 0; i < 10; i++) {
    const f = i % 2 ? first : second
    const response = await f.login('  ADMIN  ', 'incorrect-password', { 'x-forwarded-for': `192.0.2.${i}` })
    assert.equal(response.statusCode, 401, response.body)
    assert.equal(response.json().error.code, 'invalid_login')
  }
  const before = store.getUserLookups()
  const blocked = await second.login()
  assert.equal(blocked.statusCode, 429, blocked.body)
  assert.ok(Number(blocked.headers['retry-after']) >= 1)
  assert.equal(store.getUserLookups(), before, 'reject before password lookup and scrypt')
  assert.equal(store.tables.security_rate_limits.length, 1)
  const row = store.tables.security_rate_limits[0]
  assert.ok(!row._id.includes('admin'))
  assert.ok(row.expires_at instanceof Date)
  assert.ok(row.expires_at.getTime() <= Date.now() + 5 * 60_000)
})

test('unknown usernames receive the same bounded budget and generic error as known accounts', async t => {
  const f = await fixture(t)
  const response = await f.login('unknown-account', 'incorrect-password')
  const known = await f.login('admin', 'incorrect-password')
  assert.equal(response.statusCode, known.statusCode)
  assert.deepEqual(response.json(), known.json())
  for (let i = 1; i < 10; i++) assert.equal((await f.login('unknown-account', 'incorrect-password')).statusCode, 401)
  assert.equal((await f.login('unknown-account', 'incorrect-password')).statusCode, 429)
})

test('limiter fails closed on database failure and handles a concurrent first upsert', async t => {
  const f = await fixture(t)
  f.duplicateLimitOnce()
  assert.equal((await f.login()).statusCode, 200)
  f.failLimit()
  const count = f.getUserLookups()
  const failed = await f.login()
  assert.equal(failed.statusCode, 500)
  assert.equal(f.getUserLookups(), count)
})

test('concurrent password guesses cannot grow an unbounded scrypt queue', async t => {
  const f = await fixture(t)
  const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => f.login(`missing-${i}`, 'incorrect-password')))
  assert.equal(responses.filter(response => response.statusCode === 401).length, 2)
  assert.equal(responses.filter(response => response.statusCode === 503).length, 8)
  assert.ok(responses.filter(response => response.statusCode === 503).every(response => response.headers['retry-after'] === '2'))
  assert.equal((await f.login()).statusCode, 200, 'slots are released after failure')
})

test('a password replaced while login verifies cannot create a fresh session', async t => {
  const f = await fixture(t)
  f.beforeUserUpdate(() => { f.tables.users[0].password_hash = 'replacement-credential' })
  const response = await f.login()
  assert.equal(response.statusCode, 401, response.body)
  assert.equal(f.tables.sessions.length, 0)
})

test('CSRF remains mandatory and password changes atomically revoke all previous sessions', async t => {
  const f = await fixture(t)
  f.tables.users[0].display_name = 'Tên được giữ khi đổi mật khẩu'
  const first = await f.login()
  const second = await f.login()
  const firstHeaders = authHeaders(first)
  const payload = { current_password: password, new_password: 'another-secure-test-password' }
  const withoutCsrf = { origin, cookie: firstHeaders.cookie }
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/crm/password', headers: withoutCsrf, payload })).statusCode, 403)
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/crm/password', headers: { ...firstHeaders, origin: 'https://evil.example.vn' }, payload })).statusCode, 403)
  const changed = await f.app.inject({ method: 'POST', url: '/api/crm/password', headers: firstHeaders, payload })
  assert.equal(changed.statusCode, 200, changed.body)
  assert.equal(changed.json().display_name, 'Tên được giữ khi đổi mật khẩu')
  assert.equal(f.tables.sessions.length, 1)
  assert.equal(await verifyPassword(payload.new_password, f.tables.users[0].password_hash), true)
  for (const old of [first, second]) assert.equal((await f.app.inject({ url: '/api/crm/session', headers: authHeaders(old) })).statusCode, 401)
  const fresh = await f.app.inject({ url: '/api/crm/session', headers: authHeaders(changed) })
  assert.equal(fresh.statusCode, 200)
  assert.equal(fresh.json().display_name, 'Tên được giữ khi đổi mật khẩu')
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/crm/logout', headers: authHeaders(changed) })).statusCode, 204)
  assert.equal(f.tables.sessions.length, 0)
})

test('password guessing through an existing session is throttled by account', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  const request = () => f.app.inject({ method: 'POST', url: '/api/crm/password', headers: authHeaders(loggedIn), payload: { current_password: 'incorrect', new_password: 'another-secure-test-password' } })
  for (let i = 0; i < 5; i++) assert.equal((await request()).statusCode, 400)
  const response = await request()
  assert.equal(response.statusCode, 429)
  assert.ok(Number(response.headers['retry-after']) >= 1)
})

test('credential version rejects a session after an out-of-band password replacement', async t => {
  const f = await fixture(t)
  const response = await f.login()
  f.tables.users[0].password_hash = await hashPassword('replacement-password-value')
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: authHeaders(response) })).statusCode, 401)
})

test('auth endpoints reject oversized bodies before database work', async t => {
  const f = await fixture(t)
  const response = await f.login('admin', 'a'.repeat(10_000))
  assert.equal(response.statusCode, 413)
  assert.equal(f.getUserLookups(), 0)
})

test('login requires a strictly public browser key and stored legacy sessions never authenticate', async t => {
  const f = await fixture(t)
  for (const browser_public_key of [undefined, {}, { ...f.keys.publicKey, d: 'private' }]) {
    const response = await f.rawInject({ method: 'POST', url: '/api/crm/login', headers: { origin }, payload: { username: 'admin', password, browser_public_key } })
    assert.equal(response.statusCode, 400)
  }
  assert.equal(f.getUserLookups(), 0)
  const loggedIn = await f.login()
  const headers = authHeaders(loggedIn)
  delete f.tables.sessions[0].browser_public_key
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers })).statusCode, 401)
  assert.equal((await f.rawInject({ url: '/api/crm/session/bootstrap', headers })).statusCode, 401)
})

test('bootstrap reveals only binding and server time and cannot rebind the session browser key', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  const row = f.tables.sessions[0]
  const touched = row.last_active_at.getTime()
  const before = Date.now()
  const response = await f.rawInject({ url: '/api/crm/session/bootstrap', headers: { cookie: authHeaders(loggedIn).cookie } })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(Object.keys(response.json()).sort(), ['browser_binding', 'server_time'])
  assert.equal(response.json().browser_binding, loggedIn.json().browser_binding)
  assert.ok(response.json().server_time >= before && response.json().server_time <= Date.now())
  assert.equal(row.last_active_at.getTime(), touched, 'unsigned bootstrap must not refresh idle expiry')
  const attacker = browserKeys()
  const proof = requestProof(attacker.privateKey, row.browser_binding, { url: '/api/crm/session' })
  const invalid = await f.rawInject({ url: '/api/crm/session', headers: { cookie: authHeaders(loggedIn).cookie, 'x-crm-proof': proof, 'x-crm-public-key': JSON.stringify(attacker.publicKey) } })
  assert.equal(invalid.statusCode, 401)
  assert.deepEqual(row.browser_public_key, f.keys.publicKey)
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: authHeaders(loggedIn) })).statusCode, 200)
})

test('signed requests bind method, raw target, body bytes, idempotency key and browser session', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  const headers = authHeaders(loggedIn)
  const options = { method: 'POST', url: '/api/crm/jobs', headers: { ...headers, 'idempotency-key': 'first-key', 'content-type': 'application/json' }, payload: '{"a":1,"b":2}' }
  const signed = f.signRequest(options)
  for (const tampered of [
    { ...signed, method: 'GET' },
    { ...signed, url: '/api/crm/jobs?other=1' },
    { ...signed, payload: '{"b":2,"a":1}' },
    { ...signed, headers: { ...signed.headers, 'idempotency-key': 'other-key' } },
  ]) {
    const response = await f.rawInject(tampered)
    assert.ok(response.statusCode >= 400, 'altered request must fail before handler')
  }
  assert.equal(f.getHandled(), 0)
  assert.equal((await f.rawInject(signed)).statusCode, 200, 'invalid alterations do not consume the valid original proof')
  const replay = await f.rawInject(signed)
  assert.equal(replay.statusCode, 401)
  assert.equal(replay.json().error.code, 'browser_proof_replayed')
  assert.equal(f.getHandled(), 1)
  const second = await f.login()
  const crossSession = f.signRequest({ url: '/api/crm/session', headers })
  crossSession.headers.cookie = authHeaders(second).cookie
  const rejected = await f.rawInject(crossSession)
  assert.equal(rejected.statusCode, 401)
  assert.equal(rejected.json().error.code, 'browser_proof_invalid')
})

test('proof replay detection is shared, atomic and fails closed without deleting owner sessions', async t => {
  const store = memory()
  const owner = await fixture(t, store)
  const replica = await fixture(t, store)
  const loggedIn = await owner.login()
  const request = owner.signRequest({ url: '/api/crm/session', headers: authHeaders(loggedIn) })
  const responses = await Promise.all([owner.rawInject(request), replica.rawInject(request)])
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 401])
  assert.equal(store.tables.sessions.length, 1)
  const lastActive = store.tables.sessions[0].last_active_at.getTime()
  store.failProof()
  const failed = await owner.app.inject({ url: '/api/crm/session', headers: authHeaders(loggedIn) })
  assert.equal(failed.statusCode, 503)
  assert.equal(failed.json().error.code, 'browser_proof_unavailable')
  assert.equal(store.tables.sessions[0].last_active_at.getTime(), lastActive)
  assert.equal(store.tables.sessions.length, 1)
})

test('idle and absolute expiry are enforced by atomic touch and unsigned traffic cannot extend idle time', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  const headers = authHeaders(loggedIn)
  const row = f.tables.sessions[0]
  row.last_active_at = new Date(Date.now() - 29 * 60_000)
  const idleBefore = row.last_active_at.getTime()
  assert.equal((await f.rawInject({ url: '/api/crm/session', headers })).statusCode, 401)
  assert.equal(row.last_active_at.getTime(), idleBefore)
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers })).statusCode, 200)
  assert.ok(row.last_active_at.getTime() > idleBefore)
  f.beforeSessionTouch(() => { row.last_active_at = new Date(Date.now() - 31 * 60_000) })
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers })).statusCode, 401, 'cannot revive a session that expires between hooks')
  assert.equal((await f.rawInject({ url: '/api/crm/session/bootstrap', headers })).statusCode, 401)
  row.last_active_at = new Date()
  row.expires_at = new Date(Date.now() - 1)
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers })).statusCode, 401)
})

async function authorize(f: Awaited<ReturnType<typeof fixture>>, response: any, options: Row, currentPassword = password) {
  return f.app.inject({ method: 'POST', url: '/api/crm/session/authorize', headers: authHeaders(response), payload: {
    current_password: currentPassword, method: options.method, target: options.url,
    body_hash: browserBodyHash(typeof options.payload === 'string' ? options.payload : options.payload === undefined ? '' : JSON.stringify(options.payload)),
  } })
}

test('sensitive mutations require one-time password authorization scoped to exact action and session', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  const action = { method: 'PUT', url: '/api/crm/settings', headers: authHeaders(loggedIn), payload: { key: 'value' } }
  const missing = await f.app.inject(action)
  assert.equal(missing.statusCode, 403)
  assert.equal(missing.json().error.code, 'reauthentication_required')
  assert.equal(f.getHandled(), 0)
  assert.equal((await authorize(f, loggedIn, action, 'incorrect')).statusCode, 400)
  const permitted = await authorize(f, loggedIn, action)
  assert.equal(permitted.statusCode, 200)
  assert.deepEqual(Object.keys(permitted.json()).sort(), ['action_token', 'expires_in'])
  assert.equal(permitted.json().expires_in, 60)
  const authorized = { ...action, headers: { ...action.headers, 'x-crm-action-token': permitted.json().action_token } }
  assert.equal((await f.app.inject({ ...authorized, payload: { key: 'changed' } })).statusCode, 403)
  assert.equal((await f.app.inject({ ...authorized, url: '/api/crm/settings?different=1' })).statusCode, 403)
  assert.equal((await f.app.inject({ ...authorized, method: 'DELETE', url: '/api/crm/jobs/example' })).statusCode, 403)
  const second = await f.login()
  assert.equal((await f.app.inject({ ...authorized, headers: { ...authHeaders(second), 'x-crm-action-token': permitted.json().action_token } })).statusCode, 403)
  assert.equal((await f.app.inject(authorized)).statusCode, 200)
  assert.equal((await f.app.inject(authorized)).statusCode, 403, 'token is consumed after one action')
  assert.equal(f.getHandled(), 1)
  const expiring = await authorize(f, loggedIn, action)
  f.tables.crm_action_tokens.find(row => row._id === digest(expiring.json().action_token))!.expires_at = new Date(Date.now() - 1)
  assert.equal((await f.app.inject({ ...action, headers: { ...action.headers, 'x-crm-action-token': expiring.json().action_token } })).statusCode, 403)
})

test('sensitive action gate covers canonical routes and query spelling before mutation', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  for (const [method, url] of [
    ['POST', '/api/crm/providers/test'], ['POST', '/api/crm/%70roviders/test'],
    ['POST', '/api/crm/providers/test?'], ['PUT', '/api/crm/settings?'],
    ['PUT', '/api/crm/settings/smtp'], ['POST', '/api/crm/settings/smtp/test'],
    ['PATCH', '/api/crm/customers/example'], ['DELETE', '/api/crm/jobs/example'],
  ]) {
    const request = { method, url, headers: authHeaders(loggedIn), payload: {} }
    // light-my-request drops an empty final query delimiter before dispatch.
    const response = await f.rawInject(f.signRequest(request, { htu: url.endsWith('?') ? url.slice(0, -1) : url }))
    assert.equal(response.statusCode, 403, `${method} ${url}: ${response.body}`)
    assert.equal(response.json().error.code, 'reauthentication_required')
  }
  assert.equal(f.getHandled(), 0)
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/crm/jobs', headers: authHeaders(loggedIn), payload: {} })).statusCode, 200)
})

test('SMTP settings require signed reads and scoped reauthentication, then apply to account status and subsequent OTPs', async t => {
  const f = await fixture(t)
  assert.equal((await f.rawInject({ url: '/api/crm/settings/smtp' })).statusCode, 401)
  const loggedIn = await f.login()
  const headers = authHeaders(loggedIn)
  assert.equal(f.mailConfigs[0], undefined, 'the injected sender initially receives the environment configuration')
  assert.equal((await f.app.inject({ url: '/api/crm/account', headers })).json().mail_configured, false)
  assert.equal((await f.rawInject({ url: '/api/crm/settings/smtp', headers })).statusCode, 401, 'cookie alone cannot read SMTP settings')
  const initial = await f.app.inject({ url: '/api/crm/settings/smtp', headers })
  assert.equal(initial.statusCode, 200, initial.body)
  const values = { host: 'smtp.synthetic.example.test', port: 465, secure: true,
    from: 'crm@example.test', user: 'synthetic-mail-user', password: 'synthetic-smtp-secret' }
  const save = { method: 'PUT', url: '/api/crm/settings/smtp', headers, payload: { revision: 0, values } }
  assert.equal((await f.app.inject(save)).statusCode, 403)
  const permission = await authorize(f, loggedIn, save)
  assert.equal(permission.statusCode, 200, permission.body)
  const actionHeaders = { ...headers, 'x-crm-action-token': permission.json().action_token }
  const verify = { method: 'POST', url: '/api/crm/settings/smtp/test', headers, payload: { revision: 1 } }
  assert.equal((await f.app.inject(verify)).statusCode, 403, 'SMTP connection verification is also a sensitive action')
  assert.equal((await f.app.inject({ ...verify, headers: actionHeaders })).statusCode, 403, 'save authorization cannot authorize an outbound connection')
  const saved = await f.app.inject({ ...save, headers: actionHeaders })
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(saved.json().source, 'database')
  assert.equal(saved.json().password_configured, true)
  assert.doesNotMatch(saved.body, /synthetic-smtp-secret|password_encrypted/)
  assert.equal((await f.app.inject({ ...save, headers: actionHeaders })).statusCode, 403, 'save token is one-use')
  const profile = await f.app.inject({ url: '/api/crm/account', headers })
  assert.equal(profile.json().mail_configured, true, 'account email verification becomes available without restarting')
  assert.doesNotMatch(profile.body, /synthetic-smtp-secret|synthetic-mail-user|password_encrypted/)
  const first = await f.beginLogin()
  assert.equal(first.statusCode, 200, first.body)
  assert.equal(f.mailConfigs.at(-1)?.host, values.host)
  assert.equal(f.mailConfigs.at(-1)?.password, values.password)
  assert.equal(f.mailConfigs.at(-1)?.allowInsecureLocal, false)
  const replace = { ...save, payload: { revision: 1, values: { ...values, host: 'smtp.new.example.test', password: 'replacement-synthetic-secret' } } }
  const replacementPermission = await authorize(f, loggedIn, replace)
  assert.equal(replacementPermission.statusCode, 200, replacementPermission.body)
  const replaced = await f.app.inject({ ...replace, headers: { ...headers, 'x-crm-action-token': replacementPermission.json().action_token } })
  assert.equal(replaced.statusCode, 200, replaced.body)
  f.tables.crm_login_challenges[0].last_sent_at = new Date(Date.now() - 61_000)
  const resent = await f.rawInject(f.challengeRequest('/login/resend', first.json().challenge_id))
  assert.equal(resent.statusCode, 200, resent.body)
  assert.equal(f.mailConfigs.at(-1)?.host, 'smtp.new.example.test', 'resend resolves the latest persisted SMTP configuration')
  assert.equal(f.mailConfigs.at(-1)?.password, 'replacement-synthetic-secret')
})

test('action password attempts share account limit and stale password verification cannot authorize', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  const action = { method: 'PUT', url: '/api/crm/settings', payload: {} }
  for (let i = 0; i < 5; i++) assert.equal((await authorize(f, loggedIn, action, 'wrong')).statusCode, 400)
  assert.equal((await authorize(f, loggedIn, action)).statusCode, 429)
  assert.equal((f.tables.crm_action_tokens || []).length, 0)
  const race = await fixture(t)
  const owner = await race.login()
  race.beforeUserUpdate(() => { race.tables.users[0].password_hash = 'changed-after-verification' })
  assert.equal((await authorize(race, owner, action)).statusCode, 401)
  assert.equal((race.tables.crm_action_tokens || []).length, 0)
})

test('CRM rejects GET bodies, unsupported payloads, malformed UTF-8 and dangerous JSON keys before handlers', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  const headers = authHeaders(loggedIn)
  assert.equal((await f.rawInject({ method: 'GET', url: '/api/crm/session', headers: { ...headers, 'content-type': 'application/json' }, payload: '{}' })).statusCode, 400)
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/crm/jobs', headers: { ...headers, 'content-type': 'text/plain' }, payload: '{}' })).statusCode, 415)
  assert.equal((await f.rawInject({ method: 'POST', url: '/api/crm/jobs', headers: { ...headers, 'content-type': 'application/json' }, payload: Buffer.from([0xc3, 0x28]) })).statusCode, 400)
  for (const payload of ['{"__proto__":{"admin":true}}', '{"constructor":{"prototype":{"admin":true}}}']) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/crm/jobs', headers: { ...headers, 'content-type': 'application/json' }, payload })).statusCode, 400)
  }
  assert.equal(f.getHandled(), 0)
})

test('new browser gets only an expiring masked email challenge until it proves the key and OTP', async t => {
  const f = await fixture(t)
  const response = await f.beginLogin()
  assert.equal(response.statusCode, 200, response.body)
  const challenge = response.json()
  assert.equal(challenge.otp_required, true)
  assert.match(challenge.challenge_id, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(challenge.expires_in, 600)
  assert.equal(challenge.resend_after, 60)
  assert.equal(response.cookies.length, 0, 'a password alone must never create a CRM session')
  assert.equal(f.tables.sessions.length, 0)
  assert.equal(f.mailbox.length, 1)
  assert.equal(f.mailbox[0].to, 'synthetic-admin@example.test')
  assert.equal(f.mailbox[0].purpose, 'login')
  assert.match(f.mailbox[0].code, /^\d{8}$/)
  assert.ok(!response.body.includes(f.mailbox[0].to), 'pre-auth response reveals only a masked email')
  assert.ok(!response.body.includes(f.mailbox[0].code), 'the OTP is delivered only through email')
  assert.ok(!JSON.stringify(f.tables.crm_login_challenges).includes(f.mailbox[0].code), 'stored challenges cannot contain plaintext OTPs')
  const missingProof = await f.rawInject({ method: 'POST', url: '/api/crm/login/verify', headers: { origin }, payload: { challenge_id: challenge.challenge_id, code: f.mailbox[0].code, trust_device: false } })
  assert.equal(missingProof.statusCode, 401)
  const wrongKey = browserKeys()
  const forged = await f.rawInject(f.challengeRequest('/login/verify', challenge.challenge_id, { code: f.mailbox[0].code, trust_device: false }, wrongKey.privateKey))
  assert.equal(forged.statusCode, 401)
  assert.equal(f.tables.sessions.length, 0)
  const loggedIn = await f.verifyOtp(challenge.challenge_id)
  assert.equal(loggedIn.statusCode, 200, loggedIn.body)
  assert.ok(loggedIn.json().browser_binding)
  assert.equal(f.tables.sessions.length, 1)
  assert.equal((f.tables.crm_trusted_devices ?? []).length, 0, 'trust is opt-in independently of completing OTP')
  const replay = await f.verifyOtp(challenge.challenge_id)
  assert.ok(replay.statusCode >= 400, 'an accepted challenge cannot create another session')
  assert.equal(f.tables.sessions.length, 1)
})

test('OTP attempts and expiry are enforced before TTL cleanup and bad proofs do not spend the code', async t => {
  const f = await fixture(t)
  const started = await f.beginLogin()
  const challengeId = started.json().challenge_id
  const actual = f.mailbox.at(-1)!.code
  const wrong = actual === '00000000' ? '11111111' : '00000000'
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await f.verifyOtp(challengeId, wrong)
    assert.ok(response.statusCode >= 400, response.body)
    assert.equal(f.tables.sessions.length, 0)
  }
  const exhausted = await f.verifyOtp(challengeId, actual)
  assert.ok(exhausted.statusCode >= 400, 'correct OTP cannot revive an exhausted challenge')
  assert.equal(f.tables.sessions.length, 0)
  const expiring = await fixture(t)
  const second = await expiring.beginLogin()
  expiring.tables.crm_login_challenges[0].expires_at = new Date(Date.now() - 1)
  assert.ok((await expiring.verifyOtp(second)).statusCode >= 400)
  assert.equal(expiring.tables.sessions.length, 0)
})

test('a pending OTP cannot outlive replacement credentials or a changed email revision', async t => {
  for (const replacement of ['password', 'email'] as const) {
    const f = await fixture(t)
    const challenge = await f.beginLogin()
    if (replacement === 'password') f.tables.users[0].password_hash = await hashPassword('replacement-during-OTP-verification')
    else f.tables.users[0].email_revision++
    const response = await f.verifyOtp(challenge)
    assert.ok(response.statusCode >= 400, `${replacement}: ${response.body}`)
    assert.equal(f.tables.sessions.length, 0, 'an OTP issued for an old account identity cannot authorize a session')
    assert.equal((f.tables.crm_trusted_devices ?? []).length, 0)
  }
})

test('concurrent valid OTP submissions consume the challenge exactly once', async t => {
  const f = await fixture(t)
  const challenge = await f.beginLogin()
  const responses = await Promise.all([f.verifyOtp(challenge), f.verifyOtp(challenge)])
  assert.equal(responses.filter(response => response.statusCode === 200).length, 1)
  assert.equal(f.tables.sessions.length, 1)
})

test('resend is proof bound and throttled, replaces the OTP without renewing the challenge lifetime', async t => {
  const f = await fixture(t)
  const started = await f.beginLogin()
  const id = started.json().challenge_id
  const expires = f.tables.crm_login_challenges[0].expires_at.getTime()
  const originalCode = f.mailbox[0].code
  const immediate = await f.rawInject(f.challengeRequest('/login/resend', id))
  assert.equal(immediate.statusCode, 429, immediate.body)
  assert.equal(f.mailbox.length, 1, 'cooldown cannot send another email')
  const row = f.tables.crm_login_challenges[0]
  // Cooldown timestamps are server-owned. Advance fixture storage rather than
  // sleeping or changing the process clock for an authentication test.
  for (const [name, value] of Object.entries(row)) {
    if (value instanceof Date && /sent|resend|next/.test(name)) row[name] = new Date(Date.now() - 61_000)
  }
  const resent = await f.rawInject(f.challengeRequest('/login/resend', id))
  assert.equal(resent.statusCode, 200, resent.body)
  assert.equal(f.mailbox.length, 2)
  assert.equal(f.tables.crm_login_challenges[0].expires_at.getTime(), expires, 'resending must not make OTP challenges immortal')
  assert.ok((await f.verifyOtp(id, originalCode)).statusCode >= 400)
  assert.equal((await f.verifyOtp(id)).statusCode, 200)
})

test('restarting password login cannot bypass the email OTP cooldown', async t => {
  const f = await fixture(t)
  const first = await f.beginLogin()
  assert.equal(first.statusCode, 200, first.body)
  const restarted = await f.beginLogin('admin', password, { 'x-forwarded-for': '192.0.2.203' })
  assert.equal(restarted.statusCode, 429, restarted.body)
  assert.equal(f.mailbox.length, 1, 'a pending login cannot send more email by starting over')
  assert.equal(f.tables.crm_login_challenges.length, 1)
  assert.equal((await f.verifyOtp(first)).statusCode, 200, 'the original challenge remains usable')
  const concurrent = await fixture(t)
  const responses = await Promise.all([concurrent.beginLogin(), concurrent.beginLogin()])
  assert.equal(responses.filter(response => response.statusCode === 200).length, 1)
  assert.equal(responses.filter(response => response.statusCode === 429).length, 1)
  assert.equal(concurrent.mailbox.length, 1, 'parallel first requests share the same account cooldown')
})

test('old challenge resends and fresh logins share the same account email cooldown', async t => {
  const f = await fixture(t)
  const old = await f.beginLogin()
  f.tables.crm_login_challenges[0].last_sent_at = new Date(Date.now() - 61_000)
  const fresh = await f.beginLogin()
  assert.equal(fresh.statusCode, 200, fresh.body)
  const resend = await f.rawInject(f.challengeRequest('/login/resend', old.json().challenge_id))
  assert.equal(resend.statusCode, 429, resend.body)
  assert.equal(f.mailbox.length, 2, 'another challenge cannot resend while an account email was just sent')
  const concurrent = await fixture(t)
  const pending = await concurrent.beginLogin()
  concurrent.tables.crm_login_challenges[0].last_sent_at = new Date(Date.now() - 61_000)
  const attempts = await Promise.all([
    concurrent.beginLogin(),
    concurrent.rawInject(concurrent.challengeRequest('/login/resend', pending.json().challenge_id)),
  ])
  assert.equal(attempts.filter(response => response.statusCode === 200).length, 1)
  assert.equal(attempts.filter(response => response.statusCode === 429).length, 1)
  assert.equal(concurrent.mailbox.length, 2, 'parallel login and resend must serialize on the account')
})

test('trusting a device requires OTP and a later signed login, never a copied public key', async t => {
  const f = await fixture(t)
  f.tables.users[0].display_name = 'Tên tài khoản ban đầu'
  const started = await f.beginLogin()
  const loggedIn = await f.verifyOtp(started, undefined, true)
  assert.equal(loggedIn.statusCode, 200, loggedIn.body)
  assert.equal(f.tables.crm_trusted_devices.length, 1)
  const trust = f.tables.crm_trusted_devices[0]
  assert.equal(trust.user_id, 'admin')
  assert.equal(trust.credential_version, digest(passwordHash))
  assert.ok(trust.expires_at.getTime() > Date.now() + 29 * 86400_000)
  assert.ok(trust.expires_at.getTime() <= Date.now() + 30 * 86400_000)
  const copiedPublicKeyOnly = await f.beginLogin()
  assert.equal(copiedPublicKeyOnly.json().otp_required, true, 'password plus a copied public key cannot skip OTP')
  const request = f.loginRequest()
  f.tables.users[0].display_name = 'Tên mới trên thiết bị tin cậy'
  const thumbprint = browserBodyHash(JSON.stringify(f.keys.publicKey))
  const signed = { ...request, headers: { ...request.headers, 'x-crm-proof': requestProof(f.keys.privateKey, thumbprint, request) } }
  const trusted = await f.rawInject(signed)
  assert.equal(trusted.statusCode, 200, trusted.body)
  assert.ok(trusted.json().browser_binding)
  assert.equal(trusted.json().display_name, 'Tên mới trên thiết bị tin cậy')
  assert.notEqual(trusted.json().otp_required, true)
  const replay = await f.rawInject(signed)
  assert.equal(replay.statusCode, 401, 'a signed trusted login is one use across all replicas')
  trust.expires_at = new Date(Date.now() - 1)
  for (const pending of f.tables.crm_login_challenges) pending.last_sent_at = new Date(Date.now() - 61_000)
  const expiredRequest = f.loginRequest()
  const expired = await f.rawInject({ ...expiredRequest, headers: { ...expiredRequest.headers, 'x-crm-proof': requestProof(f.keys.privateKey, thumbprint, expiredRequest) } })
  assert.equal(expired.json().otp_required, true, 'expired trust requires a fresh OTP')
})

test('remember login is opt-in with persistent expiry while normal login uses a browser session cookie', async t => {
  const regular = await fixture(t)
  const short = await regular.login()
  assert.equal(short.statusCode, 200, short.body)
  assert.doesNotMatch(String(short.headers['set-cookie']), /Max-Age=|Expires=/i)
  assert.equal(regular.tables.sessions[0].remember_me, false)
  assert.equal(regular.tables.sessions[0].idle_timeout_ms, 30 * 60_000)
  assert.ok(regular.tables.sessions[0].expires_at.getTime() <= Date.now() + 12 * 3600_000)
  const remembered = await fixture(t)
  const long = await remembered.login('admin', password, {}, { remember_me: true })
  assert.equal(long.statusCode, 200, long.body)
  assert.match(String(long.headers['set-cookie']), /Max-Age=2592000/i)
  assert.equal(remembered.tables.sessions[0].remember_me, true)
  assert.equal(remembered.tables.sessions[0].idle_timeout_ms, 7 * 86400_000)
  assert.ok(remembered.tables.sessions[0].expires_at.getTime() > Date.now() + 29 * 86400_000)
  remembered.tables.sessions[0].last_active_at = new Date(Date.now() - 8 * 86400_000)
  assert.equal((await remembered.app.inject({ url: '/api/crm/session', headers: authHeaders(long) })).statusCode, 401)
})

test('changing password revokes trusted devices and pending challenges as well as sessions', async t => {
  const f = await fixture(t)
  const first = await f.beginLogin()
  const loggedIn = await f.verifyOtp(first, undefined, true)
  await f.beginLogin()
  assert.equal(f.tables.crm_trusted_devices.length, 1)
  assert.ok(f.tables.crm_login_challenges.length > 0)
  const changed = await f.app.inject({ method: 'POST', url: '/api/crm/password', headers: authHeaders(loggedIn), payload: { current_password: password, new_password: 'replacement-OTP-password-value' } })
  assert.equal(changed.statusCode, 200, changed.body)
  assert.equal(f.tables.sessions.length, 1)
  assert.equal(f.tables.crm_trusted_devices.length, 0)
  assert.equal(f.tables.crm_login_challenges.length, 0)
})

test('missing verified email blocks new-device login rather than silently falling back to password only', async t => {
  const f = await fixture(t)
  delete f.tables.users[0].email
  delete f.tables.users[0].email_verified_at
  const response = await f.beginLogin()
  assert.equal(response.statusCode, 403, response.body)
  assert.equal(response.json().error.code, 'account_email_setup_required')
  assert.equal(f.tables.sessions.length, 0)
  assert.equal(f.mailbox.length, 0)
})

test('malformed legacy email metadata never qualifies for new-device authentication', async t => {
  for (const legacy of [
    { email: 'synthetic-admin@example.test', email_verified_at: new Date(Number.NaN) },
    { email: 'synthetic-admin@example.test', email_verified_at: '2026-11-23T00:00:00.000Z' },
    { email: 'not-an-email', email_verified_at: new Date() },
    { email: 'Synthetic-Admin@example.test', email_verified_at: new Date() },
    { email: ' synthetic-admin@example.test ', email_verified_at: new Date() },
  ]) {
    const f = await fixture(t)
    Object.assign(f.tables.users[0], legacy)
    const response = await f.beginLogin()
    assert.equal(response.statusCode, 403, response.body)
    assert.equal(response.json().error.code, 'account_email_setup_required')
    assert.equal(f.tables.sessions.length, 0)
    assert.equal(f.mailbox.length, 0)
  }
})

test('legacy accounts without email revision can verify OTP and use their trusted device', async t => {
  const f = await fixture(t)
  delete f.tables.users[0].email_revision
  const first = await f.beginLogin()
  assert.equal(first.statusCode, 200, first.body)
  const loggedIn = await f.verifyOtp(first, undefined, true)
  assert.equal(loggedIn.statusCode, 200, loggedIn.body)
  assert.equal(f.tables.sessions[0].email_revision, 0)
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: authHeaders(loggedIn) })).statusCode, 200)
  const request = f.loginRequest()
  const thumbprint = browserBodyHash(JSON.stringify(f.keys.publicKey))
  const trusted = await f.rawInject({ ...request, headers: { ...request.headers, 'x-crm-proof': requestProof(f.keys.privateKey, thumbprint, request) } })
  assert.equal(trusted.statusCode, 200, trusted.body)
  assert.equal(trusted.json().otp_required, undefined)
  assert.equal(f.mailbox.length, 1, 'a correctly signed trusted legacy browser does not need another email')
})

test('revoking a session during password verification cannot recreate that session', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  f.beforeUserUpdate(() => { f.tables.sessions.splice(0) })
  const response = await f.app.inject({ method: 'POST', url: '/api/crm/password', headers: authHeaders(loggedIn),
    payload: { current_password: password, new_password: 'replacement-after-session-revoked' } })
  assert.equal(response.statusCode, 401, response.body)
  assert.equal(f.tables.sessions.length, 0, 'a session revoked during the password work cannot mint a fresh authenticated session')
})

test('account profile updates require one-use authorization and cannot write authentication internals', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  const headers = authHeaders(loggedIn)
  const profile = await f.app.inject({ url: '/api/crm/account', headers })
  assert.equal(profile.statusCode, 200, profile.body)
  assert.equal(profile.json().username, 'admin')
  assert.equal(profile.json().email, 'synthetic-admin@example.test')
  assert.equal(profile.json().email_verified, true)
  for (const forbidden of ['password_hash', 'credential_version', 'browser_public_key', 'key_thumbprint']) assert.ok(!profile.body.includes(forbidden))
  const update = { method: 'PATCH', url: '/api/crm/account', headers, payload: { display_name: 'Synthetic operator' } }
  assert.equal((await f.app.inject(update)).statusCode, 403)
  const authorization = await authorize(f, loggedIn, update)
  assert.equal(authorization.statusCode, 200, authorization.body)
  const updated = await f.app.inject({ ...update, headers: { ...headers, 'x-crm-action-token': authorization.json().action_token } })
  assert.equal(updated.statusCode, 200, updated.body)
  assert.equal(f.tables.users[0].username, 'admin')
  assert.equal(f.tables.users[0].display_name, 'Synthetic operator')
  const reloaded = await f.app.inject({ url: '/api/crm/session', headers })
  assert.equal(reloaded.statusCode, 200, reloaded.body)
  assert.equal(reloaded.json().username, 'admin')
  assert.equal(reloaded.json().display_name, 'Synthetic operator', 'a reload retains the saved profile name without logging in again')
  const usernameChange = { ...update, payload: { ...update.payload, username: 'updated-admin' } }
  const usernameAuthorization = await authorize(f, loggedIn, usernameChange)
  assert.equal(usernameAuthorization.statusCode, 200, usernameAuthorization.body)
  const usernameResponse = await f.app.inject({ ...usernameChange, headers: { ...headers, 'x-crm-action-token': usernameAuthorization.json().action_token } })
  assert.equal(usernameResponse.statusCode, 400, usernameResponse.body)
  assert.equal(f.tables.users[0].username, 'admin', 'even an authorized profile request cannot change the login username')
  assert.equal(f.tables.users[0].display_name, 'Synthetic operator')
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers })).json().username, 'admin')
  const tamper = { ...update, payload: { ...update.payload, email: 'unverified@example.test', email_verified_at: new Date(), password_hash: 'fake' } }
  const tamperAuthorization = await authorize(f, loggedIn, tamper)
  assert.equal(tamperAuthorization.statusCode, 200, tamperAuthorization.body)
  assert.equal((await f.app.inject({ ...tamper, headers: { ...headers, 'x-crm-action-token': tamperAuthorization.json().action_token } })).statusCode, 400)
  assert.equal(f.tables.users[0].email, 'synthetic-admin@example.test')
  assert.equal(f.tables.users[0].password_hash, passwordHash)
})

test('trusted devices are listed without key material and revocation needs account reauthentication', async t => {
  const f = await fixture(t)
  const challenge = await f.beginLogin()
  const loggedIn = await f.verifyOtp(challenge, undefined, true)
  const headers = authHeaders(loggedIn)
  const response = await f.app.inject({ url: '/api/crm/account', headers })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().devices.length, 1)
  const [device] = response.json().devices
  assert.equal(device.current, true)
  assert.equal(typeof device.label, 'string')
  assert.ok(!response.body.includes(f.keys.publicKey.x))
  assert.ok(!response.body.includes('key_thumbprint'))
  const revoke = { method: 'DELETE', url: `/api/crm/account/devices/${device.id}`, headers }
  assert.equal((await f.app.inject(revoke)).statusCode, 403)
  assert.equal(f.tables.crm_trusted_devices.length, 1)
  const authorization = await authorize(f, loggedIn, revoke)
  const revoked = await f.app.inject({ ...revoke, headers: { ...headers, 'x-crm-action-token': authorization.json().action_token } })
  assert.ok([200, 204].includes(revoked.statusCode), revoked.body)
  assert.equal(f.tables.crm_trusted_devices.length, 0)
  assert.equal((await f.beginLogin()).json().otp_required, true)
})

test('changing the verified account email needs codes from both mailboxes and revokes old trust and other sessions', async t => {
  const f = await fixture(t)
  const challenge = await f.beginLogin()
  const loggedIn = await f.verifyOtp(challenge, undefined, true)
  const otherSession = await f.login()
  const pendingLogin = await f.beginLogin()
  assert.equal(pendingLogin.json().otp_required, true)
  const headers = authHeaders(loggedIn)
  const start = { method: 'POST', url: '/api/crm/account/email/start', headers, payload: { email: 'changed-address@example.test' } }
  assert.equal((await f.app.inject(start)).statusCode, 403, 'changing the email requires fresh password authorization')
  const authorization = await authorize(f, loggedIn, start)
  const started = await f.app.inject({ ...start, headers: { ...headers, 'x-crm-action-token': authorization.json().action_token } })
  assert.equal(started.statusCode, 200, started.body)
  assert.equal(started.json().requires_current_code, true)
  const emailChallenge = started.json().challenge_id
  const currentCode = [...f.mailbox].reverse().find(message => message.purpose === 'email_current')!.code
  const newCode = [...f.mailbox].reverse().find(message => message.purpose === 'email_new')!.code
  assert.equal([...f.mailbox].reverse().find(message => message.purpose === 'email_current')!.to, 'synthetic-admin@example.test')
  assert.equal([...f.mailbox].reverse().find(message => message.purpose === 'email_new')!.to, 'changed-address@example.test')
  assert.equal(f.tables.users[0].email, 'synthetic-admin@example.test', 'sending an OTP cannot change the account identity')
  assert.ok(!started.body.includes(currentCode) && !started.body.includes(newCode))
  const wrongCurrentCode = currentCode === '00000000' ? '11111111' : '00000000'
  const verify = (current_code: string) => f.app.inject({ method: 'POST', url: '/api/crm/account/email/verify', headers, payload: { challenge_id: emailChallenge, code: newCode, current_code } })
  assert.ok((await verify(wrongCurrentCode)).statusCode >= 400)
  assert.equal(f.tables.users[0].email, 'synthetic-admin@example.test')
  const changed = await verify(currentCode)
  assert.equal(changed.statusCode, 200, changed.body)
  assert.equal(changed.json().email, 'changed-address@example.test')
  assert.equal(changed.json().email_verified, true)
  assert.equal(f.tables.users[0].email, 'changed-address@example.test')
  assert.equal(f.tables.sessions.length, 1, 'all other sessions are revoked when changing the email')
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers })).statusCode, 200, 'the current browser retains its bound session')
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: authHeaders(otherSession) })).statusCode, 401)
  assert.equal(f.tables.crm_trusted_devices.length, 0)
  assert.equal(f.tables.crm_login_challenges.length, 0)
  assert.equal(f.tables.crm_email_challenges.length, 0)
})

test('an existing bound session can verify its first email without trusting an unverified legacy value', async t => {
  const f = await fixture(t)
  const loggedIn = await f.login()
  const user = f.tables.users[0]
  user.email = 'legacy-unverified@example.test'
  delete user.email_verified_at
  const headers = authHeaders(loggedIn)
  const start = { method: 'POST', url: '/api/crm/account/email/start', headers, payload: { email: 'verified-first@example.test' } }
  const authorization = await authorize(f, loggedIn, start)
  const started = await f.app.inject({ ...start, headers: { ...headers, 'x-crm-action-token': authorization.json().action_token } })
  assert.equal(started.statusCode, 200, started.body)
  assert.equal(started.json().requires_current_code, false)
  assert.equal(f.mailbox.filter(message => message.purpose === 'email_current').length, 0)
  const message = f.mailbox.at(-1)!
  assert.equal(message.purpose, 'email_new')
  const changed = await f.app.inject({ method: 'POST', url: '/api/crm/account/email/verify', headers,
    payload: { challenge_id: started.json().challenge_id, code: message.code } })
  assert.equal(changed.statusCode, 200, changed.body)
  assert.equal(changed.json().email_verified, true)
  assert.equal(user.email, 'verified-first@example.test')
  assert.ok(user.email_verified_at instanceof Date)
})

test('revoking a trusted device also removes its other sessions and pending login challenges', async t => {
  const f = await fixture(t)
  const loggedIn = await f.verifyOtp(await f.beginLogin(), undefined, true)
  const other = await f.login()
  const otherHeaders = authHeaders(other)
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: otherHeaders })).statusCode, 200)
  await f.beginLogin()
  assert.equal(f.tables.sessions.length, 2)
  assert.equal(f.tables.crm_login_challenges.length, 1)
  const device = f.tables.crm_trusted_devices[0]
  const headers = authHeaders(loggedIn)
  const revoke = { method: 'DELETE', url: `/api/crm/account/devices/${device._id}`, headers }
  const authorization = await authorize(f, loggedIn, revoke)
  const revoked = await f.app.inject({ ...revoke, headers: { ...headers, 'x-crm-action-token': authorization.json().action_token } })
  assert.equal(revoked.statusCode, 204, revoked.body)
  assert.equal(f.tables.crm_trusted_devices.length, 0)
  assert.equal(f.tables.crm_login_challenges.length, 0)
  assert.equal(f.tables.sessions.length, 1)
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers: otherHeaders })).statusCode, 401)
  assert.equal((await f.app.inject({ url: '/api/crm/session', headers })).statusCode, 200)
})
