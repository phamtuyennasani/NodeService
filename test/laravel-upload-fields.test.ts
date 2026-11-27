import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';

const article = {
  Title: 'Tiêu đề mới', Content: '<p>Nội dung mới</p>', Slug: 'tieu-de-moi',
  Desc: 'Mô tả ngắn mới', Description: 'Mô tả SEO mới', Keywords: ['bài viết'],
};

test('Laravel upload accepts per-page fields without adding default mappings', async t => {
  const { outputFiles } = await build({ entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false });
  const template = await readFile('integrations/laravel-upload/resources/views/admin/layouts/js.blade.php', 'utf8');
  const script = template.split('<script>')[1].split('</script>')[0];
  const cases: {
    name: string;
    fields: string;
    pageFields?: Record<string, string>;
    html: string;
    setup?: string;
    confirms?: number;
    verify: (page: Page) => Promise<void>;
  }[] = [
    {
      name: 'plain name, content and mota selectors leave BaseCodeAW fields untouched',
      fields: `{ Title: '[name="name"]', Content: '[name="content"]', Desc: '[name="mota"]' }`,
      html: '<input name="name"><textarea name="content"></textarea><textarea name="mota"></textarea>' +
        '<input name="name[vi]" value="Giữ tiêu đề cũ"><textarea name="content[vi]">Giữ nội dung cũ</textarea>',
      verify: async page => {
        assert.equal(await page.locator('[name="name"]').inputValue(), article.Title);
        assert.equal(await page.locator('[name="content"]').inputValue(), article.Content);
        assert.equal(await page.locator('[name="mota"]').inputValue(), article.Desc);
        assert.equal(await page.locator('[name="name[vi]"]').inputValue(), 'Giữ tiêu đề cũ');
        assert.equal(await page.locator('[name="content[vi]"]').inputValue(), 'Giữ nội dung cũ');
      },
    },
    {
      name: 'the page mapping takes priority over the shared layout mapping',
      fields: `{ Title: '[name="name[vi]"]', Content: '[name="content[vi]"]' }`,
      pageFields: { Title: '[name="ten"]', Content: '[name="noidung"]', Desc: '[name="mota"]' },
      html: '<input name="ten"><textarea name="noidung"></textarea><textarea name="mota"></textarea>' +
        '<input name="name[vi]" value="Giữ tiêu đề cũ"><textarea name="content[vi]">Giữ nội dung cũ</textarea>',
      verify: async page => {
        assert.equal(await page.locator('[name="ten"]').inputValue(), article.Title);
        assert.equal(await page.locator('[name="noidung"]').inputValue(), article.Content);
        assert.equal(await page.locator('[name="mota"]').inputValue(), article.Desc);
        assert.equal(await page.locator('[name="name[vi]"]').inputValue(), 'Giữ tiêu đề cũ');
        assert.equal(await page.locator('[name="content[vi]"]').inputValue(), 'Giữ nội dung cũ');
      },
    },
    {
      name: 'ten, noidung and mota selectors read and write CKEditor instances',
      fields: `{ Title: '[name="ten"]', Content: '[name="noidung"]', Desc: '[name="mota"]' }`,
      html: '<input name="ten"><textarea id="body-editor" name="noidung"></textarea><textarea id="summary-editor" name="mota"></textarea>',
      setup: `window.CKEDITOR = { instances: Object.fromEntries(['body-editor', 'summary-editor'].map(id => [id, {
        data: '<p>Nội dung editor đã có</p>',
        getData() { return this.data; },
        setData(value, options) { this.data = value; options.callback.call(this); },
        updateElement() { const element = document.getElementById(id); element.value = this.data; element.dataset.editorUpdated = 'yes'; },
      }])) };`,
      confirms: 1,
      verify: async page => {
        assert.equal(await page.locator('[name="ten"]').inputValue(), article.Title);
        assert.equal(await page.locator('[name="noidung"]').inputValue(), article.Content);
        assert.equal(await page.locator('[name="mota"]').inputValue(), article.Desc);
        assert.equal(await page.locator('#body-editor').getAttribute('data-editor-updated'), 'yes');
        assert.equal(await page.locator('#summary-editor').getAttribute('data-editor-updated'), 'yes');
      },
    },
    {
      name: 'custom selectors support the language placeholder',
      fields: `{ Title: '[name="ten[$lang]"]', Content: '[name="noidung[$lang]"]', Desc: '[name="mota[$lang]"]' }`,
      html: '<input name="ten[vi]"><textarea name="noidung[vi]"></textarea><textarea name="mota[vi]"></textarea>',
      verify: async page => {
        assert.equal(await page.locator('[name="ten[vi]"]').inputValue(), article.Title);
        assert.equal(await page.locator('[name="noidung[vi]"]').inputValue(), article.Content);
        assert.equal(await page.locator('[name="mota[vi]"]').inputValue(), article.Desc);
      },
    },
    {
      name: 'explicit editor callbacks keep their read and write behavior',
      fields: `{ Title: '[name="ten"]', Content: { selector: '#custom-editor',
        getValue: element => element.dataset.content,
        setValue: (element, value) => { element.dataset.content = value; element.dataset.customWrite = 'yes'; },
      } }`,
      html: '<input name="ten"><div id="custom-editor" data-content="Nội dung cũ trong editor"></div>',
      confirms: 1,
      verify: async page => {
        assert.equal(await page.locator('[name="ten"]').inputValue(), article.Title);
        assert.equal(await page.locator('#custom-editor').getAttribute('data-content'), article.Content);
        assert.equal(await page.locator('#custom-editor').getAttribute('data-custom-write'), 'yes');
      },
    },
    {
      name: 'a title-only mapping does not write other form fields',
      fields: `{ Title: '[name="ten"]' }`,
      html: '<input name="ten"><textarea name="content[vi]">Giữ nội dung cũ</textarea><textarea name="desc[vi]">Giữ mô tả cũ</textarea>',
      verify: async page => {
        assert.equal(await page.locator('[name="ten"]').inputValue(), article.Title);
        assert.equal(await page.locator('[name="content[vi]"]').inputValue(), 'Giữ nội dung cũ');
        assert.equal(await page.locator('[name="desc[vi]"]').inputValue(), 'Giữ mô tả cũ');
      },
    },
  ];
  const browser = await chromium.launch();
  try {
    for (const scenario of cases) await t.test(scenario.name, async () => {
      const page = await browser.newPage();
      page.setDefaultTimeout(8000);
      const errors: string[] = [];
      let confirms = 0;
      let writes = 0;
      page.on('pageerror', error => errors.push(error.message));
      page.on('dialog', async dialog => { confirms++; await dialog.accept(); });
      const configScript = script.replace(/const AIConfig = \{[\s\S]*?\n    \};/, `const AIConfig = {
        mount: '#news-ai-writer', form: '#news-main-form', languages: { source: 'vi', targets: [] },
        endpoint: '/preview', keyMode: 'service', models: [{ value: 'test', label: 'Test' }], fields: ${scenario.fields},
    };`);
      assert.notEqual(configScript, script, 'The fixture configures the public AIConfig.fields property');
      try {
        await page.route('**/*', async route => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== 'http://localhost:3255') { errors.push(`Unexpected origin ${url.origin}`); return route.abort(); }
          if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body:
            '<!doctype html><meta charset="utf-8"><meta name="csrf-token" content="fixture-fields-csrf"><form id="news-main-form">' + scenario.html +
            `<span id="news-ai-writer"${scenario.pageFields ? ` data-fields='${JSON.stringify(scenario.pageFields)}'` : ''}></span></form>` +
            `<script>${scenario.setup ?? ''}</script><script src="/widget.js" data-credentials-url="/credentials"></script><script>${configScript}</script>`,
          });
          if (url.pathname === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
          if (url.pathname === '/credentials') return route.fulfill({ json: { base_url: null, api_key: null, model: null } });
          if (url.pathname === '/preview' && request.method() === 'POST') {
            writes++;
            assert.equal(request.postDataJSON().locale, 'vi');
            return route.fulfill({ json: { job_id: 'custom-fields-job', status: 'ready', result: [article] } });
          }
          if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
          errors.push(`Unexpected request ${request.method()} ${url.pathname}`);
          return route.abort();
        });
        await page.goto('http://localhost:3255/');
        await page.getByRole('button', { name: 'Viết bài AI' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByLabel('Từ khóa', { exact: true }).fill('bài viết');
        await dialog.getByRole('button', { name: 'Viết ngay', exact: true }).click();
        await dialog.getByRole('heading', { name: article.Title, exact: true }).waitFor();
        await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await scenario.verify(page);
        assert.equal(writes, 1);
        assert.equal(confirms, scenario.confirms ?? 0);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  } finally { await browser.close(); }
});
