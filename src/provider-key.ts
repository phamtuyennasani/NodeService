import { providerKind, type BuiltinProvider, type Config, type Provider } from './config.js'
import { unseal } from './security.js'

type KeyConfig = Pick<Config, 'encryptionKey'> & { serviceKeys: Partial<Record<BuiltinProvider, string | undefined>> }
export type ServiceKeyState = 'missing' | 'ready' | 'unreadable'

/** A saved connection credential always takes precedence over environment keys. */
export function resolveServiceKey(provider: Provider, encryptedKey: string | null | undefined, config: KeyConfig): string | undefined {
  if (encryptedKey) return unseal(encryptedKey, config.encryptionKey) || undefined
  const kind = providerKind(provider)
  // Custom compatible connections must never borrow another connection's key.
  return provider === kind ? config.serviceKeys[kind] || undefined : undefined
}

export function serviceKeyState(provider: Provider, encryptedKey: string | null | undefined, config: KeyConfig): ServiceKeyState {
  try { return resolveServiceKey(provider, encryptedKey, config) ? 'ready' : 'missing' }
  catch { return 'unreadable' }
}
