import { Decimal } from 'decimal.js'
import { z } from 'zod'
import type { Database } from '../db.js'
import type { Provider, Usage } from './provider.js'
import { WorkerError } from './provider.js'

const rate = z.union([
  z.number().nonnegative(),
  z.string().regex(/^\d{1,12}(?:\.\d{1,12})?$/),
])

export const pricingRatesSchema = z.object({
  input: rate,
  output: rate,
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
  if (!parsed.success || usage?.input == null || usage.output == null) {
    return { amount: null, source: 'pending' }
  }
  const rates = parsed.data
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
    const rates = {
      input: convertRate(model.prompt_text_token_price)!,
      output: convertRate(model.completion_text_token_price)!,
      cachedInput: convertRate(model.cached_prompt_text_token_price),
      longContext: model.long_context_threshold ? {
        threshold: model.long_context_threshold,
        input: convertLongRate(model.prompt_text_token_price_long_context),
        cachedInput: convertLongRate(model.cached_prompt_text_token_price_long_context),
        output: convertLongRate(model.completion_text_token_price_long_context),
      } : undefined,
    }
    for (const modelId of [model.id, ...(model.aliases ?? [])]) models.set(modelId, rates)
  }

  const { transaction } = await import('../db.js')
  const inserted = await transaction(db, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('xai-prices', 0))")
    let count = 0
    for (const [model, rates] of models) {
      const result = await client.query(
        `INSERT INTO model_prices(provider, model, effective_at, source_url, rates)
         SELECT 'xai', $1, now(), $2, $3::jsonb
         WHERE $3::jsonb IS DISTINCT FROM (
           SELECT rates FROM model_prices
           WHERE provider = 'xai' AND model = $1 AND effective_at <= now()
           ORDER BY effective_at DESC LIMIT 1
         )
         ON CONFLICT DO NOTHING`,
        [model, listingSource, JSON.stringify(rates)],
      )
      count += result.rowCount ?? 0
    }
    return count
  })
  return { models: models.size, inserted }
}
