import { useEffect, useState } from 'react';
import { browserBodyHash, getBrowserSessionGeneration, prepareBrowserLogin, setBrowserSession, signBrowserChallengeRequest, signBrowserRequest } from './browser-proof';

let csrfToken = '';
let loginChallenge: { id: string; clockOffset: number } | undefined;

export function cancelLoginChallenge() {
  loginChallenge = undefined;
}

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

function assertSessionGeneration(generation: number) {
  if (generation !== getBrowserSessionGeneration()) {
    throw new ApiError(409, 'browser_session_changed', 'Phiên đăng nhập đã thay đổi. Hãy thử lại.');
  }
}

type ReauthenticationHandler = (action: { method: string; target: string }) => Promise<string | null>;
let reauthenticate: ReauthenticationHandler | undefined;
let actionQueue = Promise.resolve();
let sessionChangeQueue = Promise.resolve();

export function setReauthenticationHandler(handler?: ReauthenticationHandler) {
  reauthenticate = handler;
}

/** Also used by SSE so every reconnect carries a fresh proof in a header. */
export async function signedFetch(path: string, options: RequestInit = {}, generation = getBrowserSessionGeneration()): Promise<Response> {
  assertSessionGeneration(generation);
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Địa chỉ CRM không hợp lệ.');
  const target = `/api/crm${path}`;
  const method = (options.method ?? 'GET').toUpperCase();
  if (options.body !== undefined && options.body !== null && typeof options.body !== 'string') throw new Error('CRM chỉ hỗ trợ nội dung JSON.');
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  const preSession = method === 'POST' && ['/login', '/login/verify', '/login/resend'].includes(path);
  if (csrfToken && !preSession) headers.set('X-CSRF-Token', csrfToken);
  if (preSession && path !== '/login') {
    const challengeId = JSON.parse(String(options.body ?? '{}')).challenge_id;
    if (!loginChallenge || challengeId !== loginChallenge.id) throw new ApiError(400, 'login_challenge_required', 'Hãy đăng nhập lại để nhận mã xác minh mới.');
    headers.set('X-CRM-Proof', await signBrowserChallengeRequest(target, method, String(options.body ?? ''), headers, challengeId, loginChallenge.clockOffset));
  } else if (path === '/login' && method === 'POST') {
    const publicKey = JSON.parse(String(options.body)).browser_public_key;
    const thumbprint = await browserBodyHash(JSON.stringify({ kty: publicKey.kty, crv: publicKey.crv, x: publicKey.x, y: publicKey.y }));
    headers.set('X-CRM-Proof', await signBrowserChallengeRequest(target, method, String(options.body ?? ''), headers, thumbprint));
  } else {
    headers.set('X-CRM-Proof', await signBrowserRequest(target, method, String(options.body ?? ''), headers, options.signal ?? undefined));
  }
  // Key lookup/bootstrap/signing may yield while another request rotates the session.
  assertSessionGeneration(generation);
  const response = await fetch(target, { ...options, method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (generation !== getBrowserSessionGeneration()) {
    // A stale SSE response may otherwise leave its network stream running.
    void response.body?.cancel().catch(() => {});
  }
  assertSessionGeneration(generation);
  if (!response.ok) {
    const content = await response.json().catch(() => null);
    assertSessionGeneration(generation);
    if (response.status === 401 && !preSession && path !== '/session') {
      window.dispatchEvent(new Event('crm-session-expired'));
    }
    throw new ApiError(response.status, content?.error?.code ?? '', content?.error?.message ?? 'Không thể kết nối với CRM.');
  }
  return response;
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const generation = getBrowserSessionGeneration();
  const changesSession = ['/login', '/login/verify', '/password', '/logout'].includes(path) && (options.method ?? 'GET').toUpperCase() === 'POST';
  if (!changesSession) return requestInSession(path, options, generation);
  // Do not send competing same-tab Set-Cookie responses. A queued operation
  // belongs to its original session and must be retried explicitly after rotation.
  const previous = sessionChangeQueue;
  let release!: () => void;
  sessionChangeQueue = new Promise(resolve => { release = resolve; });
  try {
    await previous;
    assertSessionGeneration(generation);
    return await requestInSession(path, options, generation);
  } finally { release(); }
}

async function requestInSession<T>(path: string, options: RequestInit, generation: number): Promise<T> {
  let effective = options;
  if (path === '/login' && (options.method ?? 'GET').toUpperCase() === 'POST') {
    loginChallenge = undefined;
    effective = { ...options, body: JSON.stringify({ ...JSON.parse(String(options.body)), browser_public_key: await prepareBrowserLogin() }) };
  }
  let response: Response;
  try { response = await signedFetch(path, effective, generation); }
  catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'reauthentication_required' || !reauthenticate) throw error;
    const handler = reauthenticate;
    const method = (effective.method ?? 'GET').toUpperCase();
    const targetUrl = new URL(`/api/crm${path}`, window.location.origin);
    const target = targetUrl.pathname + targetUrl.search;
    // Request-specific, one-use authorization: never cache a password or unlock the whole session.
    let release!: () => void;
    const previous = actionQueue;
    actionQueue = new Promise(resolve => { release = resolve; });
    let actionToken: string;
    try {
      await previous;
      assertSessionGeneration(generation);
      effective.signal?.throwIfAborted();
      const password = await handler({ method, target });
      assertSessionGeneration(generation);
      if (!password) throw new ApiError(403, 'reauthentication_canceled', 'Đã hủy thao tác.');
      effective.signal?.throwIfAborted();
      const authorization = await signedFetch('/session/authorize', {
        method: 'POST', signal: effective.signal,
        body: JSON.stringify({ current_password: password, method, target, body_hash: await browserBodyHash(String(effective.body ?? '')) }),
      }, generation);
      const value = await authorization.json();
      assertSessionGeneration(generation);
      actionToken = value.action_token;
      if (typeof actionToken !== 'string') throw new Error('Không nhận được xác nhận bảo mật.');
    } finally { release(); }
    const headers = new Headers(effective.headers);
    headers.set('X-CRM-Action-Token', actionToken);
    response = await signedFetch(path, { ...effective, headers }, generation);
  }
  const content = response.status === 204 ? undefined : await response.json();
  assertSessionGeneration(generation);
  if (path === '/login' && content?.otp_required === true) {
    if (typeof content.challenge_id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(content.challenge_id)) throw new Error('Không nhận được yêu cầu xác minh hợp lệ.');
    loginChallenge = { id: content.challenge_id, clockOffset: typeof content.server_time === 'number' ? content.server_time - Date.now() : 0 };
    setBrowserSession(null);
    csrfToken = '';
  } else if (['/login', '/login/verify', '/password'].includes(path)) {
    loginChallenge = undefined;
    setBrowserSession(content);
  }
  if (path === '/login/resend' && loginChallenge && typeof content?.server_time === 'number') loginChallenge.clockOffset = content.server_time - Date.now();
  if (path === '/logout') { loginChallenge = undefined; setBrowserSession(null); }
  return content as T;
}

