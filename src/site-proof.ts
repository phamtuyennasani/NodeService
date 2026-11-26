import { createPublicKey, verify } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { ApiError } from './api/errors.js'
import { collection, sessionOf, type MongoSource } from './db.js'
import { digest } from './security.js'

export interface SiteSecurity {
  id: string
  token_hash: string | null
  proof_required?: boolean
  signing_public_key?: string | null
  proof?: { nonce: string, expiresAt: Date }
}

const bodies = new WeakMap<FastifyRequest, Buffer>()
const invalidProof = () => new ApiError(401, 'site_proof_invalid', 'Chữ ký máy chủ website không hợp lệ hoặc đã hết hạn.')

/** Preserve exact request bytes for signatures, using Fastify's normal JSON validation. */
export function installSiteProofParser(app: FastifyInstance) {
  const parse = app.getDefaultJsonParser('error', 'error')
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, raw, done) => {
    const bytes = raw as Buffer
    const json = bytes.toString('utf8')
    if (!Buffer.from(json).equals(bytes)) return done(new ApiError(400, 'invalid_json', 'JSON cần dùng UTF-8 hợp lệ.'))
    bodies.set(request, bytes)
    parse(request, json, done)
  })
}

export function siteProofRequired(site: SiteSecurity): boolean {
  return site.proof_required === true || Boolean(site.signing_public_key)
}

export function normalizeSitePublicKey(value: string): string {
  try {
    if (value.length > 1024 || !/^-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----\s*$/.test(value)) throw new Error()
    const key = createPublicKey(value)
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error()
    return key.export({ type: 'spki', format: 'pem' }).toString()
  } catch { throw new ApiError(400, 'site_public_key_invalid', 'Cần khóa công khai EC P-256 ở định dạng PEM.') }
}

/** PHP OpenSSL and Node both use DER ECDSA signatures over this UTF-8 message. */
export function siteProofMessage(site: SiteSecurity, method: string, target: string, origin: string, body: Buffer | string, idempotency: string, ifMatch: string, created: string, nonce: string): string {
  return ['site-request-v1', site.id, site.token_hash ?? '', method, target, origin, digest(body), idempotency, ifMatch, created, nonce].join('\n')
}

export function verifySiteRequest(site: SiteSecurity, request: FastifyRequest) {
  if (!siteProofRequired(site)) return
  if (!site.signing_public_key) throw new ApiError(403, 'site_signing_key_required', 'Website cần đăng ký khóa ký trong CRM trước khi sử dụng API.')
  const proof = request.headers['x-site-proof']
  if (typeof proof !== 'string' || proof.length > 512) throw invalidProof()
  const match = /^([1-9]\d{9,12})\.([a-f0-9]{32})\.([A-Za-z0-9_-]{80,110})$/.exec(proof)
  if (!match) throw invalidProof()
  const [, created, nonce, encoded] = match
  const now = Math.floor(Date.now() / 1000)
  if (Number(created) < now - 60 || Number(created) > now + 10) throw invalidProof()
  const signature = Buffer.from(encoded, 'base64url')
  if (signature.toString('base64url') !== encoded) throw invalidProof()
  const body = bodies.get(request)
  if (request.body !== undefined && !body) throw invalidProof()
  const message = siteProofMessage(site, request.method, request.raw.url!, String(request.headers.origin ?? ''), body ?? '',
    String(request.headers['idempotency-key'] ?? ''), String(request.headers['if-match'] ?? ''), created, nonce)
  try {
    if (!verify('sha256', Buffer.from(message), site.signing_public_key, signature)) throw invalidProof()
  } catch { throw invalidProof() }
  return { nonce, expiresAt: new Date((Number(created) + 61) * 1000) }
}

/** Mutations call this in the same transaction as their writes and quota reservation. */
export async function admitSiteProof(source: MongoSource, site: SiteSecurity) {
  if (!site.proof) return
  if (site.proof.expiresAt.getTime() <= Date.now()) throw invalidProof()
  try {
    await collection(source, 'site_request_proofs').insertOne({
      _id: digest(`${site.id}:${site.token_hash}:${site.signing_public_key}:${site.proof.nonce}`), expires_at: site.proof.expiresAt,
    }, { session: sessionOf(source), ...(!sessionOf(source) ? { writeConcern: { w: 'majority' as const } } : {}) })
  } catch (error) {
    if ((error as { code?: number }).code === 11000) throw new ApiError(409, 'site_proof_replayed', 'Chữ ký này đã được sử dụng. Hãy cấp chữ ký mới cho yêu cầu tiếp theo.')
    throw new ApiError(503, 'site_proof_unavailable', 'Chưa thể xác thực chữ ký website. Vui lòng thử lại sau.')
  }
}

export function siteSecurityFilter(site: SiteSecurity) {
  // $exists preserves legacy rows and makes enrollment/rotation conflict with in-flight writes.
  return {
    signing_public_key: site.signing_public_key === undefined ? { $exists: false } : site.signing_public_key,
    proof_required: site.proof_required === undefined ? { $exists: false } : site.proof_required,
  }
}
