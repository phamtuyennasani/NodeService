import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { DashboardData, DashboardRuntime } from '../web/src/types';

const origin = 'http://localhost:3228';
const report: DashboardData = {
  metrics: {
    customers: 1, websites: 1, articles: 4, delivered: 3, pending: 2, write_errors: 0, delivery_errors: 0,
    service_cost_usd: '0', customer_cost_usd: '0', service_cost_vnd: '0', customer_cost_vnd: '0', total_cost_vnd: '0', unpriced_attempts: 0,
  },
  series: [], upcoming: [], failures: [],
};
const runtime: DashboardRuntime = {
  observed_at: '2026-11-22T04:00:00Z',
  summary: { writing: 0, queued: 0, scheduled: 0, active_threads: 0, stale_writing: 0 },
  capacity: { writer_per_process: 2, webhook_per_process: 2 }, providers: [], running: [],
};

function calendarData(month: string, date: string | null) {
  const length = new Date(`${month}-01T00:00:00Z`);
  length.setUTCMonth(length.getUTCMonth() + 1, 0);
  const days = Array.from({ length: length.getUTCDate() }, (_, index) => {
    const value = `${month}-${String(index + 1).padStart(2, '0')}`;
    return { date: value, scheduled: value === '2026-11-22' ? 6 : value === '2026-11-23' ? 2 : 0,
      written: value === '2026-11-22' ? 4 : 0, delivered: value === '2026-11-22' ? 3 : 0 };
  });
  const totals = days.reduce((sum, day) => ({ scheduled: sum.scheduled + day.scheduled, written: sum.written + day.written, delivered: sum.delivered + day.delivered }), { scheduled: 0, written: 0, delivered: 0 });
  return {
    timezone: 'Asia/Ho_Chi_Minh', month, date, totals, days,
    hours: date ? Array.from({ length: 24 }, (_, hour) => ({ hour,
      scheduled: date === '2026-11-22' ? hour === 9 ? 4 : hour === 15 ? 2 : 0 : date === '2026-11-23' && hour === 10 ? 2 : 0,
      written: date === '2026-11-22' ? hour === 9 ? 3 : hour === 15 ? 1 : 0 : 0,
      delivered: date === '2026-11-22' ? hour === 9 ? 2 : hour === 15 ? 1 : 0 : 0,
    })) : [],
  };
}

