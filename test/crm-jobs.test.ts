import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { JobDetails } from '../web/src/types';
import { evaluateSeo } from '../src/worker/seo.js';

const origin = 'http://localhost:3221';
const failedId = '9e18af13-7d6c-4d74-8ead-4c75e706f20c';
const activeId = '12850dc1-a858-42dd-881a-48daff6bb34a';
const completedId = '6ca7e10e-baf6-47d1-a04e-47bd5a194385';
const rewrittenId = '03098082-fe1c-4eae-8e60-a8af43906332';

function failedJob(): JobDetails {
  return {
    id: failedId, job_id: failedId, customer_id: 'customer-test', customer_name: 'Khách kiểm thử',
    website_id: 'website-test', website_name: 'Website kiểm thử', mode: 'scheduled', status: 'failed',
    can_rewrite: true, keyword: 'dịch vụ thiết kế website', provider: 'openai-compatible', model: 'model-test',
    tone: 'Chuyên nghiệp', style: 'SEO', length: 1200, created_at: '2026-11-20T03:00:00Z',
    scheduled_at: null, started_at: null, completed_at: '2026-11-20T03:01:00Z', source_article_id: null,
    key_mode: 'service', rewrite_key_mode: 'service', instructions: 'Giữ ví dụ thực tế.',
    result: null, attempts: [], deliveries: [], error_code: 'AI_RESPONSE', error_message: 'Phản hồi AI bị lỗi.',
  };
}

