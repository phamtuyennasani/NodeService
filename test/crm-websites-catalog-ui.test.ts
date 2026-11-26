import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import laravelGuide from '../web/src/laravel-guide.json';
import phpGuide from '../web/src/php-guide.json';
import integrationReleases from '../integrations/releases.json';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { Website } from '../web/src/types';

const origin = 'http://localhost:3237';
const websiteId = '11111111-1111-4111-8111-111111111111';
const customerId = '22222222-2222-4222-8222-222222222222';
const catalogUrl = 'https://example.vn/api/ai/content-catalog';
const issuedToken = 'fixture-site-token-for-laravel';
const releases = [
  { platform: 'laravel', ...integrationReleases.laravel, bytes: 20000, sha256: 'a'.repeat(64) },
  { platform: 'php', ...integrationReleases.php, bytes: 15000, sha256: 'b'.repeat(64) },
];
const zip = Buffer.from('PK\x03\x04synthetic-download');

async function fixture(browser: Browser, bundle: string, options: { configured?: boolean; checkFailure?: boolean; downloadFailure?: boolean; mobile?: boolean; status?: 'synced' | 'busy' } = {}) {
  const page = await browser.newPage({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 960 } });
  page.setDefaultTimeout(10000);
  const website: Website = {
    id: websiteId, name: 'Website kiểm thử', customer_id: customerId, customer_name: 'Khách kiểm thử',
    domain: 'example.vn', webhook_url: 'https://example.vn/api/webhooks/ai-articles',
    token_hint: 'site_test', last_seen_at: null, article_count: 0,
    content_catalog_url: options.configured === false ? null : catalogUrl,
    content_catalog_checked_at: null, content_catalog_synced_at: null, content_catalog_error: null, content_catalog_count: 0,
  };
  const mutations: { path: string; method: string; body: any; csrf?: string }[] = [];
  const errors: string[] = [];
  const integrations = structuredClone(releases);
  const downloads: { path: string; proof?: string }[] = [];
  let checkCount = 0;
  let holdCheck: Promise<void> | undefined;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { errors.push(`Unexpected origin ${url.origin}`); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/test.js"></script></body></html>' });
    if (url.pathname === '/test.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/crm/session/bootstrap') return route.fulfill({ json: { browser_binding: 'b'.repeat(43), server_time: Date.now() } });
    const path = url.pathname.replace('/api/crm', '');
    if (path === '/integrations') return route.fulfill({ json: { data: integrations } });
    const release = integrations.find(item => path === `/integrations/${item.platform}/${item.version}/download`);
    if (release) {
      downloads.push({ path, proof: request.headers()['x-crm-proof'] });
      if (options.downloadFailure) return route.fulfill({ status: 503, json: { error: { code: 'integration_unavailable', message: 'File ZIP chưa sẵn sàng.' } } });
      return route.fulfill({ contentType: 'application/zip', headers: { 'Content-Disposition': `attachment; filename="${release.filename}"` }, body: zip });
    }
    if (path === '/customers') return route.fulfill({ json: { data: [{ id: customerId, name: 'Khách kiểm thử' }], next_cursor: null } });
    if (path === '/websites' && request.method() === 'GET') return route.fulfill({ json: { data: [website], next_cursor: null } });
    mutations.push({ path, method: request.method(), body: request.postData() ? request.postDataJSON() : null, csrf: request.headers()['x-csrf-token'] });
    if (path === `/websites/${websiteId}/token` && request.method() === 'POST') {
      return route.fulfill({ json: { token: issuedToken } });
    }
    if (path === `/websites/${websiteId}/signing-key` && request.method() === 'PUT') {
      website.proof_required = true;
      website.signing_key_fingerprint = 'a'.repeat(64);
      return route.fulfill({ json: { proof_required: true, signing_key_fingerprint: website.signing_key_fingerprint } });
    }
    if ((path === `/websites/${websiteId}` && request.method() === 'PATCH') || (path === '/websites' && request.method() === 'POST')) {
      Object.assign(website, request.postDataJSON());
      return route.fulfill({ status: request.method() === 'POST' ? 201 : 200, json: { id: websiteId } });
    }
    if (path === `/websites/${websiteId}/content-catalog/check` && request.method() === 'POST') {
      checkCount++;
      if (holdCheck) await holdCheck;
      if (options.checkFailure) {
        website.content_catalog_checked_at = '2026-11-23T01:00:00Z';
        website.content_catalog_error = 'Không thể đọc JSON danh mục từ website.';
        return route.fulfill({ status: 422, json: { error: { code: 'invalid_catalog', message: website.content_catalog_error } } });
      }
      if (options.status === 'busy') return route.fulfill({ json: { status: 'busy', count: 0, synced_at: null } });
      website.content_catalog_checked_at = '2026-11-23T01:00:00Z';
      website.content_catalog_synced_at = '2026-11-23T01:00:00Z';
      website.content_catalog_count = 12;
      website.content_catalog_error = null;
      return route.fulfill({ json: { status: 'synced', count: 12, synced_at: website.content_catalog_synced_at } });
    }
    errors.push(`Unexpected request ${request.method()} ${path}`);
    return route.abort();
  });
  await page.goto(`${origin}/?website=${websiteId}`);
  const drawer = page.locator('.ant-drawer');
  await drawer.getByRole('button', { name: 'Kiểm tra danh mục', exact: true }).waitFor();
  return { page, drawer, website, mutations, errors, downloads, integrations, checkCount: () => checkCount, holdCheck: () => {
    let release!: () => void;
    holdCheck = new Promise<void>(resolve => { release = resolve; });
    return release;
  } };
}

