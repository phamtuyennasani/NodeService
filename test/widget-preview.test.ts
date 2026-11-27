import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { widgetPreviewPage } from '../scripts/widget-preview-page'

const bundles = Promise.all([
  build({ entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false }),
  build({ entryPoints: ['scripts/widget-preview-editor.ts'], bundle: true, format: 'iife', outfile: 'editor.js', write: false }),
])

test('demo applies AI HTML into real CKEditor, syncs manual edits and replaces an open source buffer', { timeout: 60_000 }, async () => {
  const [widget, editor] = await bundles
  const assets = new Map(editor.outputFiles.map(file => [basename(file.path), file.text]))
  const html = widgetPreviewPage({
    site: { name: 'Website demo', domain: 'example.test' },
    customer: { name: 'Khách demo', daily_limit: 10, monthly_limit: 100, max_length: 1_500 },
    csrfToken: 'fixture-csrf', defaultModel: 'test-model',
  })
  const article = {
    Title: 'Bài viết trong CKEditor', Slug: 'bai-viet-trong-ckeditor',
    Content: '<h2>Hướng dẫn biên tập</h2><p style="color:#2455d6;font-size:18px;margin-bottom:20px">Đoạn <strong>in đậm</strong> và <a href="https://example.test/huong-dan">liên kết</a>.</p>' +
      '<h3>Các bước</h3><ul><li>Bước một</li><li>Bước hai</li></ul><blockquote><p>Lưu ý biên tập.</p></blockquote>' +
      '<table style="border-collapse:collapse;width:100%"><thead><tr><th scope="col">Tiêu chí</th></tr></thead><tbody><tr><td style="padding:12px">Đạt</td></tr></tbody></table>',
    Desc: 'Tóm tắt bài viết.', Description: 'Mô tả SEO.', Keywords: ['biên tập', 'HTML'],
  }
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    page.on('dialog', dialog => dialog.accept())
    const errors: string[] = []
    const external: string[] = []
    let jobs = 0
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.origin !== 'http://localhost:3220') {
        external.push(url.href)
        return route.abort()
      }
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html })
      if (url.pathname === '/widget/v1/ai-writer.js') return route.fulfill({ contentType: 'text/javascript', body: widget.outputFiles[0].text })
      if (url.pathname === '/preview/editor.js') return route.fulfill({ contentType: 'text/javascript', body: assets.get('editor.js')! })
      if (url.pathname === '/preview/editor.css') return route.fulfill({ contentType: 'text/css', body: assets.get('editor.css')! })
      if (url.pathname === '/admin/ai/models') return route.fulfill({ json: { data: [{ model: 'test-model', display_name: 'Model demo' }] } })
      if (request.method() === 'POST' && url.pathname === '/admin/ai/previews') {
        assert.equal(request.headers()['x-csrf-token'], 'fixture-csrf')
        jobs++
        return route.fulfill({ status: 202, json: { job_id: 'fixture-job', status: 'ready', keyword: 'biên tập', result: [article] } })
      }
      return route.fulfill({ status: 204 })
    })
    await page.goto('http://localhost:3220')
    await page.locator('#editor-status-vi[data-state="ready"]').waitFor()
    const editable = page.locator('#article-vi .ck-editor__editable_root[contenteditable="true"]')
    const source = page.locator('#article-content-vi')
    assert.equal(await source.isVisible(), false)
    assert.equal(await editable.getAttribute('aria-labelledby'), 'content-label-vi')
    assert.equal(await page.getByRole('button', { name: 'Đậm', exact: true }).isVisible(), true)
    await editable.fill('Nội dung gõ trực tiếp trong editor.')
    assert.match(await source.inputValue(), /Nội dung gõ trực tiếp/)
    assert.equal(await page.evaluate(() => new FormData(document.querySelector<HTMLFormElement>('#article')!).get('body[vi]')), await source.inputValue())

    // Apply while the source panel is open, with unsaved HTML in its buffer.
    const toggleSource = page.locator('#article-vi').getByRole('button', { name: 'Nguồn', exact: true })
    await toggleSource.click()
    await page.locator('#article-vi .ck-source-editing-area textarea').fill('<p>Nháp HTML đang mở.</p>')
    await page.getByRole('button', { name: 'Viết bài AI', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Từ khóa', { exact: true }).fill('biên tập')
    await dialog.getByRole('button', { name: 'Viết ngay', exact: true }).click()
    await dialog.getByRole('heading', { name: article.Title }).waitFor()
    await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await editable.waitFor()
    assert.equal(jobs, 1)
    assert.equal(await page.locator('[name="title[vi]"]').inputValue(), article.Title)
    assert.equal(await page.locator('[name="focus_keyword[vi]"]').inputValue(), 'biên tập')
    assert.equal(await editable.locator('h2').textContent(), 'Hướng dẫn biên tập')
    assert.equal(await editable.locator('h3').textContent(), 'Các bước')
    assert.equal(await editable.locator('li').count(), 2)
    assert.equal(await editable.locator('a').getAttribute('href'), 'https://example.test/huong-dan')
    assert.equal(await editable.locator('table td').textContent(), 'Đạt')
    const appliedHtml = await source.inputValue()
    assert.match(appliedHtml, /font-size:18px/)
    assert.match(appliedHtml, /margin-bottom:20px/)
    assert.match(appliedHtml, /padding:12px/)
    assert.doesNotMatch(appliedHtml, /Nháp HTML đang mở/)

    // Switching source mode back commits manual HTML to the same website field.
    await toggleSource.click()
    const htmlEditor = page.locator('#article-vi .ck-source-editing-area textarea')
    assert.match(await htmlEditor.inputValue(), /Hướng dẫn biên tập/)
    await htmlEditor.fill('<h2>Nội dung chỉnh bằng HTML</h2><p>Đã cập nhật.</p>')
    await toggleSource.click()
    assert.equal(await editable.locator('h2').textContent(), 'Nội dung chỉnh bằng HTML')
    assert.match(await source.inputValue(), /Đã cập nhật/)

    await page.setViewportSize({ width: 375, height: 812 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'toolbar wraps within the mobile form')
    assert.deepEqual(errors, [])
    assert.deepEqual(external, [], 'demo editor is self-hosted without CDN or license requests')
  } finally {
    await browser.close()
  }
})

