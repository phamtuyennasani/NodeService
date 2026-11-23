import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { test } from 'node:test';
import { evaluateSeo } from '../src/worker/seo';

test('widget shows the saved CRM SEO report and applies the original focus keyword separately from related terms', async () => {
  const { outputFiles } = await build({
    entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
  });
  const origin = 'http://localhost:3223';
  const keyword = 'máy lọc nước gia đình';
  const typedKeyword = 'máy lọc nước';
  const article = {
    Title: 'Lựa chọn thiết bị theo chất lượng nước', Content: '<p>Đánh giá nguồn nước và chi phí bảo trì.</p>',
    Slug: 'lua-chon-thiet-bi', Desc: 'Tóm tắt.', Description: 'Mô tả SEO.', Keywords: ['nguồn nước', 'lõi lọc'],
  };
  let report = evaluateSeo(article, { keyword, siteUrl: origin });
  const warning = report.findings.find(finding => finding.applicable && !finding.passed)!;
  warning.message = '<img src=x onerror=alert(1)> Cần bổ sung từ khóa chính.';
  report.warnings = report.findings.filter(finding => finding.applicable && !finding.passed);
  let includeMetadata = true;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><meta charset="utf-8"><meta name="csrf-token" content="fixture-csrf">' +
        '<form id="article"><input name="focus_keyword"><input name="keywords"><div id="tools"></div></form>' +
        '<script src="/widget.js"></script><script>AIWriter.mount({' +
        'mount:"#tools",form:"#article",endpoint:"/admin/ai/previews",models:[{value:"model-test",label:"Model kiểm thử"}],' +
        'fields:{FocusKeyword:"[name=focus_keyword]",Keywords:"[name=keywords]"}});</script>',
      });
      if (path === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
      if (path === '/admin/ai/previews') return route.fulfill({ json: {
        job_id: 'seo-widget-job', status: 'ready', result: [article],
        ...(includeMetadata ? { keyword, seo_report: report, seo_repair_status: 'kept_draft' } : {}),
      } });
      return route.fulfill({ status: 204 });
    });
    await page.goto(origin);
    const dialog = page.getByRole('dialog');
    const launch = page.getByRole('button', { name: 'Viết bài AI' });
    await launch.click();
    await dialog.getByLabel('Từ khóa', { exact: true }).fill(typedKeyword);
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    const seo = dialog.getByRole('region', { name: 'Kết quả kiểm tra SEO từ CRM' });
    const assertSeoCounts = async () => {
      const excluded = report.findings.filter(finding => !finding.applicable).length;
      assert.equal(await seo.locator('.seo-summary').textContent(), `${report.score}/100 điểm tiêu chí nội bộ · ${report.passed}/${report.applicable} tiêu chí đạt · ${report.warnings.length} tiêu chí cần xem lại.`);
      assert.equal(await seo.locator('summary').textContent(), `Xem ${report.findings.length} tiêu chí SEO (${report.applicable} áp dụng, ${excluded} chưa áp dụng)`);
      await seo.locator('summary').click();
      assert.equal(await seo.locator('li').count(), report.findings.length);
      assert.equal(await seo.locator('li[data-state="passed"]').count(), report.passed);
      assert.equal(await seo.locator('li[data-state="warning"]').count(), report.warnings.length);
      assert.equal(await seo.locator('li[data-state="excluded"]').count(), excluded);
      assert.equal(report.findings.length, report.applicable + excluded);
      assert.equal(report.applicable, report.passed + report.warnings.length);
      assert.match(await seo.innerText(), /Tiêu chí chưa áp dụng không tính vào điểm\./);
    };
    await seo.waitFor();
    assert.equal(report.applicable, 15);
    await assertSeoCounts();
    assert.match(await seo.locator('.seo-repair').innerText(), /CRM giữ lại bản nháp/);
    const warningRow = seo.locator('li').filter({ hasText: warning.message });
    assert.equal(await warningRow.count(), 1);
    assert.equal(await warningRow.getAttribute('data-state'), 'warning');
    assert.equal(await seo.locator('img,script').count(), 0, 'CRM finding messages render as text');
    assert.ok(await seo.locator('li[data-state="excluded"]').count() > 0, 'nonapplicable findings stay excluded');
    await dialog.getByRole('button', { name: 'Chấp nhận' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[name=focus_keyword]').inputValue(), keyword);
    assert.equal(await page.locator('[name=keywords]').inputValue(), article.Keywords.join(', '));

    report = evaluateSeo(article, { keyword });
    await launch.click();
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await seo.waitFor();
    assert.equal(report.applicable, 14, 'missing website context excludes the internal-link check too');
    if (await seo.locator('details').getAttribute('open') !== null) await seo.locator('summary').click();
    await assertSeoCounts();
    await dialog.getByRole('button', { name: 'Chấp nhận' }).click();
    await dialog.waitFor({ state: 'hidden' });

    includeMetadata = false;
    await launch.click();
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await dialog.getByRole('heading', { name: article.Title }).waitFor();
    assert.equal(await seo.isVisible(), false, 'older adapters do not show a stale report');
    await dialog.getByRole('button', { name: 'Chấp nhận' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[name=focus_keyword]').inputValue(), typedKeyword, 'older adapters retain the submitted keyword');
  } finally {
    await browser.close();
  }
});

test('widget forwards optional CRM instructions with editable defaults and the same 4000-character limit', async () => {
  const { outputFiles } = await build({
    entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
  });
  const origin = 'http://localhost:3224';
  const instructions = '  Giữ giọng "chuyên gia".\nThêm <strong>bảng so sánh</strong>.  ';
  const article = {
    Title: 'Bài viết theo hướng dẫn', Content: '<p>Nội dung từ CRM.</p>', Slug: 'bai-viet-theo-huong-dan',
    Desc: 'Tóm tắt.', Description: 'Mô tả SEO.', Keywords: ['máy lọc nước'],
  };
  const posts: Record<string, unknown>[] = [];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><meta charset="utf-8"><meta name="csrf-token" content="fixture-csrf">' +
        '<form id="article"><input name="title"><div id="tools"></div></form>' +
        '<script src="/widget.js"></script><script>AIWriter.mount(' + JSON.stringify({
          mount: '#tools', form: '#article', endpoint: '/admin/ai/previews',
          models: [{ value: 'model-test', label: 'Model kiểm thử' }],
          fields: { Title: '[name=title]' }, defaults: { instructions },
        }) + ');</script>',
      });
      if (path === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
      if (path === '/admin/ai/previews' && request.method() === 'POST') {
        posts.push(request.postDataJSON() as Record<string, unknown>);
        return route.fulfill({ json: { job_id: `instructions-${posts.length}`, status: 'ready', result: [article] } });
      }
      return route.fulfill({ status: 204 });
    });
    await page.goto(origin);
    const launch = page.getByRole('button', { name: 'Viết bài AI' });
    const dialog = page.getByRole('dialog');
    await launch.click();
    const input = dialog.getByLabel('Hướng dẫn thêm');
    assert.equal(await input.inputValue(), instructions);
    assert.equal(await input.getAttribute('maxlength'), '4000');
    assert.equal(await input.getAttribute('required'), null);
    assert.equal(await dialog.locator('textarea strong').count(), 0, 'default instructions are assigned as text');
    await dialog.getByLabel('Từ khóa', { exact: true }).fill('máy lọc nước');
    const write = dialog.getByRole('button', { name: 'Viết ngay' });
    const waitForPreview = () => dialog.getByRole('heading', { name: article.Title }).waitFor();
    const reopen = async () => {
      await dialog.getByRole('button', { name: 'Đóng', exact: true }).last().click();
      await dialog.waitFor({ state: 'hidden' });
      await launch.click();
    };
    await write.click();
    await waitForPreview();
    assert.equal(posts[0].instructions, instructions.trim());
    await reopen();
    const edited = 'Phân tích theo ngân sách.\nNêu ưu và nhược điểm cho từng lựa chọn.';
    await input.fill(`  ${edited}\n`);
    await write.click();
    await waitForPreview();
    assert.equal(posts[1].instructions, edited);
    await reopen();
    await input.fill('  \n  ');
    await write.click();
    await waitForPreview();
    assert.equal(Object.hasOwn(posts[2], 'instructions'), false, 'blank optional instructions do not block submission');
    await reopen();
    await input.fill('a'.repeat(4000));
    await write.click();
    await waitForPreview();
    assert.equal((posts[3].instructions as string).length, 4000);
    await reopen();
    await input.evaluate(element => { (element as HTMLTextAreaElement).value = 'a'.repeat(4001); });
    await dialog.locator('form').dispatchEvent('submit');
    await dialog.getByRole('status').getByText('Hướng dẫn thêm không được vượt quá 4.000 ký tự.').waitFor();
    assert.equal(posts.length, 4, 'oversized programmatic/default values are rejected before POST');
  } finally {
    await browser.close();
  }
});

