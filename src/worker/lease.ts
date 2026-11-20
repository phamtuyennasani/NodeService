import type { Config } from '../config.js'
import { collection, type Database } from '../db.js'

export function backoff(attempt: number, baseMs: number, retryAfterMs = 0) { return Math.max(retryAfterMs, baseMs * 2 ** Math.max(0, attempt - 1)) }

export async function withLease<T>(db: Database, config: Config, queue: 'jobs' | 'webhook_deliveries', rowId: string, token: string, timeoutMs: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const lost = new AbortController(); const signal = AbortSignal.any([lost.signal, AbortSignal.timeout(timeoutMs)]); let renewing = false
  const timer = setInterval(async () => { if (renewing || signal.aborted) return; renewing = true; try { const result = await collection(db, queue).updateOne({ _id: rowId, lease_token: token, lease_expires_at: { $gt: new Date() } }, { $set: { lease_expires_at: new Date(Date.now() + config.leaseMs) } }); if (!result.matchedCount) lost.abort() } catch { /* lease remains valid until expiration */ } finally { renewing = false } }, Math.max(1, Math.floor(config.leaseMs / 3))); timer.unref()
  try { return await call(signal) } finally { clearInterval(timer) }
}
// @ts-nocheck
