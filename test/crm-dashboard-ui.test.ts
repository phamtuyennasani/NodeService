import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { DashboardData, DashboardRuntime, Job } from '../web/src/types';

const origin = 'http://localhost:3224';
const activeId = '12850dc1-a858-42dd-881a-48daff6bb34a';
const staleId = '9e18af13-7d6c-4d74-8ead-4c75e706f20c';

const report: DashboardData = {
  metrics: {
    customers: 1, websites: 1, articles: 12, delivered: 10, pending: 4,
    write_errors: 0, delivery_errors: 0, service_cost_usd: 0, customer_cost_usd: 0, unpriced_attempts: 0,
    service_cost_vnd: '3125', customer_cost_vnd: '9375', total_cost_vnd: '12500',
  },
  series: [{ date: '2020-01-01', articles: 12, delivered: 10, service_cost_usd: '0.125', customer_cost_usd: '0.375', service_cost_vnd: '3125', customer_cost_vnd: '9375', unpriced_attempts: 0 }], upcoming: [], failures: [],
};

function writingJob(id: string, keyword: string): Job {
  return {
    id, job_id: id, keyword, customer_id: 'customer-test', customer_name: 'Khách kiểm thử',
    website_id: 'website-test', website_name: 'Website kiểm thử', mode: 'scheduled', status: 'writing',
    provider: 'openai-compatible', model: 'model-test', tone: 'Chuyên nghiệp', style: 'SEO', length: 1500,
    created_at: '2026-11-20T05:00:00Z', scheduled_at: '2026-11-20T05:10:00Z',
    started_at: '2026-11-20T05:10:00Z', completed_at: null, source_article_id: null,
  };
}

function runtimeData(): DashboardRuntime {
  return {
    observed_at: '2026-11-20T05:12:05Z',
    summary: { writing: 2, queued: 4, scheduled: 6, active_threads: 1, stale_writing: 1, overdue_schedules: 3, oldest_wait_seconds: 185 },
    capacity: { writer_per_process: 5, webhook_per_process: 3 },
    deliveries: { pending: 7, sending: 2, failed: 3, active_threads: 1, stale_sending: 1, oldest_wait_seconds: 65 },
    attention: { write_errors: 4, delivery_errors: 3, stale_writing: 1, stale_sending: 1, unpriced_attempts: 2 },
    workers: {
      writer: { processes: 2, concurrency: 10, active_tasks: 6, last_heartbeat_at: '2026-11-20T05:12:04Z' },
      webhook: { processes: 0, concurrency: 0, active_tasks: 0, last_heartbeat_at: null },
    },
    providers: [{ provider: 'openai-compatible', writing: 2, queued: 4, active_threads: 1 }],
    running: [
      { ...writingJob(activeId, 'bài đang nghiên cứu'), writing_stage: 'research', lease_active: true, elapsed_seconds: 125 },
      { ...writingJob(staleId, 'bài chờ khôi phục'), lease_active: false, elapsed_seconds: 3605 },
    ],
  };
}

