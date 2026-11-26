import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';

const origin = 'http://localhost:3223';
const instructions = 'Thêm ví dụ thực tế và CSS inline cho bảng.';

async function mockSchedule(browser: Browser, bundle: string, immediate = false, ownKey = false) {
  const page = await browser.newPage({ viewport: { width: 390, height: 1000 }, timezoneId: 'Asia/Ho_Chi_Minh' });
  page.setDefaultTimeout(10000);
  const posts: { method: string; body: unknown; csrf: string | undefined }[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  await page.addInitScript({ content: `
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      if (url.pathname !== '/api/crm/jobs/events') return originalFetch(input, init);
      const signal = init.signal;
      let stream;
      const body = new ReadableStream({ start(controller) { stream = controller; }, cancel() { stream = undefined; } });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      signal?.addEventListener('abort', () => { stream?.error(new DOMException('Aborted', 'AbortError')); stream = undefined; }, { once: true });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
  ` });
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
    if (url.pathname === '/api/crm/jobs' && request.method() === 'GET') return route.fulfill({ json: { data: [], next_cursor: null } });
    if (url.pathname === '/api/crm/jobs/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' });
    if (url.pathname === '/api/crm/customers') return route.fulfill({ json: { data: [{ id: 'customer-test', name: 'Khách kiểm thử', key_mode: ownKey ? 'own' : 'service' }] } });
    if (url.pathname === '/api/crm/websites') return route.fulfill({ json: { data: [{ id: 'website-test', name: 'Website kiểm thử' }] } });
    if (url.pathname === '/api/crm/providers') return route.fulfill({ json: { data: ownKey ? [] : [{ provider: 'openai-compatible', display_name: 'OpenAI Compatible', enabled: true, models: [{ model: 'model-test', display_name: 'Model kiểm thử', enabled: true }] }] } });
    if (url.pathname === (immediate ? '/api/crm/jobs' : '/api/crm/schedules') && request.method() === 'POST') {
      posts.push({ method: request.method(), body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
      return route.fulfill({ status: 202, json: { job_id: immediate ? 'instant-test' : 'scheduled-test', status: immediate ? 'queued' : 'scheduled' } });
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(origin);
  await page.getByRole('button', { name: immediate ? 'Viết bài ngay' : /Lên lịch viết/ }).click();
  const modal = page.locator('.ant-modal');
  await modal.locator('.ant-modal-title').getByText(immediate ? 'Viết bài ngay' : 'Lên lịch viết bài', { exact: true }).waitFor();
  async function select(label: string, option: string) {
    await modal.getByLabel(label, { exact: true }).click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content').getByText(option, { exact: true }).click();
  }
  await select('Khách hàng', 'Khách kiểm thử');
  await select('Website nhận bài', 'Website kiểm thử');
  if (ownKey) await modal.getByLabel('Model AI', { exact: true }).fill('tenant@website/private-model:free');
  else await select('Model AI', 'Model kiểm thử · OpenAI Compatible');
  await modal.getByLabel('Từ khóa', { exact: true }).fill('dịch vụ thiết kế website');
  await select('Giọng văn', 'Chuyên nghiệp');
  await select('Phong cách', 'SEO');
  if (!immediate) await modal.getByLabel('Thời gian viết (giờ Việt Nam)', { exact: true }).fill('2030-01-01T12:00:00');
  await modal.getByLabel('Hướng dẫn thêm', { exact: true }).fill(instructions);
  return { page, modal, posts, unexpected, pageErrors };
}

test('CRM schedule accepts numeric word lengths and rejects invalid lengths', async t => {
  const { outputFiles } = await build({
    stdin: {
      contents: `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {App, ConfigProvider} from 'antd';
        import {Jobs} from './web/src/Jobs';
        import {setCsrfToken} from './web/src/api';
        import {prepareBrowserLogin} from './web/src/browser-proof';
        setCsrfToken('fixture-csrf');
        prepareBrowserLogin().then(() => createRoot(document.getElementById('root')!).render(
          <ConfigProvider theme={{token:{motion:false}}}><App><Jobs query={new URLSearchParams()} /></App></ConfigProvider>
        ));`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    for (const length of [1500, 600, 2500]) {
      await t.test(`${length} words submits as a JSON number`, async () => {
        const { page, modal, posts, unexpected, pageErrors } = await mockSchedule(browser, outputFiles[0].text);
        try {
          await modal.getByLabel('Độ dài (600–2500 từ)', { exact: true }).fill(String(length));
          const response = page.waitForResponse(response => response.url() === `${origin}/api/crm/schedules` && response.request().method() === 'POST');
          await modal.getByRole('button', { name: 'Tạo lịch viết', exact: true }).click();
          await response;
          assert.deepEqual(posts, [{
            method: 'POST', csrf: 'fixture-csrf',
            body: { customer_id: 'customer-test', website_id: 'website-test', model: 'model-test', keyword: 'dịch vụ thiết kế website', length, tone: 'Chuyên nghiệp', style: 'SEO', scheduled_at: '2030-01-01T05:00:00.000Z', instructions, use_research: true },
          }]);
          assert.deepEqual(unexpected, []);
          assert.deepEqual(pageErrors, []);
        } finally { await page.close(); }
      });
    }
    await t.test('invalid edits replace a valid value and can be corrected', async () => {
      const { page, modal, posts, unexpected, pageErrors } = await mockSchedule(browser, outputFiles[0].text);
      try {
        const input = modal.getByLabel('Độ dài (600–2500 từ)', { exact: true });
        for (const length of ['', '599', '2501', '1500.5']) {
          await input.fill('1500');
          await modal.getByLabel('Từ khóa', { exact: true }).click();
          await input.fill(length);
          await modal.getByLabel('Từ khóa', { exact: true }).click();
          await modal.getByRole('button', { name: 'Tạo lịch viết', exact: true }).click();
          await modal.getByText(length ? 'Độ dài phải là số nguyên từ 600 đến 2500 từ.' : 'Nhập từ 600 đến 2500 từ.', { exact: true }).waitFor();
          assert.equal(await input.inputValue(), length, 'invalid input must not be silently clamped into a valid schedule');
          assert.equal(posts.length, 0, `do not schedule invalid length ${JSON.stringify(length)}`);
        }
        await input.fill('1500');
        const response = page.waitForResponse(response => response.url() === `${origin}/api/crm/schedules` && response.request().method() === 'POST');
        await modal.getByRole('button', { name: 'Tạo lịch viết', exact: true }).click();
        await response;
        assert.equal(posts.length, 1, 'a corrected length can be scheduled');
        assert.equal((posts[0].body as { length: unknown }).length, 1500);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
    await t.test('instant writing submits immediately without a schedule time', async () => {
      const { page, modal, posts, unexpected, pageErrors } = await mockSchedule(browser, outputFiles[0].text, true);
      try {
        await modal.getByLabel('Độ dài (600–2500 từ)', { exact: true }).fill('1500');
        const response = page.waitForResponse(response => response.url() === `${origin}/api/crm/jobs` && response.request().method() === 'POST');
        await modal.getByRole('button', { name: 'Viết bài ngay', exact: true }).click();
        await response;
        assert.deepEqual(posts, [{
          method: 'POST', csrf: 'fixture-csrf',
          body: { customer_id: 'customer-test', website_id: 'website-test', model: 'model-test', keyword: 'dịch vụ thiết kế website', length: 1500, tone: 'Chuyên nghiệp', style: 'SEO', instructions, use_research: true },
        }]);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
    for (const immediate of [false, true]) await t.test(`own keys use a website endpoint and arbitrary model for ${immediate ? 'instant writing' : 'schedules'}`, async () => {
      const { page, modal, posts, unexpected, pageErrors } = await mockSchedule(browser, outputFiles[0].text, immediate, true);
      try {
        await modal.getByText('Kết nối OpenAI Compatible', { exact: true }).waitFor();
        assert.equal(await modal.getByLabel('Model AI', { exact: true }).getAttribute('role'), null, 'own model is a text input rather than a catalog select');
        await modal.getByLabel('Độ dài (600–2500 từ)', { exact: true }).fill('1500');
        await modal.getByRole('button', { name: immediate ? 'Viết bài ngay' : 'Tạo lịch viết', exact: true }).click();
        await modal.getByText('Nhập Base URL của API.', { exact: true }).waitFor();
        await modal.getByText('Nhập API key riêng.', { exact: true }).waitFor();
        assert.equal(posts.length, 0);
        await modal.getByLabel('Base URL', { exact: true }).fill('https://api.example.com/v1');
        await modal.getByLabel('API key riêng', { exact: true }).fill('fixture-own-key');
        const response = page.waitForResponse(response => response.url() === `${origin}/api/crm/${immediate ? 'jobs' : 'schedules'}` && response.request().method() === 'POST');
        await modal.getByRole('button', { name: immediate ? 'Viết bài ngay' : 'Tạo lịch viết', exact: true }).click();
        await response;
        assert.deepEqual(posts, [{ method: 'POST', csrf: 'fixture-csrf', body: {
          customer_id: 'customer-test', website_id: 'website-test', model: 'tenant@website/private-model:free',
          base_url: 'https://api.example.com/v1', keyAI: 'fixture-own-key', keyword: 'dịch vụ thiết kế website',
          length: 1500, tone: 'Chuyên nghiệp', style: 'SEO', instructions, use_research: true,
          ...(!immediate ? { scheduled_at: '2030-01-01T05:00:00.000Z' } : {}),
        } }]);
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
