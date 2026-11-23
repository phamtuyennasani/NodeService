import cookie from '@fastify/cookie'
import rateLimit from '@fastify/rate-limit'
import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Database } from '../db.js'
import { registerCrm } from './crm.js'
import { installErrorHandler } from './errors.js'
import { registerPublic } from './public.js'

export async function registerApi(app: FastifyInstance, db: Database, config: Config) {
  await app.register(cookie)
  // Root admission control in request-security shields all routes (including 404s).
  // Keep this separate, bounded store for stricter endpoint-specific policies.
  await app.register(rateLimit, { global: false, cache: 10_000, skipOnError: false })
  installErrorHandler(app)
  registerPublic(app, db, config)
  await app.register(async crm => registerCrm(crm, db, config), { prefix: '/api/crm' })
}
