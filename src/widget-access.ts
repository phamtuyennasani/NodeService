import { createHmac, timingSafeEqual } from 'node:crypto'

export const widgetGrantSeconds = 3600

/** Domains in CRM are canonical host[:port] values, not a list of subdomains. */
export function widgetOrigin(value: string, domain: string, development = false): string | null {
  try {
    const origin = new URL(value)
    const site = new URL(domain.includes('://') ? domain : `https://${domain}`)
    if (origin.origin !== value || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null
    if (origin.host !== site.host) return null
    const local = origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname === '[::1]'
      || origin.hostname.endsWith('.test') || origin.hostname.endsWith('.localhost')
    if (origin.protocol !== 'https:' && !(development && local && origin.protocol === 'http:')) return null
    return origin.origin
  } catch { return null }
}

export function widgetSignature(tokenHash: string, siteId: string, origin: string, expires: string): string {
  return createHmac('sha256', tokenHash).update(`widget\n${siteId}\n${origin}\n${expires}`).digest('hex')
}

export function sameWidgetToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual) || !/^[a-f0-9]{64}$/.test(expected)) return false
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

export function widgetReadToken(tokenHash: string, siteId: string, customerId: string, origin: string, jobId: string): string {
  return createHmac('sha256', tokenHash).update(`widget-read\n${siteId}\n${customerId}\n${origin}\n${jobId}`).digest('hex')
}
