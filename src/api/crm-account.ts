import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { collection, sessionOf, transaction, type Database, type MongoSource } from '../db.js'
import { digest, issueToken } from '../security.js'
import { isCrmMailConfigured, type CrmOtpMessage } from '../mail.js'
import { resolveCrmMailConfig } from '../smtp-settings.js'
import { browserKeyThumbprint, createOtp, maskEmail, otpHash, otpMatches, verifiedAccountEmail as verifiedEmail } from '../crm-otp.js'
import type { CrmSession } from './crm-session.js'
import { ApiError } from './errors.js'

type Row = Record<string, any>
export type CrmAccountContext = {
  sessions: WeakMap<object, CrmSession>
  sendOtp: (message: CrmOtpMessage) => Promise<void>
  consumeAttempt: (action: string, account: string, max: number, reply: FastifyReply) => Promise<void>
}
const challengeId = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const otp = z.string().regex(/^\d{8}$/)
const emailField = z.email().trim().toLowerCase().max(254)
const profileSchema = z.object({ display_name: z.string().trim().min(1).max(120) }).strict()
const startSchema = z.object({ email: emailField }).strict()
const verifySchema = z.object({ challenge_id: challengeId, code: otp, current_code: otp.optional() }).strict()
const resendSchema = z.object({ challenge_id: challengeId }).strict()
const otpLifetimeMs = 10 * 60_000
const resendDelayMs = 60_000
const sessionRequired = () => new ApiError(401, 'session_required', 'Vui lòng đăng nhập để tiếp tục.')
const invalidOtp = () => new ApiError(400, 'otp_invalid', 'Mã xác thực không đúng, đã hết hạn hoặc đã được sử dụng.')
const revision = (user: Row) => Number.isSafeInteger(user.email_revision) ? user.email_revision : 0
const revisionFilter = (user: Row) => user.email_revision === undefined ? { $exists: false } : user.email_revision
const iso = (date: any) => date instanceof Date && Number.isFinite(date.getTime()) ? date.toISOString() : null

