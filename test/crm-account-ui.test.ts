import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import type { AccountProfile } from '../web/src/types';

const origin = 'http://localhost:3248';
const challengeId = 'c'.repeat(43);
const emailChallengeId = 'e'.repeat(43);
const binding = 'b'.repeat(43);
const csrf = 'synthetic-account-csrf';
const password = 'synthetic-account-password';
const actionToken = 't'.repeat(43);
const hash = (body: string) => createHash('sha256').update(body).digest('base64url');

test('CRM login and Account page support OTP, mail setup, independent preferences, verified email changes and device revocation', async () => {
  const { outputFiles } = await build({
    entryPoints: ['web/src/main.tsx'], bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', write: false,
    loader: { '.css': 'empty', '.woff': 'empty', '.woff2': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  const received: { path: string; method: string; body: any }[] = [];
  let browserKey: any;
  let loggedIn = false;
  let authorized: { method: string; target: string; body_hash: string } | undefined;
  let profile: AccountProfile = {
    username: 'synthetic-admin', display_name: 'Quản trị thử nghiệm', email: 'old@example.test', email_verified: true,
    remember_me: true, mail_configured: true,
    devices: [{ id: 'synthetic-device', label: 'Chrome trên máy tính', created_at: '2026-11-23T00:00:00Z', last_used_at: '2026-11-23T01:00:00Z', expires_at: '2026-12-23T00:00:00Z', current: true }],
  };
  const loginChallenge = () => ({ otp_required: true, challenge_id: challengeId, email_hint: 'o***@example.test', expires_in: 600, resend_after: 60, server_time: Date.now() });
  const emailChallenge = () => ({ challenge_id: emailChallengeId, email_hint: 'n***@example.test', current_email_hint: 'o***@example.test', requires_current_code: true, expires_in: 600, resend_after: 60 });
  page.on('pageerror', cause => errors.push(cause.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { errors.push('Unexpected external request'); return route.abort(); }
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    const headers = request.headers();
    const raw = request.postData() ?? '';
    const body = raw ? JSON.parse(raw) : undefined;
    const method = request.method();
    const path = url.pathname.slice('/api/crm'.length);
    received.push({ path, method, body });
    const failure = (status: number, code: string, message: string) => route.fulfill({ status, json: { error: { code, message } } });
    if (path === '/session/bootstrap') return failure(401, 'session_required', 'Vui lòng đăng nhập.');
    if (path === '/login') browserKey = body.browser_public_key;
    if (headers['x-crm-proof']) {
      const [head, payload, signature] = headers['x-crm-proof'].split('.');
      const proof = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const sid = path === '/login' ? hash(JSON.stringify({ kty: browserKey.kty, crv: browserKey.crv, x: browserKey.x, y: browserKey.y })) : path.startsWith('/login/') ? challengeId : binding;
      assert.equal(proof.aud, origin); assert.equal(proof.sid, sid); assert.equal(proof.htm, method); assert.equal(proof.htu, url.pathname); assert.equal(proof.bth, hash(raw));
      assert.equal(verify('sha256', Buffer.from(`${head}.${payload}`), { key: createPublicKey({ key: browserKey, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
    } else if (path !== '/session') errors.push(`Missing proof ${method} ${path}`);
    if (path === '/login') {
      assert.equal(body.remember_me, true); assert.equal(headers['x-csrf-token'], undefined);
      return route.fulfill({ json: loginChallenge() });
    }
    if (path === '/login/verify') {
      assert.equal(headers['x-csrf-token'], undefined);
      if (body.code !== '12345678') return failure(400, 'otp_invalid', 'Mã xác minh không đúng.');
      assert.equal(body.trust_device, true); loggedIn = true;
      return route.fulfill({ json: { username: profile.username, csrf_token: csrf, browser_binding: binding, server_time: Date.now(), remember_me: true } });
    }
    if (path === '/session') return loggedIn ? route.fulfill({ json: { username: profile.username, csrf_token: csrf } }) : failure(401, 'session_required', 'Vui lòng đăng nhập.');
    assert.equal(headers['x-csrf-token'], csrf);
    if (path === '/account' && method === 'GET') return route.fulfill({ json: profile });
    if (path === '/session/authorize') {
      assert.equal(body.current_password, password); authorized = body;
      return route.fulfill({ json: { action_token: actionToken, expires_in: 60 } });
    }
    if ((path === '/account' && method === 'PATCH') || path === '/account/email/start' || (path === '/account/devices' && method === 'DELETE')) {
      if (!authorized || headers['x-crm-action-token'] !== actionToken || authorized.method !== method || authorized.target !== url.pathname || authorized.body_hash !== hash(raw)) return failure(403, 'reauthentication_required', 'Vui lòng xác nhận mật khẩu.');
      authorized = undefined;
      if (path === '/account') {
        assert.deepEqual(body, { display_name: 'Tên mới' }, 'profile updates only send editable account fields');
        profile = { ...profile, ...body }; return route.fulfill({ json: profile });
      }
      if (path === '/account/email/start') { assert.equal(body.email, 'new@example.test'); return route.fulfill({ json: emailChallenge() }); }
      profile = { ...profile, devices: [] }; return route.fulfill({ status: 204 });
    }
    if (path === '/account/email/verify') {
      assert.deepEqual(body, { challenge_id: emailChallengeId, code: '22222222', current_code: '11111111' });
      profile = { ...profile, email: 'new@example.test' };
      return route.fulfill({ json: profile });
    }
    errors.push(`Unexpected request ${method} ${path}`);
    return route.abort();
  });
  async function approveSecurity() {
    const modal = page.getByRole('dialog', { name: 'Xác nhận bảo mật', exact: true });
    await modal.getByLabel('Mật khẩu hiện tại', { exact: true }).fill(password);
    await modal.getByRole('button', { name: 'Xác nhận thao tác', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
  }
  try {
    await page.goto(`${origin}/#account`);
    const remember = page.getByRole('checkbox', { name: 'Ghi nhớ đăng nhập', exact: true });
    await remember.waitFor(); assert.equal(await remember.isChecked(), false);
    await page.getByLabel('Tên đăng nhập', { exact: true }).fill('synthetic-admin');
    await page.getByLabel('Mật khẩu', { exact: true }).fill(password); await remember.check();
    await page.getByRole('button', { name: /Đăng nhập/ }).click();
    await page.getByRole('heading', { name: 'Xác minh thiết bị', exact: true }).waitFor();
    const trust = page.getByRole('checkbox', { name: 'Không hỏi lại OTP trên thiết bị này trong 30 ngày', exact: true });
    assert.equal(await trust.isChecked(), false);
    assert.equal(await page.getByLabel('Mật khẩu', { exact: true }).count(), 0);
    await page.getByLabel('Mã OTP', { exact: true }).fill('00000000');
    await page.getByRole('button', { name: 'Xác minh và đăng nhập', exact: true }).click();
    await page.getByText('Mã xác minh không đúng.', { exact: true }).waitFor();
    assert.equal(loggedIn, false);
    await page.getByLabel('Mã OTP', { exact: true }).fill('12345678'); await trust.check();
    await page.getByRole('button', { name: 'Xác minh và đăng nhập', exact: true }).click();
    await page.getByRole('heading', { name: 'Tài khoản', exact: true }).waitFor();
    await page.getByLabel('Email mới', { exact: true }).waitFor();
    const accountUsername = page.getByLabel('Tên đăng nhập', { exact: true });
    assert.equal(await accountUsername.inputValue(), 'synthetic-admin');
    assert.equal(await accountUsername.evaluate(element => (element as HTMLInputElement).readOnly), true, 'the account username is read-only');
    assert.equal(await accountUsername.isEditable(), false);
    const verifiedProfile = profile;
    profile = { ...profile, email: null, email_verified: false, mail_configured: false };
    await page.getByRole('button', { name: /Tải lại/ }).click();
    const accountEmail = page.getByLabel('Email tài khoản', { exact: true });
    await accountEmail.waitFor();
    assert.equal(await accountEmail.isEnabled(), true, 'email can be entered before SMTP is configured');
    await accountEmail.fill('pending@example.test');
    await page.getByText('Chưa thể gửi mã xác minh', { exact: true }).waitFor();
    const sendEmail = page.getByRole('button', { name: /Gửi mã xác minh/ });
    assert.equal(await sendEmail.isDisabled(), true, 'sending verification stays disabled without SMTP');
    const blockedRequests = received.filter(row => ['/session/authorize', '/account/email/start'].includes(row.path)).length;
    await accountEmail.press('Enter');
    assert.equal(await accountEmail.inputValue(), 'pending@example.test');
    assert.equal(await page.getByText('Chưa thể gửi mã xác minh', { exact: true }).isVisible(), true);
    assert.equal(received.filter(row => ['/session/authorize', '/account/email/start'].includes(row.path)).length, blockedRequests, 'submitting without SMTP does not request reauthentication or start email verification');
    const reloadedWithoutMail = page.waitForResponse(response => response.url() === `${origin}/api/crm/account` && response.request().method() === 'GET');
    await page.getByRole('button', { name: /Tải lại/ }).click();
    await reloadedWithoutMail;
    assert.equal(await accountEmail.inputValue(), 'pending@example.test', 'reloading the profile preserves the pending email');
    assert.equal(await sendEmail.isDisabled(), true);
    profile = { ...profile, mail_configured: true };
    await page.getByRole('button', { name: /Tải lại/ }).click();
    await page.getByText('Chưa thể gửi mã xác minh', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await accountEmail.inputValue(), 'pending@example.test', 'enabling SMTP preserves the pending email');
    assert.equal(await sendEmail.isEnabled(), true, 'verification is enabled when SMTP becomes available');
    assert.equal(received.filter(row => ['/session/authorize', '/account/email/start'].includes(row.path)).length, blockedRequests, 'profile reloads do not initiate email verification');
    profile = verifiedProfile;
    await page.getByRole('button', { name: /Tải lại/ }).click();
    await page.getByLabel('Email mới', { exact: true }).waitFor();
    await page.getByLabel('Tên hiển thị', { exact: true }).fill('Tên mới');
    await page.getByRole('button', { name: /Lưu thông tin/ }).click(); await approveSecurity();
    await page.getByText('Đã cập nhật thông tin tài khoản.', { exact: true }).waitFor();
    assert.equal(profile.display_name, 'Tên mới');
    assert.equal(profile.username, 'synthetic-admin');
    assert.deepEqual(received.filter(row => row.path === '/account' && row.method === 'PATCH').map(row => row.body), [{ display_name: 'Tên mới' }, { display_name: 'Tên mới' }], 'both the original and reauthorized request exclude the read-only username');
    await page.getByLabel('Email mới', { exact: true }).fill('new@example.test');
    await page.getByRole('button', { name: /Gửi mã xác minh/ }).click(); await approveSecurity();
    await page.getByLabel('Mã OTP email hiện tại', { exact: true }).fill('11111111');
    await page.getByLabel('Mã OTP email mới', { exact: true }).fill('22222222');
    await page.getByRole('button', { name: 'Xác minh email', exact: true }).click();
    await page.getByText('Đã xác minh email. Thiết bị mới sẽ cần OTP gửi đến địa chỉ này.', { exact: true }).waitFor();
    assert.equal(profile.email, 'new@example.test');
    await page.getByRole('button', { name: 'Xóa tất cả', exact: true }).click();
    const revoke = page.getByRole('dialog');
    await revoke.getByRole('button', { name: 'Xóa tin cậy', exact: true }).click(); await approveSecurity();
    await page.getByText('Chưa có thiết bị tin cậy', { exact: true }).waitFor();
    assert.equal(profile.devices.length, 0);
    assert.equal(received.filter(row => row.path === '/account/email/verify').length, 1, 'email verification does not need a second password dialog');
    assert.deepEqual(errors, []);
  } finally { await context.close(); await browser.close(); }
});
