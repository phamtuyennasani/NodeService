import { randomUUID } from 'node:crypto'
import { collection, type Database } from '../db.js'

export type WorkerRole = 'writer' | 'webhook'

export interface WorkerHeartbeatState {
  concurrency: number
  active_tasks: number
  accepting_work: boolean
}

export interface WorkerHeartbeat {
  refresh(): void
  stop(): Promise<void>
}

interface HeartbeatDependencies {
  now?: () => Date
  schedule?: (pulse: () => void, intervalMs: number) => () => void
}

const INTERVAL_MS = 5_000
const TTL_MS = 15_000

export function startWorkerHeartbeat(
  db: Database, role: WorkerRole, getState: () => WorkerHeartbeatState, deps: HeartbeatDependencies = {},
): WorkerHeartbeat {
  const id = randomUUID()
  const now = deps.now ?? (() => new Date())
  const schedule = deps.schedule ?? ((pulse, milliseconds) => {
    const timer = setInterval(pulse, milliseconds)
    timer.unref()
    return () => clearInterval(timer)
  })
  let stopped = false
  let pending = false
  let writing: Promise<void> | undefined
  let stopping: Promise<void> | undefined

  const logError = (error: unknown) => {
    // Driver messages can contain connection strings; emit only a bounded code.
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNEXPECTED'
    console.error(role + ' worker heartbeat error', /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNEXPECTED')
  }

  const refresh = () => {
    if (stopped) return
    pending = true
    if (writing) return
    writing = (async () => {
      // Coalesce overlapping timer/state updates instead of building a write queue.
      while (pending && !stopped) {
        pending = false
        try {
          const heartbeatAt = now()
          const state = getState()
          await collection(db, 'worker_heartbeats').updateOne({ _id: id }, {
            $set: {
              role,
              heartbeat_at: heartbeatAt,
              expires_at: new Date(heartbeatAt.getTime() + TTL_MS),
              concurrency: state.concurrency,
              active_tasks: state.active_tasks,
              accepting_work: state.accepting_work,
            },
          }, { upsert: true })
        } catch (error) { logError(error) }
      }
    })().finally(() => {
      writing = undefined
      if (pending && !stopped) refresh()
    })
  }

  const cancelTimer = schedule(refresh, INTERVAL_MS)
  refresh()
  return {
    refresh,
    stop() {
      if (!stopping) {
        stopped = true
        pending = false
        cancelTimer()
        stopping = (async () => {
          // A late upsert must finish before removal so it cannot resurrect this run.
          await writing
          try { await collection(db, 'worker_heartbeats').deleteOne({ _id: id }) }
          catch (error) { logError(error) }
        })()
      }
      return stopping
    },
  }
}
