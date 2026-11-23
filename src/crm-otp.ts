import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { Config } from './config.js'
import { browserBodyHash, type BrowserPublicKey } from './crm-proof.js'

export const otpLifetimeMs = 10 * 60_000
export const otpResendMs = 60_000
export const otpAttemptLimit = 5
export const trustedDeviceLifetimeMs = 30 * 24 * 60 * 60_000
export const createOtp = () => randomInt(0, 100_000_000).toString().padStart(8, '0')

/** Only normalized mailboxes with a valid verification timestamp can receive login codes. */
export function verifiedAccountEmail(user: { email?: unknown, email_verified_at?: unknown }): string | null {
  return user.email_verified_at instanceof Date && Number.isFinite(user.email_verified_at.getTime()) &&
    typeof user.email === 'string' && user.email.length <= 254 && user.email === user.email.trim().toLowerCase() && z.email().safeParse(user.email).success ? user.email : null
}

/** A database read alone must not allow offline enumeration of short OTPs. */
export function otpHash(config: Config, challengeId: string, purpose: string, code: string): string {
  if (!Buffer.isBuffer(config.encryptionKey) || config.encryptionKey.length !== 32) throw new Error('OTP encryption key is unavailable')
  return createHmac('sha256', config.encryptionKey).update(JSON.stringify([challengeId, purpose, code])).digest('hex')
}

export function otpMatches(hash: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9]{64}$/.test(expected)) return false
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'))
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@')
  return `${local.slice(0, 1)}***@${domain}`
}

export function browserKeyThumbprint(key: BrowserPublicKey): string {
  return browserBodyHash(JSON.stringify({ kty: key.kty, crv: key.crv, x: key.x, y: key.y }))
}
