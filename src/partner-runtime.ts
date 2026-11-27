import { setTimeout as wait } from 'node:timers/promises'
import type { Config } from './config.js'
import { collection, type Database } from './db.js'
import { migrate } from './migrate.js'
import { assertEncryptionContext } from './encryption-context.js'
import { partnerConfig, partnerDatabase, type Partner } from './workspaces.js'
import { runMaintenance } from './worker/maintenance.js'
import { runWorkers } from './worker/index.js'

export async function initializePartner(db: Database, config: Config, provision = false) {
  await migrate(db)
  await assertEncryptionContext(db, partnerConfig(config), provision)
}

export async function initializeExistingPartners(root: Database, config: Config) {
  for (const partner of await collection<Partner>(root, 'partners').find({}).toArray()) {
    await initializePartner(partnerDatabase(root, partner._id), config)
  }
}

type RunningPartner = { controller: AbortController, finished: Promise<void> }
type PartnerServiceDependencies = {
  initialize?: typeof initializePartner
  maintenance?: typeof runMaintenance
  workers?: typeof runWorkers
  pause?: (signal: AbortSignal) => Promise<unknown>
}

/** Each group's pools read its own settings. Disabling stops new claims and drains active work. */
export async function runPartnerServices(root: Database, config: Config, signal: AbortSignal, role: string, deps: PartnerServiceDependencies = {}) {
  const running = new Map<string, RunningPartner>()
  const stop = () => { for (const entry of running.values()) entry.controller.abort() }
  signal.addEventListener('abort', stop, { once: true })
  const isolatedConfig = partnerConfig(config)
  try {
    while (!signal.aborted) {
      try {
        const partners = await collection<Partner>(root, 'partners').find({ enabled: true }).toArray()
        if (signal.aborted) break
        const enabled = new Set(partners.map(partner => partner._id))
        for (const [id, entry] of running) if (!enabled.has(id)) entry.controller.abort()
        for (const partner of partners) {
          if (running.has(partner._id)) continue
          const controller = new AbortController()
          const db = partnerDatabase(root, partner._id)
          const finished = (async () => {
            const tasks: Promise<void>[] = []
            try {
              await (deps.initialize ?? initializePartner)(db, config)
              if (controller.signal.aborted) return
              tasks.push((deps.maintenance ?? runMaintenance)(db, isolatedConfig, controller.signal))
              if (role === 'all' || role === 'writer') tasks.push((deps.workers ?? runWorkers)(db, isolatedConfig, controller.signal, 'writer'))
              if (role === 'all' || role === 'webhook') tasks.push((deps.workers ?? runWorkers)(db, isolatedConfig, controller.signal, 'webhook'))
              await Promise.race(tasks)
            } catch {
              console.error('Partner services could not run', partner._id)
            } finally {
              controller.abort()
              await Promise.allSettled(tasks)
            }
          })().finally(() => { running.delete(partner._id) })
          running.set(partner._id, { controller, finished })
        }
      } catch {
        // Fail closed if the control database cannot confirm which partners are enabled.
        stop()
        console.error('Could not refresh partner service access')
      }
      await (deps.pause ? deps.pause(signal) : wait(4_000, undefined, { signal })).catch(() => undefined)
    }
  } finally {
    signal.removeEventListener('abort', stop)
    stop()
    await Promise.allSettled([...running.values()].map(entry => entry.finished))
  }
}
