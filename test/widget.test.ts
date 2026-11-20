import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { test } from 'node:test';

test('Laravel widget previews, validates selectors, and applies fields with editor support', async () => {
  const { outputFiles } = await build({
    entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
  });
  const origin = 'http://localhost:3220';
  const jobId = 'aa9a15c2-61f0-4cb4-9956-f96dcf560ee0';
  const article = {
    Title: 'Cách chọn máy lọc nước', Content: '<p>Chọn theo nguồn nước.</p><img src="untrusted" onerror="alert(1)">',
    Slug: 'cach-chon-may-loc-nuoc', Desc: 'Mô tả', Desction: 'Mô tả SEO',
    'Từ khóa': ['máy lọc nước', 'nguồn nước'],
  };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const posts: unknown[] = [];
    const keys: string[] = [];
    let catalogReads = 0;
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/') return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
          <meta name="csrf-token" content="laravel-csrf"><form id="article"><input name="title" value="Bản nháp">
          <div name="body"></div><input name="keywords"><div id="tools"></div></form>
          <script src="/widget/v1/ai-writer.js"></script>
          <script>
          window.mapping = { Title: '[name="title"]', Slug: '#missing', 'Từ khóa': '[name="keywords"]',
            Content: { selector: '[name="body"]', setValue: (element, value) => { element.dataset.html = value } } };
          window.AIWriter.mount({ mount: '#tools', form: '#article', endpoint: '/admin/ai/previews', fields: window.mapping,
            modelsEndpoint: location.search ? '/admin/ai/models' : undefined,
            models: [{ value: 'gpt-4.1', label: 'GPT-4.1' }] });
          </script>`,
      });
      if (path === '/widget/v1/ai-writer.js') {
        return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
      }
      if (path === '/admin/ai/models') {
        assert.equal(request.method(), 'GET');
        assert.equal(request.headers().authorization, undefined);
        catalogReads++;
        if (catalogReads === 2) return route.fulfill({ status: 503, json: {} });
        const data = catalogReads === 3 ? [{ provider: 'anthropic', model: 'claude-test', display_name: 'Claude biên tập' }] : [];
        return route.fulfill({ json: { data } });
      }
      if (path === '/admin/ai/previews' && request.method() === 'POST') {
        const headers = request.headers();
        assert.equal(headers['x-csrf-token'], 'laravel-csrf');
        keys.push(headers['idempotency-key']);
        posts.push(request.postDataJSON());
        return route.fulfill({ status: 202, json: { job_id: jobId, status: 'queued' } });
      }
      if (path === '/admin/ai/previews/' + jobId) {
        return route.fulfill({ json: { job_id: jobId, status: 'ready', result: [article] } });
      }
      return route.abort();
    });
    const launch = page.getByRole('button', { name: 'Viết bài AI' });
    const dialog = page.getByRole('dialog');
    const accept = dialog.getByRole('button', { name: 'Chấp nhận' });
    const waitForPreview = () => dialog.getByRole('heading', { name: article.Title }).waitFor();
    await page.goto(origin);
    await launch.click();
    await dialog.getByLabel('Từ khóa').fill(article['Từ khóa'][0]);
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await waitForPreview();
    assert.equal(await dialog.locator('img').count(), 0);
    await dialog.getByRole('button', { name: 'Đóng', exact: true }).last().click();
    assert.equal(await page.locator('[name="title"]').inputValue(), 'Bản nháp');

    await launch.click();
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await waitForPreview();
    await accept.click();
    await dialog.getByText('Selector #missing cần khớp đúng một phần tử.').waitFor();
    assert.equal(await page.locator('[name="title"]').inputValue(), 'Bản nháp');
    await page.evaluate(() => {
      const mapping = (window as unknown as { mapping: Record<string, unknown> }).mapping;
      delete mapping.Slug;
    });
    await accept.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[name="title"]').inputValue(), article.Title);
    assert.equal(await page.locator('[name="keywords"]').inputValue(), article['Từ khóa'].join(', '));
    assert.equal(await page.locator('[name="body"]').getAttribute('data-html'), '<p>Chọn theo nguồn nước.</p>');
    assert.equal(posts.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.deepEqual(posts[0], {
      model: 'gpt-4.1', keyword: article['Từ khóa'][0], tone: 'Thân thiện', style: 'Hướng dẫn', length: 800,
    });

    await page.goto(origin + '/?catalog=1');
    const modelMenu = dialog.getByRole('combobox', { name: 'Model' });
    const write = dialog.getByRole('button', { name: 'Viết ngay' });
    const close = dialog.getByRole('button', { name: 'Đóng', exact: true }).first();
    for (const text of ['Website chưa có model được cấp.', 'Tải model thất bại. Đóng rồi mở lại để thử.']) {
      await launch.click();
      await modelMenu.getByText(text).waitFor({ state: 'attached' });
      assert.equal(await write.isDisabled(), true);
      assert.equal(await dialog.locator('input[name="model"]').count(), 0);
      await close.click();
    }
    await launch.click();
    await modelMenu.getByText('Claude biên tập').waitFor({ state: 'attached' });
    assert.equal(await modelMenu.inputValue(), 'claude-test');
    await dialog.getByLabel('Từ khóa').fill('Cà phê');
    await write.click();
    await dialog.getByText('Yêu cầu đang chờ xử lý…').waitFor();
    await close.click();
    // Removing a model while a job is queued still lets the editor read the accepted job.
    await launch.click();
    await waitForPreview();
    assert.equal(catalogReads, 4);
    assert.equal(posts.length, 3);
    assert.equal((posts[2] as { model: string }).model, 'claude-test');
  } finally {
    await browser.close();
  }
});

test('Laravel widget preserves safe inline table CSS in previews and applied HTML', async () => {
  const { outputFiles } = await build({
    entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
  });
  const origin = 'http://localhost:3222';
  const jobId = 'd03ef196-a1dd-4e1a-8c7a-7fcd22bd4f29';
  const article = {
    Title: 'Bảng so sánh máy lọc nước',
    Content: '<p style="color:#111827;position:fixed;top:0" onclick="window.__unsafe=true">Chọn theo nhu cầu.</p>' +
      '<table style="width:100%;border-collapse:collapse;background-image:url(https://unsafe.invalid/track)">' +
      '<thead><tr style="background-color:#f1f5f9;position:absolute"><th scope="col" colspan="2" style="padding:12px;border:1px solid #ddd;text-align:left">Tiêu chí</th></tr></thead>' +
      '<tbody><tr style="background-color:#fff"><td rowspan="2" style="padding:12px;border:1px solid #ddd;color:expression(alert(1));background:url(javascript:alert(1))" onmouseover="window.__unsafe=true">Nguồn nước</td>' +
      '<td style="position:fixed;behavior:url(https://unsafe.invalid/run)">Nước máy</td></tr><tr><td>Giếng khoan</td></tr></tbody></table>' +
      '<a href="javascript:alert(1)" onclick="window.__unsafe=true">Liên kết</a>' +
      '<script>window.__unsafe=true</script><style>body{display:none}</style><img src="https://unsafe.invalid/image"><iframe src="https://unsafe.invalid/frame"></iframe>',
    Slug: 'bang-so-sanh-may-loc-nuoc', Desc: 'Tóm tắt', Desction: 'Mô tả SEO', 'Từ khóa': ['máy lọc nước'],
  };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const externalRequests: string[] = [];
    await page.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) {
        externalRequests.push(request.url());
        return route.abort();
      }
      if (url.pathname === '/') return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><meta name="csrf-token" content="fixture-csrf">' +
          '<form id="article"><div name="body"></div><div id="tools"></div></form>' +
          '<script src="/widget.js"></script><script>AIWriter.mount({' +
          'mount:"#tools",form:"#article",endpoint:"/admin/ai/previews",' +
          'models:[{value:"model-test",label:"Model kiểm thử"}],' +
          'fields:{Content:{selector:"[name=body]",setValue:(element,value)=>{element.dataset.html=value}}}' +
          '});</script>',
      });
      if (url.pathname === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
      if (url.pathname === '/admin/ai/previews' && request.method() === 'POST') return route.fulfill({ status: 202, json: { job_id: jobId, status: 'queued' } });
      if (url.pathname === `/admin/ai/previews/${jobId}`) return route.fulfill({ json: { job_id: jobId, status: 'ready', result: [article] } });
      if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
      return route.abort();
    });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Viết bài AI' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Từ khóa').fill('máy lọc nước');
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await dialog.getByRole('heading', { name: article.Title }).waitFor();
    const preview = dialog.locator('article.body');
    assert.equal(await preview.locator('script,style,img,iframe').count(), 0);
    assert.equal(await preview.locator('[onclick],[onmouseover]').count(), 0);
    assert.equal(await preview.locator('table').evaluate(element => (element as HTMLElement).style.width), '100%');
    assert.equal(await preview.locator('table').evaluate(element => (element as HTMLElement).style.borderCollapse), 'collapse');
    assert.equal(await preview.locator('thead tr').evaluate(element => (element as HTMLElement).style.backgroundColor), 'rgb(241, 245, 249)');
    assert.equal(await preview.locator('th').evaluate(element => (element as HTMLElement).style.padding), '12px');
    assert.equal(await preview.locator('th').evaluate(element => (element as HTMLElement).style.textAlign), 'left');
    assert.equal(await preview.locator('th').getAttribute('scope'), 'col');
    assert.equal(await preview.locator('th').getAttribute('colspan'), '2');
    assert.equal(await preview.locator('td').first().getAttribute('rowspan'), '2');
    assert.equal(await preview.locator('td').first().evaluate(element => (element as HTMLElement).style.padding), '12px');
    assert.equal(await preview.locator('td').nth(1).getAttribute('style'), null, 'remove the attribute if no safe CSS declaration remains');
    assert.equal(await preview.locator('a').getAttribute('href'), null);
    const sanitizedHtml = await preview.innerHTML();
    assert.doesNotMatch(sanitizedHtml, /url\s*\(|expression\s*\(|position\s*:|behavior\s*:|javascript:/i);
    await dialog.getByRole('button', { name: 'Chấp nhận' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[name="body"]').getAttribute('data-html'), sanitizedHtml);
    assert.equal(await page.evaluate(() => '__unsafe' in window), false);
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser.close();
  }
});
