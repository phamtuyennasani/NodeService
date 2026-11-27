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
const providerId = 'openai-compatible-dialog-fixture';
const modelId = 'synthetic-internal-model';
const deleteTarget = `/api/crm/providers/${providerId}/models/${modelId}`;
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

async function fixture(browser: Browser, bundle: string, css: string, options: {
  rejectPassword?: boolean; page?: 'settings' | 'providers'; modelInUse?: boolean;
} = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const attempts: CapturedRequest[] = [];
  const deleteAttempts: CapturedRequest[] = [];
  const authorizations: Authorization[] = [];
  let mutations = 0;
  let deletions = 0;
  let modelPresent = true;
  let revision = 3;
  let saved = structuredClone(values);
  let authorization: Authorization['body'] | undefined;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: css });
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
    if (url.pathname === '/api/crm/providers' && request.method() === 'GET') {
      return route.fulfill({ json: { data: [{
        provider: providerId, kind: 'openai-compatible', display_name: 'Synthetic gateway', enabled: true,
        api_key_status: 'unreadable', api_key_configured: false, service_key_configured: false,
        base_url: 'https://gateway.example.test/v1', models: modelPresent ? [{
          model: modelId, upstream_model: 'synthetic/model', display_name: 'Synthetic model', enabled: true,
        }] : [],
      }] } });
    }
    if (url.pathname === '/api/crm/session/authorize' && request.method() === 'POST') {
      const body = request.postDataJSON();
      authorizations.push({ body, raw: request.postData()!, headers: request.headers() });
      if (options.rejectPassword || body.current_password !== syntheticPassword) {
        return route.fulfill({ status: 400, json: { error: { code: 'invalid_password', message: 'Mật khẩu hiện tại không đúng.' } } });
      }
      authorization = body;
      return route.fulfill({ json: { action_token: actionToken, expires_in: 60 } });
    }
    if (url.pathname === deleteTarget && request.method() === 'DELETE') {
      const raw = request.postData() ?? '';
      const headers = request.headers();
      deleteAttempts.push({ raw, headers });
      assert.equal(headers['x-crm-action-token'], undefined);
      assert.equal(headers['x-csrf-token'], csrf);
      assert.ok(headers['x-crm-proof']);
      if (options.modelInUse) return route.fulfill({ status: 409, json: { error: {
        code: 'model_in_use', message: 'Không thể xóa model đã được dùng trong gói khách hàng, yêu cầu viết hoặc bảng giá.',
      } } });
      modelPresent = false;
      deletions++;
      return route.fulfill({ status: 204 });
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
  await page.goto(`${origin}/#${options.page ?? 'settings'}`);
  if (options.page === 'providers') {
    await page.getByRole('navigation', { name: 'Chọn dạng kết nối AI', exact: true })
      .getByRole('button', { name: /OpenAI Compatible/ }).click();
    await page.getByRole('button', { name: 'Xóa synthetic/model', exact: true }).waitFor();
  } else await page.getByLabel('VND cho 1 USD', { exact: true }).waitFor();
  const save = page.getByRole('button', { name: 'Lưu cài đặt', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Xác nhận bảo mật', exact: true });
  return { context, page, errors, attempts, deleteAttempts, authorizations, save, dialog,
    getMutations: () => mutations, getDeletions: () => deletions };
}

test('real CRM only prompts for a password when saving settings', async t => {
  const { outputFiles } = await build({
    stdin: { contents: `import {prepareBrowserLogin} from './web/src/browser-proof';
      void prepareBrowserLogin().then(() => import('./web/src/main'));`, resolveDir: process.cwd(), loader: 'ts' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', write: false, outfile: 'fixture.js',
    loader: { '.woff': 'empty', '.woff2': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const bundle = outputFiles.find(file => file.path.endsWith('.js'))!.text;
  const css = outputFiles.find(file => file.path.endsWith('.css'))!.text;
  const browser = await chromium.launch();
  try {
    await t.test('model deletion asks for confirmation and deletes once without asking for a password', async () => {
      const f = await fixture(browser, bundle, css, { page: 'providers' });
      try {
        await f.page.getByRole('button', { name: 'Xóa synthetic/model', exact: true }).click();
        const confirmation = f.page.getByRole('dialog').filter({ hasText: 'Xóa model này?' });
        await confirmation.getByRole('button', { name: 'Xóa model', exact: true }).click();
        await f.page.getByText('Đã xóa model.', { exact: true }).waitFor();
        await confirmation.waitFor({ state: 'hidden' });
        await f.dialog.waitFor({ state: 'hidden' });
        await f.page.getByRole('button', { name: 'Xóa synthetic/model', exact: true }).waitFor({ state: 'hidden' });
        assert.equal(f.getDeletions(), 1);
        assert.equal(f.authorizations.length, 0);
        assert.equal(f.deleteAttempts.length, 1);
        assert.equal(f.deleteAttempts[0].headers['x-crm-action-token'], undefined);
        assert.equal(f.deleteAttempts[0].raw, '');
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test('canceling ordinary deletion confirmation leaves the model without making a request', async () => {
      const f = await fixture(browser, bundle, css, { page: 'providers' });
      try {
        await f.page.getByRole('button', { name: 'Xóa synthetic/model', exact: true }).click();
        const confirmation = f.page.getByRole('dialog').filter({ hasText: 'Xóa model này?' });
        await confirmation.getByRole('button', { name: 'Hủy', exact: true }).click();
        await confirmation.waitFor({ state: 'hidden' });
        assert.equal(f.getDeletions(), 0);
        assert.equal(f.authorizations.length, 0);
        assert.equal(f.deleteAttempts.length, 0);
        assert.equal(await f.dialog.count(), 0);
        await f.page.getByRole('button', { name: 'Xóa synthetic/model', exact: true }).click({ trial: true });
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test('in-use model error resets deletion loading without removing the model', async () => {
      const f = await fixture(browser, bundle, css, { page: 'providers', modelInUse: true });
      try {
        await f.page.getByRole('button', { name: 'Xóa synthetic/model', exact: true }).click();
        const confirmation = f.page.getByRole('dialog').filter({ hasText: 'Xóa model này?' });
        await confirmation.getByRole('button', { name: 'Xóa model', exact: true }).click();
        await f.page.getByText('Không thể xóa model đã được dùng trong gói khách hàng, yêu cầu viết hoặc bảng giá.', { exact: true }).waitFor();
        assert.equal(f.getDeletions(), 0);
        assert.equal(f.deleteAttempts.length, 1);
        assert.equal(f.authorizations.length, 0);
        await confirmation.getByRole('button', { name: 'Xóa model', exact: true }).click({ trial: true });
        await confirmation.getByRole('button', { name: 'Hủy', exact: true }).click();
        await confirmation.waitFor({ state: 'hidden' });
        await f.page.getByRole('button', { name: 'Xóa synthetic/model', exact: true }).click({ trial: true });
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test('retention settings keep the password dialog above the confirmation and save once', async () => {
      const f = await fixture(browser, bundle, css);
      try {
        await f.page.getByRole('tab', { name: 'Lưu trữ dữ liệu', exact: true }).click();
        await f.page.getByLabel('Lưu yêu cầu viết bài (ngày)', { exact: true }).fill('30');
        await f.save.click();
        const confirmation = f.page.getByRole('dialog').filter({ hasText: 'Bật hoặc rút ngắn thời gian lưu dữ liệu?' });
        await confirmation.getByRole('button', { name: 'Xác nhận và lưu', exact: true }).click();
        await f.dialog.waitFor();
        const password = f.dialog.getByLabel('Mật khẩu hiện tại', { exact: true });
        await password.click({ trial: true, timeout: 1500 });
        await password.fill(syntheticPassword);
        for (let index = 0; index < 8; index++) {
          await f.page.keyboard.press('Tab');
          assert.equal(await f.dialog.evaluate(dialog => (document.activeElement === document.body && !document.hasFocus())
            || dialog.contains(document.activeElement)), true);
        }
        await f.dialog.getByRole('button', { name: 'Xác nhận thao tác', exact: true }).click();
        await confirmation.waitFor({ state: 'hidden' });
        await f.page.getByText('Đã lưu cài đặt. Hệ thống sẽ áp dụng trong tối đa 5 giây.', { exact: true }).waitFor();
        assert.equal(f.getMutations(), 1);
        assert.equal(f.authorizations.length, 1);
        assert.equal(f.attempts.length, 2);
        assert.equal(JSON.parse(f.attempts[1].raw).values.job_retention_days, 30);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    });

    await t.test('cancel dismisses the real dialog without authorizing or saving', async () => {
      const f = await fixture(browser, bundle, css);
      try {
        await f.page.getByLabel('VND cho 1 USD', { exact: true }).fill('27000');
        await f.save.click();
        await f.dialog.waitFor();
        await f.dialog.getByText('Nhập lại mật khẩu để lưu thay đổi cài đặt. Xác nhận chỉ có hiệu lực cho lần lưu này.', { exact: true }).waitFor();
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
      const f = await fixture(browser, bundle, css);
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
      const f = await fixture(browser, bundle, css, { rejectPassword: true });
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