async function mockDashboard(browser: Browser, bundle: string, options: { empty?: boolean; failed?: boolean; websiteOnly?: boolean; eventReadyState?: number } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Ho_Chi_Minh' });
  page.setDefaultTimeout(10000);
  await page.clock.install({ time: new Date('2026-11-22T04:00:00Z') });
  const runtimeRequests: URL[] = [];
  const reportRequests: URL[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  let failed = options.failed ?? false;
  const runtime = runtimeData();
  const reportData = structuredClone(report);
  let heldRuntime: { entered: () => void; wait: Promise<void> } | undefined;
  let heldReport: { entered: () => void; wait: Promise<void> } | undefined;
  await page.addInitScript({ content: `
    const originalFetch = window.fetch.bind(window);
    let stream, resume;
    const encoder = new TextEncoder();
    window.__emitCrmEvent = (type, data = {}) => {
      if (type === 'error') { window.__crmStreamReady = false; stream?.error(new TypeError('Fixture disconnect')); stream = undefined; return; }
      if (type === 'open' && resume) { const open = resume; resume = undefined; open(); return; }
      stream?.enqueue(encoder.encode('event: ' + type + '\\ndata: ' + JSON.stringify(data) + '\\n\\n'));
    };
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      if (url.pathname !== '/api/crm/jobs/events') return originalFetch(input, init);
      const signal = init.signal;
      const body = new ReadableStream({ start(controller) { stream = controller; }, cancel() { stream = undefined; } });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      signal?.addEventListener('abort', () => { stream?.error(new DOMException('Aborted', 'AbortError')); stream = undefined; }, { once: true });
      if (${options.eventReadyState === 0} && window.__crmHoldStream !== false) {
        window.__crmHoldStream = false;
        await new Promise((resolve, reject) => { resume = resolve; signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
      }
      window.__crmStreamReady = true;
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  ` });
  if (options.empty) {
    runtime.summary = { writing: 0, queued: 0, scheduled: 0, active_threads: 0, stale_writing: 0, overdue_schedules: 0, oldest_wait_seconds: null };
    runtime.deliveries = { pending: 0, sending: 0, failed: 0, active_threads: 0, stale_sending: 0, oldest_wait_seconds: null };
    runtime.attention = { write_errors: 0, delivery_errors: 0, stale_writing: 0, stale_sending: 0, unpriced_attempts: 0 };
    runtime.providers = [];
    runtime.running = [];
  }
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpected.push(request.url());
      return route.abort();
    }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/crm-test.js"></script></body></html>' });
    if (url.pathname === '/crm-test.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/crm/session/bootstrap') return route.fulfill({ json: { browser_binding: 'b'.repeat(43), server_time: Date.now() } });
    if (url.pathname === '/api/crm/customers') return route.fulfill({ json: { data: [{ id: 'customer-test', name: 'Khách kiểm thử' }] } });
    if (url.pathname === '/api/crm/websites') {
      const data = options.websiteOnly && !url.searchParams.has('id') ? [] : [
        { id: 'website-test', name: 'Website kiểm thử', customer_id: 'customer-test' },
      ];
      return route.fulfill({ json: { data } });
    }
    if (url.pathname === '/api/crm/dashboard') {
      reportRequests.push(url);
      const body = structuredClone(reportData);
      const held = heldReport;
      heldReport = undefined;
      if (held) { held.entered(); await held.wait; }
      return route.fulfill({ json: body });
    }
    if (url.pathname === '/api/crm/dashboard/runtime') {
      runtimeRequests.push(url);
      const body = structuredClone(runtime);
      const held = heldRuntime;
      heldRuntime = undefined;
      if (held) { held.entered(); await held.wait; }
      return failed
        ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Tạm thời không lấy được số liệu.' } } })
        : route.fulfill({ json: body });
    }
    if (url.pathname === '/api/crm/jobs/events') {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': ready\n\n' });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  const query = new URLSearchParams({ from: '2020-01-01', to: '2020-01-31', website_id: 'website-test' });
  if (!options.websiteOnly) query.set('customer_id', 'customer-test');
  await page.goto(`${origin}/?${query}`);
  const panel = page.getByRole('region', { name: 'Hoạt động hiện tại', exact: true });
  await panel.waitFor();
  return {
    page, panel, runtimeRequests, reportRequests, unexpected, pageErrors,
    emitJobEvent: async (type: string, data: { job_id?: string } = {}) => page.evaluate(({ type: eventType, data: eventData }) => {
      (window as any).__emitCrmEvent(eventType, eventData);
    }, { type, data }),
    recover: () => { failed = false; },
    failRuntime: () => { failed = true; },
    runtime, reportData,
    holdNextRuntime: () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      heldRuntime = { entered, wait };
      return { started, release };
    },
    holdNextReport: () => {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      heldReport = { entered, wait };
      return { started, release };
    },
  };
}