test('Laravel widget previews, validates selectors, and applies fields with editor support', async () => {
  const { outputFiles } = await build({
    entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
  });
  const origin = 'http://localhost:3220';
  const jobId = 'aa9a15c2-61f0-4cb4-9956-f96dcf560ee0';
  const article = {
    Title: 'Cách chọn máy lọc nước', Content: '<p>Chọn theo nguồn nước.</p><img src="untrusted" onerror="alert(1)">',
    Slug: 'cach-chon-may-loc-nuoc', Desc: 'Mô tả', Description: 'Mô tả SEO',
    Keywords: ['máy lọc nước', 'nguồn nước'],
  };
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const posts: unknown[] = [];
    const keys: string[] = [];
    const { Description, Keywords, ...legacyArticle } = article;
    let previewArticle: object = article;
    let catalogReads = 0;
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/') return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
          <meta name="csrf-token" content="laravel-csrf"><form id="article"><input name="title" value="Bản nháp">
          <div name="body"></div><input name="keywords"><input name="legacy-keywords" value="Từ khóa cũ">
          <input name="description"><div name="legacy-description"></div><div id="tools"></div></form>
          <script src="/widget/v1/ai-writer.js"></script>
          <script>
          const legacy = { Desction: { selector: '[name="legacy-description"]', setValue: async (element, value) => { element.textContent = value } },
            'Từ khóa': '[name="legacy-keywords"]' };
          window.mapping = new URLSearchParams(location.search).has('legacy') ? legacy : { ...legacy,
            Title: '[name="title"]', Slug: '#missing', Description: '[name="description"]', Keywords: '[name="keywords"]',
            Content: { selector: '[name="body"]', setValue: (element, value) => { element.dataset.html = value } } };
          window.AIWriter.mount({ mount: '#tools', form: '#article', endpoint: '/admin/ai/previews', keyMode: 'service', provider: 'leak-provider', api_key: 'leak-key', fields: window.mapping,
            modelsEndpoint: new URLSearchParams(location.search).has('catalog') ? '/admin/ai/models' : undefined,
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
        return route.fulfill({ json: { job_id: jobId, status: 'ready', result: [previewArticle] } });
      }
      return route.abort();
    });
    const launch = page.getByRole('button', { name: 'Viết bài AI' });
    const dialog = page.getByRole('dialog');
    const accept = dialog.getByRole('button', { name: 'Chấp nhận' });
    const waitForPreview = () => dialog.getByRole('heading', { name: article.Title }).waitFor();
    await page.goto(origin);
    previewArticle = { ...article, Desction: 'Mô tả từ trường cũ', 'Từ khóa': ['từ khóa từ trường cũ'] };
    await launch.click();
    await dialog.getByLabel('Từ khóa').fill(article.Keywords[0]);
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await waitForPreview();
    assert.equal(await dialog.locator('img').count(), 0);
    await dialog.getByRole('button', { name: 'Đóng', exact: true }).last().click();
    assert.equal(await page.locator('[name="title"]').inputValue(), 'Bản nháp');

    await launch.click();
    await dialog.getByLabel('Sử dụng dữ liệu tìm kiếm để hỗ trợ viết bài').uncheck();
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
    assert.equal(await page.locator('[name="description"]').inputValue(), Description);
    assert.equal(await page.locator('[name="keywords"]').inputValue(), article.Keywords.join(', '));
    assert.equal(await page.locator('[name="legacy-description"]').textContent(), '');
    assert.equal(await page.locator('[name="legacy-keywords"]').inputValue(), 'Từ khóa cũ');
    assert.equal(await page.locator('[name="body"]').getAttribute('data-html'), '<p>Chọn theo nguồn nước.</p>');
    assert.equal(posts.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.deepEqual(posts[0], {
      model: 'gpt-4.1', keyword: article.Keywords[0], tone: 'Thân thiện', style: 'Hướng dẫn', length: 800, use_research: true,
    });
    assert.equal((posts[1] as { use_research: boolean }).use_research, false);
    assert.equal('api_key' in (posts[0] as object), false);

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
    assert.equal(await close.isDisabled(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true, 'writing keeps the dialog open');
    await waitForPreview();
    assert.equal(await close.isDisabled(), false);
    assert.equal(catalogReads, 3);
    assert.equal(posts.length, 3);
    assert.equal((posts[2] as { model: string }).model, 'claude-test');
    assert.equal('api_key' in (posts[2] as object), false);

    previewArticle = { ...legacyArticle, Desction: Description, 'Từ khóa': Keywords };
    await page.goto(origin + '/?legacy=1');
    await launch.click();
    await dialog.getByLabel('Từ khóa').fill(Keywords[0]);
    await write.click();
    await waitForPreview();
    await accept.click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[name="legacy-description"]').textContent(), Description);
    assert.equal(await page.locator('[name="legacy-keywords"]').inputValue(), Keywords.join(', '));
  } finally {
    await browser.close();
  }
});

