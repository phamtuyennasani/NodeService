import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const bundle = (await build({ entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false })).outputFiles[0].text
const articles = {
  'en-US': { Title: 'Original English article', Content: '<p>New English original 123.</p>', Slug: 'english-original', Desc: 'Summary', Description: 'SEO', Keywords: ['article'] },
  ja: { Title: '日本語の記事', Content: '<p>日本語の内容 456。</p>', Slug: 'japanese', Desc: '説明', Description: '記事の説明', Keywords: ['日本語', '記事'], FocusKeyword: '記事' },
  vi: { Title: 'Bài tiếng Việt', Content: '<p>Nội dung tiếng Việt 456.</p>', Slug: 'bai-tieng-viet', Desc: 'Tóm tắt', Description: 'Mô tả', Keywords: ['nội dung', 'bài viết'], FocusKeyword: 'bài viết' },
}

async function fixture(t: test.TestContext, options: { failTranslation?: boolean; failReadTranslation?: boolean; holdTranslation?: boolean; pollTranslation?: boolean; targets?: string[]; mobile?: boolean; remote?: boolean } = {}) {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } })
  t.after(() => browser.close())
  page.setDefaultTimeout(10000)
  page.on('dialog', dialog => dialog.accept())
  const posts: { body: any; id: string }[] = []
  const signed: { body: string; id: string }[] = []
  const jobs = new Map<string, unknown>()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  let failed = false
  let readFailed = false
  const statusReads: string[] = []
  const polls = new Map<string, number>()
  const site = '33333333-3333-4333-8333-333333333333'
  const script = options.remote
    ? `http://localhost:3263/widget/v1/ai-writer.js?site=${site}&expires=${Math.floor(Date.now() / 1000) + 3600}&signature=${'e'.repeat(64)}`
    : '/widget.js'
  const cors = { 'Access-Control-Allow-Origin': 'http://localhost:3262',
    'Access-Control-Allow-Headers': 'content-type,idempotency-key,x-widget-expires,x-widget-signature,x-widget-read-token,x-site-proof',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }
  await page.route('**/*', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors })
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="csrf-token" content="test">
      <form id="article"><input name="name[en-us]" value="Saved original"><textarea name="content[en-us]">Saved content</textarea>
      <input name="name[ja]"><textarea name="content[ja]"></textarea><input id="vi-title"><textarea id="vi-body"></textarea>
      <input name="focus[en-us]"><input name="focus[ja]"><input id="vi-focus"><input name="keywords[en-us]"><input name="keywords[ja]"><input id="vi-keywords">
      <input name="slug" value="saved-slug"><span id="tools"></span></form><script src="${script}" data-authorize-url="/authorize"></script><script>
      AIWriter.mount({mount:'#tools',form:'#article',${options.remote ? '' : "endpoint:'/preview',"}models:[{value:'test',label:'Test'}],
        languages:{source:'en-us',targets:${JSON.stringify(options.targets ?? ['ja', 'vi'])}},
        fields:{Title:'[name="name[$lang]"]',FocusKeyword:'[name="focus[$lang]"]',Keywords:'[name="keywords[$lang]"]',Content:{selector:'[name="content[$lang]"]',getValue:element=>'<p>Old editor content.</p>',
          setValue:(element,value)=>{element.value=value;element.dataset.editorWrite='yes'}},Slug:'[name=slug]'},
        fieldsByLocale:{vi:{Title:'#vi-title',FocusKeyword:'#vi-focus',Keywords:'#vi-keywords',Content:'#vi-body'}}});
      </script>` })
    if (path === '/widget.js' || path === '/widget/v1/ai-writer.js') return route.fulfill({ contentType: 'text/javascript', body: bundle })
    if (path.endsWith('/models')) return route.fulfill({ headers: cors, json: { proof_required: true, key_mode: 'service', data: [{ model: 'test', display_name: 'Test' }] } })
    if (path === '/authorize') {
      signed.push(request.postDataJSON())
      if (request.headers()['x-csrf-token'] !== 'test') errors.push('Missing CSRF on authorization')
      return route.fulfill({ json: { proof: `proof-${signed.length}` } })
    }
    if (path.endsWith('/result')) {
      if (request.headers()['x-widget-read-token'] !== 'a'.repeat(64)) errors.push('Missing result read token')
      const id = path.split('/').at(-2)!
      if (options.failReadTranslation && !readFailed && (jobs.get(id) as any)?.Title === articles.vi.Title) {
        readFailed = true
        return route.fulfill({ headers: cors, status: 503, json: { error: { message: 'Tạm thời chưa đọc được bản dịch.' } } })
      }
      return route.fulfill({ headers: cors, json: [jobs.get(id)] })
    }
    if (request.method() === 'GET' && (path.includes('/previews/') || path.startsWith('/preview/'))) {
      const id = path.split('/').at(-1)!
      statusReads.push(id)
      if (options.remote && request.headers()['x-widget-read-token'] !== 'a'.repeat(64)) errors.push('Missing status read token')
      const count = polls.get(id) ?? 0
      polls.set(id, count + 1)
      const status = options.pollTranslation && jobs.get(id) === articles.ja ? ['writing', 'retrying', 'ready'][Math.min(count, 2)] : 'ready'
      return route.fulfill({ headers: cors, json: { job_id: id, status, writing_stage: 'draft', result: [jobs.get(id)] } })
    }
    if ((path === '/preview' || path.endsWith('/previews')) && request.method() === 'POST') {
      const body = request.postDataJSON()
      posts.push({ body, id: request.headers()['idempotency-key'] })
      if (options.remote && (request.headers()['x-site-proof'] !== `proof-${signed.length}`
        || signed.at(-1)?.body !== request.postData() || signed.at(-1)?.id !== request.headers()['idempotency-key'])) errors.push('Proof did not bind the exact request')
      if (body.locale === 'ja' && options.holdTranslation) await gate
      if (body.locale === 'vi' && options.failTranslation && !failed) {
        failed = true
        return route.fulfill({ status: 503, json: { error: { message: 'Dịch tiếng Việt tạm thời thất bại.' } } })
      }
      const article = articles[body.locale as keyof typeof articles]
      const jobId = `11111111-1111-4111-8111-${String(posts.length).padStart(12, '0')}`
      jobs.set(jobId, article)
      return route.fulfill({ headers: cors, json: { job_id: jobId,
        ...(options.remote ? { read_token: 'a'.repeat(64) } : {}),
        article_group_id: '22222222-2222-4222-8222-222222222222', status: options.pollTranslation && body.locale === 'ja' ? 'queued' : 'ready', result: [article] } })
    }
    return route.fulfill({ status: 404 })
  })
  await page.goto('http://localhost:3262/')
  const dialog = page.getByRole('dialog')
  const apply = dialog.getByRole('button', { name: 'Áp dụng', exact: true })
  async function write(keyword = 'article') {
    await page.getByRole('button', { name: 'Viết bài AI' }).click()
    await dialog.getByLabel('Từ khóa', { exact: true }).fill(keyword)
    await dialog.getByRole('button', { name: 'Viết ngay' }).click()
    await dialog.getByRole('heading', { name: articles['en-US'].Title, exact: true }).waitFor()
  }
  return { page, dialog, apply, posts, errors, signed, statusReads, release, write }
}

test('applying only the original starts a fresh writing cycle and never translates existing form content', async t => {
  const f = await fixture(t)
  await f.write()
  assert.equal(await f.page.locator('[name="name[en-us]"]').inputValue(), 'Saved original')
  assert.equal(await f.dialog.getByRole('combobox', { name: 'Ngôn ngữ bài viết' }).count(), 0)
  assert.equal(await f.dialog.getByRole('button', { name: 'Dịch sang các ngôn ngữ khác' }).isVisible(), true)
  await f.apply.click()
  await f.dialog.waitFor({ state: 'hidden' })
  assert.equal(f.posts.length, 1)
  assert.equal(await f.page.locator('[name="content[en-us]"]').inputValue(), articles['en-US'].Content)
  assert.equal(await f.page.locator('#vi-body').inputValue(), '')
  await f.page.getByRole('button', { name: 'Viết bài AI' }).click()
  assert.equal(await f.dialog.getByLabel('Từ khóa', { exact: true }).inputValue(), '')
  assert.equal(await f.dialog.getByRole('button', { name: 'Viết ngay' }).isVisible(), true)
  assert.equal(await f.apply.isVisible(), false)
  assert.equal(f.posts.length, 1)
  await f.dialog.getByLabel('Từ khóa', { exact: true }).fill('another article')
  await f.dialog.getByRole('button', { name: 'Viết ngay' }).click()
  await f.dialog.getByRole('heading', { name: articles['en-US'].Title, exact: true }).waitFor()
  assert.equal(f.posts.length, 2)
  assert.deepEqual(f.posts.map(post => post.body.locale), ['en-US', 'en-US'])
  assert.notEqual(f.posts[0].body.article_ref, f.posts[1].body.article_ref)
  assert.notEqual(f.posts[0].id, f.posts[1].id)
  assert.ok(f.posts.every(post => !post.body.translation_source && !post.body.translation_of_job_id))
  assert.equal(await f.dialog.getByRole('button', { name: 'Dịch sang các ngôn ngữ khác' }).isVisible(), true)
  assert.deepEqual(f.errors, [])
})

test('translates the preview original into every target then applies all versions once, including editor callbacks and locale overrides', async t => {
  const f = await fixture(t, { holdTranslation: true, mobile: true })
  await f.write()
  await f.dialog.getByRole('button', { name: 'Dịch sang các ngôn ngữ khác' }).click()
  await f.dialog.getByText('Đang gửi yêu cầu dịch sang Tiếng Nhật…', { exact: true }).waitFor()
  await f.dialog.getByRole('heading', { name: 'Đang dịch bài viết sang các ngôn ngữ khác', exact: true }).waitFor()
  assert.equal(await f.dialog.locator('.writing-language').textContent(), '1/2 · Tiếng Anh (Mỹ) (en-US) → Tiếng Nhật (ja)')
  assert.equal(await f.dialog.locator('[data-scene="translation"]').isVisible(), true)
  assert.equal(await f.dialog.locator('[data-scene="waiting"]').isVisible(), false)
  assert.equal(await f.dialog.locator('.accept').isDisabled(), true)
  assert.equal(await f.dialog.getByRole('button', { name: 'Đóng', exact: true }).isDisabled(), true)
  assert.equal(await f.page.locator('[name="name[en-us]"]').inputValue(), 'Saved original')
  f.release()
  await f.dialog.getByText('Đã dịch 2/2', { exact: true }).waitFor()
  await f.apply.waitFor({ state: 'visible' })
  await f.page.waitForFunction(() => !document.querySelector('#tools > span')!.shadowRoot!.querySelector<HTMLButtonElement>('.accept')!.disabled)
  assert.deepEqual(await f.dialog.locator('footer').getByRole('button').allTextContents(), ['Áp dụng'])
  assert.equal(await f.page.locator('#vi-body').inputValue(), '')
  assert.deepEqual(f.posts.map(post => post.body.locale), ['en-US', 'ja', 'vi'])
  assert.equal(new Set(f.posts.map(post => post.body.article_ref)).size, 1)
  assert.equal(new Set(f.posts.map(post => post.id)).size, 3)
  for (const post of f.posts.slice(1)) {
    assert.equal(post.body.translation_source.Content, articles['en-US'].Content)
    assert.equal(post.body.translation_source.Title, articles['en-US'].Title)
    assert.equal(post.body.translation_of_job_id, '11111111-1111-4111-8111-000000000001')
    assert.equal(post.body.use_research, false)
  }
  const previewLanguage = f.dialog.getByRole('tablist', { name: 'Ngôn ngữ xem trước' })
  const japanese = previewLanguage.getByRole('tab', { name: 'Tiếng Nhật', exact: true })
  const vietnamese = previewLanguage.getByRole('tab', { name: 'Tiếng Việt', exact: true })
  await japanese.click()
  await f.dialog.getByRole('heading', { name: articles.ja.Title, exact: true }).waitFor()
  assert.equal(await japanese.getAttribute('aria-selected'), 'true')
  assert.equal(await japanese.evaluate(element => element.matches(':focus')), true)
  await japanese.press('End')
  await f.dialog.getByRole('heading', { name: articles.vi.Title, exact: true }).waitFor()
  await vietnamese.press('Home')
  await f.dialog.getByRole('heading', { name: articles['en-US'].Title, exact: true }).waitFor()
  assert.equal(await previewLanguage.getByRole('tab', { name: /Bản gốc/ }).getAttribute('aria-selected'), 'true')
  await vietnamese.click()
  await f.dialog.getByRole('heading', { name: articles.vi.Title, exact: true }).waitFor()
  const metrics = await f.dialog.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }))
  assert.ok(metrics.scroll <= metrics.client + 1)
  await f.apply.click()
  await f.dialog.waitFor({ state: 'hidden' })
  assert.equal(f.posts.length, 3)
  assert.equal(await f.page.locator('[name="content[en-us]"]').inputValue(), articles['en-US'].Content)
  assert.equal(await f.page.locator('[name="content[ja]"]').inputValue(), articles.ja.Content)
  assert.equal(await f.page.locator('[name="content[ja]"]').getAttribute('data-editor-write'), 'yes')
  assert.equal(await f.page.locator('#vi-body').inputValue(), articles.vi.Content)
  assert.equal(await f.page.locator('[name="focus[en-us]"]').inputValue(), 'article')
  assert.equal(await f.page.locator('[name="focus[ja]"]').inputValue(), articles.ja.FocusKeyword)
  assert.equal(await f.page.locator('#vi-focus').inputValue(), articles.vi.FocusKeyword)
  assert.equal(await f.page.locator('[name="keywords[ja]"]').inputValue(), articles.ja.Keywords.join(', '))
  assert.equal(await f.page.locator('#vi-keywords').inputValue(), articles.vi.Keywords.join(', '))
  assert.equal(await f.page.locator('[name=slug]').inputValue(), articles['en-US'].Slug)
  await f.page.getByRole('button', { name: 'Viết bài AI' }).click()
  assert.equal(await f.dialog.getByRole('button', { name: 'Viết ngay' }).isVisible(), true)
  assert.equal(await f.dialog.getByRole('tablist', { name: 'Ngôn ngữ xem trước' }).isVisible(), false)
  assert.equal(f.posts.length, 3)
  await f.dialog.getByLabel('Từ khóa', { exact: true }).fill('next article')
  await f.dialog.getByRole('button', { name: 'Viết ngay' }).click()
  await f.dialog.getByRole('heading', { name: articles['en-US'].Title, exact: true }).waitFor()
  assert.equal(f.posts.length, 4)
  assert.equal(f.posts[3].body.locale, 'en-US')
  assert.equal(f.posts[3].body.translation_source, undefined)
  assert.equal(await f.dialog.locator('.writing-title').textContent(), 'Đang tạo bài viết của bạn')
  assert.equal(await f.dialog.locator('.writing-language').isVisible(), false)
  assert.notEqual(f.posts[3].body.article_ref, f.posts[0].body.article_ref)
  assert.equal(await f.dialog.getByRole('button', { name: 'Dịch sang các ngôn ngữ khác' }).isVisible(), true)
  assert.deepEqual(f.errors, [])
})

test('translation retry keeps completed languages and the failed request id without exposing a partial apply', async t => {
  const f = await fixture(t, { failTranslation: true })
  await f.write()
  await f.dialog.getByRole('button', { name: 'Dịch sang các ngôn ngữ khác' }).click()
  await f.dialog.getByText('Dịch tiếng Việt tạm thời thất bại.', { exact: true }).waitFor()
  assert.equal(await f.apply.isDisabled(), true)
  assert.equal(await f.page.locator('[name="content[ja]"]').inputValue(), '')
  assert.equal(await f.page.locator('[name="name[en-us]"]').inputValue(), 'Saved original')
  await f.dialog.getByRole('button', { name: 'Thử lại bản dịch' }).click()
  await f.page.waitForFunction(() => !document.querySelector('#tools > span')!.shadowRoot!.querySelector<HTMLButtonElement>('.accept')!.disabled)
  assert.deepEqual(f.posts.map(post => post.body.locale), ['en-US', 'ja', 'vi', 'vi'])
  assert.equal(f.posts[2].id, f.posts[3].id)
  assert.deepEqual(f.posts[2].body, f.posts[3].body)
  assert.deepEqual(await f.dialog.locator('footer').getByRole('button').allTextContents(), ['Áp dụng'])
  await f.apply.click()
  await f.dialog.waitFor({ state: 'hidden' })
  assert.equal(await f.page.locator('#vi-body').inputValue(), articles.vi.Content)
  assert.deepEqual(f.errors, [])
})

test('a website without target languages offers only apply after receiving its original', async t => {
  const f = await fixture(t, { targets: [] })
  await f.write()
  assert.deepEqual(await f.dialog.locator('footer').getByRole('button').allTextContents(), ['Áp dụng'])
  await f.apply.click()
  await f.dialog.waitFor({ state: 'hidden' })
  assert.equal(f.posts.length, 1)
  assert.deepEqual(f.errors, [])
})

test('remote CRM signs each original and translation separately and reads their protected results', async t => {
  const f = await fixture(t, { remote: true })
  await f.write()
  await f.dialog.getByRole('button', { name: 'Dịch sang các ngôn ngữ khác' }).click()
  await f.page.waitForFunction(() => !document.querySelector('#tools > span')!.shadowRoot!.querySelector<HTMLButtonElement>('.accept')!.disabled)
  assert.equal(f.signed.length, 3)
  assert.equal(f.posts.length, 3)
  assert.equal(new Set(f.signed.map(input => input.id)).size, 3)
  assert.deepEqual(f.posts.map(post => post.body.locale), ['en-US', 'ja', 'vi'])
  await f.apply.click()
  await f.dialog.waitFor({ state: 'hidden' })
  assert.equal(await f.page.locator('#vi-body').inputValue(), articles.vi.Content)
  assert.deepEqual(f.errors, [])
})

test('retrying a received translation reads its existing job without another write or quota reservation', async t => {
  const f = await fixture(t, { remote: true, failReadTranslation: true })
  await f.write()
  await f.dialog.getByRole('button', { name: 'Dịch sang các ngôn ngữ khác' }).click()
  await f.dialog.getByText('Tạm thời chưa đọc được bản dịch.', { exact: true }).waitFor()
  assert.equal(await f.apply.isDisabled(), true)
  await f.dialog.getByRole('button', { name: 'Thử lại bản dịch' }).click()
  await f.page.waitForFunction(() => !document.querySelector('#tools > span')!.shadowRoot!.querySelector<HTMLButtonElement>('.accept')!.disabled)
  assert.equal(f.posts.length, 3)
  assert.equal(f.signed.length, 3)
  assert.deepEqual(f.statusReads, ['11111111-1111-4111-8111-000000000003'])
  await f.apply.click()
  await f.dialog.waitFor({ state: 'hidden' })
  assert.equal(await f.page.locator('#vi-body').inputValue(), articles.vi.Content)
  assert.deepEqual(f.errors, [])
})

test('queued and retrying translations retain their translation title, language and illustration throughout polling', async t => {
  const f = await fixture(t, { pollTranslation: true, mobile: true })
  await f.write()
  await f.dialog.getByRole('button', { name: 'Dịch sang các ngôn ngữ khác' }).click()
  for (const message of ['Bản dịch Tiếng Nhật đang chờ xử lý…', 'Đang dịch bài viết sang Tiếng Nhật…', 'CRM đang thử dịch lại sang Tiếng Nhật…']) {
    await f.dialog.getByText(message, { exact: true }).waitFor()
    assert.equal(await f.dialog.locator('.writing-title').textContent(), 'Đang dịch bài viết sang các ngôn ngữ khác')
    assert.equal(await f.dialog.locator('.writing-visual').getAttribute('data-stage'), 'translation')
    assert.equal(await f.dialog.locator('[data-scene="translation"]').isVisible(), true)
    assert.equal(await f.dialog.locator('[data-scene="draft"]').isVisible(), false)
    assert.equal(await f.dialog.getByRole('progressbar').getAttribute('aria-label'), 'Đang dịch sang Tiếng Nhật (ja)')
  }
  await f.page.waitForFunction(() => !document.querySelector('#tools > span')!.shadowRoot!.querySelector<HTMLButtonElement>('.accept')!.disabled)
  assert.equal(f.posts.length, 3)
  assert.equal(await f.dialog.locator('.writing-title').isVisible(), false)
  assert.deepEqual(f.errors, [])
})
