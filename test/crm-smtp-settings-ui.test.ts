import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { RuntimeSettings } from '../web/src/Settings';

const origin = 'http://localhost:3254';
const syntheticPassword = 'synthetic-operator-password';
const syntheticSmtpPassword = 'synthetic-smtp-app-password';
const csrf = 'synthetic-smtp-csrf';
const actionToken = 't'.repeat(43);
const runtimeValues: RuntimeSettings = {
  usd_to_vnd: 25000, writer_concurrency: 5, delivery_concurrency: 5, worker_poll_ms: 500,
  ai_timeout_ms: 120000, outline_timeout_ms: 120000, seo_repair_timeout_ms: 90000,
  writer_max_attempts: 3, delivery_max_attempts: 5, delivery_retry_minutes: 5, webhook_timeout_ms: 15000,
  research_enabled: true, research_timeout_ms: 8000, research_max_results: 5,
  job_retention_days: 0, delivery_retention_days: 0, cleanup_interval_minutes: 60,
  provider_limits: Object.fromEntries(['openai', 'anthropic', 'xai', 'openai-compatible'].map(provider => [provider, {
    concurrency: 10, requests_per_minute: 60, tokens_per_minute: 120000,
  }])) as RuntimeSettings['provider_limits'],
};
const initialSmtp = { host: 'smtp.example.test', port: 587, secure: false, from: 'noreply@example.test', user: 'smtp-user@example.test' };
const bodyHash = (raw: string) => createHash('sha256').update(raw).digest('base64url');
type Captured = { method: string; path: string; raw: string; body: any; headers: Record<string, string> };
type Authorization = { current_password: string; method: string; target: string; body_hash: string };

async function fixture(browser: Browser, bundle: string, conflict = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const attempts: Captured[] = [];
  const authorizations: Authorization[] = [];
  const saved: Captured[] = [];
  let authorization: Authorization | undefined;
  let smtp = structuredClone(initialSmtp);
  let revision = 3;
  let smtpGets = 0;
  let passwordConfigured = true;
  let rejectNextSave = conflict;
  const response = () => ({ values: smtp, revision, password_configured: passwordConfigured, configured: true, source: 'database', updated_at: '2026-11-23T00:00:00Z' });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { errors.push('Unexpected external request'); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    const method = request.method();
    const path = url.pathname;
    const headers = request.headers();
    if (path === '/api/crm/session/bootstrap') return route.fulfill({ json: { browser_binding: 'b'.repeat(43), server_time: Date.now() } });
    assert.ok(headers['x-crm-proof'], `${method} ${path} must carry a browser proof`);
    if (path === '/api/crm/session') return route.fulfill({ json: { username: 'synthetic-admin', csrf_token: csrf } });
    assert.equal(headers['x-csrf-token'], csrf);
    if (path === '/api/crm/settings' && method === 'GET') return route.fulfill({ json: { values: runtimeValues, defaults: runtimeValues, revision: 7, updated_at: null } });
    if (path === '/api/crm/settings/smtp' && method === 'GET') { smtpGets++; return route.fulfill({ json: response() }); }
    const raw = request.postData() ?? '';
    const body = raw ? JSON.parse(raw) : undefined;
    if (path === '/api/crm/session/authorize' && method === 'POST') {
      assert.equal(body.current_password, syntheticPassword);
      authorization = body; authorizations.push(body);
      return route.fulfill({ json: { action_token: actionToken, expires_in: 60 } });
    }
    if ((path === '/api/crm/settings/smtp' && method === 'PUT') || (path === '/api/crm/settings/smtp/test' && method === 'POST')) {
      const captured = { method, path, raw, body, headers }; attempts.push(captured);
      if (path.endsWith('/test')) {
        assert.deepEqual(body, { revision }, 'connection tests use the saved revision without resending a password or unsaved draft');
        assert.equal(headers['x-crm-action-token'], undefined);
        saved.push(captured); return route.fulfill({ json: { ok: true } });
      }
      if (!authorization || headers['x-crm-action-token'] !== actionToken || authorization.method !== method || authorization.target !== path || authorization.body_hash !== bodyHash(raw)) {
        return route.fulfill({ status: 403, json: { error: { code: 'reauthentication_required', message: 'Vui lòng xác nhận mật khẩu.' } } });
      }
      authorization = undefined;
      if (rejectNextSave) {
        rejectNextSave = false; revision++;
        smtp = { ...smtp, from: 'other@example.test' };
        return route.fulfill({ status: 409, json: { error: { code: 'smtp_settings_conflict', message: 'Cấu hình SMTP đã được thay đổi.' } } });
      }
      assert.equal(body.revision, revision);
      const { password, ...safe } = body.values;
      smtp = safe;
      if (!smtp.user) passwordConfigured = false;
      else if (password) passwordConfigured = true;
      saved.push(captured); revision++;
      return route.fulfill({ json: response() });
    }
    errors.push(`Unexpected request ${method} ${path}`);
    return route.abort();
  });
  await page.goto(`${origin}/#settings`);
  await page.getByLabel('VND cho 1 USD', { exact: true }).waitFor();
  async function smtpTab() {
    await page.getByRole('tab', { name: 'Email / SMTP', exact: true }).click();
    await page.getByLabel('Máy chủ SMTP', { exact: true }).waitFor();
  }
  async function approve() {
    const dialog = page.getByRole('dialog', { name: 'Xác nhận bảo mật', exact: true });
    await dialog.getByLabel('Mật khẩu hiện tại', { exact: true }).fill(syntheticPassword);
    const completed = page.waitForResponse(response => response.request().headers()['x-crm-action-token'] === actionToken && response.url().startsWith(`${origin}/api/crm/settings/smtp`));
    await dialog.getByRole('button', { name: 'Xác nhận thao tác', exact: true }).click();
    await completed;
    await dialog.waitFor({ state: 'hidden' });
  }
  return { context, page, errors, attempts, authorizations, saved, smtpTab, approve, getCount: () => smtpGets };
}

