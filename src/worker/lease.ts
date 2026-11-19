import type { Config } from '../config.js'
import type { Database } from '../db.js'

export function backoff(attempt: number, baseMs: number, retryAfterMs = 0): number {
  return Math.max(retryAfterMs, baseMs * 2 ** (attempt - 1))
}

export async function withLease<T>(
  db: Database, config: Config, queue: 'jobs' | 'webhook_deliveries',
  rowId: string, token: string, timeoutMs: number, call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const lost = new AbortController()
  const signal = AbortSignal.any([lost.signal, AbortSignal.timeout(timeoutMs)])
  let renewing = false
  const interval = setInterval(async () => {
    if (renewing || signal.aborted) return
    renewing = true
    try {
      const result = await db.query(`
        UPDATE ${queue} SET lease_expires_at=clock_timestamp()+($3::int*interval '1 ms')
        WHERE id=$1 AND lease_token=$2 AND lease_expires_at>clock_timestamp()
      `, [rowId, token, config.leaseMs])
      if (!result.rowCount) lost.abort()
    } catch {
      // The existing lease remains valid until its expiration.
    } finally {
      renewing = false
    }
  }, Math.max(1, Math.floor(config.leaseMs / 3)))
  interval.unref()
  try {
    return await call(signal)
  } finally {
    clearInterval(interval)
  }
}