test('demo writes the Vietnamese original, translates to English only on request, then applies both editors and SEO fields', { timeout: 60_000 }, async t => {
  const [widget, editor] = await bundles
  const assets = new Map(editor.outputFiles.map(file => [basename(file.path), file.text]))
  const html = widgetPreviewPage({ site: { name: 'Website demo', domain: 'example.test' }, customer: { name: 'Khách demo', daily_limit: 10, monthly_limit: 100, max_length: 1500 }, csrfToken: 'fixture-csrf' })
  const original = { Title: 'Máy lọc nước gia đình', Slug: 'may-loc-nuoc', Content: '<h2>Chọn máy lọc nước</h2><p>Nội dung bản gốc tiếng Việt.</p>', Desc: 'Tóm tắt tiếng Việt', Description: 'SEO tiếng Việt', Keywords: ['máy lọc nước', 'gia đình'] }
  const translated = { Title: 'Home water filters', Slug: 'home-water-filters', Content: '<h2>Choosing a water filter</h2><p>The translated English article.</p>', Desc: 'English summary', Description: 'English SEO description', Keywords: ['water filters', 'home'] }
  const posts: any[] = []
  const errors: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const browser = await chromium.launch()
  t.after(() => browser.close())
  const page = await browser.newPage()
  page.setDefaultTimeout(10000)
  page.on('dialog', dialog => dialog.accept())
  page.on('pageerror', error => errors.push(error.message))
  await page.route('http://localhost:3271/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: html })
    if (path === '/widget/v1/ai-writer.js') return route.fulfill({ contentType: 'text/javascript', body: widget.outputFiles[0].text })
    if (path === '/preview/editor.js') return route.fulfill({ contentType: 'text/javascript', body: assets.get('editor.js')! })
    if (path === '/preview/editor.css') return route.fulfill({ contentType: 'text/css', body: assets.get('editor.css')! })
    if (path === '/admin/ai/models') return route.fulfill({ json: { data: [{ model: 'test-model', display_name: 'Model demo' }] } })
    if (request.method() === 'POST' && path === '/admin/ai/previews') {
      assert.equal(request.headers()['x-csrf-token'], 'fixture-csrf')
      const body = request.postDataJSON()
      posts.push(body)
      if (body.locale === 'vi') return route.fulfill({ json: { job_id: 'original', status: 'ready', result: [original] } })
      return route.fulfill({ json: { job_id: 'translation', status: 'queued' } })
    }
    if (path === '/admin/ai/previews/translation') {
      await gate
      return route.fulfill({ json: { job_id: 'translation', status: 'ready', result: [translated] } })
    }
    return route.fulfill({ status: 204 })
  })
  await page.goto('http://localhost:3271')
  await page.locator('#editor-status-vi[data-state="ready"]').waitFor()
  await page.locator('#editor-status-en[data-state="ready"]').waitFor({ state: 'attached' })
  assert.equal(await page.locator('#article-en').isVisible(), false)
  const englishTab = page.getByRole('tab', { name: 'English', exact: true })
  await englishTab.click()
  await page.locator('[name="title[en]"]').fill('Existing English title')
  const englishPanel = page.locator('#article-en')
  await englishPanel.getByRole('button', { name: 'Nguồn', exact: true }).click()
  await englishPanel.locator('.ck-source-editing-area textarea').fill('<p>Unsaved source buffer.</p>')
  await page.getByRole('button', { name: 'Viết bài AI', exact: true }).click()
  const dialog = page.getByRole('dialog')
  assert.match(await dialog.locator('.source-language-name').textContent() ?? '', /Việt/)
  assert.match(await dialog.locator('.target-languages').textContent() ?? '', /Anh/)
  assert.equal(await dialog.getByRole('button', { name: 'English', exact: true }).count(), 0, 'no interface language switch')
  await dialog.getByLabel('Từ khóa', { exact: true }).fill('máy lọc nước')
  await dialog.getByRole('button', { name: 'Viết ngay', exact: true }).click()
  await dialog.getByRole('heading', { name: original.Title, exact: true }).waitFor()
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].languages, { source: 'vi', targets: ['en'] })
  assert.equal(posts[0].locale, 'vi')
  assert.equal(posts[0].translation_source, undefined)
  assert.equal(await page.locator('[name="title[vi]"]').inputValue(), '')
  assert.equal(await page.locator('[name="title[en]"]').inputValue(), 'Existing English title')
  await dialog.getByRole('button', { name: 'Dịch sang các ngôn ngữ khác', exact: true }).click()
  await dialog.getByText(/đang chờ xử lý…/).waitFor()
  assert.equal(posts.length, 2)
  assert.equal(posts[1].locale, 'en')
  assert.equal(posts[1].translation_of_job_id, 'original')
  assert.equal(posts[1].translation_source.Content, original.Content)
  assert.equal(posts[1].translation_source.Title, original.Title)
  assert.equal(await dialog.locator('.accept').isDisabled(), true)
  release()
  await dialog.getByRole('heading', { name: translated.Title, exact: true }).waitFor()
  await dialog.getByText('Đã dịch 1/1', { exact: true }).waitFor()
  await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click()
  await dialog.waitFor({ state: 'hidden' })
  for (const [locale, article] of [['vi', original], ['en', translated]] as const) {
    for (const [name, value] of Object.entries({ title: article.Title, slug: article.Slug, summary: article.Desc, seo_description: article.Description, keywords: article.Keywords.join(', '), focus_keyword: 'máy lọc nước' })) {
      assert.equal(await page.locator(`[name="${name}[${locale}]"]`).inputValue(), value)
    }
    const source = page.locator(`#article-content-${locale}`)
    const data = await page.evaluate(() => Object.fromEntries(new FormData(document.querySelector<HTMLFormElement>('#article')!)))
    assert.equal(data[`body[${locale}]`], await source.inputValue())
    assert.match(await source.inputValue(), locale === 'vi' ? /bản gốc tiếng Việt/ : /translated English article/)
  }
  assert.equal(await englishPanel.locator('.ck-source-editing-area').isVisible(), false)
  assert.equal(await englishPanel.locator('.ck-editor__editable_root h2').textContent(), 'Choosing a water filter')
  assert.doesNotMatch(await page.locator('#article-content-en').inputValue(), /Unsaved source buffer/)
  await englishTab.focus()
  await englishTab.press('ArrowLeft')
  assert.equal(await page.locator('#article-vi').isVisible(), true)
  assert.equal(await page.locator('#article-en').isVisible(), false)
  await page.setViewportSize({ width: 375, height: 812 })
  await page.getByRole('tab', { name: 'English', exact: true }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.deepEqual(errors, [])
})
