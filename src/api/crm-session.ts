import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { collection, sessionOf, transaction, type Database, type MongoSource } from '../db.js'
import { digest, hashPassword, issueToken, verifyPassword } from '../security.js'
import { browserBodyHash, parseBrowserPublicKey, verifyBrowserProof, type BrowserPublicKey } from '../crm-proof.js'
import { ApiError } from './errors.js'
import { sendCrmOtp, type CrmOtpMessage } from '../mail.js'
import { resolveCrmMailConfig } from '../smtp-settings.js'
import { browserKeyThumbprint, createOtp, maskEmail, otpHash, otpMatches, otpLifetimeMs, otpResendMs, otpAttemptLimit, trustedDeviceLifetimeMs, verifiedAccountEmail } from '../crm-otp.js'
import { registerCrmAccount } from './crm-account.js'

const sessionMaxAge = 60 * 60 * 12
const sessionIdleMs = 30 * 60_000
const rememberedMaxAge = 30 * 24 * 60 * 60
const rememberedIdleMs = 7 * 24 * 60 * 60_000
const actionMaxAgeMs = 60_000
const authWindowMs = 5 * 60_000
const invalidLogin = () => new ApiError(401, 'invalid_login', 'Tên đăng nhập hoặc mật khẩu không đúng.')
const sessionRequired = () => new ApiError(401, 'session_required', 'Vui lòng đăng nhập để tiếp tục.')
const passwordField = z.string().min(1).max(256)
const loginSchema = z.object({ username: z.string().trim().toLowerCase().min(1).max(120), password: passwordField, browser_public_key: z.unknown(), remember_me: z.boolean().default(false) }).strict()
const challengeSchema = z.object({ challenge_id: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
const otpSchema = challengeSchema.extend({ code: z.string().regex(/^\d{8}$/), trust_device: z.boolean().default(false) }).strict()
const passwordSchema = z.object({ current_password: loginSchema.shape.password, new_password: z.string().min(12).max(256) }).strict()
const actionSchema = z.object({
  current_password: passwordField, method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
  target: z.string().min(1).max(2_048).regex(/^\/api\/crm\/(?!\/)[^\r\n#]*$/),
  body_hash: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict()
// A valid dummy hash ensures unknown accounts still perform the same password work.
const passwordPlaceholder = `${Buffer.alloc(24).toString('base64url')}.${Buffer.alloc(64).toString('base64url')}`
export type CrmSession = {
  user_id: string, username: string, display_name: string, csrf_token: string, id: string,
  browser_public_key: BrowserPublicKey, browser_binding: string,
  remember_me: boolean,
}
type Session = CrmSession

const idleTimeout = (row: any) => row.remember_me === true ? rememberedIdleMs : sessionIdleMs
const emailRevisionFilter = (user: { email_revision?: unknown }) => user.email_revision === undefined ? { $exists: false } : user.email_revision
const accountDisplayName = (user: { username: string, display_name?: unknown }) => typeof user.display_name === 'string' && user.display_name.trim() ? user.display_name.trim() : user.username

/** These operations expose credentials, change privileges, or destroy CRM data. */
export function crmRequiresActionAuthorization(method: string, target: string) {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false
  const path = target.split('?')[0]
  if (method === 'DELETE') return true
  if (path === '/api/crm/account' || path === '/api/crm/account/email/start') return true
  if (/^\/api\/crm\/providers(?:\/|$)/.test(path)) return !/\/(?:check|ping)$/.test(path)
  return /^\/api\/crm\/(?:websites|customers|settings|prices)(?:\/|$)/.test(path)
}

/** Production rollout intentionally requires signing in again: never trust the legacy cookie. */
export function crmSessionCookieName(config: Pick<Config, 'production'>) {
  return config.production ? '__Host-crm_session' : 'crm_session'
}

function assertCrmOrigin(request: FastifyRequest, config: Config) {
  const unsafe = request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS'
  const site = request.headers['sec-fetch-site']
  const rejected = () => new ApiError(403, 'origin_rejected', 'Vui lòng thực hiện thao tác từ trang CRM.')
  if (site === 'cross-site' || (unsafe && site === 'same-site')) throw rejected()
  // Never trust Host / X-Forwarded-Host to decide which origin may modify CRM.
  // Header-less non-browser clients remain supported; writes still need CSRF.
  const origin = request.headers.origin
  if (origin !== undefined && (typeof origin !== 'string' || origin !== config.origin)) throw rejected()
  if (unsafe && origin === undefined && request.headers.referer !== undefined) {
    try { if (new URL(String(request.headers.referer)).origin !== config.origin) throw rejected() } catch { throw rejected() }
  }
}

/** Fixed short windows are shared across API replicas and never extend on failure. */
async function consumeAccountAttempt(db: Database, action: string, account: string, max: number, reply: FastifyReply) {
  const window = Math.floor(Date.now() / authWindowMs)
  const expiresAt = new Date((window + 1) * authWindowMs)
  const buckets = collection(db, 'security_rate_limits')
  const id = `crm-${action}:${digest(account)}:${window}`
  const increment = () => buckets.findOneAndUpdate({ _id: id }, {
    $inc: { count: 1 }, $setOnInsert: { expires_at: expiresAt },
  }, { upsert: true, returnDocument: 'after' })
  let row
  try { row = await increment() } catch (error) {
    // The unique _id can race on the first request; retry instead of bypassing.
    if ((error as { code?: number }).code !== 11000) throw error
    row = await increment()
  }
  if (!row || typeof row.count !== 'number' || row.count > max) {
    reply.header('Retry-After', String(Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000))))
    throw new ApiError(429, 'rate_limit', 'Đã có quá nhiều lần xác thực. Vui lòng thử lại sau ít phút.')
  }
}

export function registerSessions(app: FastifyInstance, db: Database, config: Config, options: { sendOtp?: typeof sendCrmOtp } = {}) {
  const cookieName = crmSessionCookieName(config)
  const audience = config.origin || 'http://localhost'
  // __Host- cookies cannot carry Domain and must have Secure and Path=/, which
  // prevents sibling subdomains from replacing the CRM session cookie.
  const cookieOptions = { path: config.production ? '/' : '/api/crm', httpOnly: true, sameSite: 'strict' as const, secure: config.production || config.secureCookies }
  const sessions = new WeakMap<object, Session>()
  const rawBodies = new WeakMap<object, Buffer>()
  const loginProofs = new WeakSet<object>()
  const sendOtp = async (message: CrmOtpMessage) => (options.sendOtp ?? sendCrmOtp)({ ...config,
    mail: await resolveCrmMailConfig(db, config) }, message)
  const preauth = (request: FastifyRequest) => request.method === 'POST' && ['/api/crm/login', '/api/crm/login/verify', '/api/crm/login/resend'].includes(request.routeOptions.url || '')
  // Keep Fastify's protected JSON parsing, while signing the exact received bytes.
  // This parser is encapsulated to the CRM plugin and retains each route body limit.
  const parseJson = app.getDefaultJsonParser('error', 'error')
  app.removeContentTypeParser('application/json')
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, raw, done) => {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8')
    const text = bytes.toString('utf8')
    if (!Buffer.from(text, 'utf8').equals(bytes)) return done(new ApiError(400, 'invalid_request', 'Dữ liệu JSON phải dùng UTF-8.'))
    rawBodies.set(request, bytes)
    return parseJson(request, text, done)
  })
  let activePasswordWork = 0
  async function passwordWork<T>(reply: FastifyReply, task: () => Promise<T>): Promise<T> {
    // scrypt shares the libuv pool; reject excess work without an unbounded queue.
    if (activePasswordWork >= 2) {
      reply.header('Retry-After', '2')
      throw new ApiError(503, 'authentication_busy', 'Xác thực đang bận. Vui lòng thử lại sau.')
    }
    activePasswordWork++
    try { return await task() } finally { activePasswordWork-- }
  }
  async function newSession(source: MongoSource, userId: string, passwordHash: string, browserKey: BrowserPublicKey, remember = false, emailRevision = 0) {
    const token = issueToken(); const csrfToken = issueToken(); const browserBinding = issueToken()
    const now = new Date()
    await collection(source, 'sessions').insertOne({
      _id: digest(token), token_hash: digest(token), user_id: userId, csrf_token: csrfToken,
      credential_version: digest(passwordHash), expires_at: new Date(now.getTime() + (remember ? rememberedMaxAge : sessionMaxAge) * 1000),
      browser_public_key: browserKey, browser_binding: browserBinding, last_active_at: now,
      key_thumbprint: browserKeyThumbprint(browserKey), remember_me: remember,
      idle_timeout_ms: remember ? rememberedIdleMs : sessionIdleMs, email_revision: emailRevision,
    }, { session: sessionOf(source) })
    return { token, csrfToken, browserBinding }
  }
  function sessionResponse(reply: FastifyReply, username: string, displayName: string, token: string, csrfToken: string, browserBinding: string, remember = false) { return reply.setCookie(cookieName, token, { ...cookieOptions, ...(remember ? { maxAge: rememberedMaxAge } : {}) }).send({ username, display_name: displayName, csrf_token: csrfToken, browser_binding: browserBinding, server_time: Date.now(), remember_me: remember }) }

  async function admitProof(request: FastifyRequest, key: BrowserPublicKey, binding: string) {
    const proof = verifyBrowserProof(request.headers['x-crm-proof'], key, {
      audience, method: request.method, target: request.raw.url!, binding,
      bodyHash: browserBodyHash(rawBodies.get(request) || Buffer.alloc(0)), idempotencyKey: String(request.headers['idempotency-key'] || ''),
    })
    try {
      await collection(db, 'crm_request_proofs').insertOne({ _id: digest(`${binding}:${proof.jti}`), expires_at: proof.expiresAt }, { writeConcern: { w: 'majority' } })
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ApiError(401, 'browser_proof_replayed', 'Yêu cầu bảo mật này đã được sử dụng.')
      throw new ApiError(503, 'browser_proof_unavailable', 'Không thể xác thực yêu cầu lúc này. Vui lòng thử lại.')
    }
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    assertCrmOrigin(request, config)
    const hasBody = request.headers['transfer-encoding'] !== undefined || Number(request.headers['content-length'] || 0) > 0
    if ((request.method === 'GET' || request.method === 'HEAD') && hasBody) throw new ApiError(400, 'invalid_request', 'Yêu cầu này không được chứa nội dung.')
    if (hasBody) {
      const contentType = String(request.headers['content-type'] || '')
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
        throw new ApiError(415, 'unsupported_media_type', 'CRM chỉ chấp nhận dữ liệu JSON UTF-8.')
      }
    }
    if (preauth(request)) return
    const token = request.cookies[cookieName]
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw sessionRequired()
    const now = new Date()
    const row = await collection(db, 'sessions').findOne({ _id: digest(token), expires_at: { $gt: now } })
    if (!row || !(row.last_active_at instanceof Date) || row.last_active_at.getTime() <= now.getTime() - idleTimeout(row)) throw sessionRequired()
    let browserKey: BrowserPublicKey
    try {
      browserKey = parseBrowserPublicKey(row.browser_public_key)
      if (typeof row.browser_binding !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(row.browser_binding)) throw sessionRequired()
    } catch { throw sessionRequired() }
    const user = await collection(db, 'users').findOne({ _id: row.user_id })
    if (!user || (row.credential_version && (!user.password_hash || row.credential_version !== digest(user.password_hash))) || (row.email_revision ?? 0) !== (user.email_revision ?? 0)) throw sessionRequired()
    const session = { user_id: user._id, username: user.username, display_name: accountDisplayName(user), csrf_token: row.csrf_token, id: row._id,
      browser_public_key: browserKey, browser_binding: row.browser_binding, remember_me: row.remember_me === true }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const provided = Buffer.from(String(request.headers['x-csrf-token'] ?? '')); const expected = Buffer.from(session.csrf_token)
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new ApiError(403, 'csrf_invalid', 'Phiên bảo mật đã thay đổi. Hãy tải lại trang.')
    }
    sessions.set(request, session)
  })
  app.addHook('preValidation', async request => {
    if (preauth(request)) {
      if (request.routeOptions.url === '/api/crm/login') {
        const fields = loginSchema.parse(request.body)
        const key = parseBrowserPublicKey(fields.browser_public_key)
        // Unsigned clients may request an OTP, but may never claim device trust.
        if (request.headers['x-crm-proof']) { await admitProof(request, key, browserKeyThumbprint(key)); loginProofs.add(request) }
      } else {
        const { challenge_id } = challengeSchema.passthrough().parse(request.body)
        const challenge = await collection(db, 'crm_login_challenges').findOne({ _id: digest(challenge_id), expires_at: { $gt: new Date() } })
        if (!challenge) throw new ApiError(400, 'otp_expired', 'Mã xác thực đã hết hạn hoặc đã được sử dụng. Hãy đăng nhập lại.')
        await admitProof(request, parseBrowserPublicKey(challenge.browser_public_key), challenge_id)
      }
      return
    }
    if (request.method === 'GET' && request.routeOptions.url === '/api/crm/session/bootstrap') return
    const current = sessions.get(request)!
    const bodyHash = browserBodyHash(rawBodies.get(request) || Buffer.alloc(0))
    const proof = verifyBrowserProof(request.headers['x-crm-proof'], current.browser_public_key, {
      audience, method: request.method, target: request.raw.url!, bodyHash,
      binding: current.browser_binding, idempotencyKey: String(request.headers['idempotency-key'] || ''),
    })
    try {
      await collection(db, 'crm_request_proofs').insertOne({
        _id: digest(`${current.browser_binding}:${proof.jti}`), expires_at: proof.expiresAt,
      }, { writeConcern: { w: 'majority' } })
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new ApiError(401, 'browser_proof_replayed', 'Yêu cầu bảo mật này đã được sử dụng.')
      throw new ApiError(503, 'browser_proof_unavailable', 'Không thể xác thực yêu cầu lúc này. Vui lòng thử lại.')
    }
    // Check inactivity again atomically: an unsigned/invalid proof never extends
    // a session and a request cannot revive a session that just expired.
    const now = new Date()
    const touched = await collection(db, 'sessions').updateOne({
      _id: current.id, browser_binding: current.browser_binding,
      expires_at: { $gt: now }, last_active_at: { $gt: new Date(now.getTime() - (current.remember_me ? rememberedIdleMs : sessionIdleMs)) },
    }, { $max: { last_active_at: now } })
    if (!touched.matchedCount) throw sessionRequired()
    // Route matching may decode path characters. Classify the canonical route
    // template, while proof and action scope still bind the exact incoming URL.
    // Unknown routes have no handler; conservatively gate their raw spelling.
    if (!crmRequiresActionAuthorization(request.method, request.routeOptions.url || request.raw.url!)) return
    const actionToken = request.headers['x-crm-action-token']
    const required = () => new ApiError(403, 'reauthentication_required', 'Vui lòng xác nhận mật khẩu cho thao tác này.')
    if (typeof actionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(actionToken)) throw required()
    const authorized = await collection(db, 'crm_action_tokens').findOneAndDelete({
      _id: digest(actionToken), session_id: current.id, method: request.method,
      target: request.raw.url!, body_hash: bodyHash, expires_at: { $gt: new Date() },
    }, { writeConcern: { w: 'majority' } })
    if (!authorized) throw required()
  })
  app.post('/login', { bodyLimit: 8 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { username, password, browser_public_key: suppliedKey, remember_me } = loginSchema.parse(request.body)
    const browserKey = parseBrowserPublicKey(suppliedKey)
    await consumeAccountAttempt(db, 'login', username, 10, reply)
    const user = await collection<{ _id: string, password_hash: string }>(db, 'users').findOne({ username })
    const valid = await passwordWork(reply, () => verifyPassword(password, user?.password_hash ?? passwordPlaceholder))
    if (!user || !valid) throw invalidLogin()
    if (!verifiedAccountEmail(user)) throw new ApiError(403, 'account_email_setup_required', 'Tài khoản chưa có email nhận OTP đã xác minh. Hãy cập nhật email từ phiên CRM hiện tại hoặc liên hệ quản trị viên để cấu hình email tài khoản.')
    const thumbprint = browserKeyThumbprint(browserKey)
    const trusted = loginProofs.has(request) && await collection(db, 'crm_trusted_devices').findOne({
      _id: digest(`${user._id}:${thumbprint}`), user_id: user._id, key_thumbprint: thumbprint,
      credential_version: digest(user.password_hash), email_revision: user.email_revision ?? 0, expires_at: { $gt: new Date() },
    })
    if (trusted) {
      const session = await transaction(db, async source => {
        const tx = { session: sessionOf(source) }
        const updated = await collection(source, 'users').updateOne({ _id: user._id, password_hash: user.password_hash, email: user.email, email_revision: emailRevisionFilter(user) }, { $inc: { auth_revision: 1 } }, tx)
        if (!updated.matchedCount) throw invalidLogin()
        const admitted = await collection(source, 'crm_trusted_devices').updateOne({ _id: trusted._id, credential_version: digest(user.password_hash), email_revision: user.email_revision ?? 0, expires_at: { $gt: new Date() } }, { $set: { last_used_at: new Date() } }, tx)
        if (!admitted.matchedCount) throw invalidLogin()
        const previous = request.cookies[cookieName]
        if (previous && /^[A-Za-z0-9_-]{43}$/.test(previous)) await collection(source, 'sessions').deleteOne({ _id: digest(previous) }, tx)
        return newSession(source, user._id, user.password_hash, browserKey, remember_me, user.email_revision ?? 0)
      })
      return sessionResponse(reply, username, accountDisplayName(user), session.token, session.csrfToken, session.browserBinding, remember_me)
    }
    await consumeAccountAttempt(db, 'otp-send', user._id, 5, reply)
    const id = issueToken(); const code = createOtp(); const now = new Date()
    await transaction(db, async source => {
      const options = { session: sessionOf(source) }
      const updated = await collection(source, 'users').updateOne({ _id: user._id, password_hash: user.password_hash, email: user.email, email_revision: emailRevisionFilter(user) }, { $inc: { auth_revision: 1 } }, options)
      if (!updated.matchedCount) throw invalidLogin()
      const recent = await collection(source, 'crm_login_challenges').findOne({ user_id: user._id, last_sent_at: { $gt: new Date(now.getTime() - otpResendMs) } }, options)
      if (recent) {
        reply.header('Retry-After', String(Math.max(1, Math.ceil((recent.last_sent_at.getTime() + otpResendMs - now.getTime()) / 1000))))
        throw new ApiError(429, 'otp_resend_limited', 'Vui lòng chờ một phút trước khi gửi lại mã OTP.')
      }
      await collection(source, 'crm_login_challenges').insertOne({
        _id: digest(id), user_id: user._id, email: user.email, email_revision: user.email_revision ?? 0,
        credential_version: digest(user.password_hash), browser_public_key: browserKey,
        key_thumbprint: thumbprint, remember_me, code_hash: otpHash(config, id, 'login', code),
        attempts: 0, send_revision: 0, last_sent_at: now, expires_at: new Date(now.getTime() + otpLifetimeMs),
        previous_session_id: request.cookies[cookieName] && /^[A-Za-z0-9_-]{43}$/.test(request.cookies[cookieName]) ? digest(request.cookies[cookieName]) : null,
        label: deviceLabel(request),
      }, options)
    })
    try { await sendOtp({ to: user.email, code, purpose: 'login' }) }
    catch (error) { await collection(db, 'crm_login_challenges').deleteOne({ _id: digest(id) }); throw error }
    return { otp_required: true, challenge_id: id, email_hint: maskEmail(user.email), expires_in: otpLifetimeMs / 1000, resend_after: otpResendMs / 1000, server_time: Date.now() }
  })
  const otpInvalid = () => new ApiError(400, 'otp_invalid', 'Mã OTP không đúng, đã hết hạn hoặc đã được sử dụng.')
  app.post('/login/verify', { bodyLimit: 8 * 1024, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const fields = otpSchema.parse(request.body)
    const challenges = collection(db, 'crm_login_challenges')
    // Increment before comparison, shared by all replicas and concurrent callers.
    const challenge = await challenges.findOneAndUpdate({ _id: digest(fields.challenge_id), expires_at: { $gt: new Date() }, attempts: { $lt: otpAttemptLimit } }, { $inc: { attempts: 1 } }, { returnDocument: 'after' })
    if (!challenge) throw otpInvalid()
    await consumeAccountAttempt(db, 'otp-verify', challenge.user_id, 20, reply)
    if (!otpMatches(challenge.code_hash, otpHash(config, fields.challenge_id, 'login', fields.code))) throw otpInvalid()
    const result = await transaction(db, async source => {
      const tx = { session: sessionOf(source) }
      const user = await collection(source, 'users').findOne({ _id: challenge.user_id }, tx)
      if (!user || digest(user.password_hash) !== challenge.credential_version || verifiedAccountEmail(user) !== challenge.email || (user.email_revision ?? 0) !== challenge.email_revision) throw otpInvalid()
      const updated = await collection(source, 'users').updateOne({ _id: user._id, password_hash: user.password_hash, email: user.email, email_revision: emailRevisionFilter(user) }, { $inc: { auth_revision: 1 } }, tx)
      if (!updated.matchedCount) throw otpInvalid()
      const consumed = await collection(source, 'crm_login_challenges').findOneAndDelete({ _id: challenge._id, code_hash: challenge.code_hash, send_revision: challenge.send_revision, expires_at: { $gt: new Date() }, attempts: { $lte: otpAttemptLimit } }, tx)
      if (!consumed) throw otpInvalid()
      if (fields.trust_device) {
        const now = new Date()
        await collection(source, 'crm_trusted_devices').updateOne({ _id: digest(`${user._id}:${challenge.key_thumbprint}`) }, { $set: {
          user_id: user._id, key_thumbprint: challenge.key_thumbprint, label: challenge.label,
          credential_version: digest(user.password_hash), email_revision: user.email_revision ?? 0,
          last_used_at: now, expires_at: new Date(now.getTime() + trustedDeviceLifetimeMs),
        }, $setOnInsert: { created_at: now } }, { ...tx, upsert: true })
      }
      if (challenge.previous_session_id) await collection(source, 'sessions').deleteOne({ _id: challenge.previous_session_id }, tx)
      return { username: user.username, display_name: accountDisplayName(user), session: await newSession(source, user._id, user.password_hash, parseBrowserPublicKey(challenge.browser_public_key), challenge.remember_me, user.email_revision ?? 0) }
    })
    return sessionResponse(reply, result.username, result.display_name, result.session.token, result.session.csrfToken, result.session.browserBinding, challenge.remember_me)
  })
  app.post('/login/resend', { bodyLimit: 4 * 1024, config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const { challenge_id } = challengeSchema.parse(request.body)
    const now = new Date()
    const challenge = await collection(db, 'crm_login_challenges').findOne({ _id: digest(challenge_id), expires_at: { $gt: now }, attempts: { $lt: otpAttemptLimit } })
    if (!challenge) throw otpInvalid()
    await consumeAccountAttempt(db, 'otp-send', challenge.user_id, 5, reply)
    const code = createOtp(); const codeHash = otpHash(config, challenge_id, 'login', code)
    await transaction(db, async source => {
      const tx = { session: sessionOf(source) }
      const user = await collection(source, 'users').findOne({ _id: challenge.user_id }, tx)
      if (!user || digest(user.password_hash) !== challenge.credential_version || verifiedAccountEmail(user) !== challenge.email || (user.email_revision ?? 0) !== challenge.email_revision) throw otpInvalid()
      const updated = await collection(source, 'users').updateOne({ _id: user._id, password_hash: user.password_hash, email: user.email, email_revision: emailRevisionFilter(user) }, { $inc: { auth_revision: 1 } }, tx)
      if (!updated.matchedCount) throw otpInvalid()
      // Share the user lock with fresh logins so switching challenges cannot
      // evade the email cooldown, including requests on different replicas.
      const recent = await collection(source, 'crm_login_challenges').findOne({ user_id: user._id, last_sent_at: { $gt: new Date(now.getTime() - otpResendMs) } }, tx)
      if (recent) {
        reply.header('Retry-After', String(Math.max(1, Math.ceil((recent.last_sent_at.getTime() + otpResendMs - now.getTime()) / 1000))))
        throw new ApiError(429, 'otp_resend_limited', 'Vui lòng chờ một phút trước khi gửi lại mã OTP.')
      }
      const claimed = await collection(source, 'crm_login_challenges').updateOne({ _id: challenge._id, code_hash: challenge.code_hash, send_revision: challenge.send_revision, expires_at: { $gt: new Date() }, attempts: { $lt: otpAttemptLimit } }, { $set: { code_hash: codeHash, last_sent_at: now }, $inc: { send_revision: 1 } }, tx)
      if (!claimed.matchedCount) throw otpInvalid()
    })
    try { await sendOtp({ to: challenge.email, code, purpose: 'login' }) }
    catch (error) { await collection(db, 'crm_login_challenges').deleteOne({ _id: challenge._id, code_hash: codeHash }); throw error }
    return { otp_required: true, challenge_id, email_hint: maskEmail(challenge.email), expires_in: Math.max(0, Math.floor((challenge.expires_at.getTime() - Date.now()) / 1000)), resend_after: otpResendMs / 1000, server_time: Date.now() }
  })
  app.get('/session/bootstrap', async request => ({ browser_binding: sessions.get(request)!.browser_binding, server_time: Date.now() }))
  app.get('/session', async request => {
    const { username, display_name, csrf_token, remember_me } = sessions.get(request)!
    return { username, display_name, csrf_token, remember_me }
  })
  app.post('/session/authorize', { bodyLimit: 8 * 1024, config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const fields = actionSchema.parse(request.body); const current = sessions.get(request)!
    await consumeAccountAttempt(db, 'password', current.user_id, 5, reply)
    const user = await collection<{ password_hash: string }>(db, 'users').findOne({ _id: current.user_id })
    await passwordWork(reply, async () => {
      if (!user || !(await verifyPassword(fields.current_password, user.password_hash))) throw new ApiError(400, 'invalid_password', 'Mật khẩu hiện tại không đúng.')
    })
    const actionToken = issueToken()
    await transaction(db, async source => {
      const options = { session: sessionOf(source) }
      // Serialize password verification with a concurrent credential replacement;
      // a password accepted before that replacement cannot authorize a new action.
      const updated = await collection(source, 'users').updateOne({ _id: current.user_id, password_hash: user!.password_hash, email_revision: emailRevisionFilter(user!) }, { $inc: { auth_revision: 1 } }, options)
      if (!updated.matchedCount) throw sessionRequired()
      const now = new Date()
      const alive = await collection(source, 'sessions').updateOne({ _id: current.id, browser_binding: current.browser_binding,
        credential_version: digest(user!.password_hash), expires_at: { $gt: now }, last_active_at: { $gt: new Date(now.getTime() - (current.remember_me ? rememberedIdleMs : sessionIdleMs)) } }, { $max: { last_active_at: now } }, options)
      if (!alive.matchedCount) throw sessionRequired()
      await collection(source, 'crm_action_tokens').insertOne({
        _id: digest(actionToken), session_id: current.id, method: fields.method,
        target: fields.target, body_hash: fields.body_hash, expires_at: new Date(Date.now() + actionMaxAgeMs),
      }, options)
    })
    return { action_token: actionToken, expires_in: actionMaxAgeMs / 1_000 }
  })
  app.post('/logout', async (request, reply) => { await collection(db, 'sessions').deleteOne({ _id: digest(request.cookies[cookieName]!) }); return reply.clearCookie(cookieName, cookieOptions).code(204).send() })
  app.post('/password', { bodyLimit: 8 * 1024, config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const fields = passwordSchema.parse(request.body); const current = sessions.get(request)!
    await consumeAccountAttempt(db, 'password', current.user_id, 5, reply)
    const user = await collection<{ password_hash: string }>(db, 'users').findOne({ _id: current.user_id })
    const passwordHash = await passwordWork(reply, async () => {
      if (!user || !(await verifyPassword(fields.current_password, user.password_hash))) throw new ApiError(400, 'invalid_password', 'Mật khẩu hiện tại không đúng.')
      return hashPassword(fields.new_password)
    })
    const session = await transaction(db, async source => {
      const options = { session: sessionOf(source) }
      const updated = await collection(source, 'users').updateOne({ _id: current.user_id, password_hash: user!.password_hash, email_revision: emailRevisionFilter(user!) }, { $set: { password_hash: passwordHash }, $inc: { auth_revision: 1 } }, options)
      if (!updated.matchedCount) throw sessionRequired()
      // Touch the existing session so logout/revocation conflicts with this transaction.
      // A read alone could observe a stale snapshot and recreate a revoked session.
      const now = new Date()
      const alive = await collection(source, 'sessions').updateOne({ _id: current.id, user_id: current.user_id,
        browser_binding: current.browser_binding, credential_version: digest(user!.password_hash),
        expires_at: { $gt: now }, last_active_at: { $gt: new Date(now.getTime() - (current.remember_me ? rememberedIdleMs : sessionIdleMs)) },
      }, { $max: { last_active_at: now } }, options)
      if (!alive.matchedCount) throw sessionRequired()
      await collection(source, 'sessions').deleteMany({ user_id: current.user_id }, options)
      await collection(source, 'crm_trusted_devices').deleteMany({ user_id: current.user_id }, options)
      await collection(source, 'crm_login_challenges').deleteMany({ user_id: current.user_id }, options)
      await collection(source, 'crm_email_challenges').deleteMany({ user_id: current.user_id }, options)
      return newSession(source, current.user_id, passwordHash, current.browser_public_key, current.remember_me, user!.email_revision ?? 0)
    })
    return sessionResponse(reply, current.username, current.display_name, session.token, session.csrfToken, session.browserBinding, current.remember_me)
  })
  registerCrmAccount(app, db, config, { sessions, sendOtp, consumeAttempt: (action, account, max, reply) => consumeAccountAttempt(db, action, account, max, reply) })
}

function deviceLabel(request: FastifyRequest): string {
  const ua = String(request.headers['user-agent'] || '')
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Trình duyệt'
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Macintosh|Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Thiết bị'
  return `${browser} · ${os}`
}
// @ts-nocheck
