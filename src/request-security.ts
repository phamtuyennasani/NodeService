import type { FastifyInstance } from 'fastify';
import ipaddr from 'ipaddr.js';
import type { Config } from './config.js';

type SecurityConfig = Config['security'];
type ClientWindow = { startedAt: number; all: number; api: number; writes: number; active: number };
type GateResult = { allowed: true; release: () => void } | { allowed: false; status: 429 | 503; retryAfter: number };
const windowMs = 60_000;

export function securityOptions(config: Config): SecurityConfig {
  return {
    trustedProxies: [], requestsPerMinute: 600, apiRequestsPerMinute: 240,
    writeRequestsPerMinute: 60, totalRequestsPerMinute: 12_000, maxTrackedIps: 10_000,
    maxConcurrentRequests: 200, maxConcurrentPerIp: 20, maxConnections: 1_000, requestTimeoutMs: 15_000,
    connectionTimeoutMs: 30_000, headersTimeoutMs: 10_000,
    ...(config.security as Partial<SecurityConfig> | undefined),
  };
}

/** Treat an IPv6 /64 as one client so rotating interface addresses is no bypass. */
export function clientAddress(ip: string): string {
  try {
    const parsed = ipaddr.process(ip);
    if (parsed.kind() === 'ipv4') return parsed.toString();
    const bytes = parsed.toByteArray();
    return `${ipaddr.fromByteArray([...bytes.slice(0, 8), ...Array(8).fill(0)]).toString()}/64`;
  } catch {
    // Never use an arbitrary attacker-controlled string as a cache key.
    return 'unknown';
  }
}

/** A cheap, strictly bounded admission gate. It runs before authentication or DB work. */
export class RequestGate {
  private readonly clients = new Map<string, ClientWindow>();
  private totalStartedAt: number;
  private total = 0;
  private active = 0;
  private nextSweep = 0;

  constructor(private readonly options: SecurityConfig, private readonly now: () => number = Date.now) {
    this.totalStartedAt = now();
  }

  get trackedClients() { return this.clients.size; }

  enter(ip: string, api: boolean, write: boolean): GateResult {
    const now = this.now();
    if (now - this.totalStartedAt >= windowMs) { this.totalStartedAt = now; this.total = 0; }

    const key = clientAddress(ip);
    let client = this.clients.get(key);
    if (!client) {
      if (this.clients.size >= this.options.maxTrackedIps && now >= this.nextSweep) {
        this.nextSweep = now + 1_000;
        for (const [address, value] of this.clients) {
          if (!value.active && now - value.startedAt >= windowMs) this.clients.delete(address);
        }
      }
      // Do not evict live counters: cache flooding must not reset an attacker's limit.
      if (this.clients.size >= this.options.maxTrackedIps) return { allowed: false, status: 503, retryAfter: 1 };
      client = { startedAt: now, all: 0, api: 0, writes: 0, active: 0 };
      this.clients.set(key, client);
    } else if (now - client.startedAt >= windowMs) {
      client.startedAt = now; client.all = 0; client.api = 0; client.writes = 0;
    }
    client.all++;
    if (api) client.api++;
    if (api && write) client.writes++;
    if (client.all > this.options.requestsPerMinute || (api && client.api > this.options.apiRequestsPerMinute) || (api && write && client.writes > this.options.writeRequestsPerMinute)) {
      return { allowed: false, status: 429, retryAfter: this.retry(client.startedAt, now) };
    }
    // An already rejected sender cannot spend the shared instance budget and
    // lock out everyone else merely by repeating cheap, over-limit requests.
    if (++this.total > this.options.totalRequestsPerMinute) return { allowed: false, status: 429, retryAfter: this.retry(this.totalStartedAt, now) };
    if (this.active >= this.options.maxConcurrentRequests || client.active >= this.options.maxConcurrentPerIp) {
      return { allowed: false, status: 503, retryAfter: 1 };
    }
    this.active++; client.active++;
    let released = false;
    return { allowed: true, release: () => {
      if (released) return;
      released = true; this.active--; client.active--;
    } };
  }

  private retry(startedAt: number, now: number) { return Math.max(1, Math.ceil((startedAt + windowMs - now) / 1_000)); }
}

export function installRequestSecurity(app: FastifyInstance, config: Config) {
  const gate = new RequestGate(securityOptions(config));
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    // These resource types are embedded by the customer site; do not set CORP same-origin.
    if (!request.url.startsWith('/widget/')) reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Content-Security-Policy', [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:", "font-src 'self' data:", "connect-src 'self'",
      "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'",
    ].join('; '));
    if (config.production && config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');

    const path = request.url.split('?', 1)[0];
    const api = /^\/(?:api|v1)(?:\/|$)/.test(path);
    if (api) reply.header('Cache-Control', 'no-store');
    const admission = gate.enter(request.ip, api, !['GET', 'HEAD', 'OPTIONS'].includes(request.method));
    if (!admission.allowed) {
      reply.header('Retry-After', String(admission.retryAfter));
      reply.header('Cache-Control', 'no-store');
      reply.header('Connection', 'close');
      return reply.code(admission.status).send({ error: {
        code: admission.status === 429 ? 'rate_limit' : 'server_busy',
        message: admission.status === 429 ? 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' : 'Dịch vụ đang bận. Vui lòng thử lại sau.',
      } });
    }
    // Raw events also cover SSE/hijacked replies, which skip Fastify onResponse.
    const release = () => { admission.release(); reply.raw.off('finish', release); reply.raw.off('close', release); request.raw.off('aborted', release); };
    reply.raw.once('finish', release);
    reply.raw.once('close', release);
    request.raw.once('aborted', release);
    if (request.url.length > 2_048) return reply.code(414).send({ error: { code: 'invalid_request', message: 'Đường dẫn quá dài.' } });
  });
}
