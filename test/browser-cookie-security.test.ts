import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import test from 'node:test';

const crmOrigin = 'https://crm.example.test';
const siblingOrigin = 'https://sibling.example.test';
const crossSiteOrigin = 'https://attacker.other.test';
const cookieName = '__Host-crm_session';
const sessionValue = 's'.repeat(43);
const attemptedValue = 'a'.repeat(43);
const controlName = 'browser_cookie_control';
const html = '<!doctype html><meta charset="utf-8"><title>Cookie security fixture</title>';

type Observation = {
  method: string;
  originalSession: boolean;
  attemptedSession: boolean;
  control: boolean;
  domainControl: boolean;
};

// These are browser-policy fixtures, not a replacement for auth-security.test.ts:
// that file asserts the real registerSessions production Set-Cookie response.
// No login, real account, external network, or application DB is used here.
async function fixture(browser: Browser): Promise<{
  context: BrowserContext;
  page: Page;
  probes: Observation[];
}> {
  const context = await browser.newContext();
  const probes: Observation[] = [];
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (![crmOrigin, siblingOrigin, crossSiteOrigin].includes(url.origin)) {
      return route.abort('blockedbyclient');
    }
    if (url.origin === crmOrigin && url.pathname === '/fixture/login') {
      // Matches registerSessions with production=true: host-only, Secure,
      // HttpOnly, SameSite=Strict, Path=/ and the 12-hour session lifetime.
      return route.fulfill({
        contentType: 'text/html', body: html,
        headers: { 'set-cookie': `${cookieName}=${sessionValue}; Max-Age=43200; Path=/; HttpOnly; Secure; SameSite=Strict` },
      });
    }
    if (url.origin === crmOrigin && url.pathname === '/fixture/control') {
      return route.fulfill({
        body: 'control established',
        headers: { 'set-cookie': `${controlName}=present; Path=/; HttpOnly; Secure; SameSite=None` },
      });
    }
    if (url.origin === siblingOrigin && url.pathname === '/fixture/domain-attempt') {
      return route.fulfill({
        contentType: 'text/html', body: html,
        headers: { 'set-cookie': `${cookieName}=${attemptedValue}; Domain=example.test; Path=/; HttpOnly; Secure; SameSite=Strict` },
      });
    }
    if (url.origin === siblingOrigin && url.pathname === '/fixture/own-session') {
      return route.fulfill({
        contentType: 'text/html', body: html,
        headers: { 'set-cookie': `${cookieName}=${attemptedValue}; Path=/; HttpOnly; Secure; SameSite=Strict` },
      });
    }
    if (url.origin === crmOrigin && url.pathname === '/fixture/probe') {
      const headers = await request.allHeaders();
      const pairs = new Set((headers.cookie ?? '').split(/;\s*/));
      // Retain only booleans. Cookie values never enter test output/logs.
      probes.push({
        method: request.method(),
        originalSession: pairs.has(`${cookieName}=${sessionValue}`),
        attemptedSession: pairs.has(`${cookieName}=${attemptedValue}`),
        control: pairs.has(`${controlName}=present`),
        domainControl: pairs.has('domain_control=present'),
      });
      return route.fulfill({
        contentType: 'text/html', body: html,
        headers: {
          'access-control-allow-origin': crossSiteOrigin,
          'access-control-allow-credentials': 'true',
          'cache-control': 'no-store',
        },
      });
    }
    return route.fulfill({ contentType: 'text/html', body: html });
  });
  const page = await context.newPage();
  await page.goto(`${crmOrigin}/fixture/login`);
  const session = (await context.cookies(crmOrigin)).find(cookie => cookie.name === cookieName);
  assert.equal(session?.value === sessionValue, true, 'HTTPS fixture must establish the original session');
  assert.equal(session?.httpOnly, true);
  assert.equal(session?.secure, true);
  assert.equal(session?.sameSite, 'Strict');
  assert.equal(session?.domain, 'crm.example.test');
  assert.equal(session?.path, '/');
  return { context, page, probes };
}

