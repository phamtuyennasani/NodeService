import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { collection, transaction, type Database, type TransactionContext } from '../db.js'
import { hashPassword } from '../security.js'
import { partnerDatabase, type Partner } from '../workspaces.js'
import { initializePartner } from '../partner-runtime.js'
import { ApiError, idSchema, notFound } from './errors.js'
import type { CrmSession } from './crm-session.js'

const nameField = z.string().trim().min(1).max(160)
const passwordField = z.string().min(12).max(256)
const createFields = z.object({
  name: nameField,
  username: z.string().trim().toLowerCase().regex(/^[\w.@-]{3,100}$/),
  email: z.email().trim().toLowerCase().max(254),
  password: passwordField,
}).strict()
const patchFields = z.object({ name: nameField.optional(), enabled: z.boolean().optional() }).strict()
const params = z.object({ id: idSchema })

export function registerPartners(app: FastifyInstance, root: Database, config: Config,
  sessions: WeakMap<object, CrmSession>, initialize = initializePartner) {
  function requireRoot(request: FastifyRequest) {
    if (sessions.get(request)?.role !== 'root') throw new ApiError(403, 'root_required', 'Chỉ root được quản lý tài khoản đối tác.')
  }
  app.get('/partners', async request => {
    requireRoot(request)
    const partners = await collection<Partner>(root, 'partners').find({}).sort({ name: 1, _id: 1 }).toArray()
    const accounts = await collection(root, 'users').find({ role: 'provider' }, {
      projection: { partner_id: 1, username: 1, email: 1 },
    }).toArray()
    const data: Record<string, unknown>[] = []
    for (const partner of partners) {
      const db = partnerDatabase(root, partner._id)
      const account = accounts.find(user => user.partner_id === partner._id)
      const [customers, websites, articles] = await Promise.all([
        collection(db, 'customers').countDocuments({}),
        collection(db, 'sites').countDocuments({}),
        collection(db, 'jobs').countDocuments({ status: 'ready' }),
      ])
      data.push({ id: partner._id, name: partner.name, enabled: partner.enabled,
        username: account?.username ?? '', email: account?.email ?? '',
        customer_count: customers, website_count: websites, article_count: articles,
        created_at: partner.created_at, updated_at: partner.updated_at })
    }
    return { data }
  })
  app.post('/partners', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    requireRoot(request)
    const fields = createFields.parse(request.body)
    if (await collection(root, 'users').findOne({ $or: [{ username: fields.username }, { email: fields.email }] })) {
      throw new ApiError(409, 'account_exists', 'Tên đăng nhập hoặc email đã được sử dụng.')
    }
    const id = randomUUID()
    const passwordHash = await hashPassword(fields.password)
    const database = partnerDatabase(root, id)
    try { await initialize(database, config, true) }
    catch (error) {
      // This new group has not been published or made available to workers.
      await database.db.dropDatabase().catch(() => undefined)
      throw error
    }
    const now = new Date()
    try {
      await transaction(root, async source => {
        const options = { session: source.session }
        await collection(source, 'partners').insertOne({ _id: id, name: fields.name, enabled: true, created_at: now, updated_at: now }, options)
        await collection(source, 'users').insertOne({
          _id: randomUUID(), username: fields.username, display_name: fields.name,
          role: 'provider', partner_id: id, enabled: true, password_hash: passwordHash,
          email: fields.email, email_verified_at: now, email_revision: 1, created_at: now,
        }, options)
      })
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        // A competing account creation can win after our preliminary lookup.
        // Only clean up a definitively aborted transaction, never an uncertain commit.
        await database.db.dropDatabase().catch(() => undefined)
        throw new ApiError(409, 'account_exists', 'Tên đăng nhập hoặc email đã được sử dụng.')
      }
      throw error
    }
    return reply.code(201).send({ id, name: fields.name, username: fields.username, email: fields.email, enabled: true })
  })
  app.patch('/partners/:id', async request => {
    requireRoot(request)
    const { id } = params.parse(request.params)
    const fields = patchFields.parse(request.body)
    if (!Object.keys(fields).length) throw new ApiError(400, 'invalid_request', 'Chọn thông tin cần cập nhật.')
    await transaction(root, async source => {
      const options = { session: source.session }
      const updated = await collection(source, 'partners').updateOne({ _id: id }, { $set: { ...fields, updated_at: new Date() } }, options)
      if (!updated.matchedCount) throw notFound()
      if (fields.enabled === false) {
        const users = await collection(source, 'users').find({ partner_id: id, role: 'provider' }, options).toArray()
        for (const user of users) {
          // User locking also prevents a concurrent login/password rotation from reviving a session.
          await collection(source, 'users').updateOne({ _id: user._id }, { $inc: { auth_revision: 1 } }, options)
          await revokePartnerSessions(source, user._id)
        }
      }
    })
    return { id, ...fields }
  })
  app.post('/partners/:id/password', { bodyLimit: 4 * 1024 }, async (request, reply) => {
    requireRoot(request)
    const { id } = params.parse(request.params)
    const { password } = z.object({ password: passwordField }).strict().parse(request.body)
    const passwordHash = await hashPassword(password)
    await transaction(root, async source => {
      const options = { session: source.session }
      const user = await collection(source, 'users').findOneAndUpdate({ partner_id: id, role: 'provider' }, {
        $set: { password_hash: passwordHash, updated_at: new Date() }, $inc: { auth_revision: 1 },
      }, { ...options, returnDocument: 'after' })
      if (!user) throw notFound()
      await revokePartnerSessions(source, user._id)
    })
    return reply.code(204).send()
  })
}

async function revokePartnerSessions(source: TransactionContext, userId: string) {
  for (const name of ['sessions', 'crm_trusted_devices', 'crm_login_challenges', 'crm_email_challenges']) {
    await collection(source, name).deleteMany({ user_id: userId }, { session: source.session })
  }
}
