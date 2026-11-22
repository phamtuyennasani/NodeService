import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import type { CatalogProvider } from '../web/src/types';

const origin = 'http://localhost:3234';
const customA = 'openai-compatible-11111111-1111-4111-8111-111111111111';
const customB = 'openai-compatible-22222222-2222-4222-8222-222222222222';

async function fixture(browser: Browser, bundle: string, options: { failList?: boolean; failCreate?: boolean; customOnly?: boolean } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const providers: CatalogProvider[] = [
    { provider: 'openai', display_name: 'OpenAI', enabled: true, service_key_configured: true, models: [{ model: 'gpt-4.1', display_name: 'GPT 4.1', enabled: true }] },
    { provider: 'anthropic', display_name: 'Anthropic', enabled: true, service_key_configured: true, models: [] },
    { provider: 'xai', display_name: 'xAI', enabled: true, service_key_configured: true, models: [] },
    { provider: 'openai-compatible', display_name: 'OpenAI Compatible', enabled: true, service_key_configured: true, api_key_configured: true, base_url: 'https://legacy.example.test/v1', models: [] },
  ];
  if (options.customOnly) {
    providers.splice(0, providers.length, {
      provider: customA, kind: 'openai-compatible', display_name: 'Gateway Alpha', enabled: true,
      service_key_configured: true, api_key_configured: true, base_url: 'https://alpha.example.test/v1', models: [],
    });
  }
  const mutations: { path: string; method: string; body: any; csrf?: string }[] = [];
  const errors: string[] = [];
  let failList = options.failList ?? false;
  let failCreate = options.failCreate ?? false;
  let nextProvider = 0;
  let nextModel = 0;
  let holdCheck: Promise<void> | undefined;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script src="/test.js"></script></body></html>' });
    if (url.pathname === '/test.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    const path = url.pathname.replace('/api/crm', '');
    if (path === '/providers' && request.method() === 'GET') {
      if (failList) { failList = false; return route.fulfill({ status: 503, json: { error: { message: 'Chưa tải được danh mục.' } } }); }
      return route.fulfill({ json: { data: providers } });
    }
    mutations.push({ path, method: request.method(), body: request.postData() ? request.postDataJSON() : null, csrf: request.headers()['x-csrf-token'] });
    if (path === '/providers' && request.method() === 'POST') {
      if (failCreate) { failCreate = false; return route.fulfill({ status: 422, json: { error: { message: 'Base URL chưa được chấp nhận.' } } }); }
      const body = request.postDataJSON();
      const provider = { provider: [customA, customB][nextProvider++], kind: 'openai-compatible' as const, display_name: body.display_name,
        base_url: body.base_url, enabled: body.enabled, service_key_configured: true, api_key_configured: true, models: [] };
      providers.push(provider);
      return route.fulfill({ status: 201, json: provider });
    }
    const match = path.match(/^\/providers\/([^/]+)(?:\/(.*))?$/);
    if (match) {
      const provider = providers.find(item => item.provider === match[1]);
      if (!provider) return route.fulfill({ status: 404, json: {} });
      if (!match[2] && request.method() === 'PATCH') {
        const { api_key: _key, ...fields } = request.postDataJSON();
        Object.assign(provider, fields);
        return route.fulfill({ json: provider });
      }
      if (match[2] === 'models' && request.method() === 'POST') {
        const body = request.postDataJSON();
        const model = { ...body, model: 'model-internal-' + ++nextModel, upstream_model: body.model };
        provider.models.push(model);
        return route.fulfill({ status: 201, json: model });
      }
      if (match[2] === 'check') {
        if (holdCheck) await holdCheck;
        return route.fulfill({ json: { message: 'Kết nối thành công.' } });
      }
      if (match[2]?.endsWith('/ping')) return route.fulfill({ json: { message: 'Model đang hoạt động.' } });
      if (match[2]?.startsWith('models/') && request.method() === 'PATCH') {
        const model = provider.models.find(item => item.model === decodeURIComponent(match[2]!.slice(7)));
        if (!model) return route.fulfill({ status: 404, json: {} });
        Object.assign(model, request.postDataJSON());
        return route.fulfill({ json: model });
      }
    }
    errors.push(`Unexpected request: ${request.method()} ${path}`);
    return route.abort();
  });
  await page.goto(origin);
  return { page, providers, mutations, errors, holdCheck: () => {
    let release!: () => void;
    holdCheck = new Promise<void>(resolve => { release = resolve; });
    return release;
  } };
}

