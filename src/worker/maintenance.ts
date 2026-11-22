import { randomUUID } from 'node:crypto'
import { setTimeout as wait } from 'node:timers/promises'
import type { Config } from '../config.js'
import { collection, type Database } from '../db.js'
import { readSettings, settingsRefreshMs, type RuntimeSettings } from '../runtime-settings.js'
import { runRetentionOnce } from './retention.js'

const scheduleId = 'retention-schedule'
const duplicateKey = (error: unknown) => (error as { code?: number }).code === 11000
type Cleanup = (db: Database, settings: RuntimeSettings, now: Date) => Promise<unknown>

/** A shared deadline prevents every replica from running a cleanup each interval. */
export async function maintenanceTick(db: Database, config: Config, now = new Date(), cleanup: Cleanup = runRetentionOnce) {
  const settings = await readSettings(db, config)
  const { values } = settings
  if (!values.job_retention_days && !values.delivery_retention_days) return false
  const policy = [values.job_retention_days, values.delivery_retention_days, values.cleanup_interval_minutes,
    settings.retention_updated_at ?? ''].join(':')
  const schedules = collection(db, 'runtime_maintenance')
  const next = new Date(now.getTime() + values.cleanup_interval_minutes * 60_000)
  const current = await schedules.findOne({ _id: scheduleId })
  if (!current) {
    try { await schedules.insertOne({ _id: scheduleId, policy, next_run_at: next }) }
    catch (error) { if (!duplicateKey(error)) throw error }
    return false
  }
  if (current.policy !== policy) {
    await schedules.updateOne({ _id: scheduleId, policy: current.policy ?? null }, { $set: { policy, next_run_at: next } })
    return false
  }
  const token = randomUUID()
  const claimed = await schedules.updateOne({ _id: scheduleId, policy, next_run_at: { $lte: now } }, {
    $set: { next_run_at: next, run_token: token },
  })
  if (!claimed.matchedCount) return false
  try {
    // A policy saved by another API must not run under a stale schedule.
    const latest = await readSettings(db, config)
    if ([latest.values.job_retention_days, latest.values.delivery_retention_days,
      latest.values.cleanup_interval_minutes, latest.retention_updated_at ?? ''].join(':') !== policy) return false
    await cleanup(db, latest.values, now)
    return true
  } catch (error) {
    await schedules.updateOne({ _id: scheduleId, run_token: token }, {
      $set: { next_run_at: new Date(now.getTime() + 60_000) },
    }).catch(() => undefined)
    throw error
  }
}

export async function runMaintenance(db: Database, config: Config, signal: AbortSignal) {
  while (!signal.aborted) {
    try { await maintenanceTick(db, config) }
    catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'UNEXPECTED'
      console.error('maintenance error', code)
    }
    await wait(settingsRefreshMs, undefined, { signal }).catch(() => undefined)
  }
}