async function mockCalendar(browser: Browser, bundle: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, timezoneId: 'Asia/Ho_Chi_Minh' });
  page.setDefaultTimeout(10000);
  await page.clock.install({ time: new Date('2026-11-22T04:00:00Z') });
  await page.addInitScript({ content: `
    class TestEventSource extends EventTarget {
      static instances = [];
      constructor(url) { super(); this.url = url; this.readyState = 1; TestEventSource.instances.push(this); }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: TestEventSource });
    Object.defineProperty(window, '__crmEventSources', { configurable: true, value: TestEventSource.instances });
  ` });
  const calendarRequests: URL[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  let failed = false;
  let writtenCount = 4;
  let hold: { entered: () => void; wait: Promise<void> } | undefined;
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { unexpected.push(url.href); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/crm-test.js"></script></body></html>' });
    if (url.pathname === '/crm-test.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/crm/customers') return route.fulfill({ json: { data: [{ id: 'customer-test', name: 'Khách kiểm thử' }] } });
    if (url.pathname === '/api/crm/websites') return route.fulfill({ json: { data: [{ id: 'website-test', name: 'Website kiểm thử', customer_id: 'customer-test' }] } });
    if (url.pathname === '/api/crm/dashboard') return route.fulfill({ json: report });
    if (url.pathname === '/api/crm/dashboard/runtime') return route.fulfill({ json: runtime });
    if (url.pathname === '/api/crm/jobs/events') return route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' });
    if (url.pathname === '/api/crm/dashboard/calendar') {
      calendarRequests.push(url);
      const body = calendarData(url.searchParams.get('month')!, url.searchParams.get('date'));
      if (body.month === '2026-11') {
        body.totals.written += writtenCount - 4;
        body.days.find(day => day.date === '2026-11-22')!.written = writtenCount;
        if (body.date === '2026-11-22') body.hours.find(hour => hour.hour === 9)!.written += writtenCount - 4;
      }
      const held = hold; hold = undefined;
      if (held) { held.entered(); await held.wait; }
      if (failed) return route.fulfill({ status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Tạm thời không lấy được lịch bài viết.' } } });
      return route.fulfill({ json: body });
    }
    unexpected.push(`${route.request().method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(`${origin}/#overview?from=2026-11-09&to=2026-11-22&customer_id=customer-test&website_id=website-test`);
  await page.getByRole('heading', { name: 'Tổng quan', exact: true }).waitFor();
  return {
    page, calendarRequests, unexpected, pageErrors,
    fail: () => { failed = true; }, recover: () => { failed = false; },
    setWrittenCount: (value: number) => { writtenCount = value; },
    emitJobEvent: async (type: string) => page.evaluate(eventType => {
      const source = (window as typeof window & { __crmEventSources: EventTarget[] }).__crmEventSources[0];
      source.dispatchEvent(new MessageEvent(eventType, { data: JSON.stringify({ job_id: 'calendar-job' }) }));
    }, type),
    holdNext: () => {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      hold = { entered, wait };
      return { started, release };
    },
    open: async () => {
      await page.getByRole('button', { name: /Xem dạng lịch/ }).click();
      await page.getByRole('heading', { name: 'Lịch bài viết', exact: true }).waitFor();
      await page.locator('button[data-date="2026-11-22"]').waitFor();
    },
  };
}

async function addStyles(page: Awaited<ReturnType<typeof mockCalendar>>['page']) {
  await page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
  await page.addStyleTag({ content: await readFile('web/src/dashboard.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('web/src/overview-calendar.css', 'utf8') });
  await page.addStyleTag({ content: 'html { scrollbar-gutter: stable; } #root { max-width: 1200px; margin: 24px auto; padding: 0 20px; }' });
}

test('CRM calendar opens from overview and presents scoped monthly and hourly article counts', async t => {
  const { outputFiles } = await build({
    stdin: {
      contents: `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {App, ConfigProvider} from 'antd';
        import {Dashboard} from './web/src/Dashboard';
        createRoot(document.getElementById('root')!).render(
          <ConfigProvider theme={{token:{motion:false}}}><App><Dashboard query={new URLSearchParams(window.location.hash.startsWith('#overview?') ? window.location.hash.split('?')[1] : window.location.search)} /></App></ConfigProvider>
        );`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('month cells include all three counts and scope is preserved when opening, browsing and returning', async () => {
      const fixture = await mockCalendar(browser, outputFiles[0].text);
      const { page, calendarRequests, unexpected, pageErrors } = fixture;
      try {
        await fixture.open();
        const first = calendarRequests[0];
        assert.equal(first.searchParams.get('month'), '2026-11');
        assert.equal(first.searchParams.get('customer_id'), 'customer-test');
        assert.equal(first.searchParams.get('website_id'), 'website-test');
        assert.equal(first.searchParams.has('date'), false);
        const calendar = page.getByRole('table', { name: 'Lịch bài viết theo tháng', exact: true });
        await calendar.waitFor();
        assert.equal(await calendar.locator('button[data-date^="2026-11-"]').count(), 30);
        assert.match(await calendar.locator('[data-date="2026-11-22"]').getAttribute('aria-label') ?? '', /6 lên lịch, 4 đã viết, 3 đã giao/);
        assert.match(await calendar.locator('[data-date="2026-11-21"]').getAttribute('aria-label') ?? '', /0 lên lịch, 0 đã viết, 0 đã giao/);
        await addStyles(page);
        if (process.env.CRM_CALENDAR_SCREENSHOT) await page.screenshot({ path: process.env.CRM_CALENDAR_SCREENSHOT, fullPage: true });
        await page.getByRole('button', { name: 'Tháng sau', exact: true }).click();
        await page.locator('button[data-date="2026-12-01"]').waitFor();
        assert.equal(calendarRequests.at(-1)?.searchParams.get('month'), '2026-12');
        await page.getByRole('button', { name: 'Tháng trước', exact: true }).click();
        await page.locator('button[data-date="2026-11-22"]').waitFor();
        assert.equal(calendarRequests.at(-1)?.searchParams.get('month'), '2026-11');
        assert.equal(calendarRequests.at(-1)?.searchParams.get('customer_id'), 'customer-test');
        await page.getByRole('button', { name: /Về tổng quan/ }).click();
        await page.getByRole('heading', { name: 'Tổng quan', exact: true }).waitFor();
        const filters = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
        assert.equal(filters.get('customer_id'), 'customer-test');
        assert.equal(filters.get('website_id'), 'website-test');
        assert.equal(filters.get('from'), '2026-11-09');
        assert.equal(filters.get('to'), '2026-11-22');
        assert.equal(filters.has('view'), false);
        await page.goBack();
        await page.getByRole('heading', { name: 'Lịch bài viết', exact: true }).waitFor();
        await page.goForward();
        await page.getByRole('heading', { name: 'Tổng quan', exact: true }).waitFor();
        await fixture.open();
        await page.reload();
        await page.getByRole('heading', { name: 'Lịch bài viết', exact: true }).waitFor();
        await page.locator('button[data-date="2026-11-22"]').waitFor();
        assert.equal(calendarRequests.at(-1)?.searchParams.get('website_id'), 'website-test');
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('selecting a day shows 24 Vietnam hours and can browse days or return to the month', async () => {
      const fixture = await mockCalendar(browser, outputFiles[0].text);
      const { page, calendarRequests, unexpected, pageErrors } = fixture;
      try {
        await fixture.open();
        await page.locator('button[data-date="2026-11-22"]').click();
        const hours = page.getByRole('table', { name: 'Số bài viết theo giờ', exact: true });
        await hours.waitFor();
        assert.equal(calendarRequests.at(-1)?.searchParams.get('date'), '2026-11-22');
        assert.equal(await hours.locator('tbody tr').count(), 24);
        const hourNine = hours.locator('tbody tr').filter({ hasText: /^09:00/ });
        assert.match((await hourNine.innerText()).replace(/\s+/g, ' '), /09:00.*4.*3.*2/);
        await hours.getByText(/Giờ Việt Nam.*UTC\+7/).waitFor();
        await addStyles(page);
        if (process.env.CRM_CALENDAR_DAY_SCREENSHOT) await page.screenshot({ path: process.env.CRM_CALENDAR_DAY_SCREENSHOT, fullPage: true });
        const nextDay = page.waitForResponse(response => new URL(response.url()).searchParams.get('date') === '2026-11-23');
        await page.getByRole('button', { name: 'Ngày sau', exact: true }).click();
        await nextDay;
        assert.equal(calendarRequests.at(-1)?.searchParams.get('date'), '2026-11-23');
        const previousDay = page.waitForResponse(response => new URL(response.url()).searchParams.get('date') === '2026-11-22');
        await page.getByRole('button', { name: 'Ngày trước', exact: true }).click();
        await previousDay;
        await page.getByRole('button', { name: /Xem theo tháng/ }).click();
        await page.getByRole('table', { name: 'Lịch bài viết theo tháng', exact: true }).waitFor();
        assert.equal(calendarRequests.at(-1)?.searchParams.has('date'), false);
        await page.locator('button[data-date="2026-11-30"]').click();
        await page.getByRole('table', { name: 'Số bài viết theo giờ', exact: true }).waitFor();
        const december = page.waitForResponse(response => new URL(response.url()).searchParams.get('date') === '2026-12-01');
        await page.getByRole('button', { name: 'Ngày sau', exact: true }).click();
        await december;
        await page.getByRole('heading', { name: 'Ngày 01/12/2026', exact: true }).waitFor();
        assert.equal(calendarRequests.at(-1)?.searchParams.get('month'), '2026-12');
        assert.equal(calendarRequests.at(-1)?.searchParams.get('date'), '2026-12-01');
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('month picker selects a different month and current month restores today', async () => {
      const fixture = await mockCalendar(browser, outputFiles[0].text);
      const { page, calendarRequests, unexpected, pageErrors } = fixture;
      try {
        await fixture.open();
        await page.getByRole('textbox', { name: 'Chọn tháng', exact: true }).click();
        await page.locator('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden) .ant-picker-cell[title="2026-02"]').click();
        await page.locator('button[data-date="2026-02-01"]').waitFor();
        assert.equal(calendarRequests.at(-1)?.searchParams.get('month'), '2026-02');
        assert.equal(await page.locator('button[data-date^="2026-02-"]').count(), 28);
        await page.getByRole('button', { name: 'Tháng hiện tại', exact: true }).click();
        await page.locator('button[data-date="2026-11-22"]').waitFor();
        assert.equal(calendarRequests.at(-1)?.searchParams.get('month'), '2026-11');
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('job events during an active calendar request trigger a trailing refresh', async () => {
      const fixture = await mockCalendar(browser, outputFiles[0].text);
      const { page, calendarRequests, unexpected, pageErrors } = fixture;
      const releases: (() => void)[] = [];
      try {
        await fixture.open();
        const count = calendarRequests.length;
        const first = fixture.holdNext(); releases.push(first.release);
        fixture.setWrittenCount(5);
        await fixture.emitJobEvent('job.updated');
        await page.clock.runFor(200);
        await first.started;
        const trailing = fixture.holdNext(); releases.push(trailing.release);
        fixture.setWrittenCount(6);
        await fixture.emitJobEvent('job.created');
        await page.clock.runFor(200);
        assert.equal(calendarRequests.length, count + 1, 'retain the active request until it completes');
        const firstResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/dashboard/calendar');
        first.release(); await firstResponse;
        await page.locator('button[data-date="2026-11-22"][aria-label*="5 đã viết"]').waitFor();
        await page.clock.runFor(200);
        await trailing.started;
        const finalResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/dashboard/calendar');
        trailing.release(); await finalResponse;
        await page.locator('button[data-date="2026-11-22"][aria-label*="6 đã viết"]').waitFor();
        assert.equal(calendarRequests.length, count + 2);
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { releases.forEach(release => release()); await page.close(); }
    });

    await t.test('loading and failed calendar requests do not invent zero counts and retry restores the month', async () => {
      const fixture = await mockCalendar(browser, outputFiles[0].text);
      const { page, calendarRequests, unexpected, pageErrors } = fixture;
      const held = fixture.holdNext();
      try {
        await page.getByRole('button', { name: /Xem dạng lịch/ }).click();
        await held.started;
        assert.equal(await page.locator('button[data-date]').count(), 0, 'no zero-valued grid while the first request is pending');
        fixture.fail(); held.release();
        await page.getByText('Tạm thời không lấy được lịch bài viết.', { exact: true }).waitFor();
        assert.equal(await page.locator('button[data-date]').count(), 0, 'a failed request does not become an empty calendar');
        fixture.recover();
        await page.getByRole('button', { name: /Tải lại/ }).click();
        await page.locator('button[data-date="2026-11-22"]').waitFor();
        assert.ok(calendarRequests.length >= 2);
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { held.release(); await page.close(); }
    });

    await t.test('calendar month and hour views fit a 320px viewport with actual styles', async () => {
      const fixture = await mockCalendar(browser, outputFiles[0].text);
      const { page, pageErrors, unexpected } = fixture;
      try {
        await page.setViewportSize({ width: 320, height: 900 });
        await addStyles(page);
        await fixture.open();
        for (const view of ['month', 'day']) {
          if (view === 'day') {
            await page.locator('button[data-date="2026-11-22"]').click();
            await page.getByRole('table', { name: 'Số bài viết theo giờ', exact: true }).waitFor();
          }
          const bounds = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, width: document.documentElement.scrollWidth }));
          assert.ok(bounds.width <= bounds.viewport + 1, `${view} calendar does not overflow the viewport: ${JSON.stringify(bounds)}`);
        }
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
