import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomBytes, sign, webcrypto } from 'node:crypto'
import test from 'node:test'
import { ApiError } from '../src/api/errors.js'
import { browserBodyHash, parseBrowserPublicKey, verifyBrowserProof } from '../src/crm-proof.js'
import { migrate } from '../src/migrate.js'
import type { Database } from '../src/db.js'

const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const exported = keyPair.publicKey.export({ format: 'jwk' })
const publicKey = parseBrowserPublicKey({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y })
const nowMs = Date.UTC(2026, 10, 23, 3, 15, 41, 999)
const nowSeconds = Math.floor(nowMs / 1_000)
const expected = {
  audience: 'https://crm.example.test', method: 'POST',
  target: '/api/crm/jobs?keyword=m%C3%A1y+l%E1%BB%8Dc&limit=10',
  bodyHash: browserBodyHash('{"keyword":"máy lọc","length":1200}'),
  binding: randomBytes(32).toString('base64url'), idempotencyKey: '  exact-idempotency-key  ',
}
const header = { alg: 'ES256', typ: 'crm-pop+jwt' }
const claims = () => ({
  aud: expected.audience, htm: expected.method, htu: expected.target,
  bth: expected.bodyHash, sid: expected.binding, iat: nowSeconds,
  jti: randomBytes(32).toString('base64url'), ikh: expected.idempotencyKey,
})
const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
const signedText = (encodedHeader: string, encodedPayload: string, encoding: 'ieee-p1363' | 'der' = 'ieee-p1363') => {
  const input = `${encodedHeader}.${encodedPayload}`
  const signature = sign('sha256', Buffer.from(input), { key: keyPair.privateKey, dsaEncoding: encoding })
  return `${input}.${signature.toString('base64url')}`
}
const proof = (payload: unknown = claims(), protectedHeader: unknown = header) => signedText(encode(protectedHeader), encode(payload))
const isError = (status: number, code: string) => (error: unknown) => error instanceof ApiError && error.status === status && error.code === code
const invalid = (value: unknown, overrides = {}) => assert.throws(
  () => verifyBrowserProof(value, publicKey, { ...expected, ...overrides }, nowMs), isError(401, 'browser_proof_invalid'),
)

test('browser keys accept only canonical public EC P-256 points', () => {
  assert.deepEqual(parseBrowserPublicKey(publicKey), publicKey)
  for (const extra of ['d', 'kid', 'jku', 'x5u', 'alg', 'use', 'key_ops', 'ext', '__proto__']) {
    const value = { ...publicKey }
    Object.defineProperty(value, extra, { value: 'not-permitted', enumerable: true })
    assert.throws(() => parseBrowserPublicKey(value), isError(400, 'browser_key_invalid'))
  }
  const badPoints: unknown[] = [
    null, [], 'not-a-key', {}, { ...publicKey, kty: 'RSA' }, { ...publicKey, crv: 'P-384' },
    { ...publicKey, x: publicKey.x + '=' }, { ...publicKey, x: publicKey.x.slice(1) },
    { ...publicKey, x: '+'.repeat(43) }, { ...publicKey, y: 'A'.repeat(43) },
    { ...publicKey, x: 'A'.repeat(43), y: 'A'.repeat(43) },
    { ...publicKey, x: 42 }, { ...publicKey, y: undefined },
  ]
  for (const value of badPoints) assert.throws(() => parseBrowserPublicKey(value), isError(400, 'browser_key_invalid'))
})