async function addProvider(page: Awaited<ReturnType<typeof fixture>>['page'], name: string, base: string, key: string) {
  if (!await page.getByRole('button', { name: /Thêm provider/ }).isVisible()) {
    await page.getByRole('navigation', { name: 'Chọn dạng kết nối AI', exact: true }).getByRole('button', { name: /OpenAI Compatible/ }).click();
  }
  await page.getByRole('button', { name: /Thêm provider/, exact: false }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Tên provider', { exact: true }).fill(name);
  await dialog.getByLabel('Base URL', { exact: true }).fill(base);
  await dialog.getByLabel('API key', { exact: true }).fill(key);
  await dialog.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name, exact: true }).waitFor();
}

async function addModel(page: Awaited<ReturnType<typeof fixture>>['page'], name: string) {
  await page.getByRole('button', { name: /Thêm model/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Mã model', { exact: true }).fill('same-model');
  await dialog.getByLabel('Tên hiển thị', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Lưu model', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText(name, { exact: true }).waitFor();
  await page.getByText('same-model', { exact: true }).waitFor();
}

test('CRM providers manages independent OpenAI Compatible connections', async t => {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {App,ConfigProvider} from 'antd'; import {Providers} from './web/src/Providers';
      import {setCsrfToken} from './web/src/api'; setCsrfToken('providers-csrf');
      createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{token:{motion:false,colorPrimary:'#315d49'}}}><App><Providers /></App></ConfigProvider>);`,
      resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' },
    write: false, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const browser = await chromium.launch();
  try {
    await t.test('top navigation contains four connection types and compatible providers are nested within their type', async () => {
      const { page, errors } = await fixture(browser, bundle.outputFiles[0].text);
      try {
        const navigation = page.getByRole('navigation', { name: 'Chọn dạng kết nối AI', exact: true });
        await navigation.waitFor();
        assert.equal(await navigation.getByRole('button').count(), 4);
        assert.deepEqual(await navigation.locator('strong').allTextContents(), ['OpenAI', 'Anthropic', 'xAI', 'OpenAI Compatible']);
        assert.equal(await page.locator('.page-heading').getByRole('button', { name: /Thêm provider/ }).count(), 0);
        for (const name of ['OpenAI', 'Anthropic', 'xAI']) {
          await navigation.getByRole('button').filter({ has: page.locator('strong', { hasText: new RegExp('^' + name + '$') }) }).click();
          await page.getByRole('heading', { name, exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: /Thêm provider/ }).count(), 0, `${name} must not show compatible creation`);
          assert.equal(await page.getByRole('navigation', { name: 'Chọn provider OpenAI Compatible', exact: true }).count(), 0);
        }
        await navigation.getByRole('button', { name: /OpenAI Compatible/ }).click();
        const group = page.locator('.record-compatible-group');
        await group.getByRole('heading', { name: 'Provider OpenAI Compatible', exact: true }).waitFor();
        await group.getByRole('button', { name: /Thêm provider/ }).waitFor();
        const providers = page.getByRole('navigation', { name: 'Chọn provider OpenAI Compatible', exact: true });
        await providers.getByRole('button', { name: /Kết nối mặc định/ }).waitFor();
        assert.equal(await page.locator('.record-provider-detail').getByRole('button', { name: /Thêm provider/ }).count(), 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    await t.test('creates two providers and keeps endpoint, key, model routes and edits isolated', async () => {
      const { page, mutations, errors } = await fixture(browser, bundle.outputFiles[0].text);
      try {
        await addProvider(page, 'Gateway Alpha', 'https://alpha.example.test/v1', 'fixture-alpha');
        await addModel(page, 'Model Alpha');
        await addProvider(page, 'Gateway Beta', 'https://beta.example.test/v1', 'fixture-beta');
        await addModel(page, 'Model Beta');
        const types = page.getByRole('navigation', { name: 'Chọn dạng kết nối AI', exact: true });
        const connections = page.getByRole('navigation', { name: 'Chọn provider OpenAI Compatible', exact: true });
        assert.equal(await types.getByRole('button').count(), 4);
        assert.doesNotMatch(await types.innerText(), /Gateway Alpha|Gateway Beta/);
        assert.equal(await types.getByRole('button', { name: /OpenAI Compatible/ }).getAttribute('aria-pressed'), 'true');
        assert.equal(await connections.getByRole('button').count(), 3);
        assert.equal(await connections.getByRole('button', { name: /Gateway Beta/ }).getAttribute('aria-pressed'), 'true');
        await types.getByRole('button').filter({ has: page.locator('strong', { hasText: /^OpenAI$/ }) }).click();
        await page.getByRole('heading', { name: 'OpenAI', exact: true }).waitFor();
        assert.equal(await connections.count(), 0);
        await types.getByRole('button', { name: /OpenAI Compatible/ }).click();
        await page.getByRole('heading', { name: 'Gateway Beta', exact: true }).waitFor();
        assert.equal(await page.getByText('Model Alpha', { exact: true }).count(), 0);
        await page.getByRole('button', { name: 'Kiểm tra kết nối', exact: true }).click();
        await page.getByText('Kết nối thành công.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Ping model same-model', exact: true }).click();
        await page.getByText('Model đang hoạt động.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Cấu hình kết nối', exact: true }).click();
        let dialog = page.getByRole('dialog');
        assert.equal(await dialog.getByLabel('Tên provider', { exact: true }).inputValue(), 'Gateway Beta');
        assert.equal(await dialog.getByLabel('Base URL', { exact: true }).inputValue(), 'https://beta.example.test/v1');
        assert.equal(await dialog.getByLabel('API key', { exact: true }).inputValue(), '');
        await dialog.getByLabel('Tên provider', { exact: true }).fill('Gateway Beta đổi tên');
        await dialog.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await page.getByRole('heading', { name: 'Gateway Beta đổi tên', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Chỉnh sửa same-model', exact: true }).click();
        dialog = page.getByRole('dialog');
        assert.equal(await dialog.getByLabel('Mã model', { exact: true }).inputValue(), 'same-model');
        assert.equal(await dialog.getByLabel('Mã model', { exact: true }).isDisabled(), true);
        await dialog.getByLabel('Tên hiển thị', { exact: true }).fill('Model Beta sửa');
        await dialog.getByRole('button', { name: 'Lưu model', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await connections.getByRole('button', { name: /Gateway Alpha/ }).click();
        await page.locator('.record-provider-detail').getByText('https://alpha.example.test/v1', { exact: true }).waitFor();
        await page.getByText('Model Alpha', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Ping model same-model', exact: true }).click();
        await page.waitForFunction(() => !document.querySelector('.ant-btn-loading'));
        assert.deepEqual(mutations.filter(item => item.path === '/providers').map(item => item.body), [
          { display_name: 'Gateway Alpha', base_url: 'https://alpha.example.test/v1', api_key: 'fixture-alpha', enabled: true },
          { display_name: 'Gateway Beta', base_url: 'https://beta.example.test/v1', api_key: 'fixture-beta', enabled: true },
        ]);
        assert.ok(mutations.some(item => item.path === `/providers/${customB}/check`));
        assert.ok(mutations.some(item => item.path === `/providers/${customB}/models/model-internal-2/ping`));
        assert.ok(mutations.some(item => item.path === `/providers/${customA}/models/model-internal-1/ping`));
        assert.deepEqual(mutations.find(item => item.path === `/providers/${customB}`)?.body,
          { display_name: 'Gateway Beta đổi tên', base_url: 'https://beta.example.test/v1' });
        assert.deepEqual(mutations.find(item => item.method === 'PATCH' && item.path.endsWith('/models/model-internal-2'))?.body, { display_name: 'Model Beta sửa' });
        assert.ok(mutations.every(item => item.csrf === 'providers-csrf'));
        assert.doesNotMatch(await page.locator('body').innerText(), /fixture-alpha|fixture-beta|model-internal-/);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    await t.test('a catalog with only a custom connection retains the four type tabs and can select that nested provider', async () => {
      const { page, mutations, errors } = await fixture(browser, bundle.outputFiles[0].text, { customOnly: true });
      try {
        const types = page.getByRole('navigation', { name: 'Chọn dạng kết nối AI', exact: true });
        await types.waitFor();
        assert.equal(await types.getByRole('button').count(), 4);
        assert.doesNotMatch(await types.innerText(), /Gateway Alpha/);
        await types.getByRole('button', { name: /OpenAI Compatible/ }).click();
        const connections = page.getByRole('navigation', { name: 'Chọn provider OpenAI Compatible', exact: true });
        assert.equal(await connections.getByRole('button').count(), 1);
        assert.equal(await connections.getByRole('button', { name: /Gateway Alpha/ }).getAttribute('aria-pressed'), 'true');
        await page.getByRole('heading', { name: 'Gateway Alpha', exact: true }).waitFor();
        await page.locator('.record-provider-detail').getByText('https://alpha.example.test/v1', { exact: true }).waitFor();
        assert.equal(await connections.getByText('Kết nối mặc định', { exact: true }).count(), 0);
        assert.deepEqual(mutations, []);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    await t.test('retries list errors, retains failed creation input and blocks duplicate connection checks', async () => {
      const fixtureData = await fixture(browser, bundle.outputFiles[0].text, { failList: true, failCreate: true });
      const { page, mutations, errors } = fixtureData;
      try {
        await page.getByText('Chưa tải được danh mục.', { exact: true }).waitFor();
        await page.getByRole('button', { name: /Tải lại/ }).click();
        await page.getByRole('navigation', { name: 'Chọn dạng kết nối AI', exact: true }).getByRole('button', { name: /OpenAI Compatible/ }).click();
        await page.getByRole('button', { name: /Thêm provider/ }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
        await dialog.getByText('Nhập tên provider.', { exact: true }).waitFor();
        assert.equal(mutations.length, 0);
        await dialog.getByLabel('Tên provider', { exact: true }).fill('Gateway Alpha');
        await dialog.getByLabel('Base URL', { exact: true }).fill('https://alpha.example.test/v1');
        await dialog.getByLabel('API key', { exact: true }).fill('fixture-alpha');
        await dialog.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
        await page.getByText('Base URL chưa được chấp nhận.', { exact: true }).waitFor();
        assert.equal(await dialog.getByLabel('Tên provider', { exact: true }).inputValue(), 'Gateway Alpha');
        await dialog.getByRole('button', { name: 'Lưu cấu hình', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        const release = fixtureData.holdCheck();
        await page.getByRole('button', { name: 'Kiểm tra kết nối', exact: true }).click();
        await page.locator('.ant-btn-loading').waitFor();
        assert.equal(await page.getByRole('button', { name: /Kiểm tra kết nối/ }).isDisabled(), true);
        release();
        await page.getByText('Kết nối thành công.', { exact: true }).waitFor();
        assert.equal(mutations.filter(item => item.path.endsWith('/check')).length, 1);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });

    await t.test('multiple providers and actual styles fit a 320px viewport', async () => {
      const { page, errors } = await fixture(browser, bundle.outputFiles[0].text);
      try {
        await addProvider(page, 'Gateway Alpha', 'https://alpha.example.test/v1', 'fixture-alpha');
        await addModel(page, 'Model Alpha');
        await addProvider(page, 'Gateway Beta', 'https://beta.example.test/v1', 'fixture-beta');
        await addModel(page, 'Model Beta');
        await page.addStyleTag({ content: (await readFile('web/src/styles.css', 'utf8')).replace(/^@import[^;]+;\s*/m, '') });
        await page.addStyleTag({ content: await readFile('web/src/records.css', 'utf8') });
        await page.addStyleTag({ content: '#root { max-width: 1200px; margin: 24px auto; padding: 0 20px; }' });
        if (process.env.CRM_PROVIDERS_SCREENSHOT) {
          await page.locator('.ant-message-notice').last().waitFor({ state: 'hidden' });
          await page.screenshot({ path: process.env.CRM_PROVIDERS_SCREENSHOT, fullPage: true });
        }
        await page.setViewportSize({ width: 320, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        assert.equal(await page.getByRole('button', { name: /Thêm provider/ }).isVisible(), true);
        assert.equal(await page.locator('.page-heading').getByRole('button', { name: /Thêm provider/ }).count(), 0);
        if (process.env.CRM_PROVIDERS_MOBILE_SCREENSHOT) await page.screenshot({ path: process.env.CRM_PROVIDERS_MOBILE_SCREENSHOT, fullPage: true });
        await page.getByRole('button', { name: 'Cấu hình kết nối', exact: true }).click();
        await page.getByLabel('Tên provider', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
