import { createHash, createPublicKey, verify } from 'node:crypto'
import { ApiError } from './api/errors.js'

export type BrowserPublicKey = { kty: 'EC'; crv: 'P-256'; x: string; y: string }

type ExpectedBrowserProof = {
  audience: string
  method: string
  target: string
  bodyHash: string
  binding: string
  idempotencyKey: string
}

const base64url = /^[A-Za-z0-9_-]+$/
const hashPattern = /^[A-Za-z0-9_-]{43}$/
const invalidKey = () => new ApiError(400, 'browser_key_invalid', 'Khóa bảo mật trình duyệt không hợp lệ.')
const invalidProof = () => new ApiError(401, 'browser_proof_invalid', 'Không xác thực được yêu cầu từ trình duyệt này.')

function exactKeys(value: unknown, names: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  return keys.length === names.length && keys.every(key => typeof key === 'string' && names.includes(key))
}

function decode(value: string): Buffer {
  if (!base64url.test(value)) throw invalidProof()
  const result = Buffer.from(value, 'base64url')
  if (result.toString('base64url') !== value) throw invalidProof()
  return result
}

/** Accept only a public, importable P-256 point; callers cannot select another key source. */
export function parseBrowserPublicKey(value: unknown): BrowserPublicKey {
  try {
    if (!exactKeys(value, ['kty', 'crv', 'x', 'y']) || value.kty !== 'EC' || value.crv !== 'P-256' ||
        typeof value.x !== 'string' || typeof value.y !== 'string' || !hashPattern.test(value.x) || !hashPattern.test(value.y)) throw invalidKey()
    const key: BrowserPublicKey = { kty: 'EC', crv: 'P-256', x: value.x, y: value.y }
    if (decode(key.x).length !== 32 || decode(key.y).length !== 32) throw invalidKey()
    // Node validates that both coordinates identify a point on the selected curve.
    createPublicKey({ key, format: 'jwk' })
    return key
  } catch { throw invalidKey() }
}

/** Digest the exact UTF-8 request bytes, before parsing or normalizing JSON. */
export function browserBodyHash(raw: string | Buffer): string {
  return createHash('sha256').update(raw).digest('base64url')
}

function flatObject(segment: string): Record<string, unknown> {
  const bytes = decode(segment)
  const json = bytes.toString('utf8')
  if (!Buffer.from(json, 'utf8').equals(bytes)) throw invalidProof()
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !Object.values(value).every(item => typeof item === 'string' || typeof item === 'number')) throw invalidProof()
  // These signed objects contain only scalar values. Count property separators
  // outside strings so duplicate JSON names (including escaped names) fail closed.
  let quoted = false; let escaped = false; let properties = 0
  for (const character of json) {
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') quoted = false
    } else if (character === '"') quoted = true
    else if (character === ':') properties++
  }
  if (properties !== Object.keys(value).length) throw invalidProof()
  return value as Record<string, unknown>
}

/** Verify only cryptography/claims. The caller must atomically admit jti in shared storage. */
export function verifyBrowserProof(
  proof: unknown,
  key: BrowserPublicKey,
  expected: ExpectedBrowserProof,
  nowMs = Date.now(),
): { jti: string; expiresAt: Date } {
  if (proof == null || proof === '') throw new ApiError(401, 'browser_proof_required', 'Yêu cầu cần xác thực từ trình duyệt đã đăng nhập.')
  try {
    if (typeof proof !== 'string' || proof.length > 4_096 || !Number.isFinite(nowMs)) throw invalidProof()
    const segments = proof.split('.')
    if (segments.length !== 3) throw invalidProof()
    const [encodedHeader, encodedPayload, encodedSignature] = segments
    const header = flatObject(encodedHeader)
    if (!exactKeys(header, ['alg', 'typ']) || header.alg !== 'ES256' || header.typ !== 'crm-pop+jwt') throw invalidProof()
    const payload = flatObject(encodedPayload)
    if (!exactKeys(payload, ['aud', 'htm', 'htu', 'bth', 'sid', 'iat', 'jti', 'ikh']) ||
        payload.aud !== expected.audience || payload.htm !== expected.method ||
        payload.htu !== expected.target || payload.bth !== expected.bodyHash ||
        payload.sid !== expected.binding || payload.ikh !== expected.idempotencyKey ||
        typeof payload.aud !== 'string' || typeof payload.htm !== 'string' || !/^[A-Z]+$/.test(payload.htm) ||
        typeof payload.htu !== 'string' || !payload.htu.startsWith('/') || payload.htu.startsWith('//') ||
        payload.htu.length > 2_048 || /[\r\n#]/.test(payload.htu) ||
        typeof payload.bth !== 'string' || !hashPattern.test(payload.bth) ||
        typeof payload.sid !== 'string' || !hashPattern.test(payload.sid) ||
        typeof payload.ikh !== 'string' || typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat) ||
        typeof payload.jti !== 'string' || !/^[A-Za-z0-9_-]{22,86}$/.test(payload.jti)) throw invalidProof()
    const nowSeconds = Math.floor(nowMs / 1_000)
    if (payload.iat < nowSeconds - 60 || payload.iat > nowSeconds + 10) throw invalidProof()
    const signature = decode(encodedSignature)
    if (signature.length !== 64) throw invalidProof()
    const publicKey = createPublicKey({ key: parseBrowserPublicKey(key), format: 'jwk' })
    if (!verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), {
      key: publicKey, dsaEncoding: 'ieee-p1363',
    }, signature)) throw invalidProof()
    // Integer-second acceptance includes the final second in full. Mongo TTL is
    // cleanup only and must not erase replay evidence while a proof is still valid.
    return { jti: payload.jti, expiresAt: new Date((payload.iat + 61) * 1_000) }
  } catch { throw invalidProof() }
}
