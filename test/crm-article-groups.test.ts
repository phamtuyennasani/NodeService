import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright'

test('CRM article groups show website identity, the source first, and direct links from translations to their source job', async () => {
  const root = '11111111-1111-4111-8111-111111111111'
  const target = '22222222-2222-4222-8222-222222222222'
  const other = '33333333-3333-4333-8333-333333333333'
  const site = '44444444-4444-4444-8444-444444444444'
  const customer = '55555555-5555-4555-8555-555555555555'
  const base = { id: root, job_id: root, customer_id: customer, customer_name: 'Customer', website_id: site, website_name: 'Website A',
    article_group_id: root, article_ref: 'news:7', original_job_id: root, original_locale: 'en', locale: 'en',
    mode: 'preview', status: 'completed', keyword: 'English source', model: 'model', tone: 'clear', style: 'guide', length: 800,
    created_at: '2026-11-26T01:00:00Z', updated_at: '2026-11-26T01:00:00Z', scheduled_at: null, started_at: null, completed_at: null, source_article_id: null, key_mode: 'service' }
  const translated = { ...base, id: target, job_id: target, locale: 'ja', article_title: '日本語の翻訳', is_translation: true, translation_of_job_id: root,
    translation_source: { Title: 'Reviewed source', Content: '<p>Edited source revision.</p>' },
    result: [{ Title: '日本語の翻訳', Content: '<p>内容です。</p>', Slug: '記事', Desc: '説明', Description: '記事の説明', Keywords: ['記事'] }], attempts: [], deliveries: [] }
  const groups = [{
    group_key: 'A', article_group_id: root, article_ref: 'news:7', website_id: site, website_name: 'Website A', website_domain: 'a.example.com',
    customer_id: customer, customer_name: 'Customer', original_locale: 'en', original_job_id: root, original_title: 'Approved English', source_kind: 'crm', legacy: false, versions: 2,
    locales: [{ locale: 'en', job_id: root, status: 'completed' }, { locale: 'ja', job_id: target, status: 'completed' }], jobs: [base, translated], created_at: base.created_at, updated_at: base.updated_at,
  }, {
    group_key: 'B', article_group_id: other, article_ref: 'news:7', website_id: '66666666-6666-4666-8666-666666666666', website_name: 'Website B', website_domain: 'b.example.com',
    customer_id: customer, customer_name: 'Customer', original_locale: 'en', original_job_id: other, original_title: 'Other website article', source_kind: 'crm', legacy: false, versions: 1,
    locales: [{ locale: 'en', job_id: other, status: 'completed' }], jobs: [{ ...base, id: other, job_id: other }], created_at: base.created_at, updated_at: base.updated_at,
  }]
  const { outputFiles } = await build({ stdin: { contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {App,ConfigProvider} from 'antd';import {Jobs} from './web/src/Jobs';import {setCsrfToken} from './web/src/api';import {prepareBrowserLogin} from './web/src/browser-proof';setCsrfToken('fixture');prepareBrowserLogin().then(()=>createRoot(document.getElementById('root')!).render(<ConfigProvider theme={{token:{motion:false}}}><App><Jobs query={new URLSearchParams('view=articles')} /></App></ConfigProvider>));`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, write: false, define: { 'process.env.NODE_ENV': '"test"' } })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.addInitScript(() => {
      const original = window.fetch.bind(window)
      window.fetch = (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString(), location.origin)
        if (url.pathname === '/api/crm/jobs/events') return Promise.resolve(new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } }))
        return original(input, init)
      }
    })
    await page.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>' })
      if (path === '/bundle.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text })
      if (path === '/api/crm/session/bootstrap') return route.fulfill({ json: { browser_binding: 'b'.repeat(43), server_time: Date.now() } })
      if (path === '/api/crm/article-groups') return route.fulfill({ json: { data: groups, next_cursor: null } })
      if (path === '/api/crm/jobs/' + target) return route.fulfill({ json: translated })
      if (path.startsWith('/api/crm/customers') || path.startsWith('/api/crm/websites')) return route.fulfill({ json: { data: [], next_cursor: null } })
      return route.fulfill({ status: 204 })
    })
    await page.goto('http://localhost:3263/')
    await page.getByRole('heading', { name: 'Nhóm bài viết', exact: true }).waitFor()
    await page.getByText('Approved English', { exact: true }).waitFor()
    await page.getByText('Website B', { exact: true }).waitFor()
    assert.equal(await page.getByText('news:7', { exact: true }).count(), 2)
    await page.getByRole('button', { name: 'Xem các bản của Approved English', exact: true }).click()
    await page.getByText('Bản gốc', { exact: true }).waitFor()
    const childRows = page.locator('.ant-table-expanded-row tr[data-row-key]')
    assert.equal(await childRows.first().getAttribute('data-row-key'), root)
    await page.getByRole('button', { name: 'ja · Đã viết', exact: true }).click()
    const drawer = page.locator('.ant-drawer')
    await drawer.getByText('Dịch từ lần viết', { exact: true }).waitFor()
    await drawer.getByText('Bài gốc CRM', { exact: true }).waitFor()
    assert.equal(await drawer.locator(`a[href="#jobs?job=${root}"]`).count(), 2)
    await drawer.getByRole('tab', { name: 'Bản gốc dùng để dịch', exact: true }).click()
    await drawer.getByText('Edited source revision.', { exact: true }).waitFor()
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
