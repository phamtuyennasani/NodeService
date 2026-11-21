import { setTimeout as delay } from 'node:timers/promises'
import type { ChangeStream, ChangeStreamDocument, ResumeToken } from 'mongodb'
import { collection, type Database } from './db.js'

/**
 * Process-local event broker for live CRM job updates.
 *
 * Workers publish after durable updates for the local reconnect fallback.
 * The API bridges MongoDB changes from every worker process into safe job
 * invalidations. Consumers fetch only the affected authoritative job row.
 *
 * This broker is intentionally transport agnostic so workers can publish
 * updates without depending on Fastify's request/response objects.
 */

export type JobEventType = 'ready' | 'job.created' | 'job.updated' | 'job.deleted'

export interface JobEvent {
  type: JobEventType
  job_id?: string
  [key: string]: unknown
}

type Subscriber = {
  jobId?: string
  receive: (event: JobEvent) => void
}

export class JobEventBroker {
  private readonly subscribers = new Set<Subscriber>()

  subscribe(receive: Subscriber['receive'], jobId?: string) {
    const subscriber = { jobId, receive }
    this.subscribers.add(subscriber)
    return () => this.subscribers.delete(subscriber)
  }

  publish(event: JobEvent) {
    for (const subscriber of this.subscribers) {
      if (event.type !== 'ready' && subscriber.jobId && subscriber.jobId !== event.job_id) continue
      try {
        subscriber.receive(event)
      } catch {
        // A disconnected response should not prevent other CRM clients from
        // receiving the same update. The SSE handler removes its subscriber
        // when the response closes.
      }
    }
  }

  get size() {
    return this.subscribers.size
  }
}

export const jobEvents = new JobEventBroker()

// Lease renewals only extend ownership; sending them to browsers would bring
// back periodic redraws. All other externally visible job changes invalidate
// just their job, and the browser fetches the authoritative row.
const visibleFields = [
  'status', 'writing_stage', 'scheduled_at', 'started_at', 'completed_at',
  'keyword', 'tone', 'style', 'length', 'instructions', 'use_research',
  'provider', 'model', 'source_article_id', 'retry_of_job_id', 'result',
  'outline', 'seo_report', 'seo_repair_status', 'error_code', 'error_message',
]
const attemptFields = ['status', 'usage', 'cost_usd', 'cost_source', 'provider_response_id', 'finished_at', 'error_code', 'error']
const deliveryFields = ['status', 'attempt_count', 'http_status', 'error', 'next_attempt_at', 'delivered_at']
const deliveryAttemptFields = ['finished_at', 'http_status', 'error']
const changedField = { $concatArrays: [
  { $map: { input: { $objectToArray: { $ifNull: ['$updateDescription.updatedFields', {}] } }, as: 'field', in: '$$field.k' } },
  { $ifNull: ['$updateDescription.removedFields', []] },
] }
const visibleChanges = (fields: string[]) => ({ $or: [
  { operationType: { $in: ['insert', 'replace'] } },
  { operationType: 'update', $expr: { $gt: [{ $size: { $setIntersection: [fields, changedField] } }, 0] } },
] })

/** One shared MongoDB stream per API, including updates from separate workers. */
export class DatabaseJobEvents {
  private readonly subscribers = new JobEventBroker()
  private readonly stopped = new AbortController()
  private stream?: ChangeStream
  private running?: Promise<void>
  private connected = false
  private resumeAfter?: ResumeToken
  private readonly unsubscribeLocal: () => boolean

  constructor(private readonly db: Database, private readonly warn: (error: unknown) => void = () => {}) {
    this.unsubscribeLocal = jobEvents.subscribe(event => {
      // Keep same-process updates available while MongoDB reconnects. In the
      // healthy case the database stream is the single source of updates.
      if (!this.connected) this.subscribers.publish(event)
    })
  }

  start() {
    if (this.running || this.stopped.signal.aborted) return
    // In-memory route fixtures do not implement MongoDB change streams.
    if (typeof this.db.db.watch !== 'function') return
    this.running = this.consume()
  }

  subscribe(receive: Subscriber['receive'], jobId?: string) {
    return this.subscribers.subscribe(receive, jobId)
  }

  async close() {
    this.stopped.abort()
    this.unsubscribeLocal()
    await this.stream?.close().catch(() => {})
    await this.running
  }

  private async consume() {
    let retryMs = 1_000
    while (!this.stopped.signal.aborted) {
      try {
        this.stream = this.db.db.watch([
          { $match: { $or: [
            { 'ns.coll': 'jobs', $or: [visibleChanges(visibleFields), { operationType: 'delete' }] },
            { 'ns.coll': 'ai_attempts', ...visibleChanges(attemptFields) },
            { 'ns.coll': 'webhook_deliveries', ...visibleChanges(deliveryFields) },
            { 'ns.coll': 'webhook_attempts', ...visibleChanges(deliveryAttemptFields) },
          ] } },
          // No encrypted API keys, article content or other job fields cross
          // the event channel, even when the document itself is replaced.
          { $project: { _id: 1, operationType: 1, documentKey: 1, 'ns.coll': 1, 'fullDocument.job_id': 1, 'fullDocument.delivery_id': 1 } },
        ], { fullDocument: 'updateLookup', maxAwaitTimeMS: 1_000, ...(this.resumeAfter ? { resumeAfter: this.resumeAfter } : {}) })
        while (!this.stopped.signal.aborted) {
          const change = await this.stream.tryNext() as ChangeStreamDocument | null
          if (this.stopped.signal.aborted) break
          if (this.stream.resumeToken) this.resumeAfter = this.stream.resumeToken
          if (!this.connected) {
            this.connected = true
            retryMs = 1_000
            // A snapshot closes the initial connection race and any gap when
            // a resume token has expired or the API has restarted.
            this.subscribers.publish({ type: 'ready' })
          }
          if (change && 'documentKey' in change) {
            const name = change.ns.coll
            const document = 'fullDocument' in change ? change.fullDocument : undefined
            const delivery = name === 'webhook_attempts' && typeof document?.delivery_id === 'string'
              ? await collection(this.db, 'webhook_deliveries').findOne({ _id: document.delivery_id }, { projection: { job_id: 1 } }) : undefined
            const jobId = name === 'jobs' ? change.documentKey._id : name === 'webhook_attempts' ? delivery?.job_id : document?.job_id
            if (typeof jobId === 'string') this.subscribers.publish({
              type: name === 'jobs' && change.operationType === 'delete' ? 'job.deleted'
                : name === 'jobs' && change.operationType === 'insert' ? 'job.created' : 'job.updated',
              job_id: jobId,
            })
          }
          if (this.stream.closed && !this.stopped.signal.aborted) throw new Error('Job change stream closed')
        }
      } catch (error) {
        if (this.stopped.signal.aborted) break
        this.connected = false
        // A lost oplog history cannot be resumed. Reopen from now and ask
        // clients to reconcile once the new stream has been established.
        if ([260, 280, 286].includes(Number((error as { code?: number })?.code))) this.resumeAfter = undefined
        this.warn(error)
      } finally {
        await this.stream?.close().catch(() => {})
        this.stream = undefined
      }
      if (this.stopped.signal.aborted) break
      await delay(retryMs, undefined, { signal: this.stopped.signal, ref: false }).catch(() => {})
      retryMs = Math.min(retryMs * 2, 30_000)
    }
    this.connected = false
  }
}
