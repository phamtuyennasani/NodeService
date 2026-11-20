import { timingSafeEqual, randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { collection, transaction, type Database } from '../db.js'
import { digest, hashPassword, issueToken, verifyPassword } from '../security.js'
import { ApiError } from './errors.js'

const cookieName = 'crm_session'
const sessionMaxAge = 60 * 60 * 12
const invalidLogin = () => new ApiError(401, 'invalid_login', 'Tên đăng nhập hoặc mật khẩu không đúng.')
const sessionRequired = () => new ApiError(401, 'session_required', 'Vui lòng đăng nhập để tiếp tục.')
const loginSchema = z.object({ username: z.string().trim().toLowerCase().min(1).max(120), password: z.string().min(1).max(256) }).strict()
const passwordSchema = z.object({ current_password: loginSchema.shape.password, new_password: z.string().min(12).max(256) }).strict()
const passwordPlaceholder = 'Y2Fubm90IGxvZyBpbiB3aXRoIHRoaXM=.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
type Session = { user_id: string, username: string, csrf_token: string }

export function registerSessions(app: FastifyInstance, db: Database, config: Config) {
  const cookieOptions = { path: '/api/crm', httpOnly: true, sameSite: 'strict' as const, secure: config.secureCookies }
  const sessions = new WeakMap<object, Session>()
  async function newSession(userId: string) {
    const token = issueToken(); const csrfToken = issueToken()
    await collection(db, 'sessions').insertOne({ _id: digest(token), token_hash: digest(token), user_id: userId, csrf_token: csrfToken, expires_at: new Date(Date.now() + sessionMaxAge * 1000) })
    return { token, csrfToken }
  }
  function sessionResponse(reply: FastifyReply, username: string, token: string, csrfToken: string) { return reply.setCookie(cookieName, token, { ...cookieOptions, maxAge: sessionMaxAge }).send({ username, csrf_token: csrfToken }) }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (request.method === 'POST' && request.routeOptions.url === '/api/crm/login') return
    const token = request.cookies[cookieName]
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw sessionRequired()
    const row = await collection(db, 'sessions').findOne({ _id: digest(token), expires_at: { $gt: new Date() } })
    if (!row) throw sessionRequired()
    const user = await collection<{ _id: string, username: string }>(db, 'users').findOne({ _id: row.user_id })
    if (!user) throw sessionRequired()
    const session = { user_id: user._id, username: user.username, csrf_token: row.csrf_token }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const provided = Buffer.from(String(request.headers['x-csrf-token'] ?? '')); const expected = Buffer.from(session.csrf_token)
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new ApiError(403, 'csrf_invalid', 'Phiên bảo mật đã thay đổi. Hãy tải lại trang.')
    }
    sessions.set(request, session)
  })
  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403, 'origin_rejected', 'Vui lòng đăng nhập từ trang CRM.')
    const { username, password } = loginSchema.parse(request.body)
    const user = await collection<{ _id: string, password_hash: string }>(db, 'users').findOne({ username })
    const valid = await verifyPassword(password, user?.password_hash ?? passwordPlaceholder); if (!user || !valid) throw invalidLogin()
    await collection(db, 'sessions').deleteMany({ $or: [{ expires_at: { $lte: new Date() } }, { token_hash: digest(request.cookies[cookieName] ?? '') }] })
    const session = await newSession(user._id); return sessionResponse(reply, username, session.token, session.csrfToken)
  })
  app.get('/session', async request => sessions.get(request)!)
  app.post('/logout', async (request, reply) => { await collection(db, 'sessions').deleteOne({ _id: digest(request.cookies[cookieName]!) }); return reply.clearCookie(cookieName, cookieOptions).code(204).send() })
  app.post('/password', async (request, reply) => {
    const fields = passwordSchema.parse(request.body); const current = sessions.get(request)!; const user = await collection<{ password_hash: string }>(db, 'users').findOne({ _id: current.user_id })
    if (!user || !(await verifyPassword(fields.current_password, user.password_hash))) throw new ApiError(400, 'invalid_password', 'Mật khẩu hiện tại không đúng.')
    const passwordHash = await hashPassword(fields.new_password)
    await transaction(db, async client => { const updated = await collection(client, 'users').updateOne({ _id: current.user_id, password_hash: user.password_hash }, { $set: { password_hash: passwordHash } }); if (!updated.matchedCount) throw sessionRequired(); await collection(client, 'sessions').deleteMany({ user_id: current.user_id }) })
    const session = await newSession(current.user_id); return sessionResponse(reply, current.username, session.token, session.csrfToken)
  })
}
// @ts-nocheck
