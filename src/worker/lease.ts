import type { Config } from '../config.js'
import { collection, type Database } from '../db.js'

export function backoff(attempt: number, baseMs: number, retryAfterMs = 0) { return Math.max(retryAfterMs, baseMs * 2 ** Math.max(0, attempt - 1)) }

export async function withLease<T>(db: Database, config: Config, queue: 'jobs' | 'webhook_deliveries', rowId: string, token: string, timeoutMs: number, call: (signal: AbortSignal, touch: () => void) => Promise<T>, startIdleTimer = true): Promise<T> {
  const lost = new AbortController()
  const timeout = new AbortController()
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  const expire = () => timeout.abort()
  const touch = () => {
    if (timeout.signal.aborted || lost.signal.aborted) return
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    timeoutTimer = setTimeout(expire, timeoutMs)
    timeoutTimer.unref?.()
  }
  if (startIdleTimer) touch()
  const signal = AbortSignal.any([lost.signal, timeout.signal])
  let renewing = false
  const timer = setInterval(async () => { if (renewing || signal.aborted) return; renewing = true; try { const result = await collection(db, queue).updateOne({ _id: rowId, lease_token: token, lease_expires_at: { $gt: new Date() } }, { $set: { lease_expires_at: new Date(Date.now() + config.leaseMs) } }); if (!result.matchedCount) lost.abort() } catch { /* lease remains valid until expiration */ } finally { renewing = false } }, Math.max(1, Math.floor(config.leaseMs / 3))); timer.unref()
  try { return await call(signal, touch) } finally { clearInterval(timer); if (timeoutTimer !== undefined) clearTimeout(timeoutTimer) }
}
// @ts-nocheck
