import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import type { KeywordAnalysisView } from '../src/keywords/contracts.js'

const site = '22c240aa-9959-4c14-a49f-ec38eb68f126', customer = '50a91ec9-e750-4807-8530-29fcac2fa0aa'
const id = '3aa3b51c-c62e-41d0-bcc9-cdca3fd4d13e', candidate = '123456789012345678901234'
const origin = 'http://localhost:3266'
const saved: KeywordAnalysisView = {
  id, website_id: site, customer_id: customer,
  input: { website_id: site, client_request_id: randomUUID(), seed: 'máy lọc nước', country: 'VN', locale: 'vi', type: 'suggestions', business: '', audience: '' },
  status: 'ready', stage: 'done', created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
  result: { source: 'keywordtool_guest', total_count: 676, fetched_at: new Date().toISOString(), partial: false,
    country: 'Vietnam', language: 'Tiếng Việt', metrics_scope: 'unverified_cache', candidates: [
      { id: candidate, keyword: 'máy lọc nước', source_rank: 1, volume: 0, trend: 0, bid_low: 0, bid_high: 0.2, ads_competition: 0, metrics_status: 'available' },
      { id: 'a'.repeat(24), keyword: 'máy lọc nước gia đình', source_rank: 2, volume: null, trend: null, bid_low: null, bid_high: null, ads_competition: null, metrics_status: 'unavailable' },
    ] }, suggestions: [], error: null, ai_note: null, reused: false, source_cost: 'free', ai_cost_usd: null, ai_called: false,
}

