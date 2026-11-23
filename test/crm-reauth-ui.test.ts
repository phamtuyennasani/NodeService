import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { RuntimeSettings } from '../web/src/Settings';

const origin = 'http://localhost:3239';
const syntheticPassword = 'synthetic-dialog-password';
const csrf = 'synthetic-dialog-csrf';
const binding = 'b'.repeat(43);
const actionToken = 't'.repeat(43);
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
type CapturedRequest = { raw: string; headers: Record<string, string> };
type Authorization = CapturedRequest & { body: { current_password: string; method: string; target: string; body_hash: string } };
const bodyHash = (raw: string) => createHash('sha256').update(raw).digest('base64url');

async function fixture(browser: Browser, bundle: string, rejectPassword = false) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const attempts: CapturedRequest[] = [];
  const authorizations: Authorization[] = [];
  let mutations = 0;
  let revision = 3;
  let saved = structuredClone(values);
  let authorization: Authorization['body'] | undefined;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/crm/session/bootstrap' && request.method() === 'GET') {
      return route.fulfill({ json: { browser_binding: binding, server_time: Date.now() } });
    }
    if (url.pathname === '/api/crm/session' && request.method() === 'GET') {
      if (!request.headers()['x-crm-proof']) errors.push('Session read did not carry a browser proof');
      return route.fulfill({ json: { username: 'synthetic-admin', csrf_token: csrf } });
    }
    if (url.pathname === '/api/crm/settings' && request.method() === 'GET') {
      return route.fulfill({ json: { values: saved, defaults: values, revision, updated_at: null } });
    }
    if (url.pathname === '/api/crm/session/authorize' && request.method() === 'POST') {
      const body = request.postDataJSON();
      authorizations.push({ body, raw: request.postData()!, headers: request.headers() });
      if (rejectPassword || body.current_password !== syntheticPassword) {
        return route.fulfill({ status: 400, json: { error: { code: 'invalid_password', message: 'Mật khẩu hiện tại không đúng.' } } });
      }
      authorization = body;
      return route.fulfill({ json: { action_token: actionToken, expires_in: 60 } });
    }
    if (url.pathname === '/api/crm/settings' && request.method() === 'PUT') {
      const raw = request.postData()!;
      const headers = request.headers();
      attempts.push({ raw, headers });
      if (headers['x-crm-action-token'] !== actionToken || !authorization || authorization.method !== request.method()
        || authorization.target !== url.pathname + url.search || authorization.body_hash !== bodyHash(raw)) {
        return route.fulfill({ status: 403, json: { error: { code: 'reauthentication_required', message: 'Vui lòng xác nhận mật khẩu cho thao tác này.' } } });
      }
      authorization = undefined;
      mutations++;
      saved = request.postDataJSON().values;
      revision++;
      return route.fulfill({ json: { values: saved, defaults: values, revision, updated_at: '2026-11-23T00:00:00Z' } });
    }
    errors.push(`Unexpected request: ${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(`${origin}/#settings`);
  await page.getByLabel('VND cho 1 USD', { exact: true }).waitFor();
  const save = page.getByRole('button', { name: 'Lưu cài đặt', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Xác nhận bảo mật', exact: true });
  return { context, page, errors, attempts, authorizations, save, dialog, getMutations: () => mutations };
}

test('real CRM entry prompts for one-use password authorization through its actual dialog', async t => {
  const { outputFiles } = await build({
    stdin: { contents: `import {prepareBrowserLogin} from './web/src/browser-proof';
      void prepareBrowserLogin().then(() => import('./web/src/main'));`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', write: false,
    loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty' },
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('cancel dismisses the real dialog without authorizing or saving', async () => {
      const f = await fixture(browser, outputFiles[0].text);
      try {
        await f.page.getByLabel('VND cho 1 USD', { exact: true }).fill('27000');
        await f.save.click();
        await f.dialog.waitFor();
        await f.dialog.getByText('Nhập lại mật khẩu để xác nhận thao tác quản trị nhạy cảm. Xác nhận chỉ có hiệu lực cho một thao tác này.', { exact: true }).waitFor();
        assert.equal(f.attempts.length, 1);
        assert.equal(f.authorizations.length, 0);
        assert.equal(f.getMutations(), 0);
        assert.equal(await f.dialog.getByLabel('Mật khẩu hiện tại', { exact: true }).getAttribute('type'), 'password');
        await f.dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
        await f.dialog.waitFor({ state: 'hidden' });
        await f.page.getByText('Đã hủy thao tác.', { exact: true }).waitFor();
        assert.equal(f.authorizations.length, 0);
        assert.equal(f.attempts.length, 1, 'cancel must not retry the pending mutation');
        assert.equal(f.getMutations(), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test('confirm requires a password and retries exactly the pending body once with scoped authorization', async () => {
      const f = await fixture(browser, outputFiles[0].text);
      try {
        await f.page.getByLabel('VND cho 1 USD', { exact: true }).fill('27000');
        await f.save.click();
        await f.dialog.waitFor();
        await f.dialog.getByRole('button', { name: 'Xác nhận thao tác', exact: true }).click();
        await f.dialog.getByText('Nhập mật khẩu hiện tại.', { exact: true }).waitFor();
        assert.equal(f.authorizations.length, 0);
        assert.equal(f.getMutations(), 0);
        await f.dialog.getByLabel('Mật khẩu hiện tại', { exact: true }).fill(syntheticPassword);
        await f.dialog.getByRole('button', { name: 'Xác nhận thao tác', exact: true }).click();
        await f.page.getByText('Đã lưu cài đặt. Hệ thống sẽ áp dụng trong tối đa 5 giây.', { exact: true }).waitFor();
        assert.equal(f.getMutations(), 1);
        assert.equal(f.authorizations.length, 1);
        assert.equal(f.attempts.length, 2);
        assert.equal(f.attempts[0].raw, f.attempts[1].raw, 'retry must preserve the original request JSON bytes');
        assert.deepEqual(f.authorizations[0].body, {
          current_password: syntheticPassword, method: 'PUT', target: '/api/crm/settings', body_hash: bodyHash(f.attempts[0].raw),
        });
        assert.equal(f.authorizations[0].headers['x-csrf-token'], csrf);
        assert.ok(f.authorizations[0].headers['x-crm-proof']);
        assert.equal(f.attempts[0].headers['x-crm-action-token'], undefined);
        assert.equal(f.attempts[1].headers['x-crm-action-token'], actionToken);
        assert.notEqual(f.attempts[0].headers['x-crm-proof'], f.attempts[1].headers['x-crm-proof'], 'retry needs a fresh proof nonce');
        assert.equal(f.attempts[1].headers['x-csrf-token'], csrf);
        assert.equal(JSON.parse(f.attempts[1].raw).values.usd_to_vnd, 27000);
        assert.ok(!f.attempts[1].raw.includes(syntheticPassword));
        await f.dialog.waitFor({ state: 'hidden' });
        await f.page.getByLabel('VND cho 1 USD', { exact: true }).fill('28000');
        await f.save.click();
        await f.dialog.waitFor();
        assert.equal(await f.dialog.getByLabel('Mật khẩu hiện tại', { exact: true }).inputValue(), '', 'password must be cleared for a distinct action');
        assert.equal(f.authorizations.length, 1, 'the prior confirmation must not unlock the next mutation');
        assert.equal(f.getMutations(), 1);
        await f.dialog.getByRole('button', { name: 'Hủy', exact: true }).click();
        await f.dialog.waitFor({ state: 'hidden' });
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test('wrong password reports the server error and never retries a mutation', async () => {
      const f = await fixture(browser, outputFiles[0].text, true);
      try {
        await f.page.getByLabel('VND cho 1 USD', { exact: true }).fill('27000');
        await f.save.click();
        await f.dialog.waitFor();
        await f.dialog.getByLabel('Mật khẩu hiện tại', { exact: true }).fill('incorrect-synthetic-password');
        await f.dialog.getByRole('button', { name: 'Xác nhận thao tác', exact: true }).click();
        await f.page.getByText('Mật khẩu hiện tại không đúng.', { exact: true }).waitFor();
        assert.equal(f.authorizations.length, 1);
        assert.equal(f.attempts.length, 1);
        assert.equal(f.getMutations(), 0);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });
  } finally { await browser.close(); }
});
