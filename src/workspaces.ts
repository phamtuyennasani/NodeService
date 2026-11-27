import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { Config } from './config.js'
import { collection, rootDatabase, type Database, type TransactionContext } from './db.js'
import { digest } from './security.js'
import { ApiError } from './api/errors.js'
import { resolveCrmMailConfig } from './smtp-settings.js'

export type Partner = {
  _id: string
  name: string
  enabled: boolean
  created_at: Date
  updated_at: Date
}
export type AccountAccess = {
  role: 'root' | 'provider'
  partner: { id: string, name: string } | null
}
const partnerIdSchema = z.uuid()
const databases = new WeakMap<Database, Map<string, Database>>()

/** One database per partner keeps joins, transactions and indexes within the group. */
export function partnerDatabase(root: Database, partnerId: string): Database {
  root = rootDatabase(root)
  partnerIdSchema.parse(partnerId)
  let cache = databases.get(root)
  if (!cache) { cache = new Map(); databases.set(root, cache) }
  let db = cache.get(partnerId)
  if (!db) {
    const key = createHash('sha256').update(JSON.stringify([root.db.databaseName, partnerId])).digest('hex').slice(0, 32)
    const name = `crm_p_${key}`
    db = { client: root.client, db: root.client.db(name), root, partnerId }
    cache.set(partnerId, db)
  }
  return db
}

export function partnerConfig(config: Config): Config {
  return { ...config, serviceKeys: { openai: undefined, anthropic: undefined, xai: undefined, 'openai-compatible': undefined }, mail: undefined }
}

export async function accountAccess(root: Database, user: Record<string, any>): Promise<AccountAccess> {
  if (user.enabled === false) throw new ApiError(403, 'account_disabled', 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.')
  if (user.role === 'root' || user.role === undefined) return { role: 'root', partner: null }
  if (user.role !== 'provider' || !partnerIdSchema.safeParse(user.partner_id).success) {
    throw new ApiError(403, 'account_access_denied', 'Tài khoản chưa được cấp quyền truy cập CRM.')
  }
  const partner = await collection<Partner>(root, 'partners').findOne({ _id: user.partner_id, enabled: true })
  if (!partner) throw new ApiError(403, 'partner_disabled', 'Nhóm đối tác đã bị khóa. Vui lòng liên hệ quản trị viên.')
  return { role: 'provider', partner: { id: partner._id, name: partner.name } }
}

type RequestScope = { database: Database, config: Config, accountDatabase: Database }

/** Authentication uses the control database. Business handlers use this request's group. */
export function createWorkspaceAccess(root: Database, base: Config) {
  const context = new AsyncLocalStorage<RequestScope>()
  const isolatedConfig = partnerConfig(base)
  const current = () => context.getStore()
  const database: Database = {
    client: root.client,
    get db() { return current()?.database.db ?? root.db },
    resolve: () => current()?.database ?? root,
  }
  const config = new Proxy(base, {
    get: (_target, property) => Reflect.get(current()?.config ?? base, property),
  })
  function select(db: Database) {
    const scope = current()
    if (!scope) throw new Error('Workspace request context is missing')
    scope.database = db
    scope.config = db.partnerId ? isolatedConfig : base
  }
  async function identify(user: Record<string, any>) {
    const access = await accountAccess(root, user)
    const scope = current()
    if (scope) scope.accountDatabase = access.partner ? partnerDatabase(root, access.partner.id) : root
    return access
  }
  return {
    database, config,
    install(app: FastifyInstance) {
      app.addHook('onRequest', (_request, _reply, done) => {
        context.run({ database: root, config: base, accountDatabase: root }, done)
      })
    },
    identify,
    async authorize(request: FastifyRequest, user: Record<string, any>) {
      const access = await identify(user)
      const query = new URL(request.raw.url!, 'http://crm.local').searchParams
      const requested = query.get('workspace')
      if (query.getAll('workspace').length > 1) throw new ApiError(400, 'invalid_workspace', 'Chỉ chọn một nhóm quản lý.')
      if (access.role === 'provider' && requested && requested !== access.partner!.id) {
        throw new ApiError(403, 'workspace_forbidden', 'Bạn chỉ được quản lý nhóm đối tác của mình.')
      }
      const id = requested && requested !== 'root' ? partnerIdSchema.parse(requested) : access.partner?.id
      if (id) {
        const partner = await collection<Partner>(root, 'partners').findOne({ _id: id })
        if (!partner || (access.role !== 'root' && !partner.enabled)) throw new ApiError(404, 'workspace_not_found', 'Không tìm thấy nhóm đối tác.')
        select(partnerDatabase(root, id))
      }
      // The proof still signs the original URL, including the selected workspace.
      if (request.query && typeof request.query === 'object') delete (request.query as Record<string, unknown>).workspace
      return access
    },
    async mailConfig() {
      const db = current()?.accountDatabase ?? root
      if (db.partnerId) {
        const mail = await resolveCrmMailConfig(db, isolatedConfig)
        if (mail) return mail
      }
      // The system sender bootstraps OTP for a newly provisioned partner.
      return resolveCrmMailConfig(root, base)
    },
    async routePublic(request: FastifyRequest) {
      const path = request.raw.url!.split('?')[0]
      if (!path.startsWith('/v1/')) return
      const widget = path.match(/^\/v1\/widget\/([^/]+)\//)
      const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{16,256})$/i)
      const filter = widget ? { _id: decodeURIComponent(widget[1]) } : token ? { token_hash: digest(token[1]) } : null
      if (!filter) return
      const route = await collection(root, 'partner_sites').findOne(filter)
      if (!route) return
      const partner = await collection<Partner>(root, 'partners').findOne({ _id: route.partner_id, enabled: true })
      if (!partner) throw new ApiError(403, 'partner_disabled', 'Nhóm quản lý website đã bị khóa.')
      select(partnerDatabase(root, partner._id))
    },
  }
}

/** Routing changes commit together with the website and its token, including rotation. */
export async function writePartnerSiteRoute(source: TransactionContext, siteId: string, tokenHash?: string | null) {
  if (!source.partnerId || !source.root) return
  const routes = collection(source.root, 'partner_sites')
  await routes.updateOne({ _id: siteId, partner_id: source.partnerId }, {
    $set: { partner_id: source.partnerId, ...(typeof tokenHash === 'string' ? { token_hash: tokenHash } : {}) },
    ...(tokenHash === null ? { $unset: { token_hash: '' } } : {}),
  }, { upsert: true, session: source.session })
}

export async function deletePartnerSiteRoute(source: TransactionContext, siteId: string) {
  if (!source.partnerId || !source.root) return
  await collection(source.root, 'partner_sites').deleteOne({ _id: siteId, partner_id: source.partnerId }, { session: source.session })
}