test('browser request body hashes bind exact bytes and preserve UTF-8 and empty bodies', () => {
  assert.equal(browserBodyHash(''), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU')
  const text = '{"keyword":"máy lọc nước"}'
  assert.equal(browserBodyHash(text), browserBodyHash(Buffer.from(text, 'utf8')))
  assert.equal(browserBodyHash(text), createHash('sha256').update(text).digest('base64url'))
  assert.notEqual(browserBodyHash('{"a":1}'), browserBodyHash('{ "a": 1 }'))
  assert.notEqual(browserBodyHash('{"a":1,"b":2}'), browserBodyHash('{"b":2,"a":1}'))
})

test('valid ES256 proof returns only its nonce and replay expiration beyond acceptance', () => {
  const payload = claims()
  const result = verifyBrowserProof(proof(payload), publicKey, expected, nowMs)
  assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'jti'])
  assert.equal(result.jti, payload.jti)
  assert.equal(result.expiresAt.getTime(), (payload.iat + 61) * 1_000)
  assert.ok(result.expiresAt.getTime() > nowMs)
  for (const age of [-60, 10]) {
    const boundary = { ...claims(), iat: nowSeconds + age }
    const result = verifyBrowserProof(proof(boundary), publicKey, expected, nowMs)
    assert.ok(result.expiresAt.getTime() > nowMs)
  }
  const emptyIdempotency = { ...claims(), ikh: '' }
  verifyBrowserProof(proof(emptyIdempotency), publicKey, { ...expected, idempotencyKey: '' }, nowMs)
})

test('proof method, exact path/query, body, session, audience and idempotency cannot be retargeted', () => {
  const original = proof()
  for (const override of [
    { method: 'DELETE' }, { method: 'post' },
    { target: '/api/crm/providers' },
    { target: expected.target.replace('limit=10', 'limit=100') },
    { target: expected.target.replace('keyword=', 'limit=10&keyword=') },
    { target: expected.target.replace('+', '%20') },
    { bodyHash: browserBodyHash('{"length":2500}') },
    { binding: randomBytes(32).toString('base64url') },
    { audience: 'https://sibling.example.test' },
    { idempotencyKey: expected.idempotencyKey.trim() }, { idempotencyKey: '' },
  ]) invalid(original, override)
})

test('signed proofs reject unknown, duplicate, missing and malformed claims', () => {
  const valid = claims()
  for (const name of Object.keys(valid)) {
    const missing: Record<string, unknown> = { ...valid }
    delete missing[name]
    invalid(proof(missing))
  }
  for (const name of ['sub', 'jwk', 'nonce', 'exp', 'nbf', '__proto__']) {
    const extra: Record<string, unknown> = { ...valid }
    Object.defineProperty(extra, name, { value: 'extra', enumerable: true })
    invalid(proof(extra))
  }
  const duplicate = JSON.stringify(valid).replace('"aud":', '"aud":"ignored","aud":')
  invalid(signedText(encode(header), Buffer.from(duplicate).toString('base64url')))
  const escapedDuplicate = JSON.stringify(valid).replace('"aud":', '"a\\u0075d":"ignored","aud":')
  invalid(signedText(encode(header), Buffer.from(escapedDuplicate).toString('base64url')))
  for (const value of ['', 'x'.repeat(21), 'x'.repeat(87), 'a+b'.repeat(10), 42, null]) invalid(proof({ ...valid, jti: value }))
  for (const value of [nowSeconds - 61, nowSeconds + 11, nowSeconds + 0.1, String(nowSeconds), null, Number.MAX_SAFE_INTEGER + 1]) invalid(proof({ ...valid, iat: value }))
  invalid(proof({ ...valid, htm: 'post' }), { method: 'post' })
  invalid(proof({ ...valid, htu: '//other.example/path' }), { target: '//other.example/path' })
  invalid(proof({ ...valid, htu: '/path#fragment' }), { target: '/path#fragment' })
  invalid(proof({ ...valid, sid: 'short' }), { binding: 'short' })
  invalid(proof({ ...valid, bth: 'short' }), { bodyHash: 'short' })
  invalid(proof({ ...valid, ikh: null }), { idempotencyKey: null })
  for (const value of [[], null, 'claims', { ...valid, nested: {} }]) invalid(proof(value))
})

