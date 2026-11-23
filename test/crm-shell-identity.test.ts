import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { AccountProfile } from '../web/src/types';

const origin = 'http://localhost:3257';
const username = 'synthetic-admin';
const csrf = 'synthetic-identity-csrf';

async function fixture(browser: Browser, bundle: string, displayName?: string, accountName = 'Tên hồ sơ đã lưu') {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const patches: unknown[] = [];
  let sessionName = displayName;
  let profile: AccountProfile = {
    username, display_name: accountName, email: 'synthetic@example.test', email_verified: true,
    mail_configured: true, remember_me: false, devices: [],
  };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { errors.push('Unexpected external request'); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/crm/session/bootstrap') return route.fulfill({ json: { browser_binding: 'b'.repeat(43), server_time: Date.now() } });
    assert.ok(request.headers()['x-crm-proof'], `${request.method()} ${url.pathname} carries a browser proof`);
    if (url.pathname === '/api/crm/session') return route.fulfill({ json: { username, csrf_token: csrf, ...(sessionName === undefined ? {} : { display_name: sessionName }) } });
    assert.equal(request.headers()['x-csrf-token'], csrf);
    if (url.pathname === '/api/crm/providers' && request.method() === 'GET') return route.fulfill({ json: { data: [] } });
    if (url.pathname === '/api/crm/account' && request.method() === 'GET') return route.fulfill({ json: profile });
    if (url.pathname === '/api/crm/account' && request.method() === 'PATCH') {
      const body = request.postDataJSON(); patches.push(body);
      assert.deepEqual(Object.keys(body), ['display_name']);
      profile = { ...profile, display_name: body.display_name }; sessionName = profile.display_name;
      return route.fulfill({ json: profile });
    }
    errors.push(`Unexpected request ${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(`${origin}/#providers`);
  await page.getByRole('heading', { name: 'Nhà cung cấp AI', exact: true }).waitFor();
  const sidebar = page.locator('.crm-sidebar');
  async function assertIdentity(name: string, initials: string) {
    await sidebar.getByRole('button', { name: `Tài khoản ${name}`, exact: true }).waitFor();
    assert.equal(await sidebar.locator('.crm-identity strong').textContent(), name);
    assert.equal(await sidebar.locator('.crm-avatar').textContent(), initials);
  }
  return { context, page, errors, patches, assertIdentity };
}

test('CRM shell uses the configured display name across reloads and profile reconciliation', async t => {
  const bundle = await build({
    stdin: { contents: `import {prepareBrowserLogin} from './web/src/browser-proof'; void prepareBrowserLogin().then(() => import('./web/src/main'));`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', write: false,
    loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('session display name drives the sidebar, accessible label and avatar before and after reload', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text, '  Lê Minh An  ');
      try {
        await f.assertIdentity('Lê Minh An', 'LA');
        await f.page.reload();
        await f.assertIdentity('Lê Minh An', 'LA');
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
    await t.test('missing or whitespace-only display names fall back to the username', async () => {
      for (const displayName of [undefined, '   ']) {
        const f = await fixture(browser, bundle.outputFiles[0].text, displayName);
        try {
          await f.assertIdentity(username, 'SY');
          assert.deepEqual(f.errors, []);
        } finally { await f.context.close(); }
      }
    });
    await t.test('loading the current account reconciles stale session data and saving updates the shell immediately', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text, 'Tên phiên cũ', 'Nguyễn Minh Tâm');
      try {
        await f.assertIdentity('Tên phiên cũ', 'TC');
        await f.page.locator('.crm-sidebar').getByRole('link', { name: 'Tài khoản', exact: true }).click();
        await f.page.getByLabel('Tên hiển thị', { exact: true }).waitFor();
        await f.assertIdentity('Nguyễn Minh Tâm', 'NT');
        await f.page.getByLabel('Tên hiển thị', { exact: true }).fill('Tên mới');
        await f.page.getByRole('button', { name: /Lưu thông tin/ }).click();
        await f.page.getByText('Đã cập nhật thông tin tài khoản.', { exact: true }).waitFor();
        await f.assertIdentity('Tên mới', 'TM');
        assert.deepEqual(f.patches, [{ display_name: 'Tên mới' }]);
        await f.page.reload();
        await f.assertIdentity('Tên mới', 'TM');
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
  } finally { await browser.close(); }
});
