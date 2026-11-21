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
    summary: { writing: 2, queued: 4, scheduled: 6, active_threads: 1, stale_writing: 1 },
    capacity: { writer_per_process: 5, webhook_per_process: 3 },
    providers: [{ provider: 'openai-compatible', writing: 2, queued: 4, active_threads: 1 }],
    running: [
      { ...writingJob(activeId, 'bài đang nghiên cứu'), writing_stage: 'research', lease_active: true, elapsed_seconds: 125 },
      { ...writingJob(staleId, 'bài chờ khôi phục'), lease_active: false, elapsed_seconds: 3605 },
    ],
  };
}

async function mockDashboard(browser: Browser, bundle: string, options: { empty?: boolean; failed?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Ho_Chi_Minh' });
  page.setDefaultTimeout(10000);
  await page.clock.install();
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
    class TestEventSource extends EventTarget {
      static instances = [];
      constructor(url) {
        super();
        this.url = url;
        this.withCredentials = false;
        this.readyState = 1;
        TestEventSource.instances.push(this);
      }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: TestEventSource });
    Object.defineProperty(window, '__crmEventSources', { configurable: true, value: TestEventSource.instances });
  ` });
  if (options.empty) {
    runtime.summary = { writing: 0, queued: 0, scheduled: 0, active_threads: 0, stale_writing: 0 };
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
    if (url.pathname === '/api/crm/customers') return route.fulfill({ json: { data: [{ id: 'customer-test', name: 'Khách kiểm thử' }] } });
    if (url.pathname === '/api/crm/websites') return route.fulfill({ json: { data: [{ id: 'website-test', name: 'Website kiểm thử' }] } });
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
  await page.goto(`${origin}/?from=2020-01-01&to=2020-01-31&customer_id=customer-test&website_id=website-test`);
  const panel = page.getByRole('region', { name: 'Hoạt động hiện tại', exact: true });
  await panel.waitFor();
  return {
    page, panel, runtimeRequests, reportRequests, unexpected, pageErrors,
    emitJobEvent: async (type: string, data: { job_id?: string } = {}) => page.evaluate(({ type: eventType, data: eventData }) => {
      const source = (window as typeof window & { __crmEventSources: EventTarget[] }).__crmEventSources[0];
      source.dispatchEvent(new MessageEvent(eventType, { data: JSON.stringify(eventData) }));
    }, { type, data }),
    recover: () => { failed = false; },
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
        createRoot(document.getElementById('root')!).render(
          <ConfigProvider theme={{token:{motion:false}}}><App><Dashboard query={new URLSearchParams(window.location.search)} /></App></ConfigProvider>
        );`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('dashboard cost totals, source breakdown and chart tooltips display Vietnamese dong', async () => {
      const { page, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        await page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
        await page.addStyleTag({ content: await readFile('web/src/dashboard.css', 'utf8') });
        await page.addStyleTag({ content: '#root { max-width: 1200px; margin: 24px auto; padding: 0 24px; }' });
        const cost = page.locator('.dash-cost');
        await cost.locator('.dash-cost-total').getByText('VNĐ', { exact: true }).waitFor();
        assert.match(await cost.locator('.dash-cost-total').innerText(), /12\.500\s+VNĐ/);
        await cost.locator('.dash-cost-sources').getByText(/3\.125\s₫/, { exact: true }).waitFor();
        await cost.locator('.dash-cost-sources').getByText(/9\.375\s₫/, { exact: true }).waitFor();
        const dot = cost.locator('.recharts-area-dots circle').first();
        await dot.hover({ force: true });
        await cost.locator('.recharts-default-tooltip').getByText(/3\.125\s₫/, { exact: true }).waitFor();
        await cost.locator('.recharts-default-tooltip').getByText(/9\.375\s₫/, { exact: true }).waitFor();
        assert.doesNotMatch(await cost.innerText(), /USD|US\$/);
        if (process.env.CRM_CURRENCY_SCREENSHOT) await page.screenshot({ path: process.env.CRM_CURRENCY_SCREENSHOT, fullPage: true });
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('job completion, deletion and reconnect update report counters and queues with a trailing refresh', async () => {
      const { page, reportRequests, reportData, emitJobEvent, holdNextReport, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        const reportResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/dashboard');
        await page.locator('.dash-metric').filter({ hasText: 'Bài đã viết' }).getByText('12', { exact: true }).waitFor();
        const held = holdNextReport();
        reportData.metrics.articles = 13;
        reportData.metrics.service_cost_vnd = '500';
        reportData.metrics.customer_cost_vnd = '0.25';
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
        held.release();
        await completed;
        await page.locator('.dash-metric').filter({ hasText: 'Bài đã viết' }).getByText('13', { exact: true }).waitFor();
        await page.locator('.dash-cost-sources').getByText('< 1 ₫', { exact: true }).waitFor();
        assert.match(await page.locator('.dash-cost-total').innerText(), /500\s+VNĐ/);
        await page.getByRole('button', { name: /lịch cần xóa/ }).waitFor();
        const trailing = reportResponse();
        await page.clock.fastForward(200);
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
      } finally { await page.close(); }
    });

    await t.test('events received during a runtime request get a trailing refresh and ready repairs missed events', async () => {
      const { page, panel, runtimeRequests, reportRequests, runtime, emitJobEvent, holdNextRuntime, pageErrors } = await mockDashboard(browser, outputFiles[0].text);
      try {
        await panel.getByRole('button', { name: 'Xem chi tiết bài đang nghiên cứu', exact: true }).waitFor();
        const held = holdNextRuntime();
        await emitJobEvent('job.updated', { job_id: activeId });
        await page.clock.fastForward(200);
        await held.started;
        runtime.summary.queued = 8;
        await emitJobEvent('job.created', { job_id: staleId });
        await page.clock.fastForward(200);
        assert.equal(runtimeRequests.length, 2, 'serialize refreshes while a request is active');
        const finished = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        held.release();
        await finished;
        await panel.getByText('Cập nhật khi job thay đổi', { exact: true }).waitFor();
        await page.waitForFunction(() => document.querySelector('.dash-runtime')?.getAttribute('aria-busy') === 'false');
        const trailing = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        await page.clock.fastForward(200);
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
      } finally { await page.close(); }
    });

    await t.test('active and stalled jobs, scoped counters, event refresh and navigation', async () => {
      const fixture = await mockDashboard(browser, outputFiles[0].text);
      const { page, panel, runtimeRequests, reportRequests, unexpected, pageErrors, emitJobEvent } = fixture;
      try {
        await panel.getByRole('button', { name: 'Xem chi tiết bài đang nghiên cứu', exact: true }).waitFor();
        assert.equal(await panel.locator('.dash-runtime-stat').filter({ hasText: 'Đang viết' }).locator('strong').innerText(), '2');
        assert.equal(await panel.locator('.dash-runtime-stat').filter({ hasText: 'Đang chờ' }).locator('strong').innerText(), '4');
        assert.equal(await panel.locator('.dash-runtime-stat').filter({ hasText: 'Luồng AI đang bận' }).locator('strong').innerText(), '1');
        assert.match(await panel.innerText(), /Cấu hình mỗi tiến trình: 5 luồng viết · 3 luồng giao bài/);
        await panel.getByText('Có job viết quá thời gian lease', { exact: true }).waitFor();
        await panel.getByText('Chờ phục hồi', { exact: true }).waitFor();
        await panel.getByText('Đang nghiên cứu', { exact: true }).waitFor();
        await panel.getByText('2 phút 5 giây', { exact: true }).waitFor();
        assert.match(await panel.locator('.dash-live').innerText(), /^Cập nhật 12:12:05/);
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
        assert.equal(runtimeRequests.length, 2, 'do not poll the current runtime endpoint');
        assert.equal(reportRequests.length, 2, 'do not poll the historical report');
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
    await t.test('idle view uses zero counters and no stalled-job warning', async () => {
      const { page, panel, unexpected, pageErrors } = await mockDashboard(browser, outputFiles[0].text, { empty: true });
      try {
        await panel.getByText('Hiện không có job đang viết', { exact: true }).waitFor();
        assert.deepEqual(await panel.locator('.dash-runtime-stat strong').allTextContents(), ['0', '0', '0']);
        assert.equal(await panel.getByText('Có job viết quá thời gian lease', { exact: true }).count(), 0);
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