export function mutate<T>(path: string, method: string, body?: object): Promise<T> {
  return request<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
}

export function withQuery(path: string, parameters: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') query.set(key, String(value));
  });
  return query.size ? `${path}?${query}` : path;
}

export function useResource<T>(path: string | null) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ path: string; data?: T; error?: Error; requestedAt: number }>();
  const [loading, setLoading] = useState(Boolean(path));

  useEffect(() => {
    if (!path) return;
    const abort = new AbortController();
    const requestedAt = performance.now();
    setLoading(true);
    request<T>(path, { signal: abort.signal })
      .then((data) => setResult({ path, data, requestedAt }))
      .catch((error: Error) => {
        if (!abort.signal.aborted) setResult({ path, error, requestedAt });
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [path, revision]);

  const current = result?.path === path ? result : undefined;
  return {
    data: current?.data,
    error: current?.error,
    requestedAt: current?.requestedAt,
    loading: Boolean(path) && (loading || !current),
    reload: () => setRevision((previous) => previous + 1),
  };
}

export function useSearchValue(value: string, delay = 250) {
  const [search, setSearch] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setSearch(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);
  return search.trim() || undefined;
}

export function useCatalog(path: '/customers' | '/websites', selected?: string | null, customerId?: string) {
  const [search, setSearch] = useState('');
  const q = useSearchValue(search);
  type CatalogEntry = { id: string; name: string; customer_id?: string; key_mode?: 'own' | 'service' };
  const list = useResource<{ data: CatalogEntry[] }>(withQuery(path, { q, limit: 50, customer_id: customerId }));
  const current = list.data?.data ?? [];
  const needSelected = selected && !current.some((item) => item.id === selected);
  const exact = useResource<{ data: CatalogEntry[] }>(needSelected ? withQuery(path, { id: selected, limit: 1 }) : null);
  const data = [...(exact.data?.data ?? []), ...current];
  return {
    options: data.map((item) => ({ value: item.id, label: item.name })),
    selected: data.find((item) => item.id === selected),
    loading: list.loading || exact.loading,
    error: list.error ?? exact.error,
    searchConfig: { onSearch: setSearch, filterOption: false },
  };
}
