import { useEffect, useRef } from 'react';
import { ApiError, request } from './api';
import type { JobDetails } from './types';

/** Re-read only the changed job: event frames deliberately omit article data. */
export function useLiveJobs(callbacks: {
  changed: (job: JobDetails, requestedAt: number) => void;
  deleted: (id: string) => void;
  reconcile: () => void;
  failed: (error: Error) => void;
}) {
  const current = useRef(callbacks);
  current.current = callbacks;
  useEffect(() => {
    const source = new EventSource('/api/crm/jobs/events');
    const pending = new Map<string, { again: boolean; timer?: number; controller?: AbortController }>();
    let disposed = false;
    function refresh(id: string) {
      const state = pending.get(id) ?? { again: false };
      pending.set(id, state);
      state.again = true;
      if (state.timer !== undefined || state.controller) return;
      state.timer = window.setTimeout(async () => {
        state.timer = undefined;
        state.again = false;
        const controller = new AbortController();
        state.controller = controller;
        const requestedAt = performance.now();
        try {
          const job = await request<JobDetails>(`/jobs/${encodeURIComponent(id)}`, { signal: controller.signal });
          if (!disposed && !controller.signal.aborted) current.current.changed(job, requestedAt);
        } catch (error) {
          if (!disposed && !controller.signal.aborted) {
            if (error instanceof ApiError && error.status === 404) current.current.deleted(id);
            else current.current.failed(error as Error);
          }
        } finally {
          state.controller = undefined;
          if (!disposed && !controller.signal.aborted && state.again) refresh(id);
          else if (pending.get(id) === state) pending.delete(id);
        }
      }, 75);
    }
    function receive(event: Event) {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as { job_id?: string; deleted?: boolean };
        if (typeof payload?.job_id !== 'string' || !payload.job_id) return;
        if (event.type === 'job.deleted' || payload.deleted) {
          const state = pending.get(payload.job_id);
          if (state?.timer !== undefined) window.clearTimeout(state.timer);
          state?.controller?.abort();
          pending.delete(payload.job_id);
          current.current.deleted(payload.job_id);
        } else refresh(payload.job_id);
      } catch {
        // A malformed event must not break the live connection.
      }
    }
    const reconcile = () => { if (!document.hidden) current.current.reconcile(); };
    source.addEventListener('job.created', receive);
    source.addEventListener('job.updated', receive);
    source.addEventListener('job.deleted', receive);
    source.addEventListener('ready', reconcile);
    document.addEventListener('visibilitychange', reconcile);
    return () => {
      disposed = true;
      source.close();
      document.removeEventListener('visibilitychange', reconcile);
      for (const state of pending.values()) {
        if (state.timer !== undefined) window.clearTimeout(state.timer);
        state.controller?.abort();
      }
      pending.clear();
    };
  }, []);
}
