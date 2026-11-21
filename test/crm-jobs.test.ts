import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { JobDetails } from '../web/src/types';
import { evaluateSeo } from '../src/worker/seo.js';
import { vnd } from '../web/src/shared';

const origin = 'http://localhost:3221';
const failedId = '9e18af13-7d6c-4d74-8ead-4c75e706f20c';
const activeId = '12850dc1-a858-42dd-881a-48daff6bb34a';
const completedId = '6ca7e10e-baf6-47d1-a04e-47bd5a194385';
const rewrittenId = '03098082-fe1c-4eae-8e60-a8af43906332';

test('Vietnamese money formatting distinguishes small costs, zero and missing costs', () => {
  assert.match(vnd('1234567.5'), /^1\.234\.568\s₫$/);
  assert.equal(vnd('0.000000000001'), '< 1 ₫');
  assert.equal(vnd('0.999999999999'), '< 1 ₫');
  assert.match(vnd('0'), /^0\s₫$/);
  for (const value of [undefined, null, '', 'not-money', Infinity]) assert.equal(vnd(value), '—');
});

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

async function mockCrm(browser: Browser, bundle: string, rewriteKeyMode: 'own' | 'service' = 'service', options: { outline?: 'timeout' | 'missing'; query?: string } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  await page.addInitScript({ content: `
    class TestEventSource extends EventTarget {
      static instances = [];
      constructor(url) { super(); this.url = url; TestEventSource.instances.push(this); }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { configurable: true, value: TestEventSource });
    Object.defineProperty(window, '__crmEventSources', { configurable: true, value: TestEventSource.instances });
  ` });
  const failed = { ...failedJob(), rewrite_key_mode: rewriteKeyMode };
  const active: JobDetails = { ...failedJob(), id: activeId, job_id: activeId, keyword: 'bài đang viết', status: 'writing', writing_stage: 'outline', can_rewrite: false, error_code: null, error_message: null };
  const completed: JobDetails = {
    ...failedJob(), id: completedId, job_id: completedId, keyword: 'bài đã hoàn tất', status: 'completed',
    error_code: null, error_message: null,
    outline: {
      title: 'Thiết kế website phù hợp với doanh nghiệp', searchIntent: 'Tìm hiểu cách chọn website',
      audience: 'Chủ doanh nghiệp', angle: 'Bắt đầu từ nhu cầu sử dụng', questions: ['Website cần những chức năng nào?'],
      sections: [{ heading: 'Xác định nhu cầu', purpose: 'Chọn chức năng phục vụ khách hàng', estimatedWords: 400, subheadings: ['Chức năng cần thiết'], evidence: [{ sourceIndex: 1, fact: 'Ưu tiên nhu cầu đã xác minh.' }] }],
    },
    result: [{ Title: 'Bài viết hoàn tất', Content: '<p>Nội dung đã viết.</p>', Slug: 'bai-viet-hoan-tat', Desc: 'Tóm tắt', Description: 'Mô tả SEO', Keywords: ['bài đã hoàn tất'] }],
  };
  completed.seo_report = evaluateSeo(completed.result![0], { keyword: completed.keyword });
  completed.seo_repair_status = 'kept_draft';
  completed.attempts = [{ id: 'attempt-outline', provider: 'openai-compatible', model: completed.model, stage: 'outline', status: 'succeeded', started_at: completed.created_at }];
  if (options.outline) completed.outline = null;
  if (options.outline === 'timeout') completed.attempts[0] = { ...completed.attempts[0], status: 'failed', error_code: 'AI_OUTLINE_TIMEOUT', error_message: 'Bước lập dàn ý đã hết thời gian chờ.' };
  const rewritten: JobDetails = {
    ...failed, id: rewrittenId, job_id: rewrittenId, mode: 'rewrite', status: 'queued', can_rewrite: false,
    retry_of_job_id: failedId, error_code: null, error_message: null, completed_at: null,
  };
  const details = new Map([failed, active, completed, rewritten].map(job => [job.id, job]));
  const posts: { method: string; body: unknown; csrf: string | undefined }[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  const detailReads: string[] = [];
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
      const status = url.searchParams.get('status');
      let data = [...details.values()].filter(job => (job.id !== rewrittenId || posts.length) && (!status || job.status === status || (status === 'ready' && job.status === 'completed')));
      if (url.searchParams.get('date_basis') === 'cost') data = data.map(job => { const { attempts, ...row } = job; return row as JobDetails; });
      return route.fulfill({ json: { data, next_cursor: null } });
    }
    if (url.pathname === '/api/crm/jobs/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' });
    if (['/api/crm/customers', '/api/crm/websites', '/api/crm/providers'].includes(url.pathname)) return route.fulfill({ json: { data: [] } });
    if (url.pathname === `/api/crm/jobs/${failedId}/rewrite`) {
      posts.push({ method: request.method(), body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
      return route.fulfill({ status: 202, json: { job_id: rewrittenId, status: 'queued', retry_of_job_id: failedId } });
    }
    const detail = details.get(url.pathname.replace('/api/crm/jobs/', ''));
    if (detail) { detailReads.push(detail.id); return route.fulfill({ json: detail }); }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(`${origin}/${options.query ? `?${options.query}` : ''}`);
  const row = (keyword: string) => page.getByRole('row').filter({ has: page.getByRole('button', { name: new RegExp(keyword) }) });
  await row(failed.keyword).waitFor();
  return {
    page, row, posts, unexpected, pageErrors, details, detailReads, listReads: () => listReads,
    emitJobEvent: (type: string, data: Record<string, unknown> = {}) => page.evaluate(({ type: eventType, data: eventData }) => {
      const source = (window as typeof window & { __crmEventSources: EventTarget[] }).__crmEventSources[0];
      source.dispatchEvent(new MessageEvent(eventType, { data: JSON.stringify(eventData) }));
    }, { type, data }),
  };
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
          <ConfigProvider theme={{token:{motion:false}}}><App><Jobs query={new URLSearchParams(window.location.search)} /></App></ConfigProvider>
        );`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('live job updates refresh only their own authoritative row and recover missed events', async () => {
      const fixture = await mockCrm(browser, outputFiles[0].text);
      const { page, row, details, detailReads, emitJobEvent, unexpected, pageErrors } = fixture;
      try {
        const completed = { ...details.get(activeId)!, status: 'completed', can_rewrite: true, writing_stage: null,
          updated_at: '2026-11-20T05:00:00Z', completed_at: '2026-11-20T05:00:00Z', cost_usd: '0.012300000000', cost_vnd: '307.500000000000',
          result: details.get(completedId)!.result } satisfies JobDetails;
        details.set(activeId, completed);
        await emitJobEvent('job.updated', { job_id: activeId, status: 'completed' });
        await row('bài đang viết').getByRole('button', { name: 'Xóa bài viết' }).waitFor();
        assert.equal(await row('bài đang viết').getByRole('button', { name: /Viết lại/ }).isEnabled(), true);
        assert.match(await row('bài đang viết').innerText(), /308\s₫/);
        assert.doesNotMatch(await row('bài đang viết').innerText(), /USD|US\$/);
        assert.equal(fixture.listReads(), 1, 'a job event must not reload the collection');
        assert.deepEqual(detailReads, [activeId]);

        const created = { ...completed, id: rewrittenId, job_id: rewrittenId, keyword: 'yêu cầu từ máy khác', status: 'queued', can_rewrite: false, result: null };
        details.set(rewrittenId, created);
        await emitJobEvent('job.created', { job_id: rewrittenId });
        await row(created.keyword).waitFor();
        assert.equal(fixture.listReads(), 1, 'new jobs use a single-job lookup too');

        details.set(activeId, { ...completed, keyword: 'tên mới sau khi kết nối lại', updated_at: '2026-11-20T06:00:00Z' });
        await emitJobEvent('ready');
        await row('tên mới sau khi kết nối lại').waitFor();
        assert.equal(fixture.listReads(), 2, 'ready reconciles events missed during a disconnection');
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('live jobs enter and leave the active status filter', async () => {
      const { page, row, details, emitJobEvent, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        await page.getByRole('combobox', { name: 'Trạng thái', exact: true }).click();
        await page.locator('.ant-select-item-option-content').getByText('Đã viết', { exact: true }).click();
        await row('bài đã hoàn tất').waitFor();
        await row('bài đang viết').waitFor({ state: 'hidden' });
        details.set(activeId, { ...details.get(activeId)!, status: 'completed', can_rewrite: true, writing_stage: null, updated_at: '2026-11-20T05:00:00Z', result: details.get(completedId)!.result });
        await emitJobEvent('job.updated', { job_id: activeId });
        await row('bài đang viết').waitFor();
        details.set(activeId, { ...details.get(activeId)!, status: 'queued', can_rewrite: false, updated_at: '2026-11-20T05:01:00Z', result: null });
        await emitJobEvent('job.updated', { job_id: activeId });
        await row('bài đang viết').waitFor({ state: 'hidden' });
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('cost-date live updates use attempt dates and newer reads replace equal-timestamp snapshots', async () => {
      const fixture = await mockCrm(browser, outputFiles[0].text, 'service', { query: 'date_basis=cost&from=2026-11-21&to=2026-11-21' });
      const { page, row, details, emitJobEvent, unexpected, pageErrors } = fixture;
      try {
        details.set(activeId, { ...details.get(activeId)!, updated_at: '2026-11-20T03:00:00Z', attempts: [
          { id: 'old-cost', provider: 'openai', model: 'test', status: 'failed', started_at: '2026-11-20T03:00:00Z', cost_usd: '9', cost_vnd: '225000' },
          { id: 'new-cost', provider: 'openai', model: 'test', status: 'succeeded', started_at: '2026-11-21T03:00:00Z', cost_usd: '0.0123', cost_vnd: '307.5' },
          { id: 'new-fraction', provider: 'openai', model: 'test', status: 'succeeded', started_at: '2026-11-21T04:00:00Z', cost_usd: '0.00002', cost_vnd: '0.5' },
        ] });
        await emitJobEvent('job.updated', { job_id: activeId });
        await row('bài đang viết').getByText(/308\s₫/).waitFor();
        assert.equal(await row('bài đang viết').count(), 1, 'an old job remains in the cost period of its new attempt');
        details.set(activeId, { ...details.get(activeId)!, cost_usd: '0.0234', cost_vnd: '585' });
        await page.getByRole('button', { name: /Làm mới/ }).first().click();
        await row('bài đang viết').getByText(/585\s₫/).waitFor();
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('job costs and AI attempts use VND while preserving pending and sub-dong costs', async () => {
      const { page, row, details, emitJobEvent, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        details.set(completedId, { ...details.get(completedId)!, cost_usd: '0.000012', cost_vnd: '0.3', attempts: [
          { id: 'priced', provider: 'openai', model: 'Lượt tính phí', status: 'succeeded', started_at: '2026-11-20T03:00:00Z', cost_usd: '0.0123', cost_vnd: '307.5' },
          { id: 'tiny', provider: 'openai', model: 'Lượt rất nhỏ', status: 'succeeded', started_at: '2026-11-20T03:00:00Z', cost_usd: '0.000012', cost_vnd: '0.3' },
          { id: 'zero', provider: 'openai', model: 'Lượt miễn phí', status: 'succeeded', started_at: '2026-11-20T03:00:00Z', cost_usd: '0', cost_vnd: '0' },
          { id: 'unpriced', provider: 'openai', model: 'Lượt chưa có giá', status: 'succeeded', started_at: '2026-11-20T03:00:00Z', cost_usd: null, cost_vnd: null },
        ] });
        await emitJobEvent('job.updated', { job_id: completedId });
        await row('bài đã hoàn tất').getByText('< 1 ₫', { exact: true }).waitFor();
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByRole('tab', { name: 'Lần gọi AI (4)', exact: true }).click();
        await drawer.getByText(/308\s₫/, { exact: true }).waitFor();
        await drawer.getByText('< 1 ₫', { exact: true }).waitFor();
        await drawer.getByText(/^0\s₫$/, { exact: true }).waitFor();
        await drawer.getByText('Chờ đối soát', { exact: true }).waitFor();
        assert.doesNotMatch(await drawer.innerText(), /USD|US\$/);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

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

    await t.test('saved outline appears before the article tab and renders its plan', async () => {
      const { page, row, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        assert.deepEqual((await drawer.getByRole('tab').allTextContents()).slice(0, 3), ['Yêu cầu', 'Dàn ý', 'Bài viết']);
        await drawer.getByRole('tab', { name: 'Dàn ý', exact: true }).click();
        const outline = drawer.getByRole('region', { name: 'Dàn ý bài viết' });
        await outline.getByRole('heading', { name: 'Thiết kế website phù hợp với doanh nghiệp' }).waitFor();
        for (const text of ['Tìm hiểu cách chọn website', 'Chủ doanh nghiệp', 'Bắt đầu từ nhu cầu sử dụng', 'Website cần những chức năng nào?', 'Chọn chức năng phục vụ khách hàng', '400 từ dự kiến', 'Chức năng cần thiết', 'Nguồn 1: Ưu tiên nhu cầu đã xác minh.']) {
          await outline.getByText(text, { exact: true }).waitFor();
        }
        await outline.getByRole('heading', { name: 'Xác định nhu cầu' }).waitFor();
        await drawer.getByRole('tab', { name: 'Bài viết', exact: true }).click();
        await drawer.getByRole('heading', { name: 'Bài viết hoàn tất' }).waitFor();
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('outline tab explains a timeout while keeping the completed article available', async () => {
      const { page, row, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text, 'service', { outline: 'timeout' });
      try {
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByRole('tab', { name: 'Dàn ý', exact: true }).click();
        await drawer.getByText('Bước lập dàn ý đã hết thời gian chờ', { exact: true }).waitFor();
        await drawer.getByText(/Không có dàn ý được lưu. Hệ thống tiếp tục viết/).waitFor();
        assert.equal(await drawer.locator('.ant-alert-warning').count(), 1);
        await drawer.getByRole('tab', { name: 'Bài viết', exact: true }).click();
        await drawer.getByRole('heading', { name: 'Bài viết hoàn tất' }).waitFor();
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('outline tab distinguishes planning in progress from an older job without an outline', async () => {
      const { page, row, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text, 'service', { outline: 'missing' });
      try {
        await row('bài đang viết').getByRole('button', { name: /bài đang viết/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByRole('tab', { name: 'Dàn ý', exact: true }).click();
        await drawer.getByText('Đang lập dàn ý. Nội dung sẽ xuất hiện khi bước này hoàn tất.', { exact: true }).waitFor();
        await drawer.getByRole('button', { name: 'Close', exact: true }).click();
        await drawer.waitFor({ state: 'hidden' });
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        await drawer.getByRole('tab', { name: 'Dàn ý', exact: true }).click();
        await drawer.getByText('Yêu cầu này chưa có dàn ý được lưu', { exact: true }).waitFor();
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