test('Laravel widget preserves complete long articles and safe inline table CSS through preview and apply', async () => {
  const { outputFiles } = await build({
    entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
  });
  const origin = 'http://localhost:3222';
  const jobId = 'd03ef196-a1dd-4e1a-8c7a-7fcd22bd4f29';
  const sections = Array.from({ length: 8 }, (_, index) =>
    `<h2>Phần ${index + 1}: Đánh giá giải pháp lọc nước</h2>` +
    Array.from({ length: 5 }, () => '<p>Gia đình cần đánh giá nguồn nước đầu vào, công suất sử dụng, diện tích lắp đặt và chi phí thay lõi trước khi chọn thiết bị. Hãy so sánh thông số kỹ thuật với kết quả kiểm nghiệm, kiểm tra điều kiện bảo hành và lập lịch bảo trì để duy trì chất lượng nước trong suốt quá trình sử dụng.</p>').join('')
  ).join('');
  const ending = '<h2>Câu hỏi thường gặp cuối bài</h2><p>Thời điểm thay lõi phụ thuộc chất lượng nước và hướng dẫn bảo trì.</p>' +
    '<ul><li>Kiểm tra lưu lượng định kỳ.</li><li>Ghi lại lịch thay lõi cuối cùng.</li></ul>';
  const article = {
    Title: 'Bảng so sánh máy lọc nước',
    Content: '<p style="color:#111827;position:fixed;top:0" onclick="window.__unsafe=true">Chọn theo nhu cầu.</p>' +
      '<p><span style="color:#2455d6;position:fixed" onclick="window.__unsafe=true">Nội dung nhấn mạnh an toàn.</span></p>' +
      '<hr style="border-top:1px solid #ddd;position:fixed">' +
      sections +
      '<table style="width:100%;border-collapse:collapse;background-image:url(https://unsafe.invalid/track)">' +
      '<thead><tr style="background-color:#f1f5f9;position:absolute"><th scope="col" colspan="2" style="padding:12px;border:1px solid #ddd;text-align:left">Tiêu chí</th></tr></thead>' +
      '<tbody><tr style="background-color:#fff"><td rowspan="2" style="padding:12px;border:1px solid #ddd;color:expression(alert(1));background:url(javascript:alert(1))" onmouseover="window.__unsafe=true">Nguồn nước</td>' +
      '<td style="position:fixed;behavior:url(https://unsafe.invalid/run)">Nước máy</td></tr><tr><td>Giếng khoan</td></tr></tbody></table>' +
      '<a href="javascript:alert(1)" onclick="window.__unsafe=true">Liên kết</a>' +
      '<script>window.__unsafe=true</script><style>body{display:none}</style><img src="https://unsafe.invalid/image"><iframe src="https://unsafe.invalid/frame"></iframe>' + ending,
    Slug: 'bang-so-sanh-may-loc-nuoc', Desc: 'Tóm tắt', Description: 'Mô tả SEO', Keywords: ['máy lọc nước'],
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
    assert.equal(await preview.locator('span').textContent(), 'Nội dung nhấn mạnh an toàn.');
    assert.equal(await preview.locator('span').evaluate(element => (element as HTMLElement).style.color), 'rgb(36, 85, 214)');
    assert.equal(await preview.locator('hr').count(), 1);
    assert.equal(await preview.locator('hr').evaluate(element => (element as HTMLElement).style.borderTop), '1px solid rgb(221, 221, 221)');
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
    assert.ok(sanitizedHtml.length > 10_000, 'Preview must retain the complete long article');
    assert.ok(sanitizedHtml.includes(sections), 'Preview must retain every section and paragraph');
    assert.ok(sanitizedHtml.endsWith(ending), 'Preview must retain the final FAQ and list');
    assert.equal(await preview.locator('h2').count(), 9);
    await dialog.getByRole('button', { name: 'Chấp nhận' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[name="body"]').getAttribute('data-html'), sanitizedHtml);
    assert.equal(await page.evaluate(() => '__unsafe' in window), false);
    assert.deepEqual(externalRequests, []);
  } finally {
    await browser.close();
  }
});

test('widget sends personal provider credentials only in own-key mode', async () => {
  const { outputFiles } = await build({
    entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
  });
  const origin = 'http://localhost:3221';
  const jobId = '8d3d6a8f-6a2b-4e6f-a00a-8b6fc34b4a9e';
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let payload: Record<string, unknown> | undefined;
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/') return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta name="csrf-token" content="csrf-own"><form id="article"><input name="title"><div name="body"></div><div id="tools"></div></form>' +
          '<script src="/widget.js"></script><script>AIWriter.mount({' +
          'mount:"#tools",form:"#article",endpoint:"/admin/ai/previews",keyMode:"own",provider:"openai",api_key:"sk-test-personal",model:"gpt-4.1-mini",fields:{Title:"[name=title]",Content:"[name=body]"}})</script>',
      });
      if (path === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
      if (path === '/admin/ai/previews' && request.method() === 'POST') {
        payload = request.postDataJSON() as Record<string, unknown>;
        return route.fulfill({ status: 202, json: { job_id: jobId, status: 'queued' } });
      }
      if (path === '/admin/ai/previews/' + jobId) {
        return route.fulfill({ json: { job_id: jobId, status: 'ready', result: [{
          Title: 'Bài thử nghiệm', Content: '<p>Nội dung</p>', Slug: 'bai-thu-nghiem', Desc: 'Mô tả', Description: 'SEO', Keywords: ['thử nghiệm'],
        }] } });
      }
      return route.abort();
    });
    await page.goto(origin);
    const dialog = page.getByRole('dialog');
    await page.getByRole('button', { name: 'Viết bài AI' }).click();
    assert.equal(await dialog.locator('[name="model"]').inputValue(), 'gpt-4.1-mini');
    assert.equal(await dialog.locator('[name="model"]').getAttribute('readonly'), '');
    await dialog.getByLabel('Từ khóa').fill('nội dung thử nghiệm');
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await dialog.getByRole('heading', { name: 'Bài thử nghiệm' }).waitFor();
    assert.deepEqual(payload, {
      provider: 'openai', api_key: 'sk-test-personal', model: 'gpt-4.1-mini', keyword: 'nội dung thử nghiệm',
      tone: 'Thân thiện', style: 'Hướng dẫn', length: 800, use_research: true,
    });
  } finally {
    await browser.close();
  }
});
