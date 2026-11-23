import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { browserBodyHash, parseBrowserPublicKey } from '../src/crm-proof.js'

/** Synthetic browser key for real server-authentication tests; never a real login. */
export function browserProofFixture(audience: string) {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const exported = pair.publicKey.export({ format: 'jwk' })
  const publicKey = parseBrowserPublicKey({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y })
  const binding = randomBytes(32).toString('base64url')
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
  return {
    publicKey, binding,
    sessionFields() {
      return { browser_public_key: publicKey, browser_binding: binding, last_active_at: new Date() }
    },
    proof(method: string, target: string, rawBody = '', idempotencyKey = '') {
      const input = `${encode({ alg: 'ES256', typ: 'crm-pop+jwt' })}.${encode({
        aud: audience, htm: method, htu: target, bth: browserBodyHash(rawBody),
        sid: binding, iat: Math.floor(Date.now() / 1_000), jti: randomBytes(32).toString('base64url'), ikh: idempotencyKey,
      })}`
      const signature = sign('sha256', Buffer.from(input), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' })
      return `${input}.${signature.toString('base64url')}`
    },
  }
}
