import type { FastifyInstance } from 'fastify'
import type { Config } from '../config.js'
import type { Database } from '../db.js'
import { registerCustomers } from './crm-customers.js'
import { registerPrices } from './crm-prices.js'
import { registerProviders } from './crm-providers.js'
import { registerReports } from './crm-reports.js'
import { registerCalendar } from './crm-calendar.js'
import { registerSessions } from './crm-session.js'
import { registerSettings } from './crm-settings.js'
import { effectiveConfig } from '../runtime-settings.js'
import { registerIntegrations } from './crm-integrations.js'
import { createWorkspaceAccess } from '../workspaces.js'
import { registerPartners } from './crm-partners.js'

export function registerCrm(app: FastifyInstance, root: Database, base: Config, workspaces?: ReturnType<typeof createWorkspaceAccess>) {
  const access = workspaces ?? createWorkspaceAccess(root, base)
  if (!workspaces) access.install(app)
  const sessions = registerSessions(app, root, base, access)
  registerPartners(app, root, base, sessions)
  const db = access.database
  const config = access.config
  registerIntegrations(app)
  registerCustomers(app, db, config)
  registerReports(app, db, config, () => effectiveConfig(db, config))
  registerCalendar(app, db)
  registerProviders(app, db, config)
  registerPrices(app, db, config, () => effectiveConfig(db, config))
  registerSettings(app, db, config)
}
