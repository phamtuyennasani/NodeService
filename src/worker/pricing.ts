import { randomUUID } from 'node:crypto'
import { Decimal } from 'decimal.js'
import { z } from 'zod'
import { collection, type Database } from '../db.js'
import type { Provider, Usage } from './provider.js'
import { WorkerError } from './provider.js'

const rate = z.union([
  z.number().nonnegative(),
  z.string().regex(/^\d{1,12}(?:\.\d{1,12})?$/),
])

export const pricingRatesSchema = z.object({
  total: rate.optional(),
  input: rate.optional(),
  output: rate.optional(),
  cachedInput: rate.optional(),
  cacheWrite5m: rate.optional(),
  cacheWrite1h: rate.optional(),
  longContext: z.object({
    threshold: z.number().int().positive(),
    input: rate.optional(),
    cachedInput: rate.optional(),
    output: rate.optional(),
  }).optional(),
  request: rate.optional(),
})

export type PricingRates = z.infer<typeof pricingRatesSchema>
export type CostSource = 'provider' | 'estimated' | 'pending'
export interface Cost {
  amount: string | null
  source: CostSource
}

export function priceUsage(provider: Provider, rawRates: unknown, usage: Usage | null): Cost {
  if (provider === 'xai' && usage?.costTicks != null) {
    return { amount: new Decimal(usage.costTicks).div('10000000000').toFixed(12), source: 'provider' }
  }
  const parsed = pricingRatesSchema.safeParse(rawRates)
  if (!parsed.success || usage == null) {
    return { amount: null, source: 'pending' }
  }
  const rates = parsed.data
  if (rates.total != null) {
    const totalTokens = (usage.input ?? 0) + (usage.cachedInput ?? 0) + (usage.cacheWrite5m ?? 0) + (usage.cacheWrite1h ?? 0) + (usage.output ?? 0) + (usage.reasoning ?? 0)
    if (totalTokens <= 0) return { amount: null, source: 'pending' }
    return { amount: new Decimal(rates.total).times(totalTokens).div(1_000_000).plus(rates.request ?? 0).toFixed(12), source: 'estimated' }
  }
  if (usage.input == null || usage.output == null) return { amount: null, source: 'pending' }
  const threshold = (usage.input + (usage.cachedInput ?? 0) + (usage.cacheWrite5m ?? 0) + (usage.cacheWrite1h ?? 0))
  const longContext = rates.longContext && threshold > rates.longContext.threshold ? rates.longContext : undefined
  const lines = [
    { quantity: usage.input, price: longContext?.input ?? rates.input },
    { quantity: usage.cachedInput ?? 0, price: longContext?.cachedInput ?? rates.cachedInput },
    { quantity: usage.cacheWrite5m ?? 0, price: rates.cacheWrite5m },
    { quantity: usage.cacheWrite1h ?? 0, price: rates.cacheWrite1h },
    { quantity: usage.output, price: longContext?.output ?? rates.output },
  ]
  if (lines.some(line => line.quantity > 0 && line.price == null)) {
    return { amount: null, source: 'pending' }
  }
  const tokenCost = lines.reduce(
    (sum, line) => sum.plus(new Decimal(line.price ?? 0).times(line.quantity).div(1_000_000)),
    new Decimal(0),
  )
  return { amount: tokenCost.plus(rates.request ?? 0).toFixed(12), source: 'estimated' }
}

const listingEndpoint = 'https://api.x.ai/v1/language-models'
const listingSource = 'https://docs.x.ai/developers/rest-api-reference/inference/models#list-language-models'

const listingSchema = z.object({
  models: z.array(z.object({
    id: z.string().min(1).max(160),
    aliases: z.array(z.string().min(1).max(160)).nullish(),
    prompt_text_token_price: rate,
    cached_prompt_text_token_price: rate.nullish(),
    completion_text_token_price: rate,
    prompt_text_token_price_long_context: rate.nullish(),
    cached_prompt_text_token_price_long_context: rate.nullish(),
    completion_text_token_price_long_context: rate.nullish(),
    long_context_threshold: z.number().int().nonnegative().nullish(),
  })),
})

function convertRate(value: number | string | null | undefined): number | undefined {
  return value == null ? undefined : new Decimal(value).div(10_000).toNumber()
}

function convertLongRate(value: number | string | null | undefined): number | undefined {
  const price = convertRate(value)
  return price === 0 ? undefined : price
}

export async function syncXaiPrices(db: Database, key: string, fetcher: typeof fetch = fetch) {
  let listing: z.infer<typeof listingSchema>
  try {
    const response = await fetcher(listingEndpoint, {
      headers: { authorization: 'Bearer ' + key },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error('xAI prices unavailable')
    }
    listing = listingSchema.parse(await response.json())
  } catch {
    throw new WorkerError('XAI_PRICES_UNAVAILABLE', 'Không lấy được bảng giá xAI. Kiểm tra API key và thử lại.', true)
  }
  const models = new Map<string, PricingRates>()
  for (const model of listing.models) {
    const rates = { total: new Decimal(convertRate(model.prompt_text_token_price) ?? 0).plus(convertRate(model.completion_text_token_price) ?? 0).div(2).toNumber() }
    for (const modelId of [model.id, ...(model.aliases ?? [])]) models.set(modelId, rates)
  }

  let inserted = 0
  for (const [model, rates] of models) {
    const current = await collection<any>(db, 'model_prices').findOne({ provider: 'xai', model }, { sort: { effective_at: -1 } })
    if (JSON.stringify(current?.rates) === JSON.stringify(rates)) continue
    await collection(db, 'model_prices').insertOne({ _id: randomUUID(), provider: 'xai', model, effective_at: new Date(), source_url: listingSource, rates, created_at: new Date() })
    inserted += 1
  }
  return { models: models.size, inserted }
}
// @ts-nocheck