test('SMTP settings keep secrets write-only, isolate drafts and protect saved connection actions', async t => {
  const bundle = await build({
    stdin: { contents: `import {prepareBrowserLogin} from './web/src/browser-proof'; void prepareBrowserLogin().then(() => import('./web/src/main'));`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', write: false,
    loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('saving asks for a password and checking the saved SMTP connection runs directly', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text);
      try {
        await f.page.getByLabel('VND cho 1 USD', { exact: true }).fill('27000');
        await f.smtpTab();
        assert.equal(await f.page.locator('form form').count(), 0, 'SMTP must have an independent form');
        assert.equal(await f.page.getByRole('button', { name: 'Lưu cài đặt', exact: true }).isVisible(), false, 'general settings actions must not appear to save SMTP');
        const secret = f.page.getByLabel('Mật khẩu SMTP', { exact: true });
        assert.equal(await secret.inputValue(), '');
        assert.equal(await secret.getAttribute('type'), 'password');
        assert.equal(await f.page.getByRole('button', { name: /Lưu SMTP/ }).isDisabled(), true);
        const testConnection = f.page.getByRole('button', { name: /Kiểm tra kết nối/ });
        assert.equal(await testConnection.isEnabled(), true);
        await f.page.getByLabel('Email người gửi', { exact: true }).fill('changed@example.test');
        assert.equal(await testConnection.isDisabled(), true, 'unsaved settings cannot be tested');
        await f.page.getByRole('button', { name: /Lưu SMTP/ }).click();
        await f.approve();
        await f.page.waitForFunction(() => (document.querySelector('input[type="password"]') as HTMLInputElement | null)?.value === '');
        assert.equal(f.saved.length, 1);
        assert.deepEqual(f.saved[0].body, { revision: 3, values: { ...initialSmtp, from: 'changed@example.test' } });
        assert.equal('password' in f.saved[0].body.values, false, 'empty password preserves stored secret without echoing it');
        await testConnection.click();
        await f.page.getByText('Kết nối SMTP thành công. Không có email nào được gửi.', { exact: true }).waitFor();
        assert.equal(f.saved.length, 2);
        assert.deepEqual(f.saved[1].body, { revision: 4 });
        assert.equal(f.authorizations.length, 1, 'only saving settings requires password confirmation');
        assert.ok(f.attempts.every(attempt => !attempt.raw.includes(syntheticPassword)));
        assert.equal(await secret.inputValue(), '');
        await f.page.getByRole('tab', { name: 'Vận hành', exact: true }).click();
        assert.equal(await f.page.getByLabel('VND cho 1 USD', { exact: true }).inputValue(), '27000', 'switching tabs preserves the unrelated operational draft');
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test('connection identity changes require a replacement secret and clearing the user clears authentication', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text);
      try {
        await f.smtpTab();
        const host = f.page.getByLabel('Máy chủ SMTP', { exact: true });
        const secret = f.page.getByLabel('Mật khẩu SMTP', { exact: true });
        const security = f.page.getByLabel('Bảo mật kết nối', { exact: true });
        await security.click();
        await f.page.locator('.ant-select-item-option-content').filter({ hasText: 'TLS trực tiếp (thường cổng 465)' }).click();
        assert.equal(await f.page.getByLabel('Cổng SMTP', { exact: true }).inputValue(), '465');
        await security.click();
        await f.page.locator('.ant-select-item-option-content').filter({ hasText: 'STARTTLS bắt buộc (thường cổng 587)' }).click();
        assert.equal(await f.page.getByLabel('Cổng SMTP', { exact: true }).inputValue(), '587');
        await host.fill('smtp-new.example.test');
        await f.page.getByRole('button', { name: /Lưu SMTP/ }).click();
        await f.page.locator('.ant-form-item-explain-error').filter({ hasText: /mật khẩu/i }).first().waitFor();
        assert.equal(f.attempts.length, 0, 'missing replacement SMTP secret is blocked before any request');
        assert.equal(f.authorizations.length, 0);
        await secret.fill(syntheticSmtpPassword);
        await f.page.getByRole('button', { name: /Lưu SMTP/ }).click(); await f.approve();
        assert.equal(f.saved.length, 1);
        assert.deepEqual(f.saved[0].body, { revision: 3, values: { ...initialSmtp, host: 'smtp-new.example.test', password: syntheticSmtpPassword } });
        assert.equal(await secret.inputValue(), '', 'new secrets are cleared after a successful save');
        await f.page.getByLabel('Tên đăng nhập SMTP', { exact: true }).fill('');
        await f.page.getByRole('button', { name: /Lưu SMTP/ }).click(); await f.approve();
        assert.equal(f.saved.length, 2);
        assert.equal(f.saved[1].body.values.user, '');
        assert.equal('password' in f.saved[1].body.values, false);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test('conflicts preserve the SMTP draft and reload asks before discarding it', async () => {
      const f = await fixture(browser, bundle.outputFiles[0].text, true);
      try {
        await f.smtpTab();
        const from = f.page.getByLabel('Email người gửi', { exact: true });
        const save = f.page.getByRole('button', { name: /Lưu SMTP/ });
        await from.fill('draft@example.test');
        await save.click(); await f.approve();
        await f.page.getByRole('button', { name: 'Tải cấu hình SMTP mới', exact: true }).waitFor();
        assert.equal(await from.inputValue(), 'draft@example.test');
        assert.equal(await save.isDisabled(), true);
        assert.equal(await f.page.getByRole('button', { name: /Kiểm tra kết nối/ }).isDisabled(), true);
        await f.page.getByRole('button', { name: /Tải lại SMTP/ }).click();
        const confirm = f.page.getByRole('dialog');
        await confirm.getByRole('button', { name: 'Tiếp tục chỉnh sửa', exact: true }).click();
        assert.equal(f.getCount(), 1);
        assert.equal(await from.inputValue(), 'draft@example.test');
        await f.page.getByRole('button', { name: /Tải lại SMTP/ }).click();
        await f.page.getByRole('dialog').getByRole('button', { name: 'Tải lại SMTP', exact: true }).click();
        await f.page.waitForFunction(() => (document.querySelector('input[type="email"]') as HTMLInputElement | null)?.value === 'other@example.test');
        assert.equal(await from.inputValue(), 'other@example.test');
        assert.equal(f.getCount(), 2);
        assert.equal(await save.isDisabled(), true);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
  } finally { await browser.close(); }
});