test('CRM keyword free discovery, history, retry and article handoff work on desktop and mobile', { timeout: 60_000 }, async t => {
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {App,ConfigProvider} from 'antd';
      import {Keywords} from './web/src/Keywords'; import {crmTheme} from './web/src/theme';
      import {prepareBrowserLogin,setBrowserSession} from './web/src/browser-proof'; import {setCsrfToken} from './web/src/api';
      import './web/src/styles.css'; import './web/src/records.css';
      void prepareBrowserLogin().then(()=>{setBrowserSession({browser_binding:'${'b'.repeat(43)}',server_time:Date.now()});setCsrfToken('test-csrf');
        createRoot(document.getElementById('root')).render(<ConfigProvider theme={crmTheme}><App><main className="crm-page"><Keywords query={new URLSearchParams('website_id=${site}')} /></main></App></ConfigProvider>);});`,
      resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', write: false, outdir: '/tmp/crm-keyword-ui',
    loader: { '.woff': 'empty', '.woff2': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
  })
  const js = bundle.outputFiles.find(f => f.path.endsWith('.js'))!.text
  const css = bundle.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? ''
  const browser = await chromium.launch()
  t.after(() => browser.close())
  for (const width of [1440, 375]) await t.test(`${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } })
    page.setDefaultTimeout(10000)
    const errors: string[] = [], posts: any[] = [], jobs: any[] = []
    let exists = false, rejectFirst = true
    page.on('pageerror', e => errors.push(e.message))
    await page.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url())
      if (url.origin !== origin) { errors.push(`External ${url.origin}`); return route.abort() }
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/test.css"></head><body><div id="root"></div><script src="/test.js"></script></body></html>' })
      if (url.pathname === '/test.js') return route.fulfill({ contentType: 'text/javascript', body: js })
      if (url.pathname === '/test.css') return route.fulfill({ contentType: 'text/css', body: css })
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 })
      if (url.pathname === '/api/crm/session/bootstrap') return route.fulfill({ json: { browser_binding: 'b'.repeat(43), server_time: Date.now() } })
      assert.ok(req.headers()['x-crm-proof'])
      if (url.pathname === '/api/crm/customers') return route.fulfill({ json: { data: [{ id: customer, name: 'Khách hàng thử', key_mode: 'service' }] } })
      if (url.pathname === '/api/crm/websites') return route.fulfill({ json: { data: [{ id: site, customer_id: customer, name: 'Website mới' }] } })
      if (url.pathname === '/api/crm/providers') return route.fulfill({ json: { data: [{ provider: 'openai', display_name: 'OpenAI', enabled: true, service_key_configured: true, models: [{ model: 'gpt-4.1', display_name: 'GPT-4.1', enabled: true }] }] } })
      if (url.pathname === '/api/crm/settings/keywords') return route.fulfill({ json: { values: { enabled: true, mode: 'guest' }, revision: 0, api_key_configured: false } })
      if (url.pathname === '/api/crm/keyword-analyses' && req.method() === 'GET') return route.fulfill({ json: { data: exists ? [{ id, website_id: site, seed: 'máy lọc nước', status: 'ready', created_at: saved.created_at }] : [] } })
      if (url.pathname === '/api/crm/keyword-analyses' && req.method() === 'POST') {
        posts.push(req.postDataJSON())
        if (rejectFirst) { rejectFirst = false; return route.fulfill({ status: 503, json: { error: { message: 'Lỗi mạng thử nghiệm' } } }) }
        exists = true
        return route.fulfill({ status: 202, json: { ...saved, status: 'queued', stage: 'source', result: null } })
      }
      if (url.pathname === `/api/crm/keyword-analyses/${id}`) return route.fulfill({ json: saved })
      if (url.pathname === '/api/crm/jobs' && req.method() === 'POST') { jobs.push(req.postDataJSON()); return route.fulfill({ status: 202, json: { job_id: randomUUID(), status: 'queued' } }) }
      errors.push(`Unexpected ${req.method()} ${url.pathname}`); return route.abort()
    })
    try {
      await page.goto(origin)
      await page.getByLabel('Chủ đề hoặc sản phẩm/dịch vụ', { exact: true }).fill('máy lọc nước')
      await page.getByRole('button', { name: 'Phân tích từ khóa', exact: true }).click()
      await page.getByText('Lỗi mạng thử nghiệm', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'Phân tích từ khóa', exact: true }).click()
      await page.getByRole('heading', { name: '2 từ khóa đã lấy / 676 gợi ý nguồn' }).waitFor()
      assert.equal(posts.length, 2); assert.equal(posts[0].client_request_id, posts[1].client_request_id)
      assert.equal(posts[1].ai_model, undefined)
      assert.equal(posts[1].country, 'VN'); assert.equal(posts[1].locale, 'vi')
      await page.getByText('Số liệu cache chỉ để tham khảo', { exact: true }).waitFor()
      await page.getByText('1/2 từ khóa có lượng tìm kiếm.', { exact: true }).waitFor()
      assert.equal(await page.getByRole('cell', { name: 'Chưa có', exact: true }).count(), 1)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
      assert.equal(overflow, false, 'table may scroll internally, the page must fit the viewport')
      await page.screenshot({ path: `/tmp/crm-keywords-${width}.png`, fullPage: true })
      await page.getByRole('button', { name: 'Viết bài', exact: true }).first().click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Model AI', { exact: true }).click()
      await page.getByText('GPT-4.1 · OpenAI', { exact: true }).click()
      assert.equal(await dialog.getByLabel('Từ khóa', { exact: true }).inputValue(), 'máy lọc nước')
      await dialog.getByRole('button', { name: 'Viết bài ngay', exact: true }).click()
      await page.getByText('Đã tạo yêu cầu viết từ đề xuất. Xem tại Yêu cầu viết.', { exact: true }).waitFor()
      assert.equal(jobs.length, 1)
      assert.deepEqual(jobs[0].keyword_selection, { analysis_id: id, candidate_id: candidate })
      assert.deepEqual(jobs[0].languages, { source: 'vi', targets: [] })
      assert.equal(jobs[0].website_id, site)
      assert.equal(jobs[0].customer_id, customer)
      assert.deepEqual(errors, [])
    } finally { await page.close() }
  })
})
