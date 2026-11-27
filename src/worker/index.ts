import { setTimeout as wait } from 'node:timers/promises'
import type { Config } from '../config.js'
import type { Database } from '../db.js'
import { effectiveConfig } from '../runtime-settings.js'
import { assertEncryptionContext } from '../encryption-context.js'
import { runWebhookOnce } from './delivery.js'
import { startWorkerHeartbeat, type WorkerHeartbeat, type WorkerHeartbeatState, type WorkerRole } from './heartbeat.js'
import { runWriterOnce } from './writer.js'
import { runKeywordOnce } from '../keywords/worker.js'

export { runWebhookOnce } from './delivery.js'
export { runWriterOnce } from './writer.js'

export interface WorkerPoolDependencies {
  runOnce?: (db: Database, config: Config) => Promise<boolean>
  getConfig?: (db: Database, config: Config) => Promise<Config>
  createHeartbeat?: (db: Database, role: WorkerRole, getState: () => WorkerHeartbeatState) => WorkerHeartbeat
  checkEncryption?: (db: Database, config: Config) => Promise<void>
}

export async function runWorkers(
  db: Database, config: Config, signal: AbortSignal, role: WorkerRole, deps: WorkerPoolDependencies = {},
) {
  if (signal.aborted) return
  // Validate before publishing capacity or claiming a job. A wrong local key
  // must not turn a healthy shared queue into permanent credential failures.
  await (deps.checkEncryption ?? assertEncryptionContext)(db, config)
  if (signal.aborted) return
  const runOnce = deps.runOnce ?? (role === 'writer' ? runWriterOnce : role === 'keyword' ? runKeywordOnce : runWebhookOnce)
  const getConfig = deps.getConfig ?? effectiveConfig
  const active = new Set<Promise<void>>()
  const idle = new Set<AbortController>()
  let activeTasks = 0
  let concurrency = 0
  let acceptingWork = false
  const heartbeat = (deps.createHeartbeat ?? startWorkerHeartbeat)(db, role, () => ({
    concurrency, active_tasks: activeTasks, accepting_work: acceptingWork,
  }))
  const onAbort = () => { acceptingWork = false; heartbeat.refresh() }
  signal.addEventListener('abort', onAbort, { once: true })
  let previousPollMs: number | undefined
  let wake: (() => void) | undefined
  const logError = (error: unknown) => {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNEXPECTED'
    console.error(role + ' worker error', code)
  }

  // One cancellable supervisor wait avoids accumulating timers when jobs finish quickly.
  const pause = (milliseconds: number) => new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      if (wake === finish) wake = undefined
      resolve()
    }
    wake = finish
    timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
    if (signal.aborted) finish()
  })

  try {
    while (!signal.aborted) {
      let snapshot: Config
      try {
        // The shared settings reader refreshes at most every five seconds. An expired
        // read must succeed before new claims; existing jobs retain their own snapshot.
        snapshot = await getConfig(db, config)
      } catch (error) {
        logError(error)
        if (acceptingWork) { acceptingWork = false; heartbeat.refresh() }
        await pause(Math.max(100, Math.min(1_000, config.workerPollMs)))
        continue
      }
      if (signal.aborted) break
      if (previousPollMs !== undefined && previousPollMs !== snapshot.workerPollMs) {
        // A reduced poll interval must also wake slots sleeping under the old
        // value, without signalling any provider/webhook request already running.
        for (const controller of idle) controller.abort()
      }
      previousPollMs = snapshot.workerPollMs
      const nextConcurrency = role === 'writer' ? snapshot.workerConcurrency : role === 'keyword' ? 1 : snapshot.webhookConcurrency
      const stateChanged = !acceptingWork || concurrency !== nextConcurrency
      concurrency = nextConcurrency
      acceptingWork = true
      while (!signal.aborted && active.size < concurrency) {
        const task = (async () => {
          let handled = false
          activeTasks += 1
          try { handled = await runOnce(db, snapshot) }
          catch (error) { logError(error) }
          finally { activeTasks -= 1 }
          // Empty/error slots retain their poll delay instead of hammering MongoDB.
          if (!handled) {
            const controller = new AbortController()
            idle.add(controller)
            try {
              await wait(snapshot.workerPollMs, undefined, { signal: AbortSignal.any([signal, controller.signal]) })
                .catch(() => undefined)
            } finally { idle.delete(controller) }
          }
        })().finally(() => {
          active.delete(task)
          wake?.()
        })
        active.add(task)
      }
      if (stateChanged) heartbeat.refresh()
      // Poll even while all slots are busy so a configured increase takes effect.
      // A decrease only stops new claims; it never interrupts work already running.
      await pause(Math.min(1_000, snapshot.workerPollMs))
    }
  } finally {
    acceptingWork = false
    heartbeat.refresh()
    try { await Promise.all(active) }
    finally {
      signal.removeEventListener('abort', onAbort)
      await heartbeat.stop()
    }
  }
}