test('compact JWS strictly checks protected header, canonical encoding and P1363 signature', () => {
  const valid = proof()
  for (const missing of [undefined, null, '']) assert.throws(
    () => verifyBrowserProof(missing, publicKey, expected, nowMs), isError(401, 'browser_proof_required'),
  )
  for (const value of [[], ['token'], {}, 3, true, 'x'.repeat(4_097), valid + '.extra', ' ' + valid, valid + '\n', 'a.b.c', '..']) invalid(value)
  for (const value of [
    { alg: 'none', typ: 'crm-pop+jwt' }, { alg: 'HS256', typ: 'crm-pop+jwt' },
    { alg: 'ES384', typ: 'crm-pop+jwt' }, { alg: 'ES256', typ: 'JWT' },
    { alg: 'ES256' }, { typ: 'crm-pop+jwt' },
    { ...header, jwk: publicKey }, { ...header, jku: 'https://attacker.example/key' },
    { ...header, kid: 'other' }, { ...header, x5u: 'https://attacker.example/cert' },
    { ...header, crit: [] }, { ...header, b64: false },
  ]) invalid(proof(claims(), value))
  const duplicateHeader = Buffer.from('{"alg":"none","alg":"ES256","typ":"crm-pop+jwt"}').toString('base64url')
  invalid(signedText(duplicateHeader, encode(claims())))
  const segments = valid.split('.')
  for (let index = 0; index < 3; index++) {
    const padded = [...segments]; padded[index] += '='; invalid(padded.join('.'))
  }
  invalid(`${segments[0]}.${segments[1]}.`)
  invalid(`${segments[0]}.${segments[1]}.${randomBytes(63).toString('base64url')}`)
  invalid(`${segments[0]}.${segments[1]}.${randomBytes(64).toString('base64url')}`)
  const changed = Buffer.from(segments[2], 'base64url'); changed[0] ^= 1
  invalid(`${segments[0]}.${segments[1]}.${changed.toString('base64url')}`)
  invalid(signedText(encode(header), encode(claims()), 'der'))
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' })
  const otherKey = parseBrowserPublicKey({ kty: other.kty, crv: other.crv, x: other.x, y: other.y })
  assert.throws(() => verifyBrowserProof(valid, otherKey, expected, nowMs), isError(401, 'browser_proof_invalid'))
  invalid(signedText(Buffer.from([0xff, 0xfe]).toString('base64url'), encode(claims())))
  invalid(valid, { target: '/different' })
  assert.throws(() => verifyBrowserProof(valid, publicKey, expected, Number.NaN), isError(401, 'browser_proof_invalid'))
})

test('nonextractable WebCrypto P-256 signatures verify without exporting the private key', async () => {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  assert.equal(keys.privateKey.extractable, false)
  await assert.rejects(webcrypto.subtle.exportKey('jwk', keys.privateKey))
  const exported = await webcrypto.subtle.exportKey('jwk', keys.publicKey)
  const key = parseBrowserPublicKey({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y })
  const payload = claims()
  const input = `${encode(header)}.${encode(payload)}`
  const signature = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, Buffer.from(input)))
  assert.equal(signature.length, 64)
  assert.equal(verifyBrowserProof(`${input}.${signature.toString('base64url')}`, key, expected, nowMs).jti, payload.jti)
})

test('migration adds shared proof replay and action token TTL collections', async () => {
  const collections = new Set<string>()
  const indexes: { name: string; key: object; options: Record<string, unknown> }[] = []
  const db = {
    client: { async connect() {} },
    db: {
      async createCollection(name: string) { collections.add(name) },
      collection(name: string) { return {
        async createIndex(key: object, options: Record<string, unknown> = {}) { indexes.push({ name, key, options }) },
        async indexes() { return [] }, async findOne() { return null }, async updateMany() {}, async updateOne() {},
      } },
    },
  } as unknown as Database
  await migrate(db)
  for (const name of ['crm_request_proofs', 'crm_action_tokens']) {
    assert.ok(collections.has(name))
    assert.ok(indexes.some(index => index.name === name && JSON.stringify(index.key) === '{"expires_at":1}' && index.options.expireAfterSeconds === 0))
  }
})
