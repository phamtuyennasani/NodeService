import { randomUUID } from 'node:crypto'
import { collection, sessionOf, transaction, type Database, type TransactionContext } from '../db.js'
import { jobEvents } from '../job-events.js'

const dayMs = 86_400_000
const leaseMs = 5 * 60_000
const lockId = 'retention-lock'
const terminalJobs = ['ready', 'completed', 'failed', 'canceled']
const activeJobs = ['scheduled', 'queued', 'writing']
const terminalDeliveries = ['delivered', 'failed']

export interface RetentionSettings {
  job_retention_days: number
  delivery_retention_days: number
}

function cutoff(days: number, now: Date) {
  // Invalid or disabled policies must never turn into an unbounded deletion.
  return Number.isSafeInteger(days) && days > 0 && days <= 3650
    ? new Date(now.getTime() - days * dayMs) : null
}

function oldJobs(before: Date) {
  return { status: { $in: terminalJobs }, $or: [
    { completed_at: { $type: 'date', $lt: before } },
    { completed_at: null, updated_at: { $type: 'date', $lt: before } },
  ] }
}

function oldDeliveries(before: Date) {
  return { status: { $in: terminalDeliveries }, $or: [
    { updated_at: { $type: 'date', $lt: before } },
    { updated_at: null, delivered_at: { $type: 'date', $lt: before } },
  ] }
}