test('CRM overview shows current jobs and processing slots independently from historical dates', async t => {
  const { outputFiles } = await build({
    stdin: {
      contents: `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {App, ConfigProvider} from 'antd';
        import {Dashboard} from './web/src/Dashboard';
        import {prepareBrowserLogin} from './web/src/browser-proof';
        prepareBrowserLogin().then(() => {
        createRoot(document.getElementById('root')!).render(
          <ConfigProvider theme={{token:{motion:false}}}><App><Dashboard query={new URLSearchParams(window.location.hash.startsWith('#overview?') ? window.location.hash.split('?')[1] : window.location.search)} /></App></ConfigProvider>
        ); });`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('dashboard cost totals and chart tooltips only display service-key costs in Vietnamese dong', async () => {
      const { page, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        await page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
        await page.addStyleTag({ content: await readFile('web/src/dashboard.css', 'utf8') });
        await page.addStyleTag({ content: '#root { max-width: 1200px; margin: 24px auto; padding: 0 24px; }' });
        const cost = page.locator('.dash-cost');
        await cost.locator('.dash-cost-total').getByText('VNĐ', { exact: true }).waitFor();
        assert.match(await cost.locator('.dash-cost-total').innerText(), /3\.125\s+VNĐ/);
        await cost.locator('.dash-cost-sources').getByText(/3\.125\s₫/, { exact: true }).waitFor();
        assert.equal(await cost.locator('.dash-cost-sources button').count(), 1);
        assert.equal(await cost.locator('.recharts-area').count(), 1);
        // The one-point series sits on the plot's upper boundary; hover inside
        // the plot so integer mouse coordinates cannot round above that boundary.
        await cost.locator('.recharts-surface').hover({ force: true });
        // Recharts throttles mouse events and Redux notifications to animation frames.
        await page.clock.runFor(50);
        await cost.locator('.recharts-default-tooltip').getByText(/3\.125\s₫/, { exact: true }).waitFor();
        assert.doesNotMatch(await cost.innerText(), /9\.375|12\.500|Key khách hàng/);
        await cost.getByText('Chỉ ghi nhận chi phí bài viết dùng hạn mức được cấp, theo ngày gọi AI. Key cá nhân không được theo dõi chi phí.', { exact: true }).waitFor();
        assert.doesNotMatch(await cost.innerText(), /USD|US\$/);
        if (process.env.CRM_CURRENCY_SCREENSHOT) await page.screenshot({ path: process.env.CRM_CURRENCY_SCREENSHOT, fullPage: true });
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('job completion, deletion and reconnect update report counters and queues with a trailing refresh', async () => {
      const { page, reportRequests, reportData, emitJobEvent, holdNextReport, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      const releases: (() => void)[] = [];
      try {
        const reportResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/dashboard');
        await page.locator('.dash-metric').filter({ hasText: 'Bài đã viết' }).getByText('12', { exact: true }).waitFor();
        const held = holdNextReport();
        releases.push(held.release);
        reportData.metrics.articles = 13;
        reportData.metrics.service_cost_vnd = '0.25';
        reportData.metrics.customer_cost_vnd = '500';
        reportData.metrics.total_cost_vnd = '500.25';
        reportData.upcoming = [{ ...writingJob(activeId, 'lịch cần xóa'), status: 'scheduled' }];
        await emitJobEvent('job.updated', { job_id: activeId });
        await page.clock.fastForward(200);
        await held.started;
        reportData.metrics.articles = 14;
        reportData.upcoming = [];
        reportData.failures = [{ ...writingJob(staleId, 'yêu cầu lỗi mới'), status: 'failed' }];
        await emitJobEvent('job.deleted', { job_id: activeId });
        await page.clock.fastForward(200);
        assert.equal(reportRequests.length, 2, 'do not abort an active report request for a new job event');
        const completed = reportResponse();
        const heldTrailing = holdNextReport();
        releases.push(heldTrailing.release);
        held.release();
        await completed;
        await page.locator('.dash-metric').filter({ hasText: 'Bài đã viết' }).getByText('13', { exact: true }).waitFor();
        await page.locator('.dash-cost-sources').getByText('< 1 ₫', { exact: true }).waitFor();
        assert.match(await page.locator('.dash-cost-total').innerText(), /< 1\s+VNĐ/);
        await page.getByRole('button', { name: /lịch cần xóa/ }).waitFor();
        await page.clock.fastForward(200);
        await heldTrailing.started;
        const trailing = reportResponse();
        heldTrailing.release();
        await trailing;
        await page.locator('.dash-metric').filter({ hasText: 'Bài đã viết' }).getByText('14', { exact: true }).waitFor();
        await page.getByRole('button', { name: /yêu cầu lỗi mới/ }).waitFor();
        await page.getByRole('button', { name: /lịch cần xóa/ }).waitFor({ state: 'hidden' });
        reportData.metrics.articles = 15;
        const reconnect = reportResponse();
        await emitJobEvent('ready');
        await page.clock.fastForward(200);
        await reconnect;
        await page.locator('.dash-metric').filter({ hasText: 'Bài đã viết' }).getByText('15', { exact: true }).waitFor();
        assert.equal(reportRequests.length, 4);
        assert.deepEqual(pageErrors, []);
      } finally { releases.forEach(release => release()); await page.close(); }
    });

    await t.test('events received during a runtime request get a trailing refresh and ready repairs missed events', async () => {
      const { page, panel, runtimeRequests, reportRequests, runtime, emitJobEvent, holdNextRuntime, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      const releases: (() => void)[] = [];
      try {
        await panel.getByRole('button', { name: 'Xem chi tiết bài đang nghiên cứu', exact: true }).waitFor();
        const held = holdNextRuntime();
        releases.push(held.release);
        await emitJobEvent('job.updated', { job_id: activeId });
        await page.clock.fastForward(200);
        await held.started;
        runtime.summary.queued = 8;
        await emitJobEvent('job.created', { job_id: staleId });
        await page.clock.fastForward(200);
        assert.equal(runtimeRequests.length, 2, 'serialize refreshes while a request is active');
        const finished = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        const heldTrailing = holdNextRuntime();
        releases.push(heldTrailing.release);
        held.release();
        await finished;
        await page.clock.fastForward(200);
        await heldTrailing.started;
        const trailing = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        heldTrailing.release();
        await trailing;
        await panel.locator('.dash-runtime-stat').filter({ hasText: 'Đang chờ' }).getByText('8', { exact: true }).waitFor();
        assert.equal(runtimeRequests.length, 3);
        const reconnected = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        await emitJobEvent('ready');
        await page.clock.fastForward(200);
        await reconnected;
        assert.equal(runtimeRequests.length, 4);
        assert.equal(reportRequests.length, 4, 'live events and reconnect reconcile report aggregates too');
        assert.deepEqual(pageErrors, []);
      } finally { releases.forEach(release => release()); await page.close(); }
    });

    await t.test('active and stalled jobs, scoped counters, event refresh and navigation', async () => {
      const fixture = await mockDashboard(browser, outputFiles[0].text);
      const { page, panel, runtimeRequests, reportRequests, unexpected, pageErrors, emitJobEvent } = fixture;
      try {
        await panel.getByRole('button', { name: 'Xem chi tiết bài đang nghiên cứu', exact: true }).waitFor();
        assert.equal(await panel.locator('.dash-runtime-stat').filter({ hasText: 'Đang viết' }).locator('strong').innerText(), '2');
        assert.equal(await panel.locator('.dash-runtime-stat').filter({ hasText: 'Đang chờ' }).locator('strong').innerText(), '4');
        assert.equal(await panel.locator('.dash-runtime-stat').filter({ hasText: 'Lease viết còn hiệu lực' }).locator('strong').innerText(), '1');
        assert.match(await panel.innerText(), /Cấu hình mỗi tiến trình: 5 luồng viết · 3 luồng giao bài/);
        await panel.getByText(/^Có job viết quá thời gian lease:/).waitFor();
        assert.equal(await panel.locator('.dash-runtime-warning').count(), 0, 'the attention summary owns recovery warnings');
        await panel.getByText('Chờ phục hồi', { exact: true }).waitFor();
        await panel.getByText('Đang nghiên cứu', { exact: true }).waitFor();
        await panel.getByText('2 phút 5 giây', { exact: true }).waitFor();
        assert.match(await panel.locator('.dash-live').innerText(), /Trực tiếp[\s\S]*Cập nhật 12:12:05/);
        assert.equal(runtimeRequests.length, 1);
        assert.equal(reportRequests.length, 1);
        assert.equal(runtimeRequests[0].searchParams.get('customer_id'), 'customer-test');
        assert.equal(runtimeRequests[0].searchParams.get('website_id'), 'website-test');
        assert.equal(runtimeRequests[0].searchParams.has('from'), false);
        assert.equal(runtimeRequests[0].searchParams.has('to'), false);
        assert.equal(reportRequests[0].searchParams.get('from'), '2020-01-01');

        const refreshed = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        await page.getByRole('button', { name: /Làm mới/ }).click();
        await refreshed;
        await page.getByRole('button', { name: /Làm mới/ }).waitFor({ state: 'visible' });
        assert.equal(runtimeRequests.length, 2);
        assert.equal(reportRequests.length, 2);

        await page.clock.fastForward(5000);
        assert.equal(runtimeRequests.length, 2, 'local elapsed-time ticks do not request another runtime snapshot before its refresh interval');
        assert.equal(reportRequests.length, 2, 'local elapsed-time ticks do not reload the historical report');
        const eventRefresh = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        await emitJobEvent('job.updated', { job_id: activeId });
        await page.clock.fastForward(200);
        await eventRefresh;
        assert.equal(runtimeRequests.length, 3, 'refresh the current runtime endpoint after a job event');
        assert.equal(reportRequests.length, 3, 'refresh report aggregates after a job event');
        await panel.getByRole('button', { name: 'Xem chi tiết bài đang nghiên cứu', exact: true }).click();
        assert.equal(new URL(page.url()).hash, `#jobs?job=${activeId}`);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('current attention links preserve customer and website scope without historical dates', async () => {
      const { page, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        const attention = page.getByRole('region', { name: 'Cần xử lý', exact: true });
        await attention.getByRole('button', { name: /^Lỗi viết/ }).waitFor();
        const links = [
          { name: /^Lỗi viết/, page: 'jobs', filter: ['status', 'failed'], count: '4' },
          { name: /^Lỗi giao bài/, page: 'deliveries', filter: ['status', 'failed'], count: '3' },
          { name: /^Chờ phục hồi/, page: 'jobs', filter: ['issue', 'stale'], count: '2' },
          { name: /^Xem lượt giao chờ phục hồi/, page: 'deliveries', filter: ['issue', 'stale'] },
        ];
        for (const link of links) {
          const button = attention.getByRole('button', { name: link.name });
          if (link.count) assert.equal(await button.locator('strong').innerText(), link.count);
          await button.click();
          const [destination, query] = new URL(page.url()).hash.slice(1).split('?');
          const filters = new URLSearchParams(query);
          assert.equal(destination, link.page);
          assert.equal(filters.get('customer_id'), 'customer-test');
          assert.equal(filters.get('website_id'), 'website-test');
          assert.equal(filters.get(link.filter[0]), link.filter[1]);
          assert.equal(filters.has('from'), false, 'current issues must not inherit an old reporting period');
          assert.equal(filters.has('to'), false);
        }
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('delivery queue ages and overdue schedules are distinct from global worker capacity', async () => {
      const { page, panel, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        const delivery = panel.locator('[aria-label="Hoạt động giao bài"]');
        await delivery.getByRole('button', { name: /^Chờ giao/ }).waitFor();
        assert.equal(await delivery.getByRole('button', { name: /^Chờ giao/ }).locator('strong').innerText(), '7');
        assert.equal(await delivery.getByRole('button', { name: /^Đang giao/ }).locator('strong').innerText(), '2');
        assert.equal(await delivery.getByRole('button', { name: /^Giao lỗi/ }).locator('strong').innerText(), '3');
        await delivery.getByText('Lâu nhất 1 phút 5 giây', { exact: true }).waitFor();
        await panel.getByText('Chờ viết lâu nhất: 3 phút 5 giây', { exact: true }).waitFor();
        const workers = panel.locator('[aria-label="Tiến trình worker thực tế"]');
        assert.match(await workers.innerText(), /Toàn hệ thống/);
        assert.match(await workers.locator('div').filter({ hasText: 'Worker viết' }).innerText(), /2 tiến trình · 10 luồng nhận việc/);
        assert.match(await workers.locator('div').filter({ hasText: 'Worker viết' }).innerText(), /6 lượt kiểm tra \/ xử lý đang chạy/);
        assert.match(await workers.locator('.dash-worker-offline').innerText(), /Worker giao[\s\S]*0 tiến trình · 0 luồng nhận việc[\s\S]*Chưa nhận heartbeat còn hiệu lực/);
        assert.match(await panel.locator('.dash-runtime-context').innerText(), /Cấu hình mỗi tiến trình: 5 luồng viết · 3 luồng giao bài/);
        for (const [button, destination, key, value] of [
          [delivery.getByRole('button', { name: /^Chờ giao/ }), 'deliveries', 'status', 'pending'],
          [delivery.getByRole('button', { name: /^Đang giao/ }), 'deliveries', 'status', 'sending'],
          [delivery.getByRole('button', { name: /^Giao lỗi/ }), 'deliveries', 'status', 'failed'],
          [panel.getByRole('button', { name: /^3 lịch đã quá giờ/ }), 'jobs', 'issue', 'overdue'],
          [panel.getByRole('button', { name: /^6 lịch chưa đến giờ/ }), 'jobs', 'issue', 'future'],
        ] as const) {
          await button.click();
          const [route, query] = new URL(page.url()).hash.slice(1).split('?');
          const filters = new URLSearchParams(query);
          assert.equal(route, destination);
          assert.equal(filters.get(key), value);
          assert.equal(filters.get('customer_id'), 'customer-test');
          assert.equal(filters.get('website_id'), 'website-test');
          assert.equal(filters.has('from'), false);
        }
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('connection state follows the signed event stream and elapsed time ticks locally while heartbeat snapshots refresh', async () => {
      const { page, panel, runtimeRequests, reportRequests, emitJobEvent, holdNextRuntime, pageErrors } = await mockDashboard(browser, outputFiles[0].text, { eventReadyState: 0 });
      let release: (() => void) | undefined;
      try {
        await panel.getByRole('button', { name: 'Xem chi tiết bài đang nghiên cứu', exact: true }).waitFor();
        assert.match(await panel.locator('.dash-live').innerText(), /^Đang kết nối/);
        const active = panel.getByRole('button', { name: 'Xem chi tiết bài đang nghiên cứu', exact: true });
        await active.getByText('2 phút 5 giây', { exact: true }).waitFor();
        await page.clock.fastForward(1000);
        await active.getByText('2 phút 6 giây', { exact: true }).waitFor();
        assert.equal(runtimeRequests.length, 1, 'render elapsed seconds without a network request every second');
        const connected = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        await emitJobEvent('open');
        await emitJobEvent('ready');
        await page.clock.fastForward(200);
        await connected;
        assert.match(await panel.locator('.dash-live').innerText(), /^Trực tiếp/);
        await emitJobEvent('error');
        assert.match(await panel.locator('.dash-live').innerText(), /^Đang kết nối lại/);
        assert.equal(runtimeRequests.length, 2, 'an SSE error changes connection state without claiming new data');
        const reconnected = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        await page.clock.fastForward(1000);
        await page.waitForFunction(() => Boolean((window as any).__crmStreamReady));
        await emitJobEvent('ready');
        await page.clock.fastForward(200);
        await reconnected;
        assert.match(await panel.locator('.dash-live').innerText(), /^Trực tiếp/);
        const held = holdNextRuntime();
        release = held.release;
        await page.clock.fastForward(10000);
        await page.clock.fastForward(200);
        await held.started;
        assert.equal(runtimeRequests.length, 4, 'refresh runtime periodically even if SSE has no job events');
        assert.equal(reportRequests.length, 3, 'heartbeat checks do not reload historical reports every ten seconds');
        await page.clock.fastForward(31000);
        await panel.locator('.dash-live').getByText('Chưa cập nhật được', { exact: false }).waitFor();
        const heldFresh = holdNextRuntime();
        held.release();
        release = heldFresh.release;
        await page.clock.fastForward(200);
        await heldFresh.started;
        assert.match(await panel.locator('.dash-live').innerText(), /^Chưa cập nhật được/, 'a delayed old response cannot make the snapshot look fresh');
        const fresh = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        heldFresh.release();
        release = undefined;
        await fresh;
        await page.waitForFunction(() => document.querySelector('.dash-runtime')?.getAttribute('aria-busy') === 'false');
        assert.match(await panel.locator('.dash-live').innerText(), /^Trực tiếp/);
        assert.deepEqual(pageErrors, []);
      } finally { release?.(); await page.close(); }
    });

    await t.test('recent write and delivery errors display causes and open the correct detail', async () => {
      const { page, runtime, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        await page.locator('.dash-metric').filter({ hasText: 'Bài đã viết' }).waitFor();
        runtime.write_failures = [{ ...writingJob(staleId, 'Bài thiếu thông tin'), status: 'failed', error_message: 'Nhà cung cấp từ chối model đã chọn', error_code: 'MODEL_UNAVAILABLE' }];
        runtime.delivery_failures = [{ id: 'delivery-test', job_id: activeId, keyword: 'Bài giao chưa thành công', website_name: 'Website kiểm thử', status: 'failed', event_type: 'article.ready', attempt_count: 4, attempts: 4, last_http_status: 503, last_error: 'Website đích đang bảo trì', created_at: '2026-11-20T05:00:00Z' }];
        const refreshed = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        await page.getByRole('button', { name: /Làm mới/ }).click();
        await refreshed;
        const errors = page.locator('.dash-queues .panel').filter({ has: page.getByRole('heading', { name: 'Lỗi gần đây', exact: true }) });
        await errors.getByText('Nhà cung cấp từ chối model đã chọn', { exact: true }).waitFor();
        await errors.getByRole('button', { name: /Bài thiếu thông tin/ }).click();
        assert.equal(new URL(page.url()).hash, `#jobs?job=${staleId}`);
        await errors.getByRole('tab', { name: 'Lỗi giao bài', exact: true }).click();
        await errors.getByText('Website đích đang bảo trì', { exact: true }).waitFor();
        await errors.getByText(/4 lần gửi/).waitFor();
        await errors.getByRole('button', { name: /Bài giao chưa thành công/ }).click();
        assert.equal(new URL(page.url()).hash, '#deliveries?delivery=delivery-test');
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('pending cost counters show no reconciliation action and service costs open quota jobs in the selected period', async () => {
      const { page, reportData, reportRequests, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        await page.locator('.dash-metric').filter({ hasText: 'Bài đã viết' }).waitFor();
        reportData.metrics.unpriced_attempts = 6;
        reportData.metrics.service_cost_vnd = '100';
        const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/dashboard');
        await page.getByRole('button', { name: /Làm mới/ }).click();
        await refreshed;
        await page.waitForFunction(() => /100\s+VNĐ/.test(document.querySelector('.dash-cost-total')?.textContent ?? ''));
        assert.doesNotMatch(await page.locator('#root').innerText(), /đối soát/i);
        assert.equal(await page.locator('.dash-attention-items button').count(), 3);
        await page.locator('.dash-cost').getByRole('button', { name: /^Key dịch vụ/ }).click();
        const [destination, query] = new URL(page.url()).hash.slice(1).split('?');
        const filters = new URLSearchParams(query);
        assert.equal(destination, 'jobs');
        assert.equal(filters.get('date_basis'), 'cost');
        assert.equal(filters.get('key_mode'), 'service');
        assert.equal(filters.has('issue'), false);
        assert.equal(filters.get('customer_id'), 'customer-test');
        assert.equal(filters.get('website_id'), 'website-test');
        assert.equal(filters.get('from'), '2020-01-01');
        assert.equal(filters.get('to'), '2020-01-31');
        assert.equal(reportRequests.at(-1)?.searchParams.get('from'), filters.get('from'));
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('recent error tabs show only five rows and link to the full filtered list', async () => {
      const { page, runtime, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        await page.locator('.dash-metric').filter({ hasText: 'Bài đã viết' }).waitFor();
        runtime.write_failures = Array.from({ length: 6 }, (_, index) => ({
          ...writingJob(`write-failure-${index + 1}`, `Yêu cầu lỗi thứ ${index + 1}`), status: 'failed', error_message: `Nguyên nhân viết ${index + 1}`,
        }));
        runtime.delivery_failures = Array.from({ length: 6 }, (_, index) => ({
          id: `delivery-failure-${index + 1}`, job_id: `source-${index + 1}`, keyword: `Lượt giao lỗi thứ ${index + 1}`, website_name: 'Website kiểm thử',
          status: 'failed', event_type: 'article.ready', attempt_count: 2, attempts: 2, last_error: `Nguyên nhân giao ${index + 1}`, created_at: '2026-11-20T05:00:00Z',
        }));
        const refreshed = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        await page.getByRole('button', { name: /Làm mới/ }).click();
        await refreshed;
        const errors = page.locator('.dash-queues .panel').filter({ has: page.getByRole('heading', { name: 'Lỗi gần đây', exact: true }) });
        for (const [tab, rowPrefix, destination] of [['Lỗi viết', 'Yêu cầu lỗi thứ', 'jobs'], ['Lỗi giao bài', 'Lượt giao lỗi thứ', 'deliveries']] as const) {
          await errors.getByRole('tab', { name: tab, exact: true }).click();
          await errors.getByRole('button', { name: new RegExp(`${rowPrefix} 5`) }).waitFor();
          assert.equal(await errors.getByRole('button', { name: new RegExp(rowPrefix) }).count(), 5);
          assert.equal(await errors.getByRole('button', { name: new RegExp(`${rowPrefix} 6`) }).count(), 0);
          await errors.getByRole('button', { name: /Xem tất cả/ }).click();
          const [route, query] = new URL(page.url()).hash.slice(1).split('?');
          const filters = new URLSearchParams(query);
          assert.equal(route, destination);
          assert.equal(filters.get('status'), 'failed');
          assert.equal(filters.get('customer_id'), 'customer-test');
          assert.equal(filters.get('website_id'), 'website-test');
          assert.equal(filters.has('from'), false);
          assert.equal(filters.has('to'), false);
        }
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('calendar date presets and reset persist filters without duplicate buttons and support browser back and reload', async () => {
      const { page, runtimeRequests, reportRequests, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        await page.locator('.dash-metric').filter({ hasText: 'Bài đã viết' }).waitFor();
        for (const label of ['Hôm nay', '14 ngày qua', 'Tháng này']) {
          assert.equal(await page.getByRole('button', { name: label, exact: true }).count(), 0);
        }
        assert.equal(await page.locator('.dash-period-presets').count(), 0);
        const dateInputs = page.locator('.dash-filters .ant-picker-input input');
        await dateInputs.first().click();
        const calendarPresets = page.locator('.dash-period-popup:visible .ant-picker-presets');
        for (const label of ['Hôm nay', '14 ngày qua', 'Tháng này']) {
          await calendarPresets.getByText(label, { exact: true }).waitFor();
        }
        const todayResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/dashboard');
        await calendarPresets.getByText('Hôm nay', { exact: true }).click();
        await todayResponse;
        let filters = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
        assert.equal(filters.get('from'), '2026-11-22');
        assert.equal(filters.get('to'), '2026-11-22');
        assert.equal(filters.get('customer_id'), 'customer-test');
        assert.equal(filters.get('website_id'), 'website-test');
        await dateInputs.first().click();
        const fortnightResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/dashboard');
        await calendarPresets.getByText('14 ngày qua', { exact: true }).click();
        await fortnightResponse;
        assert.equal(new URLSearchParams(new URL(page.url()).hash.split('?')[1]).get('from'), '2026-11-09');
        await page.goBack();
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('.dash-filters .ant-picker-input input')].every(input => input.value === '22/11/2026'));
        await page.reload();
        await page.getByRole('region', { name: 'Hoạt động hiện tại', exact: true }).waitFor();
        assert.equal(await dateInputs.first().inputValue(), '22/11/2026');
        assert.equal(await dateInputs.nth(1).inputValue(), '22/11/2026');
        assert.equal(await page.getByRole('button', { name: 'Hôm nay', exact: true }).count(), 0);
        const runtimeBeforeReset = runtimeRequests.length;
        const resetResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/dashboard/runtime');
        await page.getByRole('button', { name: /Xóa bộ lọc/ }).click();
        await resetResponse;
        filters = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
        assert.equal(filters.get('from'), '2026-11-09');
        assert.equal(filters.get('to'), '2026-11-22');
        assert.equal(filters.has('customer_id'), false);
        assert.equal(filters.has('website_id'), false);
        assert.equal(runtimeRequests.length, runtimeBeforeReset + 1);
        assert.equal(runtimeRequests.at(-1)?.searchParams.has('customer_id'), false);
        assert.equal(reportRequests.at(-1)?.searchParams.get('from'), '2026-11-09');
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('overview and its primary controls fit a 320px viewport with the actual dashboard styles', async () => {
      const { page, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        await page.setViewportSize({ width: 320, height: 900 });
        await page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
        await page.addStyleTag({ content: await readFile('web/src/dashboard.css', 'utf8') });
        await page.addStyleTag({ content: 'html { scrollbar-gutter: stable; } #root { max-width: 1200px; margin: 16px auto; padding: 0 12px; }' });
        await page.getByRole('region', { name: 'Cần xử lý', exact: true }).waitFor();
        const bounds = await page.evaluate(() => {
          const viewport = document.documentElement.clientWidth;
          const selector = '.dash, .dash-filters, .dash-attention, .dash-runtime, .dash-metrics, .dash-charts, .dash-queues, .dash-running-jobs button';
          return { viewport, width: document.documentElement.scrollWidth, overflow: [...document.querySelectorAll(selector)].map(element => ({ name: element.className, rect: element.getBoundingClientRect() })).filter(({ rect }) => rect.left < -1 || rect.right > viewport + 1).map(({ name, rect }) => ({ name, left: rect.left, right: rect.right })) };
        });
        assert.deepEqual(bounds.overflow, [], 'primary panels and running-job controls remain within the viewport');
        assert.ok(bounds.width <= bounds.viewport, `page width ${bounds.width}px exceeds ${bounds.viewport}px layout viewport with a reserved scrollbar gutter`);
        await page.getByRole('button', { name: /Xóa bộ lọc/ }).waitFor({ state: 'visible' });
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('idle view uses zero counters and no stalled-job warning', async () => {
      const { page, panel, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text, { empty: true });
      try {
        await panel.getByText('Hàng đợi đang trống', { exact: true }).waitFor();
        assert.deepEqual(await panel.locator('.dash-runtime-stat strong').allTextContents(), ['0', '0', '0', '0', '0', '0']);
        assert.equal(await panel.getByText('Hiện không có job đang viết', { exact: true }).count(), 0);
        await panel.getByRole('button', { name: 'Xem chi tiết', exact: true }).click();
        await panel.getByText('Hiện không có job đang viết', { exact: true }).waitFor();
        assert.equal(await page.getByRole('region', { name: 'Cần xử lý', exact: true }).getByRole('button', { disabled: false }).count(), 0);
        assert.equal(await panel.getByText('Có job viết quá thời gian lease', { exact: true }).count(), 0);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
    await t.test('the customer metric opens the owner when only a website is selected', async () => {
      const { page, reportRequests, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text, { websiteOnly: true });
      try {
        await page.getByRole('button', { name: /^Khách hàng/ }).waitFor();
        assert.equal(reportRequests[0].searchParams.has('customer_id'), false);
        assert.equal(reportRequests[0].searchParams.get('website_id'), 'website-test');
        await page.getByRole('button', { name: /^Khách hàng/ }).click();
        assert.equal(new URL(page.url()).hash, '#customers?customer=customer-test');
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
    await t.test('runtime failure is visible and can be retried without losing the historical report', async () => {
      const { page, panel, recover, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text, { failed: true });
      try {
        await panel.getByText('Không thể cập nhật hoạt động hiện tại', { exact: true }).waitFor();
        await page.getByText('Bài đã viết', { exact: true }).waitFor();
        recover();
        await panel.getByRole('button', { name: 'Thử lại', exact: true }).click();
        await panel.getByRole('button', { name: 'Xem chi tiết bài đang nghiên cứu', exact: true }).waitFor();
        assert.equal(await panel.getByText('Không thể cập nhật hoạt động hiện tại', { exact: true }).count(), 0);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