async function mockCrm(browser: Browser, bundle: string, rewriteKeyMode: 'own' | 'service' = 'service') {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const failed = { ...failedJob(), rewrite_key_mode: rewriteKeyMode };
  const active: JobDetails = { ...failedJob(), id: activeId, job_id: activeId, keyword: 'bài đang viết', status: 'writing', writing_stage: 'outline', can_rewrite: false, error_code: null, error_message: null };
  const completed: JobDetails = {
    ...failedJob(), id: completedId, job_id: completedId, keyword: 'bài đã hoàn tất', status: 'completed',
    error_code: null, error_message: null,
    result: [{ Title: 'Bài viết hoàn tất', Content: '<p>Nội dung đã viết.</p>', Slug: 'bai-viet-hoan-tat', Desc: 'Tóm tắt', Desction: 'Mô tả SEO', 'Từ khóa': ['bài đã hoàn tất'] }],
  };
  completed.seo_report = evaluateSeo(completed.result![0], { keyword: completed.keyword });
  completed.seo_repair_status = 'kept_draft';
  completed.attempts = [{ id: 'attempt-outline', provider: 'openai-compatible', model: completed.model, stage: 'outline', status: 'succeeded', started_at: completed.created_at }];
  const rewritten: JobDetails = {
    ...failed, id: rewrittenId, job_id: rewrittenId, mode: 'rewrite', status: 'queued', can_rewrite: false,
    retry_of_job_id: failedId, error_code: null, error_message: null, completed_at: null,
  };
  const details = new Map([failed, active, completed, rewritten].map(job => [job.id, job]));
  const posts: { method: string; body: unknown; csrf: string | undefined }[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  let listReads = 0;
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
    if (url.pathname === '/api/crm/jobs') {
      listReads++;
      return route.fulfill({ json: { data: posts.length ? [rewritten, failed, active, completed] : [failed, active, completed], next_cursor: null } });
    }
    if (['/api/crm/customers', '/api/crm/websites', '/api/crm/providers'].includes(url.pathname)) return route.fulfill({ json: { data: [] } });
    if (url.pathname === `/api/crm/jobs/${failedId}/rewrite`) {
      posts.push({ method: request.method(), body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
      return route.fulfill({ status: 202, json: { job_id: rewrittenId, status: 'queued', retry_of_job_id: failedId } });
    }
    const detail = details.get(url.pathname.replace('/api/crm/jobs/', ''));
    if (detail) return route.fulfill({ json: detail });
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(origin);
  const row = (keyword: string) => page.getByRole('row').filter({ has: page.getByRole('button', { name: new RegExp(keyword) }) });
  await row(failed.keyword).waitFor();
  return { page, row, posts, unexpected, pageErrors, listReads: () => listReads };
}

test('CRM exposes and submits rewrites for failed jobs without generated content', async t => {
  const { outputFiles } = await build({
    stdin: {
      contents: `import React from 'react';
        import {createRoot} from 'react-dom/client';
        import {App, ConfigProvider} from 'antd';
        import {Jobs} from './web/src/Jobs';
        import {setCsrfToken} from './web/src/api';
        setCsrfToken('fixture-csrf');
        createRoot(document.getElementById('root')!).render(
          <ConfigProvider theme={{token:{motion:false}}}><App><Jobs query={new URLSearchParams()} /></App></ConfigProvider>
        );`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('failed job has list and detail actions, queues a retry, and links its failed original', async () => {
      const fixture = await mockCrm(browser, outputFiles[0].text);
      const { page, row, posts, unexpected, pageErrors } = fixture;
      try {
        assert.equal(await row('dịch vụ thiết kế website').getByRole('button', { name: /Viết lại/ }).isEnabled(), true);
        await row('dịch vụ thiết kế website').getByRole('button', { name: /dịch vụ thiết kế website/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByText('Phản hồi AI bị lỗi.', { exact: true }).waitFor();
        const detailRewrite = drawer.getByRole('button', { name: /Viết lại/ });
        assert.equal(await detailRewrite.isEnabled(), true);
        await detailRewrite.click();
        const modal = page.locator('.ant-modal');
        await modal.getByText('Viết lại từ yêu cầu bị lỗi', { exact: true }).waitFor();
        await modal.getByText(/Yêu cầu bị lỗi và lịch sử lỗi vẫn được giữ/).waitFor();
        await modal.getByLabel('Hướng dẫn viết lại', { exact: true }).fill('  Bổ sung phần chi phí thực tế.  ');
        await modal.getByRole('button', { name: 'Tạo bản viết lại', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        await drawer.getByText(rewrittenId, { exact: true }).waitFor();
        const failedOriginal = drawer.getByRole('link', { name: failedId, exact: true });
        assert.equal(await failedOriginal.getAttribute('href'), `#jobs?job=${failedId}`);
        await drawer.getByText('Chờ viết', { exact: true }).waitFor();
        assert.equal(await drawer.getByRole('button', { name: /Viết lại/ }).isDisabled(), true);
        assert.deepEqual(posts, [{ method: 'POST', body: { instructions: 'Bổ sung phần chi phí thực tế.' }, csrf: 'fixture-csrf' }]);
        assert.ok(fixture.listReads() >= 2, 'reload the job list after creating a rewrite');
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('current own-key setting requires a new key even when the failed job used the service key', async () => {
      const { page, row, posts, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text, 'own');
      try {
        await row('dịch vụ thiết kế website').getByRole('button', { name: /Viết lại/ }).click();
        const modal = page.locator('.ant-modal');
        await modal.getByText('Viết lại từ yêu cầu bị lỗi', { exact: true }).waitFor();
        await modal.getByRole('button', { name: 'Tạo bản viết lại', exact: true }).click();
        await modal.getByText('Nhập API key riêng để viết lại bài.', { exact: true }).waitFor();
        assert.equal(posts.length, 0, 'do not post an own-key retry without a new API key');
        await modal.getByLabel('API key riêng', { exact: true }).fill('  fixture-own-key  ');
        await modal.getByRole('button', { name: 'Tạo bản viết lại', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        await page.locator('.ant-drawer').getByText(rewrittenId, { exact: true }).waitFor();
        assert.deepEqual(posts, [{ method: 'POST', body: { keyAI: 'fixture-own-key' }, csrf: 'fixture-csrf' }]);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('active writing stays disabled and completed content remains rewritable', async () => {
      const { page, row, posts, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        assert.equal(await row('bài đang viết').getByRole('button', { name: /Viết lại/ }).isDisabled(), true);
        assert.equal(await row('bài đã hoàn tất').getByRole('button', { name: /Viết lại/ }).isEnabled(), true);
        await row('bài đang viết').getByRole('button', { name: /bài đang viết/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByText(activeId, { exact: true }).waitFor();
        await drawer.getByText('Đang lập dàn ý', { exact: true }).waitFor();
        assert.equal(await drawer.getByRole('button', { name: /Viết lại/ }).isDisabled(), true);
        await drawer.getByRole('button', { name: 'Close', exact: true }).click();
        await drawer.waitFor({ state: 'hidden' });
        await row('bài đã hoàn tất').getByRole('button', { name: /Viết lại/ }).click();
        const modal = page.locator('.ant-modal');
        await modal.getByText('Tạo một phiên bản bài viết mới', { exact: true }).waitFor();
        assert.equal(await modal.getByRole('button', { name: 'Tạo bản viết lại', exact: true }).isEnabled(), true);
        assert.equal(posts.length, 0);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('completed content exposes SEO warnings without reporting a writing failure', async () => {
      const { page, row, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByRole('tab', { name: 'Kiểm tra SEO', exact: true }).click();
        await drawer.getByText('Bài viết được chấp nhận và còn gợi ý SEO', { exact: true }).waitFor();
        await drawer.getByText('Lượt chỉnh sửa SEO chưa tạo được bản tốt hơn. Bản nháp đã lưu được giữ lại để bạn chỉnh sửa.', { exact: true }).waitFor();
        assert.equal(await drawer.locator('.seo-findings [data-state="excluded"]').count(), 3);
        assert.ok(await drawer.locator('.seo-findings [data-state="warning"]').count() > 0);
        assert.equal(await drawer.locator('.ant-alert-error').count(), 0);
        await drawer.getByRole('tab', { name: 'Lần gọi AI (1)', exact: true }).click();
        await drawer.getByText('Lập dàn ý', { exact: true }).waitFor();
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
