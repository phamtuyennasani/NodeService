import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { DashboardData, DashboardRuntime, PartnerAccount } from '../web/src/types';

const origin = 'http://localhost:3268';
const partnerId = '7ae066e5-8f06-4acf-8c3e-144e1ae40175';
const report: DashboardData = {
  metrics: { customers: 0, websites: 0, articles: 0, delivered: 0, pending: 0, write_errors: 0,
    delivery_errors: 0, service_cost_usd: 0, customer_cost_usd: 0, service_cost_vnd: 0, customer_cost_vnd: 0,
    total_cost_vnd: 0, unpriced_attempts: 0 },
  series: [], upcoming: [], failures: [],
};
const runtime: DashboardRuntime = {
  observed_at: new Date().toISOString(), summary: { writing: 0, queued: 0, scheduled: 0, active_threads: 0, stale_writing: 0 },
  capacity: { writer_per_process: 1, webhook_per_process: 1 }, running: [], providers: [],
};

test('root creates and manages partners while provider navigation stays inside its own group', async t => {
  const { outputFiles } = await build({
    stdin: { contents: `import {prepareBrowserLogin} from './web/src/browser-proof'; void prepareBrowserLogin().then(() => import('./web/src/main'));`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', write: false,
    loader: { '.woff': 'empty', '.woff2': 'empty' }, outdir: '/tmp/crm-partner-ui',
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const role of ['root', 'provider'] as const) await t.test(role, async () => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 960 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const errors: string[] = [];
    const requests: URL[] = [];
    const partners: PartnerAccount[] = [{ id: partnerId, name: 'Đối tác A', username: 'partner-a', email: 'partner-a@example.com',
      enabled: true, customer_count: 3, website_count: 4, article_count: 12 }];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== origin) { errors.push('Unexpected external request'); return route.abort(); }
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
      if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles.find(file => file.path.endsWith('.js'))!.text });
      if (url.pathname === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: outputFiles.find(file => file.path.endsWith('.css'))!.text });
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
      if (url.pathname === '/api/crm/session/bootstrap') return route.fulfill({ json: { browser_binding: 'b'.repeat(43), server_time: Date.now() } });
      requests.push(url);
      assert.ok(req.headers()['x-crm-proof']);
      if (url.pathname === '/api/crm/session') return route.fulfill({ json: { username: role, display_name: role === 'root' ? 'Quản trị' : 'Đối tác A', role,
        partner: role === 'provider' ? { id: partnerId, name: 'Đối tác A' } : null, csrf_token: 'fixture-csrf' } });
      if (url.pathname === '/api/crm/partners') {
        assert.equal(role, 'root');
        assert.equal(url.searchParams.has('workspace'), false);
        if (req.method() === 'POST') {
          const draft = req.postDataJSON();
          assert.deepEqual(draft, { name: 'Đối tác B', username: 'partner-b', email: 'partner-b@example.com', password: 'Fixture-password-123' });
          partners.push({ id: '73ed8edb-ef22-46ef-a5c4-9f52b59cb432', ...draft, enabled: true, customer_count: 0, website_count: 0, article_count: 0 });
          return route.fulfill({ status: 201, json: partners[1] });
        }
        return route.fulfill({ json: { data: partners } });
      }
      if (url.pathname === '/api/crm/dashboard') return route.fulfill({ json: report });
      if (url.pathname === '/api/crm/dashboard/runtime') return route.fulfill({ json: runtime });
      if (url.pathname === '/api/crm/jobs/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' });
      if (['/api/crm/providers', '/api/crm/customers', '/api/crm/websites'].includes(url.pathname)) return route.fulfill({ json: { data: [] } });
      errors.push(`Unexpected ${req.method()} ${url.pathname}`);
      return route.abort();
    });
    try {
      await page.goto(`${origin}/#${role === 'root' ? 'partners' : 'providers'}`);
      const sidebar = page.locator('.crm-sidebar');
      if (role === 'root') {
        await page.getByRole('heading', { name: 'Đối tác', exact: true }).waitFor();
        await page.getByRole('button', { name: /Thêm đối tác/ }).click();
        await page.getByLabel('Tên đối tác', { exact: true }).fill('Đối tác B');
        await page.getByLabel('Tên đăng nhập', { exact: true }).fill('partner-b');
        await page.getByLabel('Email nhận OTP', { exact: true }).fill('partner-b@example.com');
        await page.getByLabel('Mật khẩu ban đầu', { exact: true }).fill('Fixture-password-123');
        await page.getByRole('button', { name: 'Lưu đối tác', exact: true }).click();
        await page.getByText('Đã lưu tài khoản đối tác.', { exact: true }).waitFor();
        const row = page.getByRole('row').filter({ hasText: 'partner-a@example.com' });
        await row.getByRole('button', { name: 'Quản lý', exact: true }).click();
        await page.getByRole('heading', { name: 'Tổng quan', exact: true }).waitFor();
        await sidebar.getByRole('link', { name: 'Nhà cung cấp AI', exact: true }).click();
        await page.getByRole('heading', { name: 'Nhà cung cấp AI', exact: true }).waitFor();
        assert.equal(requests.filter(url => url.pathname === '/api/crm/providers').at(-1)!.searchParams.get('workspace'), partnerId);
        await page.reload();
        await page.getByRole('heading', { name: 'Nhà cung cấp AI', exact: true }).waitFor();
        assert.equal(requests.filter(url => url.pathname === '/api/crm/providers').at(-1)!.searchParams.get('workspace'), partnerId);
      } else {
        await page.getByRole('heading', { name: 'Nhà cung cấp AI', exact: true }).waitFor();
        assert.equal(await sidebar.getByRole('link', { name: 'Đối tác', exact: true }).count(), 0);
        assert.equal(await page.getByRole('combobox', { name: 'Nhóm quản lý' }).count(), 0);
        assert.equal(await page.locator('.crm-workspace-name').textContent(), 'Đối tác A');
        await page.goto(`${origin}/#partners`);
        await page.getByText('Chỉ root được quản lý tài khoản đối tác.', { exact: true }).waitFor();
        assert.equal(requests.some(url => url.pathname === '/api/crm/partners'), false);
      }
      await page.setViewportSize({ width: 375, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
});