/** Delete a bounded batch of finished history without changing consumed quota. */
export async function runRetentionOnce(db: Database, settings: RetentionSettings, now = new Date()): Promise<{ jobs: number; deliveries: number }> {
  const jobCutoff = cutoff(settings.job_retention_days, now)
  const deliveryCutoff = cutoff(settings.delivery_retention_days, now)
  const result = { jobs: 0, deliveries: 0 }
  if (!jobCutoff && !deliveryCutoff) return result

  const startedAt = Date.now()
  const currentTime = () => new Date(now.getTime() + Date.now() - startedAt)
  const token = randomUUID()
  const locks = collection(db, 'runtime_maintenance')
  try {
    await locks.updateOne({ _id: lockId }, { $setOnInsert: { lease_token: null, lease_expires_at: new Date(0) } }, { upsert: true })
  } catch (error) {
    // Two processes can create the initial singleton at the same moment.
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 11000)) throw error
  }
  const lock = await locks.findOneAndUpdate({ _id: lockId, lease_expires_at: { $lte: now } }, {
    $set: { lease_token: token, lease_expires_at: new Date(now.getTime() + leaseMs) },
  }, { returnDocument: 'after' })
  if (!lock) return result

  // Check ownership in every transaction. A paused process cannot resume deleting
  // after its housekeeping lease has expired and another process has acquired it.
  async function ownLease(source: TransactionContext) {
    const time = currentTime()
    const owned = await collection(source, 'runtime_maintenance').updateOne({
      _id: lockId, lease_token: token, lease_expires_at: { $gt: time },
    }, { $set: { lease_expires_at: new Date(time.getTime() + leaseMs) } }, { session: sessionOf(source) })
    return owned.matchedCount > 0
  }

  async function currentPolicy(source: TransactionContext) {
    const session = sessionOf(source)
    const settingsRows = collection(source, 'runtime_settings')
    const saved = await settingsRows.findOne({ _id: 'crm' }, { session })
    // There is no persisted policy in direct invocations using environment
    // defaults. Production defaults disable retention until the first save.
    if (!saved) return true
    if (saved.values?.job_retention_days !== settings.job_retention_days ||
        saved.values?.delivery_retention_days !== settings.delivery_retention_days) return false
    // A real write serializes deletion with settings saves. If a user disables
    // or lengthens retention first, MongoDB retries with the new policy and this
    // batch stops; a save after this write waits for this one deletion to commit.
    const guarded = await settingsRows.updateOne({
      _id: 'crm', revision: saved.revision,
      'values.job_retention_days': settings.job_retention_days,
      'values.delivery_retention_days': settings.delivery_retention_days,
    }, { $inc: { cleanup_version: 1 } }, { session })
    return guarded.matchedCount > 0
  }

  try {
    let stopped = false
    if (jobCutoff) {
      const candidates = await collection(db, 'jobs').find(oldJobs(jobCutoff), { projection: { _id: 1 } })
        .sort({ retention_checked_at: 1, completed_at: 1, updated_at: 1, _id: 1 }).limit(50).toArray()
      for (const candidate of candidates) {
        const removed = await transaction(db, async source => {
          if (!await ownLease(source) || !await currentPolicy(source)) return false
          const session = sessionOf(source)
          const jobs = collection(source, 'jobs')
          const filter = { _id: candidate._id, ...oldJobs(jobCutoff) }
          const job = await jobs.findOne(filter, { session })
          if (!job) return null

          // Job creation/rewrite also writes this website, closing the race in
          // which a newly queued rewrite would lose its source article.
          await collection(source, 'sites').updateOne({ _id: job.site_id }, { $inc: { relation_version: 1 } }, { session })
          // Rotate blocked candidates so old undelivered articles do not starve
          // the rest of the cleanup queue. Do not change their business dates.
          if (!(await jobs.updateOne(filter, {
            $inc: { retention_version: 1 }, $set: { retention_checked_at: currentTime() },
          }, { session })).matchedCount) return null
          if (await jobs.findOne({ source_article_id: job._id, status: { $in: activeJobs } }, { session, projection: { _id: 1 } })) return null
          const deliveries = await collection(source, 'webhook_deliveries').find({ job_id: job._id }, { session, projection: { _id: 1, status: 1 } }).toArray()
          if (deliveries.some(delivery => delivery.status === 'pending' || delivery.status === 'sending')) return null

          const deliveryIds = deliveries.map(delivery => delivery._id)
          if (deliveryIds.length) await collection(source, 'webhook_attempts').deleteMany({ delivery_id: { $in: deliveryIds } }, { session })
          await collection(source, 'ai_attempts').deleteMany({ job_id: job._id }, { session })
          await collection(source, 'webhook_deliveries').deleteMany({ job_id: job._id }, { session })
          await collection(source, 'quota_reservations').deleteMany({ job_id: job._id, status: { $ne: 'used' } }, { session })
          const changedAt = currentTime()
          await jobs.updateMany({ source_article_id: job._id }, { $set: { source_article_id: null, updated_at: changedAt } }, { session })
          await jobs.updateMany({ retry_of_job_id: job._id }, { $set: { retry_of_job_id: null, updated_at: changedAt } }, { session })
          const deleted = await jobs.deleteOne(filter, { session })
          if (!deleted.deletedCount) throw new Error('Retention job ownership changed during cleanup')
          return { id: job._id, deliveries: deliveryIds.length }
        })
        if (removed === false) { stopped = true; break }
        if (removed) {
          result.jobs += 1
          result.deliveries += removed.deliveries
          jobEvents.publish({ type: 'job.deleted', job_id: removed.id, deleted: true })
        }
      }
    }

    if (deliveryCutoff && !stopped) {
      const candidates = await collection(db, 'webhook_deliveries').find(oldDeliveries(deliveryCutoff), { projection: { _id: 1 } })
        .sort({ updated_at: 1, delivered_at: 1, _id: 1 }).limit(100).toArray()
      for (const candidate of candidates) {
        const removed = await transaction(db, async source => {
          if (!await ownLease(source) || !await currentPolicy(source)) return false
          const session = sessionOf(source)
          const deliveries = collection(source, 'webhook_deliveries')
          const filter = { _id: candidate._id, ...oldDeliveries(deliveryCutoff) }
          const delivery = await deliveries.findOne(filter, { session })
          if (!delivery) return null
          if (!(await deliveries.updateOne(filter, { $inc: { retention_version: 1 } }, { session })).matchedCount) return null
          await collection(source, 'webhook_attempts').deleteMany({ delivery_id: delivery._id }, { session })
          const deleted = await deliveries.deleteOne(filter, { session })
          if (!deleted.deletedCount) throw new Error('Retention delivery ownership changed during cleanup')
          return { jobId: delivery.job_id }
        })
        if (removed === false) break
        if (removed) {
          result.deliveries += 1
          if (typeof removed.jobId === 'string') jobEvents.publish({ type: 'job.updated', job_id: removed.jobId })
        }
      }
    }
    return result
  } finally {
    // The token prevents a late owner from releasing another process's lease.
    await locks.updateOne({ _id: lockId, lease_token: token }, {
      $set: { lease_token: null, lease_expires_at: new Date(0), last_completed_at: currentTime() },
    }).catch(() => undefined)
  }
}