test('CRM website catalog URL settings and manual sync', async t => {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {App,ConfigProvider} from 'antd'; import {Websites} from './web/src/Websites';
      import {setCsrfToken} from './web/src/api'; setCsrfToken('catalog-ui-csrf');
      import {prepareBrowserLogin} from './web/src/browser-proof';
      prepareBrowserLogin().then(() => createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{token:{motion:false}}}><App><Websites query={new URLSearchParams(window.location.search)} /></App></ConfigProvider>));`,
      resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('shows the connection at issuance and the current Laravel copy instructions in the widget tab', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text);
      try {
        await f.drawer.getByRole('button', { name: /Đổi token/ }).click();
        await f.page.getByRole('button', { name: 'Cấp token website', exact: true }).click();
        const connection = f.page.getByRole('textbox', { name: 'Cấu hình connection Laravel' });
        assert.equal(await connection.inputValue(), `'connection' => '${origin}|${websiteId}|${issuedToken}',`);
        await f.page.getByRole('button', { name: 'Đóng', exact: true }).click();
        await connection.waitFor({ state: 'detached' });
        await f.drawer.getByRole('tab', { name: 'Hướng dẫn tích hợp' }).click();
        await f.drawer.getByText(`'connection' => '${origin}|${websiteId}|<token-website>',`, { exact: true }).waitFor();
        const guide = await f.drawer.innerText();
        assert.doesNotMatch(guide, new RegExp(issuedToken));
        for (const file of ['config/crm-ai.php', 'app/Http/Controllers/CrmAiController.php', 'routes/crm-ai.php', 'resources/views/admin/layouts/js.blade.php']) {
          assert.ok(guide.includes(file), file);
        }
        assert.ok(guide.includes('AIConfig.languages'));
        assert.ok(guide.includes('crmScript.dataset.credentialsUrl'));
        assert.doesNotMatch(guide, /crm_ai_article_ref|crm_ai_source_job_id|crm_ai_source_locale/);
        assert.equal(await f.drawer.locator('pre').last().textContent(), laravelGuide.widget);
        assert.doesNotMatch(guide, /x-crm-ai::|NodeService\\CrmAi|crm-ai:public-key/);
        assert.deepEqual(f.errors, []);
      } finally { await f.page.close(); }
    });
    await t.test('offers platform-specific instructions and signed ZIP downloads on mobile', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text, { mobile: true });
      try {
        await f.page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
        await f.page.addStyleTag({ content: await readFile('web/src/records.css', 'utf8') });
        await f.drawer.getByRole('tab', { name: 'Hướng dẫn tích hợp' }).click();
        for (const release of releases) {
          const label = release.platform === 'laravel' ? 'Laravel' : 'PHP thuần';
          await f.drawer.getByRole('tab', { name: label, exact: true }).click();
          await f.drawer.getByText(`Phiên bản ${release.version}`, { exact: true }).waitFor();
          const [download] = await Promise.all([
            f.page.waitForEvent('download'),
            f.drawer.getByRole('button', { name: `Tải ZIP ${label}`, exact: true }).click(),
          ]);
          assert.equal(download.suggestedFilename(), release.filename);
          const path = await download.path();
          assert.deepEqual(await readFile(path!), zip);
          assert.equal(f.downloads.at(-1)?.path, `/integrations/${release.platform}/${release.version}/download`);
          assert.ok(f.downloads.at(-1)?.proof);
        }
        const guide = await f.drawer.innerText();
        assert.ok(guide.includes('PHP 8.2'));
        assert.ok(guide.includes('không cần cài Composer'));
        for (const name of ['bootstrap', 'editor', 'authorize'] as const) {
          assert.equal(phpGuide[name], await readFile(`packages/php-crm-ai/examples/${name}.php`, 'utf8'));
          await f.drawer.getByText(`examples/${name}.php`, { exact: true }).click();
          await f.drawer.getByRole('button', { name: `Sao chép ${name}.php`, exact: true }).waitFor();
          const panel = f.drawer.locator('.ant-collapse-item').filter({ hasText: `examples/${name}.php` });
          assert.equal(await panel.locator('pre').textContent(), phpGuide[name]);
        }
        const updatedVersion = f.integrations[1].version.replace(/\d+$/, patch => String(Number(patch) + 1));
        const updatedFilename = f.integrations[1].filename.replace(f.integrations[1].version, updatedVersion);
        Object.assign(f.integrations[1], { version: updatedVersion, filename: updatedFilename });
        await f.drawer.getByRole('button', { name: 'Kiểm tra bản cập nhật PHP thuần', exact: true }).click();
        await f.drawer.getByText(`Phiên bản ${updatedVersion}`, { exact: true }).waitFor();
        const [updatedDownload] = await Promise.all([
          f.page.waitForEvent('download'),
          f.drawer.getByRole('button', { name: 'Tải ZIP PHP thuần', exact: true }).click(),
        ]);
        assert.equal(updatedDownload.suggestedFilename(), updatedFilename);
        assert.equal(f.downloads.at(-1)?.path, `/integrations/php/${updatedVersion}/download`);
        assert.ok((await f.drawer.locator('.ant-drawer-body').evaluate(node => node.scrollWidth - node.clientWidth)) <= 1);
        assert.deepEqual(f.errors, []);
      } finally { await f.page.close(); }
    });
    await t.test('shows a download error without producing an empty ZIP', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text, { downloadFailure: true });
      try {
        let downloadCount = 0;
        f.page.on('download', () => downloadCount++);
        await f.drawer.getByRole('tab', { name: 'Hướng dẫn tích hợp' }).click();
        await f.drawer.getByRole('button', { name: 'Tải ZIP Laravel', exact: true }).click();
        await f.page.getByText('File ZIP chưa sẵn sàng.', { exact: true }).waitFor();
        assert.equal(downloadCount, 0);
        assert.equal(await f.drawer.getByRole('button', { name: 'Tải ZIP Laravel', exact: true }).isEnabled(), true);
        assert.deepEqual(f.errors, []);
      } finally { await f.page.close(); }
    });
    await t.test('registers a server public key and displays its fingerprint after confirmation', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text);
      try {
        await f.drawer.getByRole('button', { name: 'Đăng ký khóa ký', exact: true }).click();
        const dialog = f.page.locator('.ant-modal').filter({ has: f.page.getByLabel('Khóa công khai máy chủ') });
        assert.equal(await dialog.getByRole('button', { name: 'Xác nhận khóa ký' }).isDisabled(), true);
        const key = '-----BEGIN PUBLIC KEY-----\nfixture-public-key\n-----END PUBLIC KEY-----';
        await dialog.getByLabel('Khóa công khai máy chủ').fill(key);
        await dialog.getByRole('button', { name: 'Xác nhận khóa ký' }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.deepEqual(f.mutations[0].body, { public_key: key, expected_fingerprint: null });
        assert.equal(f.mutations[0].csrf, 'catalog-ui-csrf');
        await f.drawer.getByText('Đã đăng ký khóa ký', { exact: true }).waitFor();
        await f.drawer.getByText('a'.repeat(64), { exact: true }).waitFor();
        assert.deepEqual(f.errors, []);
      } finally { await f.page.close(); }
    });
    await t.test('edits the catalog URL, trims it and clears it explicitly without fetching before save', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text);
      try {
        await f.drawer.getByRole('button', { name: 'Chỉnh sửa', exact: true }).click();
        const dialog = f.page.locator('.ant-modal');
        const input = dialog.getByLabel('URL danh mục liên kết', { exact: true });
        assert.equal(await input.inputValue(), catalogUrl);
        await input.fill('  https://example.vn/api/links  ');
        assert.equal(f.checkCount(), 0);
        await dialog.getByRole('button', { name: 'Lưu website', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(f.mutations[0].body.content_catalog_url, 'https://example.vn/api/links');
        assert.equal(f.mutations[0].csrf, 'catalog-ui-csrf');
        assert.equal(f.checkCount(), 0);
        await f.drawer.getByText('https://example.vn/api/links', { exact: true }).waitFor();
        await f.drawer.getByRole('button', { name: 'Chỉnh sửa', exact: true }).click();
        await input.fill('');
        await dialog.getByRole('button', { name: 'Lưu website', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(f.mutations[1].body.content_catalog_url, null);
        const button = f.drawer.getByRole('button', { name: 'Kiểm tra danh mục', exact: true });
        await f.page.waitForFunction(() => document.querySelector('.ant-drawer-body button') !== null);
        assert.equal(await button.isDisabled(), true);
        assert.deepEqual(f.errors, []);
      } finally { await f.page.close(); }
    });

    await t.test('checks saved URL once while pending and refreshes synchronization details', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text);
      try {
        const release = f.holdCheck();
        const button = f.drawer.getByRole('button', { name: 'Kiểm tra danh mục', exact: true });
        await button.click();
        await f.page.waitForFunction(() => Boolean(document.querySelector('.ant-btn-loading')));
        await f.drawer.locator('button.ant-btn-loading').click({ force: true });
        assert.equal(f.checkCount(), 1);
        release();
        await f.page.getByText('Đã đọc danh mục: 12 trang có thể liên kết.', { exact: true }).waitFor();
        await f.drawer.getByText('12', { exact: true }).waitFor();
        assert.match(await f.drawer.innerText(), /23\/11\/26/);
        assert.equal(f.mutations[0].path, `/websites/${websiteId}/content-catalog/check`);
        assert.equal(f.mutations[0].csrf, 'catalog-ui-csrf');
        assert.deepEqual(f.errors, []);
      } finally { await f.page.close(); }
    });

    await t.test('shows a safe endpoint error and retains saved configuration', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text, { checkFailure: true });
      try {
        await f.drawer.getByRole('button', { name: 'Kiểm tra danh mục', exact: true }).click();
        await f.drawer.getByText('Chưa đọc được danh mục liên kết', { exact: true }).waitFor();
        await f.drawer.getByText('Không thể đọc JSON danh mục từ website.', { exact: true }).waitFor();
        assert.equal(f.website.content_catalog_url, catalogUrl);
        assert.equal(f.website.content_catalog_count, 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.page.close(); }
    });

    await t.test('does not offer a check for an unconfigured site and treats busy as in progress', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text, { configured: false });
      try {
        assert.equal(await f.drawer.getByRole('button', { name: 'Kiểm tra danh mục', exact: true }).isDisabled(), true);
        assert.equal(f.checkCount(), 0);
      } finally { await f.page.close(); }
      const busy = await fixture(browser, bundle.outputFiles[0].text, { status: 'busy' });
      try {
        await busy.drawer.getByRole('button', { name: 'Kiểm tra danh mục', exact: true }).click();
        await busy.page.getByText('CRM đang kiểm tra danh mục của website. Hãy thử lại sau.', { exact: true }).waitFor();
        assert.equal(busy.website.content_catalog_synced_at, null);
        assert.deepEqual(busy.errors, []);
      } finally { await busy.page.close(); }
    });

    await t.test('adds an optional URL on create and validates URL syntax before saving', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text, { configured: false });
      try {
        await f.drawer.getByRole('button', { name: 'Close', exact: true }).click();
        await f.page.getByRole('button', { name: /Thêm website/ }).click();
        const dialog = f.page.locator('.ant-modal');
        await dialog.getByLabel('Khách hàng', { exact: true }).click();
        await f.page.locator('.ant-select-item-option').filter({ hasText: 'Khách kiểm thử' }).click();
        await dialog.getByLabel('Tên hiển thị', { exact: true }).fill('Website mới');
        await dialog.getByLabel('Tên miền', { exact: true }).fill('example.vn');
        await dialog.getByLabel('URL webhook nhận bài', { exact: true }).fill('https://example.vn/webhook');
        const input = dialog.getByLabel('URL danh mục liên kết', { exact: true });
        await input.fill('file:///etc/passwd');
        await dialog.getByRole('button', { name: 'Lưu website', exact: true }).click();
        await dialog.getByText('Nhập URL HTTPS hợp lệ.', { exact: true }).first().waitFor();
        assert.equal(f.mutations.length, 0);
        await input.fill(catalogUrl);
        await dialog.getByRole('button', { name: 'Lưu website', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(f.mutations[0].method, 'POST');
        assert.equal(f.mutations[0].body.content_catalog_url, catalogUrl);
        assert.equal(f.checkCount(), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.page.close(); }
    });

    await t.test('catalog field and details fit mobile screens', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text, { mobile: true });
      try {
        await f.page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
        await f.page.addStyleTag({ content: await readFile('web/src/records.css', 'utf8') });
        const metrics = await f.drawer.locator('.ant-drawer-body').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
        assert.ok(metrics.scroll <= metrics.client + 1, `drawer content overflow ${metrics.scroll}/${metrics.client}`);
        await f.drawer.getByRole('button', { name: 'Chỉnh sửa', exact: true }).click();
        const dialog = f.page.locator('.ant-modal');
        await dialog.getByLabel('URL danh mục liên kết', { exact: true }).scrollIntoViewIfNeeded();
        const field = await dialog.getByLabel('URL danh mục liên kết', { exact: true }).boundingBox();
        assert.ok(field && field.x >= 0 && field.x + field.width <= 390);
        if (process.env.CRM_CATALOG_URL_SCREENSHOT) await f.page.screenshot({ path: process.env.CRM_CATALOG_URL_SCREENSHOT, fullPage: true });
        assert.deepEqual(f.errors, []);
      } finally { await f.page.close(); }
    });
  } finally { await browser.close(); }
});
