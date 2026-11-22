import { setTimeout as delay } from 'node:timers/promises'
import { providerKind, type Config, type Provider } from '../config.js'
import type { Database } from '../db.js'

const minute = 60_000

interface Reservation {
  time: number
  tokens: number
}

interface Slot {
  id: string
  expires: number
}

interface ProviderWindow {
  _id: Provider
  revision: number
  requests: Reservation[]
  slots: Slot[]
  blockedUntil?: number
}

export class ProviderCapacityPending extends Error {
  constructor(readonly retryInMs: number) { super('Provider capacity is temporarily unavailable') }
}

function capacityDelay(current: ProviderWindow, config: Config, provider: Provider, now: number, tokens: number, keepSlot: boolean) {
  const limits = config.providerLimits[providerKind(provider)]
  const slots = current.slots.filter(slot => slot.expires > now)
  const requests = current.requests.filter(request => request.time > now - minute).sort((a, b) => a.time - b.time)
  const poll = config.workerPollMs ?? 500
  const requestReady = requests.length >= limits.requestsPerMinute
    ? requests[requests.length - limits.requestsPerMinute].time + minute : now
  let tokenReady = now
  let remaining = requests.reduce((total, request) => total + request.tokens, 0)
  for (const request of requests) {
    if (remaining + tokens <= limits.tokensPerMinute) break
    remaining -= request.tokens
    tokenReady = request.time + minute
  }
  const retryInMs = Math.max(
    !keepSlot && slots.length >= limits.concurrency ? poll : 0,
    requestReady - now, tokenReady - now, (current.blockedUntil ?? 0) - now,
  )
  return { slots, requests, retryInMs }
}

export async function providerHasCapacity(db: Database, config: Config, provider: Provider) {
  const current = await db.db.collection<ProviderWindow>('provider_limits').findOne({ _id: provider })
  return !current || capacityDelay(current, config, provider, Date.now(), 0, false).retryInMs === 0
}

// A revision check serializes reservations across processes without holding a transaction during an AI request.
export async function reserveProviderRequest(
  db: Database, config: Config, provider: Provider, id: string, tokens: number,
  signal: AbortSignal, keepSlot = false,
) {
  const windows = db.db.collection<ProviderWindow>('provider_limits')
  while (true) {
    signal.throwIfAborted()
    const current = await windows.findOne({ _id: provider })
    signal.throwIfAborted()
    const now = Date.now()
    if (!current) {
      try {
        await windows.insertOne({ _id: provider, revision: 0, requests: [], slots: [] })
      } catch (error) {
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 11000) throw error
      }
      continue
    }
    const { slots, requests, retryInMs } = capacityDelay(current, config, provider, now, tokens, keepSlot)
    const owner = slots.find(slot => slot.id === id)
    if (keepSlot && !owner) throw new Error('Provider request slot expired')
    if (retryInMs > 0) {
      if (!keepSlot) throw new ProviderCapacityPending(retryInMs)
      await delay(Math.min(retryInMs, config.workerPollMs ?? 500), undefined, { signal })
      continue
    }
    if (!owner) slots.push({ id, expires: now + config.leaseMs })
    requests.push({ time: now, tokens })
    const updated = await windows.updateOne({ _id: provider, revision: current.revision }, {
      $set: { requests, slots }, $inc: { revision: 1 },
    })
    if (updated.matchedCount) return
  }
}

export function monitorProviderSlot(db: Database, config: Config, provider: Provider, id: string) {
  const windows = db.db.collection<ProviderWindow>('provider_limits')
  const controller = new AbortController()
  let heartbeat: Promise<void> = Promise.resolve()
  let expiry = setTimeout(() => controller.abort(), config.leaseMs)
  expiry.unref()

  async function renew() {
    const now = Date.now()
    const result = await windows.updateOne({ _id: provider, slots: { $elemMatch: { id, expires: { $gt: now } } } }, {
      $set: { 'slots.$.expires': now + config.leaseMs }, $inc: { revision: 1 },
    })
    if (!result.matchedCount) controller.abort()
    if (controller.signal.aborted) return
    clearTimeout(expiry)
    expiry = setTimeout(() => controller.abort(), Math.max(1, now + config.leaseMs - Date.now()))
    expiry.unref()
  }

  let renewing = false
  const timer = setInterval(() => {
    if (renewing || controller.signal.aborted) return
    renewing = true
    heartbeat = renew().catch(() => { /* The expiry timer still bounds the confirmed lease. */ })
      .finally(() => { renewing = false })
  }, Math.max(1, Math.floor(config.leaseMs / 3)))
  timer.unref()
  return {
    signal: controller.signal,
    async release(retryAfterMs = 0) {
      clearInterval(timer)
      try {
        await heartbeat
        await windows.updateOne({ _id: provider }, {
          $pull: { slots: { id } },
          $inc: { revision: 1 },
          ...(retryAfterMs > 0 ? { $max: { blockedUntil: Date.now() + retryAfterMs } } : {}),
        })
      } finally {
        clearTimeout(expiry)
      }
    },
  }
}