/** Account handlers share the signed session and action authorization installed by registerSessions. */
export function registerCrmAccount(app: FastifyInstance, db: Database, config: Config, context: CrmAccountContext) {
  function current(request: FastifyRequest) {
    const value = context.sessions.get(request)
    if (!value) throw sessionRequired()
    return value
  }
  async function account(session: CrmSession, source: MongoSource = db) {
    const user = await collection(source, 'users').findOne({ _id: session.user_id }, { session: sessionOf(source) })
    if (!user) throw sessionRequired()
    return user
  }
  // Write the user row before the session row, matching login/password lock order.
  // This makes a concurrent password/email change, logout or revocation conflict
  // with the account mutation rather than allowing a stale authorized write.
  async function guard(source: MongoSource, session: CrmSession, user: Row, update: Row = {}) {
    const options = { session: sessionOf(source) }
    const changed = await collection(source, 'users').updateOne({ _id: user._id, password_hash: user.password_hash,
      email_revision: revisionFilter(user) }, { ...update, $inc: { ...update.$inc, auth_revision: 1 } }, options)
    if (!changed.matchedCount) throw sessionRequired()
    const now = new Date()
    const alive = await collection(source, 'sessions').updateOne({ _id: session.id, user_id: session.user_id,
      browser_binding: session.browser_binding, credential_version: digest(user.password_hash),
      expires_at: { $gt: now }, last_active_at: { $gt: new Date(now.getTime() - (session.remember_me ? 7 * 24 * 60 * 60_000 : 30 * 60_000)) },
    }, { $max: { last_active_at: now } }, options)
    if (!alive.matchedCount) throw sessionRequired()
  }
  async function profile(session: CrmSession) {
    const user = await account(session)
    const devices = await collection(db, 'crm_trusted_devices').find({ user_id: user._id,
      credential_version: digest(user.password_hash), email_revision: revision(user), expires_at: { $gt: new Date() },
    }).sort({ last_used_at: -1 }).limit(100).toArray()
    const thumbprint = browserKeyThumbprint(session.browser_public_key)
    return { username: user.username, display_name: user.display_name || user.username,
      email: typeof user.email === 'string' ? user.email : null, email_verified: Boolean(verifiedEmail(user)),
      mail_configured: isCrmMailConfigured({ ...config, mail: await resolveCrmMailConfig(db, config) }), remember_me: Boolean(session.remember_me),
      devices: devices.map(device => ({ id: device._id, label: String(device.label || 'Trình duyệt').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120),
        created_at: iso(device.created_at), last_used_at: iso(device.last_used_at), expires_at: iso(device.expires_at), current: device.key_thumbprint === thumbprint })),
    }
  }
  const challengeFilter = (session: CrmSession, id: string) => ({ _id: digest(id), user_id: session.user_id,
    session_id: session.id, browser_binding: session.browser_binding, expires_at: { $gt: new Date() } })
  function challengeResponse(row: Row, id: string) {
    return { challenge_id: id, email_hint: maskEmail(row.email), requires_current_code: row.requires_current_code,
      ...(row.requires_current_code ? { current_email_hint: maskEmail(row.current_email) } : {}),
      expires_in: Math.max(0, Math.ceil((row.expires_at.getTime() - Date.now()) / 1000)),
      resend_after: Math.max(0, Math.ceil((row.last_sent_at.getTime() + resendDelayMs - Date.now()) / 1000)),
    }
  }
  async function deliver(row: Row, id: string, code: string, currentCode?: string) {
    try {
      if (row.requires_current_code && currentCode) await context.sendOtp({ to: row.current_email, code: currentCode, purpose: 'email_current' })
      await context.sendOtp({ to: row.email, code, purpose: 'email_new' })
    } catch (error) {
      // An uncertain/partially delivered pair must never remain usable.
      await collection(db, 'crm_email_challenges').deleteOne({ _id: digest(id), send_revision: row.send_revision })
      throw error
    }
  }
  app.get('/account', async request => profile(current(request)))
  app.patch('/account', { bodyLimit: 8 * 1024 }, async request => {
    const fields = profileSchema.parse(request.body)
    const session = current(request)
    const user = await account(session)
    await transaction(db, async source => { await guard(source, session, user, { $set: { ...fields, updated_at: new Date() } }) })
    return profile(session)
  })
  app.post('/account/email/start', { bodyLimit: 8 * 1024, config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const fields = startSchema.parse(request.body)
    const session = current(request)
    const user = await account(session)
    await context.consumeAttempt('email-send', user._id, 3, reply)
    const currentEmail = verifiedEmail(user)
    if (currentEmail === fields.email) throw new ApiError(400, 'email_unchanged', 'Email này đã được xác minh cho tài khoản.')
    const id = issueToken(); const code = createOtp(); const currentCode = createOtp()
    const row = { _id: digest(id), user_id: user._id, session_id: session.id, browser_binding: session.browser_binding,
      credential_version: digest(user.password_hash), email_revision: revision(user), email: fields.email,
      current_email: currentEmail,
      requires_current_code: Boolean(currentEmail), code_hash: otpHash(config, id, 'email_new', code),
      current_code_hash: currentEmail ? otpHash(config, id, 'email_current', currentCode) : null,
      attempts: 0, send_revision: issueToken(), last_sent_at: new Date(), expires_at: new Date(Date.now() + otpLifetimeMs) }
    await transaction(db, async source => {
      await guard(source, session, user)
      const options = { session: sessionOf(source) }
      const recent = await collection(source, 'crm_email_challenges').findOne({ user_id: user._id, last_sent_at: { $gt: new Date(Date.now() - resendDelayMs) } }, options)
      if (recent) { reply.header('Retry-After', '60'); throw new ApiError(429, 'otp_resend_wait', 'Vui lòng chờ 60 giây trước khi gửi lại mã.') }
      await collection(source, 'crm_email_challenges').deleteMany({ user_id: user._id }, options)
      await collection(source, 'crm_email_challenges').insertOne(row, options)
    })
    await deliver(row, id, code, currentCode)
    return challengeResponse(row, id)
  })
  app.post('/account/email/resend', { bodyLimit: 8 * 1024, config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const fields = resendSchema.parse(request.body)
    const session = current(request)
    await context.consumeAttempt('email-send', session.user_id, 3, reply)
    const user = await account(session)
    const code = createOtp(); const currentCode = createOtp()
    const row = await transaction(db, async source => {
      await guard(source, session, user)
      const options = { session: sessionOf(source) }
      const pending = await collection(source, 'crm_email_challenges').findOne(challengeFilter(session, fields.challenge_id), options)
      if (!pending || pending.credential_version !== digest(user.password_hash) || pending.email_revision !== revision(user) || pending.attempts >= 5) throw invalidOtp()
      if (pending.last_sent_at.getTime() > Date.now() - resendDelayMs) { reply.header('Retry-After', String(Math.max(1, Math.ceil((pending.last_sent_at.getTime() + resendDelayMs - Date.now()) / 1000)))); throw new ApiError(429, 'otp_resend_wait', 'Vui lòng chờ trước khi gửi lại mã.') }
      const replacement = { code_hash: otpHash(config, fields.challenge_id, 'email_new', code),
        current_code_hash: pending.requires_current_code ? otpHash(config, fields.challenge_id, 'email_current', currentCode) : null,
        send_revision: issueToken(), last_sent_at: new Date() }
      const updated = await collection(source, 'crm_email_challenges').findOneAndUpdate({ ...challengeFilter(session, fields.challenge_id), send_revision: pending.send_revision },
        { $set: replacement }, { ...options, returnDocument: 'after' })
      if (!updated) throw invalidOtp()
      return updated
    })
    await deliver(row, fields.challenge_id, code, currentCode)
    return challengeResponse(row, fields.challenge_id)
  })
  app.post('/account/email/verify', { bodyLimit: 8 * 1024, config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const fields = verifySchema.parse(request.body)
    const session = current(request)
    await context.consumeAttempt('email-verify', session.user_id, 20, reply)
    // Increment outside the transaction so wrong codes consume attempts even
    // though verification/credential checks later reject the request.
    const pending = await collection(db, 'crm_email_challenges').findOneAndUpdate({ ...challengeFilter(session, fields.challenge_id), attempts: { $lt: 5 } },
      { $inc: { attempts: 1 } }, { returnDocument: 'after', writeConcern: { w: 'majority' } })
    if (!pending) throw invalidOtp()
    const newMatches = otpMatches(pending.code_hash, otpHash(config, fields.challenge_id, 'email_new', fields.code))
    const oldMatches = !pending.requires_current_code || Boolean(fields.current_code && otpMatches(pending.current_code_hash, otpHash(config, fields.challenge_id, 'email_current', fields.current_code)))
    if (!newMatches || !oldMatches) throw invalidOtp()
    const user = await account(session)
    if (pending.credential_version !== digest(user.password_hash) || pending.email_revision !== revision(user)) throw invalidOtp()
    await transaction(db, async source => {
      const options = { session: sessionOf(source) }
      await guard(source, session, user, { $set: { email: pending.email, email_verified_at: new Date(), email_revision: revision(user) + 1, updated_at: new Date() } })
      const consumed = await collection(source, 'crm_email_challenges').findOneAndDelete({ ...challengeFilter(session, fields.challenge_id),
        code_hash: pending.code_hash, current_code_hash: pending.current_code_hash, send_revision: pending.send_revision,
        credential_version: pending.credential_version, email_revision: pending.email_revision,
        attempts: { $lte: 5 },
      }, options)
      if (!consumed) throw invalidOtp()
      const kept = await collection(source, 'sessions').updateOne({ _id: session.id, browser_binding: session.browser_binding },
        { $set: { email_revision: revision(user) + 1 } }, options)
      if (!kept.matchedCount) throw sessionRequired()
      await collection(source, 'sessions').deleteMany({ user_id: user._id, _id: { $ne: session.id } }, options)
      for (const name of ['crm_trusted_devices', 'crm_login_challenges', 'crm_email_challenges']) await collection(source, name).deleteMany({ user_id: user._id }, options)
    })
    return profile(session)
  })
  async function revoke(request: FastifyRequest, reply: FastifyReply, id?: string) {
    const session = current(request)
    const user = await account(session)
    await transaction(db, async source => {
      await guard(source, session, user)
      const options = { session: sessionOf(source) }
      if (id) {
        const device = await collection(source, 'crm_trusted_devices').findOne({ _id: id, user_id: user._id }, options)
        if (!device) throw new ApiError(404, 'not_found', 'Không tìm thấy thiết bị tin cậy.')
        await collection(source, 'crm_trusted_devices').deleteOne({ _id: id, user_id: user._id }, options)
        await collection(source, 'sessions').deleteMany({ user_id: user._id, key_thumbprint: device.key_thumbprint, _id: { $ne: session.id } }, options)
      } else {
        await collection(source, 'crm_trusted_devices').deleteMany({ user_id: user._id }, options)
        await collection(source, 'sessions').deleteMany({ user_id: user._id, _id: { $ne: session.id } }, options)
      }
      // Pending OTPs must not restore a trust grant that was just revoked.
      await collection(source, 'crm_login_challenges').deleteMany({ user_id: user._id }, options)
    })
    return reply.code(204).send()
  }
  app.delete('/account/devices', async (request, reply) => revoke(request, reply))
  app.delete('/account/devices/:id', async (request, reply) => {
    const { id } = z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.params)
    return revoke(request, reply, id)
  })
}
