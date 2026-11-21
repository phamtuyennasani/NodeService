import { useEffect, useState } from 'react';

let csrfToken = '';

export function setCsrfToken(token: string) {
  csrfToken = token;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('Content-Type', 'application/json');
  if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(`/api/crm${path}`, { ...options, headers, credentials: 'same-origin' });
  if (response.status === 204) return undefined as T;
  const content = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path !== '/login' && path !== '/session') {
      window.dispatchEvent(new Event('crm-session-expired'));
    }
    throw new ApiError(response.status, content?.error?.code ?? '', content?.error?.message ?? 'Không thể kết nối với CRM.');
  }
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
  type CatalogEntry = { id: string; name: string };
  const list = useResource<{ data: CatalogEntry[] }>(withQuery(path, { q, limit: 50, customer_id: customerId }));
  const current = list.data?.data ?? [];
  const needSelected = selected && !current.some((item) => item.id === selected);
  const exact = useResource<{ data: CatalogEntry[] }>(needSelected ? withQuery(path, { id: selected, limit: 1 }) : null);
  const data = [...(exact.data?.data ?? []), ...current];
  return {
    options: data.map((item) => ({ value: item.id, label: item.name })),
    loading: list.loading || exact.loading,
    error: list.error ?? exact.error,
    searchConfig: { onSearch: setSearch, filterOption: false },
  };
}
