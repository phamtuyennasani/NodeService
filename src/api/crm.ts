import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Database } from '../db.js'
import { registerCustomers } from './crm-customers.js'
import { registerPrices } from './crm-prices.js'
import { registerProviders } from './crm-providers.js'
import { registerReports } from './crm-reports.js'
import { registerSessions } from './crm-session.js'

export function registerCrm(app: FastifyInstance, db: Database, config: Config) {
  registerSessions(app, db, config)
  registerCustomers(app, db, config)
  registerReports(app, db)
  registerProviders(app, db, config)
  registerPrices(app, db, config)
}
