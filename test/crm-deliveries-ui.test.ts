import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { Delivery } from '../web/src/types';

const origin = 'http://localhost:3232';
const ids = { failed: 'delivery-failed', delivered: 'delivery-delivered', pending: 'delivery-pending', sending: 'delivery-sending' };
const keywords = { failed: 'Bài giao lỗi', delivered: 'Bài đã giao', pending: 'Bài chờ giao', sending: 'Bài đang giao' };
type Status = keyof typeof ids;
type Mutation = { method: string; path: string; csrf?: string };

async function mockDeliveries(browser: Browser, bundle: string, width = 1440, options: { query?: string } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(10000);
  const rows = new Map(Object.entries(ids).map(([status, id]) => [id, {
    id, job_id: `original-job-${status}`, keyword: keywords[status as Status], website_name: 'Website kiểm thử',
    customer_name: 'Khách kiểm thử', status, event_type: 'article.ready', attempt_count: 1, attempts: 1,
    last_http_status: status === 'delivered' ? 200 : status === 'failed' ? 500 : null,
    last_error: status === 'failed' ? 'Webhook tạm thời lỗi.' : null,
    next_attempt_at: status === 'pending' ? '2030-01-01T00:00:00Z' : null,
    delivered_at: status === 'delivered' ? '2026-11-22T00:05:00Z' : null,
    id_post: status === 'delivered' ? 12345 : null,
    acknowledged_at: status === 'delivered' ? '2026-11-22T00:05:00Z' : null,
    created_at: '2026-11-22T00:00:00Z', history: status === 'delivered' ? [
      { id: 'attempt-invalid', attempted_at: '2026-11-22T00:00:00Z', http_status: 200, error: 'Laravel chưa trả xác nhận hợp lệ.', id_post: null, acknowledged_at: null },
      { id: 'attempt-acknowledged', attempted_at: '2026-11-22T00:05:00Z', http_status: 200, error: null, id_post: 12345, acknowledged_at: '2026-11-22T00:05:00Z' },
    ] : [],
  } satisfies Delivery]));
  const mutations: Mutation[] = [];
  const detailReads: string[] = [];
  const listRequests: URL[] = [];
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  let mutationError: 'retry' | 'delete' | undefined;
  let holdRetry: { promise: Promise<void>; resolve: () => void } | undefined;
  let listReads = 0;
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { unexpected.push(request.url()); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/crm-test.js"></script></body></html>' });
    if (url.pathname === '/crm-test.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/crm/session/bootstrap') return route.fulfill({ json: { browser_binding: 'b'.repeat(43), server_time: Date.now() } });
    if (url.pathname === '/api/crm/deliveries' && request.method() === 'GET') {
      listReads++;
      listRequests.push(url);
      return route.fulfill({ json: { data: [...rows.values()], next_cursor: null } });
    }
    if (['/api/crm/customers', '/api/crm/websites'].includes(url.pathname)) return route.fulfill({ json: { data: [] } });
    const match = /^\/api\/crm\/deliveries\/([^/]+)(\/retry)?$/.exec(url.pathname);
    if (match) {
      const delivery = rows.get(match[1]);
      if (request.method() === 'GET' && !match[2]) {
        detailReads.push(match[1]);
        return route.fulfill(delivery ? { json: delivery } : { status: 404, json: { error: { code: 'not_found', message: 'Không tìm thấy lượt giao.' } } });
      }
      if (request.method() === 'POST' && match[2]) {
        mutations.push({ method: 'POST', path: url.pathname, csrf: request.headers()['x-csrf-token'] });
        if (holdRetry) await holdRetry.promise;
        if (mutationError === 'retry') return route.fulfill({ status: 409, json: { error: { code: 'delivery_busy', message: 'Lượt giao vừa được tiến trình khác xử lý.' } } });
        if (delivery) rows.set(match[1], { ...delivery, status: 'pending', last_error: null, next_attempt_at: '2026-11-22T01:00:00Z' });
        return route.fulfill({ status: 202, json: { id: match[1], status: 'pending' } });
      }
      if (request.method() === 'DELETE' && !match[2]) {
        mutations.push({ method: 'DELETE', path: url.pathname, csrf: request.headers()['x-csrf-token'] });
        if (mutationError === 'delete') return route.fulfill({ status: 409, json: { error: { code: 'delivery_busy', message: 'Không thể xóa lượt giao đang được xử lý.' } } });
        rows.delete(match[1]);
        return route.fulfill({ status: 204 });
      }
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(`${origin}/${options.query ? `?${options.query}` : ''}`);
  const row = (status: Status) => page.getByRole('row').filter({ has: page.getByRole('button', { name: new RegExp(keywords[status]) }) });
  await row('failed').waitFor();
  return {
    page, row, rows, mutations, detailReads, listRequests, unexpected, pageErrors,
    getListReads: () => listReads,
    setError: (kind?: 'retry' | 'delete') => { mutationError = kind; },
    holdRetry: () => {
      let resolve!: () => void;
      holdRetry = { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() };
      return () => { holdRetry?.resolve(); holdRetry = undefined; };
    },
  };
}

test('CRM delivery actions support retry and safe removal from list and detail', async t => {
  const { outputFiles } = await build({
    stdin: {
      contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {App, ConfigProvider} from 'antd'; import {Deliveries} from './web/src/Jobs';
        import {setCsrfToken} from './web/src/api'; setCsrfToken('delivery-csrf');
        import {prepareBrowserLogin} from './web/src/browser-proof';
        prepareBrowserLogin().then(() => createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{token:{motion:false}}}><App><Deliveries query={new URLSearchParams(window.location.search)} /></App></ConfigProvider>));`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('Laravel acknowledgement ID is visible in the list, detail and successful attempt only', async () => {
      const { page, row, unexpected, pageErrors } = await mockDeliveries(browser, outputFiles[0].text);
      try {
        await row('delivered').getByText('12345', { exact: true }).waitFor();
        assert.doesNotMatch(await row('failed').innerText(), /12345/);
        await row('delivered').getByRole('button', { name: new RegExp(keywords.delivered) }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByText('Xác nhận lúc', { exact: true }).first().waitFor();
        await drawer.locator('.ant-descriptions').getByText('ID bài', { exact: true }).waitFor();
        await drawer.locator('.ant-descriptions').getByText('12345', { exact: true }).waitFor();
        const accepted = drawer.locator('.ant-table-tbody tr').filter({ hasText: '12345' });
        assert.match(await accepted.innerText(), /07:05 22\/11\/26/);
        const invalid = drawer.getByRole('row').filter({ hasText: 'Laravel chưa trả xác nhận hợp lệ.' });
        assert.doesNotMatch(await invalid.innerText(), /12345/);
        assert.match(await invalid.innerText(), /—/);
        if (process.env.CRM_ACK_SCREENSHOT) {
          await page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
          await page.addStyleTag({ content: await readFile('web/src/records.css', 'utf8') });
          await page.screenshot({ path: process.env.CRM_ACK_SCREENSHOT, fullPage: true });
          if (process.env.CRM_ACK_MOBILE_SCREENSHOT) {
            await page.setViewportSize({ width: 390, height: 1000 });
            await page.screenshot({ path: process.env.CRM_ACK_MOBILE_SCREENSHOT, fullPage: true });
            assert.equal(await drawer.locator('.ant-drawer-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'acknowledgement detail must fit the mobile drawer');
            const historyScroll = drawer.locator('.ant-table-content');
            assert.equal(await historyScroll.evaluate(node => node.scrollWidth > node.clientWidth), true, 'wide history must scroll within the drawer');
            await historyScroll.evaluate(node => { node.scrollLeft = node.scrollWidth; });
            const errorCell = invalid.getByRole('cell', { name: 'Laravel chưa trả xác nhận hợp lệ.', exact: true });
            const errorBox = await errorCell.boundingBox();
            assert.ok(errorBox && errorBox.x >= 0 && errorBox.x < 390, 'history errors must be reachable by horizontal scrolling');
            await page.screenshot({ path: process.env.CRM_ACK_MOBILE_SCREENSHOT.replace(/\.png$/, '-scrolled.png'), fullPage: true });
          }
        }
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
    await t.test('overview delivery issue links forward their scope and clear only the issue filter', async () => {
      for (const [issue, label] of [['stale', 'Lượt giao chờ phục hồi'], ['queue', 'Lượt giao đã đến giờ']] as const) {
        const { page, listRequests, unexpected, pageErrors } = await mockDeliveries(browser, outputFiles[0].text, 1440, {
          query: `issue=${issue}&customer_id=customer-test&website_id=website-test&event=article.ready&status=${issue === 'stale' ? 'sending' : 'pending'}`,
        });
        try {
          await page.getByText(`Đang lọc: ${label}`, { exact: true }).waitFor();
          assert.equal(listRequests[0].searchParams.get('issue'), issue);
          assert.equal(listRequests[0].searchParams.get('customer_id'), 'customer-test');
          assert.equal(listRequests[0].searchParams.get('website_id'), 'website-test');
          assert.equal(listRequests[0].searchParams.get('event'), 'article.ready');
          const cleared = page.waitForResponse(response => new URL(response.url()).pathname === '/api/crm/deliveries' && !new URL(response.url()).searchParams.has('issue'));
          await page.getByRole('button', { name: 'Bỏ lọc này', exact: true }).click();
          await cleared;
          await page.getByText(`Đang lọc: ${label}`, { exact: true }).waitFor({ state: 'hidden' });
          const filters = listRequests.at(-1)!.searchParams;
          assert.equal(filters.has('issue'), false);
          assert.equal(filters.get('customer_id'), 'customer-test');
          assert.equal(filters.get('website_id'), 'website-test');
          assert.equal(filters.get('event'), 'article.ready');
          assert.equal(filters.get('status'), issue === 'stale' ? 'sending' : 'pending');
          assert.deepEqual(unexpected, []);
          assert.deepEqual(pageErrors, []);
        } finally { await page.close(); }
      }
    });

    await t.test('row actions expose icon labels and prevent duplicate failed retries without opening detail', async () => {
      const fixture = await mockDeliveries(browser, outputFiles[0].text);
      const { page, row, mutations, detailReads, unexpected, pageErrors } = fixture;
      let release: (() => void) | undefined;
      try {
        for (const status of ['failed', 'delivered', 'pending', 'sending'] as const) {
          assert.equal(await row(status).getByRole('button', { name: 'Gửi lại', exact: true }).isDisabled(), ['pending', 'sending'].includes(status));
          assert.equal(await row(status).getByRole('button', { name: 'Xóa lượt giao', exact: true }).isDisabled(), status === 'sending');
          assert.equal(await row(status).getByRole('button', { name: 'Gửi lại', exact: true }).innerText(), '');
          assert.equal(await row(status).getByRole('button', { name: 'Xóa lượt giao', exact: true }).innerText(), '');
        }
        await row('pending').getByRole('button', { name: 'Gửi lại', exact: true }).locator('..').hover();
        await page.getByRole('tooltip', { name: 'Gửi lại', exact: true }).waitFor();
        release = fixture.holdRetry();
        await row('failed').getByRole('button', { name: 'Gửi lại', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[aria-label="Gửi lại"].ant-btn-loading') !== null);
        assert.equal(await row('failed').getByRole('button', { name: 'Gửi lại', exact: true }).isDisabled(), true);
        assert.equal(await row('delivered').getByRole('button', { name: 'Gửi lại', exact: true }).isDisabled(), false, 'loading should be scoped to the active delivery');
        assert.equal(mutations.length, 1);
        assert.deepEqual(detailReads, [], 'row action must not open the drawer');
        release(); release = undefined;
        await row('failed').getByText('Chờ xử lý', { exact: true }).waitFor();
        assert.deepEqual(mutations, [{ method: 'POST', path: `/api/crm/deliveries/${ids.failed}/retry`, csrf: 'delivery-csrf' }]);
        assert.equal(fixture.getListReads(), 2);
        assert.equal(await page.getByRole('dialog').count(), 0);
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { release?.(); await page.close(); }
    });
    await t.test('resending delivered content requires confirmation before making a request', async () => {
      const { page, row, mutations, detailReads, unexpected, pageErrors } = await mockDeliveries(browser, outputFiles[0].text);
      try {
        await row('delivered').getByRole('button', { name: 'Gửi lại', exact: true }).click();
        const confirm = page.locator('.ant-modal-confirm');
        await confirm.waitFor();
        assert.match(await confirm.innerText(), /trùng|lặp/i);
        assert.equal(mutations.length, 0);
        await confirm.getByRole('button', { name: 'Hủy', exact: true }).click();
        assert.equal(mutations.length, 0);
        await row('delivered').getByRole('button', { name: 'Gửi lại', exact: true }).click();
        await page.locator('.ant-modal-confirm .ant-modal-confirm-btns .ant-btn-primary').click();
        await row('delivered').getByText('Chờ xử lý', { exact: true }).waitFor();
        assert.deepEqual(mutations, [{ method: 'POST', path: `/api/crm/deliveries/${ids.delivered}/retry`, csrf: 'delivery-csrf' }]);
        assert.deepEqual(detailReads, []); assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
    await t.test('delete confirmation only removes the delivery and closes its selected detail', async () => {
      const { page, row, mutations, rows, unexpected, pageErrors } = await mockDeliveries(browser, outputFiles[0].text);
      try {
        await row('failed').getByRole('button', { name: new RegExp(keywords.failed) }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByText('Mã sự kiện', { exact: true }).waitFor();
        await drawer.getByRole('button', { name: 'Xóa lượt giao', exact: true }).click();
        const popconfirm = page.locator('.ant-popconfirm');
        await popconfirm.getByText('Xóa lượt giao bài?', { exact: true }).waitFor();
        assert.match(await popconfirm.innerText(), /CRM/);
        assert.match(await popconfirm.innerText(), /website/i);
        await popconfirm.getByRole('button', { name: 'Hủy', exact: true }).click();
        assert.equal(mutations.length, 0);
        await drawer.getByRole('button', { name: 'Xóa lượt giao', exact: true }).click();
        await page.locator('.ant-popconfirm').getByRole('button', { name: 'Xóa', exact: true }).click();
        await row('failed').waitFor({ state: 'detached' });
        await page.locator('.ant-drawer-open').waitFor({ state: 'detached' });
        assert.deepEqual(mutations, [{ method: 'DELETE', path: `/api/crm/deliveries/${ids.failed}`, csrf: 'delivery-csrf' }]);
        assert.equal(rows.size, 3);
        assert.equal(mutations.some(item => item.path.includes('/jobs/')), false, 'never delete the source writing request');
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
    await t.test('failed mutations display feedback and preserve the delivery row', async () => {
      const fixture = await mockDeliveries(browser, outputFiles[0].text);
      const { page, row, mutations, unexpected, pageErrors } = fixture;
      try {
        fixture.setError('retry');
        await row('failed').getByRole('button', { name: 'Gửi lại', exact: true }).click();
        await page.getByText('Lượt giao vừa được tiến trình khác xử lý.', { exact: true }).waitFor();
        await row('failed').getByText('Lỗi', { exact: true }).waitFor();
        assert.equal(await row('failed').getByRole('button', { name: 'Gửi lại', exact: true }).isDisabled(), false);
        fixture.setError('delete');
        await row('failed').getByRole('button', { name: 'Xóa lượt giao', exact: true }).click();
        await page.locator('.ant-popconfirm').getByRole('button', { name: 'Xóa', exact: true }).click();
        await page.getByText('Không thể xóa lượt giao đang được xử lý.', { exact: true }).waitFor();
        await row('failed').waitFor();
        assert.equal(mutations.length, 2);
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
    await t.test('retry from detail refreshes its state and keeps the original writing link', async () => {
      const { page, row, mutations, detailReads, unexpected, pageErrors } = await mockDeliveries(browser, outputFiles[0].text);
      try {
        await row('failed').getByRole('button', { name: new RegExp(keywords.failed) }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByRole('button', { name: 'Gửi lại', exact: true }).click();
        await drawer.getByText('Chờ xử lý', { exact: true }).waitFor();
        assert.equal(await drawer.getByRole('button', { name: 'Gửi lại', exact: true }).isDisabled(), true);
        assert.equal(mutations.length, 1);
        assert.deepEqual(detailReads, [ids.failed, ids.failed]);
        await drawer.getByRole('button', { name: /Mở yêu cầu viết/ }).click();
        assert.match(page.url(), /#jobs\?job=original-job-failed$/);
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
    await t.test('delivery detail controls remain reachable on a narrow mobile screen', async () => {
      const { page, row, unexpected, pageErrors } = await mockDeliveries(browser, outputFiles[0].text, 320);
      try {
        await row('failed').getByRole('button', { name: new RegExp(keywords.failed) }).click();
        const drawer = page.locator('.ant-drawer');
        await drawer.getByRole('button', { name: 'Gửi lại', exact: true }).waitFor();
        const header = drawer.locator('.ant-drawer-header');
        assert.equal(await header.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'drawer header must fit without horizontal overflow');
        for (const name of ['Gửi lại', 'Xóa lượt giao']) {
          const box = await drawer.getByRole('button', { name, exact: true }).boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= 321, `${name} must remain inside the viewport`);
        }
        assert.deepEqual(unexpected, []); assert.deepEqual(pageErrors, []);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