test('Chromium enforces the production-shaped CRM cookie security attributes', async t => {
  const browser = await chromium.launch();
  try {
    await t.test('HttpOnly is hidden from JavaScript while same-host fetch sends it', async () => {
      const { context, page, probes } = await fixture(browser);
      try {
        const visible = await page.evaluate(name => document.cookie.split(/;\s*/).some(pair => pair.startsWith(`${name}=`)), cookieName);
        assert.equal(visible, false);
        const completed = await page.evaluate(async () => (await fetch('/fixture/probe', { credentials: 'same-origin' })).ok);
        assert.equal(completed, true);
        assert.equal(probes.length, 1);
        assert.equal(probes[0].originalSession, true);
      } finally { await context.close(); }
    });

    await t.test('same-host JavaScript cannot overwrite or delete an existing HttpOnly cookie', async () => {
      const { context, page, probes } = await fixture(browser);
      try {
        await page.evaluate(({ name, attempted }) => {
          document.cookie = `${name}=${attempted}; Path=/; Secure; SameSite=Strict`;
          document.cookie = `${name}=; Max-Age=0; Path=/; Secure; SameSite=Strict`;
        }, { name: cookieName, attempted: attemptedValue });
        const sessions = (await context.cookies(crmOrigin)).filter(cookie => cookie.name === cookieName);
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].value === sessionValue, true, 'HttpOnly original must survive both JS writes');
        assert.equal(sessions[0].httpOnly, true);
        await page.evaluate(async () => { await fetch('/fixture/probe', { credentials: 'include' }); });
        assert.equal(probes.at(-1)?.originalSession, true);
        assert.equal(probes.at(-1)?.attemptedSession, false);
      } finally { await context.close(); }
    });

    await t.test('a sibling cannot set a parent-Domain __Host- cookie or replace the CRM host cookie', async () => {
      const { context, page, probes } = await fixture(browser);
      try {
        await page.goto(`${siblingOrigin}/fixture/domain-attempt`);
        let sessions = (await context.cookies()).filter(cookie => cookie.name === cookieName);
        assert.equal(sessions.length, 1, 'Chromium must reject the server Domain attempt');
        assert.equal(sessions[0].domain, 'crm.example.test');
        assert.equal(sessions[0].value === sessionValue, true);
        await page.evaluate(({ name, attempted }) => {
          document.cookie = `${name}=${attempted}; Domain=example.test; Path=/; Secure; SameSite=Strict`;
          // Positive control: this sibling is allowed to set ordinary parent-Domain cookies.
          document.cookie = 'domain_control=present; Domain=example.test; Path=/; Secure; SameSite=Strict';
        }, { name: cookieName, attempted: attemptedValue });
        sessions = (await context.cookies()).filter(cookie => cookie.name === cookieName);
        assert.equal(sessions.length, 1, 'Chromium must also reject the JavaScript Domain attempt');
        assert.equal(sessions[0].value === sessionValue, true);
        assert.equal((await context.cookies(crmOrigin)).some(cookie => cookie.name === 'domain_control'), true);

        // A valid host-only cookie on the sibling is separate and still cannot replace CRM's cookie.
        await page.goto(`${siblingOrigin}/fixture/own-session`);
        assert.equal((await context.cookies(siblingOrigin)).some(cookie => cookie.name === cookieName && cookie.value === attemptedValue), true);
        await page.goto(`${crmOrigin}/fixture/home`);
        await page.evaluate(async () => { await fetch('/fixture/probe', { credentials: 'include' }); });
        assert.equal(probes.at(-1)?.originalSession, true);
        assert.equal(probes.at(-1)?.attemptedSession, false);
        assert.equal(probes.at(-1)?.domainControl, true);
      } finally { await context.close(); }
    });

    await t.test('cross-site credentialed fetch and top-level form omit the Strict session', async () => {
      const { context, page, probes } = await fixture(browser);
      try {
        await page.evaluate(async () => { await fetch('/fixture/control', { credentials: 'include' }); });
        await page.goto(`${crossSiteOrigin}/fixture/attack`);
        const fetchCompleted = await page.evaluate(async target => {
          const response = await fetch(`${target}/fixture/probe`, { credentials: 'include', mode: 'cors' });
          return response.ok;
        }, crmOrigin);
        assert.equal(fetchCompleted, true, 'the cross-site fetch must reach the fixture');
        assert.equal(probes.length, 1);
        assert.equal(probes[0].method, 'GET');
        assert.equal(probes[0].originalSession, false);
        assert.equal(probes[0].control, true, 'a SameSite=None control is sent on the credentialed cross-site fetch');

        await Promise.all([
          page.waitForURL(`${crmOrigin}/fixture/probe`),
          page.evaluate(target => {
            const form = document.createElement('form');
            form.method = 'POST'; form.action = `${target}/fixture/probe`;
            document.body.append(form); form.submit();
          }, crmOrigin),
        ]);
        assert.equal(probes.length, 2);
        assert.equal(probes[1].method, 'POST');
        assert.equal(probes[1].originalSession, false);
        assert.equal(probes[1].control, true, 'a SameSite=None control is sent on the cross-site form');

        await page.evaluate(async () => { await fetch('/fixture/probe', { credentials: 'include' }); });
        assert.equal(probes.at(-1)?.originalSession, true, 'Strict cookie remains valid once a same-origin document makes the request');
      } finally { await context.close(); }
    });
  } finally { await browser.close(); }
});
