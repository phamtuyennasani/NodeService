import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { RuntimeSettings } from '../web/src/Settings';

const origin = 'http://localhost:3231';
const values: RuntimeSettings = {
  usd_to_vnd: 25000, writer_concurrency: 5, delivery_concurrency: 5, worker_poll_ms: 500,
  ai_timeout_ms: 120000, outline_timeout_ms: 120000, seo_repair_timeout_ms: 90000,
  writer_max_attempts: 3, delivery_max_attempts: 5, delivery_retry_minutes: 5, webhook_timeout_ms: 15000,
  research_enabled: true, research_timeout_ms: 8000, research_max_results: 5,
  job_retention_days: 0, delivery_retention_days: 0, cleanup_interval_minutes: 60,
  provider_limits: Object.fromEntries(['openai', 'anthropic', 'xai', 'openai-compatible'].map(provider => [provider, {
    concurrency: 10, requests_per_minute: 60, tokens_per_minute: 120000,
  }])) as RuntimeSettings['provider_limits'],
};

async function fixture(browser: Browser, bundle: string, conflict = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const puts: { body: any; csrf?: string }[] = [];
  const errors: string[] = [];
  let stored = structuredClone(values);
  let gets = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/test.js"></script></body></html>' });
    if (url.pathname === '/test.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/crm/settings') {
      if (request.method() === 'GET') {
        gets += 1;
        return route.fulfill({ json: { values: stored, defaults: values, revision: gets === 1 ? 3 : 4, updated_at: null } });
      }
      if (request.method() === 'PUT') {
        puts.push({ body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
        if (conflict) return route.fulfill({ status: 409, json: { error: { code: 'settings_conflict', message: 'Đã thay đổi.' } } });
        stored = request.postDataJSON().values;
        return route.fulfill({ json: { values: stored, defaults: values, revision: 4, updated_at: '2026-11-22T00:00:00Z' } });
      }
    }
    errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(origin);
  await page.getByLabel('VND cho 1 USD', { exact: true }).waitFor();
  return { page, puts, errors, getCount: () => gets };
}

test('CRM settings save operational values, confirm retention and handle concurrent edits', async t => {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {App,ConfigProvider} from 'antd'; import {Settings} from './web/src/Settings';
      import {setCsrfToken} from './web/src/api'; setCsrfToken('settings-csrf');
      createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{token:{motion:false}}}><App><Settings /></App></ConfigProvider>);`,
      resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('save includes revision, CSRF, all fields and seconds conversion', async () => {
      const { page, puts, errors } = await fixture(browser, bundle.outputFiles[0].text);
      try {
        assert.equal(await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).isDisabled(), true);
        await page.getByLabel('VND cho 1 USD', { exact: true }).fill('27000');
        await page.getByLabel('AI ngừng phản hồi (giây)', { exact: true }).fill('12.5');
        await page.getByLabel('Khoảng chờ gửi lại (phút)', { exact: true }).fill('7');
        await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).click();
        await page.getByText('Đã lưu cài đặt. Hệ thống sẽ áp dụng trong tối đa 5 giây.', { exact: true }).waitFor();
        assert.deepEqual(puts, [{ csrf: 'settings-csrf', body: { revision: 3, values: { ...values, usd_to_vnd: 27000, ai_timeout_ms: 12500, delivery_retry_minutes: 7 } } }]);
        assert.equal(await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).isDisabled(), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
    await t.test('retention requires confirmation and cancellation leaves server untouched', async () => {
      const { page, puts, errors } = await fixture(browser, bundle.outputFiles[0].text);
      try {
        await page.getByRole('tab', { name: 'Lưu trữ dữ liệu' }).click();
        await page.getByLabel('Lưu yêu cầu viết bài (ngày)', { exact: true }).fill('30');
        await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).click();
        await page.getByRole('dialog').filter({ hasText: 'Bật hoặc rút ngắn thời gian lưu dữ liệu?' }).waitFor();
        assert.equal(puts.length, 0);
        await page.getByRole('button', { name: 'Kiểm tra lại', exact: true }).click();
        assert.equal(puts.length, 0);
        await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).click();
        await page.getByRole('button', { name: 'Xác nhận và lưu', exact: true }).click();
        await page.getByText('Đã lưu cài đặt. Hệ thống sẽ áp dụng trong tối đa 5 giây.', { exact: true }).waitFor();
        assert.equal(puts.length, 1);
        assert.equal(puts[0].body.values.job_retention_days, 30);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
    await t.test('delivery interval uses whole minutes and validates its bounds before saving', async () => {
      const { page, puts, errors } = await fixture(browser, bundle.outputFiles[0].text);
      try {
        const interval = page.getByLabel('Khoảng chờ gửi lại (phút)', { exact: true });
        assert.equal(await interval.inputValue(), '5');
        await page.getByText('Bài viết hoàn tất được thử lại tối đa 3 lần nếu Laravel chưa xác nhận; mặc định 5 phút giữa các lần.', { exact: true }).waitFor();
        for (const value of ['0', '1.5', '1441']) {
          await interval.fill(value);
          await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).click();
          await page.getByText('Nhập số nguyên từ 1 đến 1.440.', { exact: true }).waitFor();
          assert.equal(puts.length, 0);
        }
        await interval.fill('1440');
        await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).click();
        await page.getByText('Đã lưu cài đặt. Hệ thống sẽ áp dụng trong tối đa 5 giây.', { exact: true }).waitFor();
        assert.equal(puts[0].body.values.delivery_retry_minutes, 1440);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
    await t.test('validation blocks invalid values; conflict requires reload', async () => {
      const { page, puts, errors, getCount } = await fixture(browser, bundle.outputFiles[0].text, true);
      try {
        await page.getByLabel('Số luồng viết bài', { exact: true }).fill('0');
        await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).click();
        await page.getByText('Nhập số nguyên từ 1 đến 100.', { exact: true }).waitFor();
        assert.equal(puts.length, 0);
        await page.getByLabel('Số luồng viết bài', { exact: true }).fill('8');
        await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).click();
        await page.getByRole('button', { name: 'Tải cấu hình mới', exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: 'Tải cấu hình mới', exact: true }).click();
        await page.getByRole('button', { name: 'Tải lại cấu hình', exact: true }).click();
        await page.waitForFunction(() => !document.body.textContent?.includes('Chưa lưu cài đặt'));
        assert.equal(getCount(), 2);
        await page.waitForFunction(() => (document.querySelector('#writer_concurrency') as HTMLInputElement | null)?.value === '5');
        assert.equal(await page.getByLabel('Số luồng viết bài', { exact: true }).inputValue(), '5');
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
