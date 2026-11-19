import { setTimeout as wait } from 'node:timers/promises'
import type { Config } from '../config.js'
import type { Database } from '../db.js'
import { runWebhookOnce } from './delivery.js'
import { runWriterOnce } from './writer.js'

export { runWebhookOnce } from './delivery.js'
export { runWriterOnce } from './writer.js'

export async function runWorkers(db: Database, config: Config, signal: AbortSignal, role: 'writer' | 'webhook') {
  const runOnce = role === 'writer' ? runWriterOnce : runWebhookOnce
  const concurrency = role === 'writer' ? config.workerConcurrency : config.webhookConcurrency
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (!signal.aborted) {
      try {
        if (await runOnce(db, config)) continue
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNEXPECTED'
        console.error(role + ' worker error', code)
      }
      await wait(config.workerPollMs, undefined, { signal }).catch(() => undefined)
    }
  }))
}
