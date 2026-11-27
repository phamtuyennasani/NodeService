import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { test } from 'node:test'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { widgetPreviewPage } from '../scripts/widget-preview-page'

test('demo applies AI HTML into real CKEditor, syncs manual edits and replaces an open source buffer', { timeout: 60_000 }, async () => {
  const [widget, editor] = await Promise.all([
    build({ entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false }),
    build({ entryPoints: ['scripts/widget-preview-editor.ts'], bundle: true, format: 'iife', outfile: 'editor.js', write: false }),
  ])
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
    await page.locator('#editor-status[data-state="ready"]').waitFor()
    const editable = page.locator('.ck-editor__editable_root[contenteditable="true"]')
    const source = page.locator('#article-content')
    assert.equal(await source.isVisible(), false)
    assert.equal(await editable.getAttribute('aria-labelledby'), 'content-label')
    assert.equal(await page.getByRole('button', { name: 'Đậm', exact: true }).isVisible(), true)
    await editable.fill('Nội dung gõ trực tiếp trong editor.')
    assert.match(await source.inputValue(), /Nội dung gõ trực tiếp/)
    assert.equal(await page.evaluate(() => new FormData(document.querySelector<HTMLFormElement>('#article')!).get('body')), await source.inputValue())

    // Apply while the source panel is open, with unsaved HTML in its buffer.
    const toggleSource = page.getByRole('button', { name: 'Nguồn', exact: true })
    await toggleSource.click()
    await page.locator('.ck-source-editing-area textarea').fill('<p>Nháp HTML đang mở.</p>')
    await page.getByRole('button', { name: 'Viết bài AI', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Từ khóa', { exact: true }).fill('biên tập')
    await dialog.getByRole('button', { name: 'Viết ngay', exact: true }).click()
    await dialog.getByRole('heading', { name: article.Title }).waitFor()
    await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await editable.waitFor()
    assert.equal(jobs, 1)
    assert.equal(await page.locator('[name="title"]').inputValue(), article.Title)
    assert.equal(await page.locator('[name="focus_keyword"]').inputValue(), 'biên tập')
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
    const htmlEditor = page.locator('.ck-source-editing-area textarea')
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
