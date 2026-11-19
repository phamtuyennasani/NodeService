import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { Config } from '../config.js'
import { transaction, type Database } from '../db.js'
import { digest, hashPassword, issueToken, verifyPassword } from '../security.js'
import { ApiError } from './errors.js'

const cookieName = 'crm_session'
const sessionMaxAge = 60 * 60 * 12
const invalidLogin = () => new ApiError(401, 'invalid_login', 'Tên đăng nhập hoặc mật khẩu không đúng.')
const sessionRequired = () => new ApiError(401, 'session_required', 'Vui lòng đăng nhập để tiếp tục.')
const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(120),
  password: z.string().min(1).max(256),
}).strict()
const passwordSchema = z.object({
  current_password: loginSchema.shape.password,
  new_password: z.string().min(12).max(256),
}).strict()
const passwordPlaceholder = 'Y2Fubm90IGxvZyBpbiB3aXRoIHRoaXM=' + '.' + Buffer.alloc(64).toString('base64url')
type Session = { user_id: string, username: string, csrf_token: string }

export function registerSessions(app: FastifyInstance, db: Database, config: Config) {
  const cookieOptions = { path: '/api/crm', httpOnly: true, sameSite: 'strict' as const, secure: config.secureCookies }
  const sessions = new WeakMap<object, Session>()

  async function newSession(client: PoolClient, userId: string) {
    const token = issueToken()
    const csrfToken = issueToken()
    await client.query(`
      INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,now()+$4::int*interval '1 second')
    `, [digest(token), userId, csrfToken, sessionMaxAge])
    return { token, csrfToken }
  }

  function sessionResponse(reply: FastifyReply, username: string, token: string, csrfToken: string) {
    return reply
      .setCookie(cookieName, token, { ...cookieOptions, maxAge: sessionMaxAge })
      .send({ username, csrf_token: csrfToken })
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (request.method === 'POST' && request.routeOptions.url === '/api/crm/login') return
    const token = request.cookies[cookieName]
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw sessionRequired()
    const { rows: [session] } = await db.query<Session>(`
      SELECT s.user_id,u.username,s.csrf_token FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=$1 AND s.expires_at>now()
    `, [digest(token)])
    if (!session) throw sessionRequired()
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const provided = Buffer.from(String(request.headers['x-csrf-token'] ?? ''))
      const expected = Buffer.from(session.csrf_token)
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        throw new ApiError(403, 'csrf_invalid', 'Phiên bảo mật đã thay đổi. Hãy tải lại trang.')
      }
    }
    sessions.set(request, session)
  })

  app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      throw new ApiError(403, 'origin_rejected', 'Vui lòng đăng nhập từ trang CRM.')
    }
    const { username, password } = loginSchema.parse(request.body)
    const { rows: [user] } = await db.query('SELECT id,password_hash FROM users WHERE username=$1', [username])
    const valid = await verifyPassword(password, user?.password_hash ?? passwordPlaceholder)
    if (!user || !valid) throw invalidLogin()
    const session = await transaction(db, async client => {
      const { rows: [currentUser] } = await client.query('SELECT password_hash FROM users WHERE id=$1 FOR UPDATE', [user.id])
      if (currentUser?.password_hash !== user.password_hash) throw invalidLogin()
      await client.query('DELETE FROM sessions WHERE expires_at<=now() OR token_hash=$1', [digest(request.cookies[cookieName] ?? '')])
      return newSession(client, user.id)
    })
    return sessionResponse(reply, username, session.token, session.csrfToken)
  })

  app.get('/session', async request => {
    const { username, csrf_token } = sessions.get(request)!
    return { username, csrf_token }
  })

  app.post('/logout', async (request, reply) => {
    await db.query('DELETE FROM sessions WHERE token_hash=$1', [digest(request.cookies[cookieName]!)])
    return reply.clearCookie(cookieName, cookieOptions).code(204).send()
  })

  app.post('/password', async (request, reply) => {
    const fields = passwordSchema.parse(request.body)
    const { user_id, username } = sessions.get(request)!
    const { rows: [user] } = await db.query('SELECT password_hash FROM users WHERE id=$1', [user_id])
    if (!user || !(await verifyPassword(fields.current_password, user.password_hash))) {
      throw new ApiError(400, 'invalid_password', 'Mật khẩu hiện tại không đúng.')
    }
    const passwordHash = await hashPassword(fields.new_password)
    const session = await transaction(db, async client => {
      const updated = await client.query('UPDATE users SET password_hash=$2 WHERE id=$1 AND password_hash=$3',
        [user_id, passwordHash, user.password_hash])
      if (!updated.rowCount) throw sessionRequired()
      await client.query('DELETE FROM sessions WHERE user_id=$1', [user_id])
      return newSession(client, user_id)
    })
    return sessionResponse(reply, username, session.token, session.csrfToken)
  })
}
