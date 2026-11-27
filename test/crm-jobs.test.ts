import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

async function mockCrm(browser: Browser, bundle: string, rewriteKeyMode: 'own' | 'service' = 'service', options: { outline?: 'timeout' | 'missing'; query?: string; issueRows?: string[]; serverSelected?: boolean; historicalReady?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  await page.addInitScript({ content: `
    const originalFetch = window.fetch.bind(window);
    let stream;
    const encoder = new TextEncoder();
    window.__emitCrmEvent = (type, data = {}) => stream?.enqueue(encoder.encode('event: ' + type + '\\ndata: ' + JSON.stringify(data) + '\\n\\n'));
    window.fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, location.origin);
      if (url.pathname !== '/api/crm/jobs/events') return originalFetch(input, init);
      const signal = init.signal;
      const body = new ReadableStream({ start(controller) { stream = controller; }, cancel() { stream = undefined; } });
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      signal?.addEventListener('abort', () => { stream?.error(new DOMException('Aborted', 'AbortError')); stream = undefined; }, { once: true });
      window.__crmStreamReady = true;
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    };
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
    internal_link_report: {
      status: 'checked', candidates: 2,
      used: [{ url: 'https://example.vn/huong-dan-chon-website', anchor: 'hướng dẫn chọn website phù hợp' }],
      removed: 1, checked_at: '2026-11-23T03:00:00Z',
    },
    research_review: { status: 'found', query: 'thiết kế website', locale: 'vi', checked_at: '2026-11-27T03:00:00Z',
      sources: [{ title: 'Tài liệu kiểm thử', url: 'https://example.org/research', snippet: 'Ưu tiên nhu cầu đã xác minh.' }] },
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
  if (options.historicalReady) {
    completed.created_at = '2026-10-01T03:00:00Z';
    completed.completed_at = '2026-11-21T03:00:00Z';
  }
  const details = new Map([failed, active, completed, rewritten].map(job => [job.id, job]));
  const posts: { method: string; body: unknown; csrf: string | undefined }[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  const detailReads: string[] = [];
  const pdfRequests: { method: string; path: string; proof?: string }[] = [];
  const listRequests: URL[] = [];
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
    if (url.pathname === '/api/crm/session/bootstrap') return route.fulfill({ json: { browser_binding: 'b'.repeat(43), server_time: Date.now() } });
    if (url.pathname === '/api/crm/jobs') {
      listReads++;
      listRequests.push(url);
      const status = url.searchParams.get('status');
      let data = [...details.values()].filter(job => (job.id !== rewrittenId || posts.length) && (!status || job.status === status || (status === 'ready' && job.status === 'completed')));
      if (url.searchParams.has('issue') && options.issueRows) data = data.filter(job => options.issueRows!.includes(job.id));
      if (url.searchParams.has('issue') && options.serverSelected) data = data.map(job => {
        const { attempts, key_mode, ...selected } = job;
        return selected as JobDetails;
      });
      if (url.searchParams.get('date_basis') === 'cost') data = data.map(job => { const { attempts, ...row } = job; return row as JobDetails; });
      return route.fulfill({ json: { data, next_cursor: null } });
    }
    if (url.pathname === '/api/crm/jobs/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: ready\ndata: {}\n\n' });
    if (['/api/crm/customers', '/api/crm/websites', '/api/crm/providers'].includes(url.pathname)) return route.fulfill({ json: { data: [] } });
    if (url.pathname === `/api/crm/jobs/${failedId}/rewrite`) {
      posts.push({ method: request.method(), body: request.postDataJSON(), csrf: request.headers()['x-csrf-token'] });
      return route.fulfill({ status: 202, json: { job_id: rewrittenId, status: 'queued', retry_of_job_id: failedId } });
    }
    if (url.pathname === `/api/crm/jobs/${completedId}/pdf`) {
      pdfRequests.push({ method: request.method(), path: url.pathname, proof: request.headers()['x-crm-proof'] });
      return route.fulfill({ contentType: 'application/pdf', body: Buffer.from('%PDF-1.4\nSynthetic CRM PDF\n%%EOF') });
    }
    const detail = details.get(url.pathname.replace('/api/crm/jobs/', ''));
    if (detail) { detailReads.push(detail.id); return route.fulfill({ json: detail }); }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(`${origin}/${options.query ? `?${options.query}` : ''}`);
  const row = (keyword: string) => page.getByRole('row').filter({ has: page.getByRole('button', { name: new RegExp(keyword) }) });
  await row(options.historicalReady ? completed.keyword : options.issueRows?.[0] === activeId ? active.keyword : failed.keyword).waitFor();
  await page.waitForFunction(() => (window as any).__crmStreamReady === true);
  return {
    page, row, posts, unexpected, pageErrors, details, detailReads, pdfRequests, listRequests, listReads: () => listReads,
    emitJobEvent: (type: string, data: Record<string, unknown> = {}) => page.evaluate(({ type: eventType, data: eventData }) => {
      (window as any).__emitCrmEvent(eventType, eventData);
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
        import {prepareBrowserLogin} from './web/src/browser-proof';
        setCsrfToken('fixture-csrf');
        prepareBrowserLogin().then(() => createRoot(document.getElementById('root')!).render(
          <ConfigProvider theme={{token:{motion:false}}}><App><Jobs query={new URLSearchParams(window.location.search)} /></App></ConfigProvider>
        ));`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('PDF export is absent until a job contains visible article content', async () => {
      const { page, row, details, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        for (const keyword of ['dịch vụ thiết kế website', 'bài đang viết']) {
          await row(keyword).getByRole('button', { name: new RegExp(keyword) }).click();
          const drawer = page.locator('.ant-drawer');
          await drawer.getByText(keyword === 'bài đang viết' ? activeId : failedId, { exact: true }).waitFor();
          assert.equal(await drawer.getByRole('button', { name: 'Xuất PDF', exact: true }).count(), 0);
          await drawer.getByRole('button', { name: 'Close', exact: true }).click();
          await drawer.waitFor({ state: 'hidden' });
        }
        const completed = details.get(completedId)!;
        details.set(completedId, { ...completed, result: [{ ...completed.result![0], Content: '<p>&nbsp;<br></p><script>hidden</script>' }] });
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByText(completedId, { exact: true }).waitFor();
        assert.equal(await drawer.getByRole('button', { name: 'Xuất PDF', exact: true }).count(), 0);
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('PDF export downloads through a signed read and also works without a saved outline', async () => {
      const { page, row, pdfRequests, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text, 'service', { outline: 'missing' });
      try {
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const button = page.locator('.ant-drawer').getByRole('button', { name: 'Xuất PDF', exact: true });
        const downloadStarted = page.waitForEvent('download');
        await button.click();
        const download = await downloadStarted;
        assert.equal(download.suggestedFilename(), 'bai-viet-hoan-tat-6ca7e10e-baf.pdf');
        assert.equal((await readFile((await download.path())!)).toString(), '%PDF-1.4\nSynthetic CRM PDF\n%%EOF');
        assert.equal(pdfRequests.length, 1);
        assert.equal(pdfRequests[0].method, 'GET');
        assert.equal(pdfRequests[0].path, `/api/crm/jobs/${completedId}/pdf`);
        assert.match(pdfRequests[0].proof || '', /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        assert.equal(await button.isEnabled(), true);
        if (process.env.CRM_PDF_BUTTON_SCREENSHOT) {
          await page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
          await page.addStyleTag({ content: await readFile('web/src/records.css', 'utf8') });
          await page.screenshot({ path: process.env.CRM_PDF_BUTTON_SCREENSHOT, fullPage: true });
          await page.setViewportSize({ width: 390, height: 900 });
          assert.equal(await button.isVisible(), true);
          assert.equal(await page.locator('.ant-drawer-content-wrapper').evaluate(element => element.scrollWidth <= element.clientWidth), true);
          if (process.env.CRM_PDF_BUTTON_MOBILE_SCREENSHOT) await page.screenshot({ path: process.env.CRM_PDF_BUTTON_MOBILE_SCREENSHOT, fullPage: true });
        }
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('PDF export prevents duplicates while pending and allows retry after a backend error', async () => {
      const { page, row, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      let calls = 0;
      await page.route(`**/api/crm/jobs/${completedId}/pdf`, async route => {
        calls++;
        if (calls === 1) {
          await pending;
          return route.fulfill({ status: 503, json: { error: { code: 'pdf_busy', message: 'Máy chủ đang bận tạo PDF. Vui lòng thử lại.' } } });
        }
        return route.fulfill({ contentType: 'application/pdf', body: Buffer.from('%PDF-1.4\nRetry\n%%EOF') });
      });
      try {
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const button = page.locator('.ant-drawer').getByRole('button', { name: 'Xuất PDF', exact: true });
        const requested = page.waitForRequest(`**/api/crm/jobs/${completedId}/pdf`);
        await button.click(); await requested;
        await page.waitForFunction(element => element!.classList.contains('ant-btn-loading'), await button.elementHandle());
        assert.equal(await button.evaluate(element => element.classList.contains('ant-btn-loading')), true);
        await button.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
        assert.equal(calls, 1);
        release();
        await page.getByText('Máy chủ đang bận tạo PDF. Vui lòng thử lại.', { exact: true }).waitFor();
        await page.waitForFunction(() => !document.querySelector('.ant-drawer .ant-btn-loading'));
        const downloadStarted = page.waitForEvent('download');
        await button.click(); await downloadStarted;
        assert.equal(calls, 2);
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { release(); await page.close(); }
    });

    await t.test('closing a job while PDF is pending cancels the request and does not download the previous job', async () => {
      const { page, row, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      let release!: () => void;
      const pending = new Promise<void>(resolve => { release = resolve; });
      const downloads: string[] = [];
      page.on('download', download => downloads.push(download.suggestedFilename()));
      await page.route(`**/api/crm/jobs/${completedId}/pdf`, async route => {
        await pending;
        await route.fulfill({ contentType: 'application/pdf', body: Buffer.from('%PDF-1.4\nStale\n%%EOF') }).catch(() => {});
      });
      try {
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        const requested = page.waitForRequest(`**/api/crm/jobs/${completedId}/pdf`);
        await drawer.getByRole('button', { name: 'Xuất PDF', exact: true }).click();
        const request = await requested;
        const canceled = page.waitForEvent('requestfailed', { predicate: failed => failed === request });
        await drawer.getByRole('button', { name: 'Close', exact: true }).click();
        await canceled;
        await row('bài đang viết').getByRole('button', { name: /bài đang viết/ }).click();
        await drawer.getByText(activeId, { exact: true }).waitFor();
        release();
        assert.deepEqual(downloads, []);
        assert.equal(await drawer.getByRole('button', { name: 'Xuất PDF', exact: true }).count(), 0);
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { release(); await page.close(); }
    });

    await t.test('writing detail displays the recorded Laravel post ID for its delivery', async () => {
      const { page, row, details, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        const job = details.get(completedId)!;
        details.set(completedId, { ...job, deliveries: [{
          id: 'acknowledged-delivery', job_id: completedId, website_name: job.website_name,
          status: 'delivered', event_type: 'article.ready', attempt_count: 2, attempts: 2,
          id_post: 'post:98765', acknowledged_at: '2026-11-22T00:05:00Z', created_at: job.created_at,
        }] });
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByRole('tab', { name: 'Giao bài (1)', exact: true }).click();
        await drawer.getByRole('columnheader', { name: 'ID bài', exact: true }).waitFor();
        await drawer.getByRole('cell', { name: 'post:98765', exact: true }).waitFor();
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
    await t.test('overview issue filters trust server-selected rows, reconcile live events, and can be cleared', async () => {
      const { page, row, details, listRequests, detailReads, emitJobEvent, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text, 'service', {
        query: 'issue=stale&status=writing&customer_id=customer-test&website_id=website-test&key_mode=service',
        issueRows: [activeId], serverSelected: true,
      });
      try {
        await page.getByText('Đang lọc: Yêu cầu viết chờ phục hồi', { exact: true }).waitFor();
        assert.equal(listRequests[0].searchParams.get('issue'), 'stale');
        assert.equal(listRequests[0].searchParams.get('customer_id'), 'customer-test');
        assert.equal(listRequests[0].searchParams.get('website_id'), 'website-test');
        assert.equal(listRequests[0].searchParams.get('key_mode'), 'service');
        await row('bài đang viết').waitFor();
        assert.equal(await row('dịch vụ thiết kế website').count(), 0);

        details.set(rewrittenId, { ...details.get(activeId)!, id: rewrittenId, job_id: rewrittenId, keyword: 'yêu cầu live không thuộc lỗi này' });
        const reconciled = page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/jobs');
        await emitJobEvent('job.created', { job_id: rewrittenId });
        await reconciled;
        await page.waitForFunction(() => document.querySelector('.ant-spin-spinning') === null);
        assert.deepEqual(detailReads, [rewrittenId]);
        assert.equal(listRequests.length, 2, 'issue membership must be re-evaluated by the server after a live update');
        assert.equal(listRequests[1].searchParams.get('issue'), 'stale');
        assert.equal(await row('yêu cầu live không thuộc lỗi này').count(), 0, 'a live job matching ordinary fields must not enter a server-selected issue list');
        await row('bài đang viết').waitFor();

        const cleared = page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/jobs' && !new URL(response.url()).searchParams.has('issue'));
        await page.getByRole('button', { name: 'Bỏ lọc này', exact: true }).click();
        await cleared;
        await page.getByText('Đang lọc: Yêu cầu viết chờ phục hồi', { exact: true }).waitFor({ state: 'hidden' });
        assert.equal(listRequests.at(-1)?.searchParams.has('issue'), false);
        assert.equal(listRequests.at(-1)?.searchParams.get('status'), 'writing');
        assert.equal(listRequests.at(-1)?.searchParams.get('customer_id'), 'customer-test');
        assert.equal(listRequests.at(-1)?.searchParams.get('website_id'), 'website-test');
        assert.equal(listRequests.at(-1)?.searchParams.get('key_mode'), 'service');
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('historical ready rows and live updates use completion date instead of creation date', async () => {
      const { page, row, details, listRequests, emitJobEvent, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text, 'service', {
        query: 'status=ready&from=2026-11-21&to=2026-11-21', historicalReady: true,
      });
      try {
        await row('bài đã hoàn tất').waitFor();
        assert.equal(listRequests[0].searchParams.get('status'), 'ready');
        assert.equal(listRequests[0].searchParams.get('from'), '2026-11-21');
        details.set(completedId, { ...details.get(completedId)!, keyword: 'hoàn tất trong kỳ dù tạo từ tháng trước', updated_at: '2026-11-22T03:00:00Z' });
        await emitJobEvent('job.updated', { job_id: completedId });
        await row('hoàn tất trong kỳ dù tạo từ tháng trước').waitFor();
        details.set(completedId, { ...details.get(completedId)!, completed_at: '2026-11-22T03:00:00Z', updated_at: '2026-11-22T04:00:00Z' });
        await emitJobEvent('job.updated', { job_id: completedId });
        await row('hoàn tất trong kỳ dù tạo từ tháng trước').waitFor({ state: 'hidden' });
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

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
        await drawer.getByText('Chưa có dữ liệu chi phí', { exact: true }).waitFor();
        assert.doesNotMatch(await drawer.innerText(), /đối soát/i);
        assert.doesNotMatch(await drawer.innerText(), /USD|US\$/);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('own-key jobs show no cost accounting even when older data contains prices', async () => {
      const { page, row, details, emitJobEvent, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        details.set(completedId, { ...details.get(completedId)!, key_mode: 'own', rewrite_key_mode: 'service', cost_usd: '9', cost_vnd: '225000', attempts: [
          { id: 'legacy-own', provider: 'openai', model: 'Key cá nhân', status: 'succeeded', started_at: '2026-11-20T03:00:00Z',
            cost_usd: '9', cost_vnd: '225000', cost_source: 'estimated', pricing_id: 'legacy-price',
            pricing_snapshot: { total: 7 }, usage: { input: 100, output: 200 }, provider_response_id: 'response-own' },
        ] });
        await emitJobEvent('job.updated', { job_id: completedId });
        await row('bài đã hoàn tất').getByText('—', { exact: true }).first().waitFor();
        assert.doesNotMatch(await row('bài đã hoàn tất').innerText(), /225\.000/);
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByRole('tab', { name: 'Lần gọi AI (1)', exact: true }).click();
        await drawer.getByText('Không theo dõi chi phí', { exact: true }).waitFor();
        assert.doesNotMatch(await drawer.innerText(), /đối soát|225\.000|Nguồn chi phí|Phiên bản giá|Usage và đơn giá/i);
        await drawer.getByText('Usage đã ghi', { exact: true }).click();
        assert.match(await drawer.locator('.attempt-details pre').innerText(), /"input": 100/);
        assert.doesNotMatch(await drawer.locator('.attempt-details pre').innerText(), /pricing|total/);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('legacy missing-cost links describe data without a reconciliation workflow', async () => {
      const { page, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text, 'service', {
        query: 'issue=unpriced', issueRows: [activeId],
      });
      try {
        await page.getByText('Đang lọc: Lần gọi AI dịch vụ chưa có dữ liệu chi phí', { exact: true }).waitFor();
        assert.doesNotMatch(await page.locator('body').innerText(), /đối soát/i);
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
        await modal.getByText('Nhập Base URL để viết lại bài.', { exact: true }).waitFor();
        await modal.getByLabel('Base URL', { exact: true }).fill('https://api.example.com/v1');
        await modal.getByLabel('API key riêng', { exact: true }).fill('  fixture-own-key  ');
        await modal.getByRole('button', { name: 'Tạo bản viết lại', exact: true }).click();
        await modal.waitFor({ state: 'hidden' });
        await page.locator('.ant-drawer').getByText(rewrittenId, { exact: true }).waitFor();
        assert.deepEqual(posts, [{ method: 'POST', body: { base_url: 'https://api.example.com/v1', keyAI: 'fixture-own-key' }, csrf: 'fixture-csrf' }]);
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
        await drawer.getByRole('tab', { name: 'Bài viết', exact: true }).click();
        await drawer.getByText('Kiểm tra trước khi xuất bản', { exact: true }).waitFor();
        await drawer.getByText(/Trạng thái đã viết hoặc đã giao chưa xác nhận nội dung đã được con người kiểm duyệt/).waitFor();
        if (process.env.CRM_EDITORIAL_SCREENSHOT) {
          await page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
          await page.addStyleTag({ content: await readFile('web/src/records.css', 'utf8') });
          await page.screenshot({ path: process.env.CRM_EDITORIAL_SCREENSHOT, fullPage: true });
          await page.setViewportSize({ width: 375, height: 900 });
          assert.equal(await drawer.locator('.editorial-review-notice').evaluate(element => element.scrollWidth <= element.clientWidth), true);
          if (process.env.CRM_EDITORIAL_MOBILE_SCREENSHOT) await drawer.locator('.editorial-review-notice').screenshot({ path: process.env.CRM_EDITORIAL_MOBILE_SCREENSHOT });
          await page.setViewportSize({ width: 1440, height: 1000 });
        }
        await drawer.getByRole('tab', { name: 'Kiểm tra SEO', exact: true }).click();
        await drawer.getByText('Bài viết được chấp nhận và còn gợi ý SEO', { exact: true }).waitFor();
        await drawer.getByText('Lượt chỉnh sửa SEO chưa tạo được bản tốt hơn. Bản nháp đã lưu được giữ lại để bạn chỉnh sửa.', { exact: true }).waitFor();
        await drawer.getByText(/không xác nhận bài đã đáp ứng chính sách Google hoặc được kiểm chứng sự thật/).waitFor();
        assert.ok(await drawer.getByText('Tham khảo', { exact: true }).count() > 0);
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
        assert.deepEqual((await drawer.getByRole('tab').allTextContents()).slice(0, 4), ['Yêu cầu', 'Dàn ý', 'Nguồn nghiên cứu', 'Bài viết']);
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

    await t.test('research sources can be opened for checking against the outline', async () => {
      const { page, row, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByRole('tab', { name: 'Nguồn nghiên cứu', exact: true }).click();
        const review = drawer.getByRole('region', { name: 'Nguồn nghiên cứu', exact: true });
        await review.getByRole('heading', { name: 'Nguồn 1: Tài liệu kiểm thử', exact: true }).waitFor();
        await review.getByText('Ưu tiên nhu cầu đã xác minh.', { exact: true }).waitFor();
        await review.getByText(/chưa phải toàn văn hoặc xác minh sự thật/).waitFor();
        const source = review.getByRole('link', { name: 'https://example.org/research', exact: true });
        assert.equal(await source.getAttribute('href'), 'https://example.org/research');
        assert.equal(await source.getAttribute('rel'), 'noopener noreferrer');
        await page.setViewportSize({ width: 375, height: 900 });
        assert.ok(await review.evaluate(element => element.scrollWidth <= element.clientWidth + 1));
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('internal link tab shows catalog diagnostics and makes verification limits clear', async () => {
      const { page, row, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        assert.deepEqual((await drawer.getByRole('tab').allTextContents()).slice(0, 4), ['Yêu cầu', 'Dàn ý', 'Nguồn nghiên cứu', 'Bài viết']);
        await drawer.getByRole('tab', { name: 'Liên kết nội bộ', exact: true }).click();
        const report = drawer.getByRole('region', { name: 'Liên kết nội bộ', exact: true });
        await report.getByText('Đã kiểm tra theo danh mục website', { exact: true }).waitFor();
        await report.getByText(/Danh mục do Laravel cung cấp/).waitFor();
        await report.getByText(/không tải trang đích để xác nhận nội dung hoặc trạng thái HTTP/).waitFor();
        await report.getByText(/Không ép chèn đủ số liên kết; các liên kết có sẵn trong bài nguồn được giữ riêng/).waitFor();
        const valueFor = async (label: string) => report.locator('.ant-descriptions-row').filter({ has: page.getByText(label, { exact: true }) }).locator('.ant-descriptions-item-content').innerText();
        assert.equal(await valueFor('Ứng viên đã chọn'), '2');
        assert.equal(await valueFor('Liên kết từ danh mục'), '1');
        assert.equal(await valueFor('Thẻ liên kết bị loại'), '1');
        assert.match(await valueFor('Kiểm tra lúc'), /23\/11\/26/);
        await report.getByRole('cell', { name: 'hướng dẫn chọn website phù hợp', exact: true }).waitFor();
        const target = report.getByRole('link', { name: 'https://example.vn/huong-dan-chon-website', exact: true });
        assert.equal(await target.getAttribute('href'), 'https://example.vn/huong-dan-chon-website');
        assert.equal(await target.getAttribute('target'), '_blank');
        assert.equal(await target.getAttribute('rel'), 'noopener noreferrer');
        if (process.env.CRM_INTERNAL_LINK_SCREENSHOT) {
          await page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
          await page.addStyleTag({ content: await readFile('web/src/records.css', 'utf8') });
          await page.screenshot({ path: process.env.CRM_INTERNAL_LINK_SCREENSHOT, fullPage: true });
        }
        assert.deepEqual(unexpected, []);
        assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });

    await t.test('internal link tab explains an older job without a report', async () => {
      const { page, row, details, unexpected, pageErrors } = await mockCrm(browser, outputFiles[0].text);
      try {
        const legacy = { ...details.get(completedId)! };
        delete legacy.internal_link_report;
        details.set(completedId, legacy);
        await row('bài đã hoàn tất').getByRole('button', { name: /bài đã hoàn tất/ }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByRole('tab', { name: 'Liên kết nội bộ', exact: true }).click();
        await drawer.getByText('Bài này chưa có báo cáo liên kết nội bộ', { exact: true }).waitFor();
        assert.equal(await drawer.getByRole('region', { name: 'Liên kết nội bộ', exact: true }).count(), 0);
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
