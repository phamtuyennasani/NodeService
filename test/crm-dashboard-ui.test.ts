import assert from 'node:assert/strict';
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
  },
  series: [], upcoming: [], failures: [],
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
      return route.fulfill({ json: report });
    }
    if (url.pathname === '/api/crm/dashboard/runtime') {
      runtimeRequests.push(url);
      return failed
        ? route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Tạm thời không lấy được số liệu.' } } })
        : route.fulfill({ json: runtime });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(`${origin}/?from=2020-01-01&to=2020-01-31&customer_id=customer-test&website_id=website-test`);
  const panel = page.getByRole('region', { name: 'Hoạt động hiện tại', exact: true });
  await panel.waitFor();
  return { page, panel, runtimeRequests, reportRequests, unexpected, pageErrors, recover: () => { failed = false; } };
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
    await t.test('active and stalled jobs, scoped counters, refresh, polling and navigation', async () => {
      const fixture = await mockDashboard(browser, outputFiles[0].text);
      const { page, panel, runtimeRequests, reportRequests, unexpected, pageErrors } = fixture;
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

        const polled = page.waitForResponse(response => response.url().includes('/api/crm/dashboard/runtime'));
        await page.clock.fastForward(5000);
        await polled;
        assert.equal(runtimeRequests.length, 3, 'poll the current runtime endpoint every five seconds');
        assert.equal(reportRequests.length, 2, 'automatic refresh must not reload the historical report');
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
