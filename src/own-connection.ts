import { z } from 'zod'
import type { Config } from './config.js'
import { seal, unseal } from './security.js'
import { validateWebhookUrl } from './worker/webhook.js'

export const ownBaseUrlSchema = z.string().trim().min(1).max(500).refine(value => {
  try {
    if (/[\u0000-\u0020\u007f\\?#]/.test(value)) return false
    const url = validateWebhookUrl(value, false)
    return !url.search && !url.hash && !url.username && !url.password
  } catch { return false }
}, 'Base URL phải là địa chỉ HTTPS công khai, không chứa thông tin đăng nhập, query hoặc hash.')
  .transform(value => new URL(value).href.replace(/\/+$/, ''))

export const ownApiKeySchema = z.string().trim().min(1).max(2048).regex(/^[^\r\n\u0000]+$/)
export const ownModelSchema = z.string().trim().min(1).max(160).regex(/^[^\s\u0000-\u0020\u007f]+$/)

const connectionSchema = z.object({
  type: z.literal('openai-compatible'),
  base_url: ownBaseUrlSchema,
  api_key: ownApiKeySchema,
}).strict()

export function encodeOwnConnection(apiKey: string, baseUrl: string, encryptionKey: Config['encryptionKey']): string {
  const connection = connectionSchema.parse({ type: 'openai-compatible', base_url: baseUrl, api_key: apiKey })
  return seal(JSON.stringify(connection), encryptionKey)
}

/** New jobs keep endpoint and key together; already queued legacy jobs can still finish. */
export function decodeOwnConnection(encrypted: string, encryptionKey: Config['encryptionKey']): { apiKey: string; baseUrl?: string } {
  const plain = unseal(encrypted, encryptionKey)
  if (!plain.trimStart().startsWith('{')) return { apiKey: ownApiKeySchema.parse(plain) }
  try {
    const connection = connectionSchema.parse(JSON.parse(plain))
    return { apiKey: connection.api_key, baseUrl: connection.base_url }
  } catch { throw new Error('Invalid encrypted AI connection') }
}
