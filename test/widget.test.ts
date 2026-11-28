import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { test } from 'node:test';
import { evaluateSeo } from '../src/worker/seo';

test('the Laravel upload example mounts the remote widget, signs its request and fills the article fields', async () => {
  const { outputFiles } = await build({ entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false });
  const guide = JSON.parse(await readFile('web/src/laravel-guide.json', 'utf8'));
  const template = await readFile('integrations/laravel-upload/resources/views/admin/layouts/js.blade.php', 'utf8');
  assert.equal(guide.widget, template, 'CRM instructions use the exact JS file included in the Laravel ZIP');
  assert.doesNotMatch(template, /crm_ai_article_ref|crm_ai_source_job_id|crm_ai_source_locale|articleRef|sourceJobId/);
  const aiConfig = template.split('<script>')[1].split('</script>')[0];
  const origin = 'http://localhost:3251';
  const crm = 'http://localhost:3252';
  const site = '11111111-1111-4111-8111-111111111111';
  const job = '22222222-2222-4222-8222-222222222222';
  const article = { Title: 'Bài có chữ ký', SeoTitle: 'Tiêu đề SEO của bài có chữ ký', Content: '<p>Nội dung</p>', Slug: 'bai', Desc: 'Mô tả', Description: 'SEO', Keywords: ['bài', 'liên quan'] };
  const browser = await chromium.launch();
  const authorized: { body: string, id: string }[] = [];
  let created = 0;
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.href === origin + '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><form id="news-main-form"><input name="_token" value="fixture-csrf" type="hidden"><input name="name[vi]"><input name="seo[title][vi]"><textarea name="content[vi]"></textarea><textarea name="desc[vi]"></textarea><input name="slug[vi]"><input name="seo[description][vi]"><input name="seo[keywords][vi]"><input name="seo[focus_keyword][vi]"><span id="news-ai-writer"></span></form>
        <script src="${crm}/widget/v1/ai-writer.js?site=${site}&expires=${Math.floor(Date.now() / 1000) + 3600}&signature=${'e'.repeat(64)}" data-authorize-url="/crm-ai-upload/authorize" data-credentials-url="/crm-ai-upload/credentials"></script>
        <script src="/js/crm-ai-config.js"></script>` });
      if (url.origin === origin && url.pathname === '/js/crm-ai-config.js') return route.fulfill({ contentType: 'text/javascript', body: aiConfig });
      if (url.origin === origin && url.pathname === '/crm-ai-upload/credentials') {
        return route.fulfill({ json: { base_url: null, api_key: null, model: null } });
      }
      if (url.origin === origin && url.pathname === '/crm-ai-upload/authorize') {
        assert.equal(req.headers()['x-csrf-token'], 'fixture-csrf');
        authorized.push(req.postDataJSON());
        return route.fulfill({ json: { proof: 'fixture-per-request-proof' } });
      }
      const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'content-type,idempotency-key,x-widget-expires,x-widget-signature,x-widget-read-token,x-site-proof', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
      if (req.method() === 'OPTIONS') return route.fulfill({ headers: cors, status: 204 });
      if (url.pathname === '/widget/v1/ai-writer.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
      if (url.pathname.endsWith('/models')) return route.fulfill({ headers: cors, json: { proof_required: true, key_mode: 'service', data: [{ model: 'test-model', display_name: 'Model thử' }] } });
      if (req.method() === 'POST' && url.pathname.endsWith('/previews')) {
        assert.equal(authorized.length, 1);
        assert.equal(req.headers()['x-site-proof'], 'fixture-per-request-proof');
        assert.equal(req.postData(), authorized[0].body);
        assert.equal(req.headers()['idempotency-key'], authorized[0].id);
        created++;
        return route.fulfill({ headers: cors, status: 202, json: { job_id: job, status: 'queued', read_token: 'a'.repeat(64) } });
      }
      if (url.pathname.endsWith('/result')) return route.fulfill({ headers: cors, json: [article] });
      if (url.pathname.endsWith('/' + job)) return route.fulfill({ headers: cors, json: { job_id: job, status: 'ready' } });
      return route.fulfill({ status: 204 });
    });
    await page.goto(origin);
    await page.getByRole('button', { name: 'Viết bài AI' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('select[name="model"] option').filter({ hasText: 'Model thử' }).waitFor({ state: 'attached' });
    assert.equal(await dialog.getByRole('combobox', { name: 'Model' }).inputValue(), 'Model thử');
    await dialog.getByLabel('Từ khóa', { exact: true }).fill('nội dung');
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await dialog.getByRole('heading', { name: article.Title }).waitFor();
    await dialog.getByRole('button', { name: 'Áp dụng' }).click();
    assert.equal(created, 1);
    assert.equal(await page.locator('[name="name[vi]"]').inputValue(), article.Title);
    assert.equal(await page.locator('[name="seo[title][vi]"]').inputValue(), article.SeoTitle);
    assert.equal(await page.locator('[name="content[vi]"]').inputValue(), article.Content);
    assert.equal(await page.locator('[name="desc[vi]"]').inputValue(), article.Desc);
    assert.equal(await page.locator('[name="slug[vi]"]').inputValue(), article.Slug);
    assert.equal(await page.locator('[name="seo[description][vi]"]').inputValue(), article.Description);
    assert.equal(await page.locator('[name="seo[keywords][vi]"]').inputValue(), article.Keywords.join(', '));
    assert.equal(await page.locator('[name="seo[focus_keyword][vi]"]').inputValue(), 'nội dung');
  } finally { await browser.close(); }
});

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
      const excluded = report.findings.filter(finding => !finding.applicable && !finding.advisory).length;
      const advisory = report.findings.filter(finding => finding.advisory).length;
      assert.equal(await seo.locator('.seo-summary').textContent(), `${report.score}/100 điểm tiêu chí nội bộ · ${report.passed}/${report.applicable} tiêu chí đạt · ${report.warnings.length} tiêu chí cần xem lại.`);
      assert.equal(await seo.locator('.seo-details-label').textContent(), `${report.findings.length} tiêu chí SEO (${report.applicable} áp dụng, ${excluded} chưa áp dụng${advisory ? `, ${advisory} tham khảo` : ''})`);
      assert.equal(await seo.locator('details').getAttribute('open'), null, 'SEO details start collapsed for each new result');
      assert.equal(await seo.locator('.seo-overview').isVisible(), true, 'SEO score remains visible while details are collapsed');
      await seo.locator('summary').click();
      assert.equal(await seo.locator('li').count(), report.findings.length);
      assert.equal(await seo.locator('li[data-state="passed"]').count(), report.passed);
      assert.equal(await seo.locator('li[data-state="warning"]').count(), report.warnings.length);
      assert.equal(await seo.locator('li[data-state="excluded"]').count(), excluded + advisory);
      assert.equal(report.findings.length, report.applicable + excluded + advisory);
      assert.equal(report.applicable, report.passed + report.warnings.length);
      assert.match(await seo.innerText(), /Tiêu chí chưa áp dụng không tính vào điểm\./);
    };
    await seo.waitFor();
    assert.equal(await dialog.locator('.metadata').isVisible(), false, 'article metadata starts collapsed');
    const articleBounds = await dialog.locator('.body').boundingBox();
    assert.ok(articleBounds && articleBounds.height > 300, 'article preview keeps useful reading space on mobile');
    await dialog.locator('.metadata-details > summary').click();
    assert.equal(await dialog.locator('.metadata').isVisible(), true);
    await dialog.locator('.metadata-details > summary').click();
    assert.equal(report.applicable, 6);
    await assertSeoCounts();
    assert.match(await seo.locator('.seo-repair').innerText(), /CRM giữ lại bản nháp/);
    const warningRow = seo.locator('li').filter({ hasText: warning.message });
    assert.equal(await warningRow.count(), 1);
    assert.equal(await warningRow.getAttribute('data-state'), 'warning');
    assert.equal(await seo.locator('img,script').count(), 0, 'CRM finding messages render as text');
    assert.ok(await seo.locator('li[data-state="excluded"]').count() > 0, 'nonapplicable findings stay excluded');
    await dialog.getByRole('button', { name: 'Áp dụng' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('[name=focus_keyword]').inputValue(), keyword);
    assert.equal(await page.locator('[name=keywords]').inputValue(), article.Keywords.join(', '));

    report = evaluateSeo(article, { keyword });
    await launch.click();
    await dialog.getByLabel('Từ khóa', { exact: true }).fill(typedKeyword);
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await seo.waitFor();
    assert.equal(report.applicable, 6, 'internal-link presence remains advisory with or without website context');
    await assertSeoCounts();
    await dialog.getByRole('button', { name: 'Áp dụng' }).click();
    await dialog.waitFor({ state: 'hidden' });

    includeMetadata = false;
    await launch.click();
    await dialog.getByLabel('Từ khóa', { exact: true }).fill(typedKeyword);
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await dialog.getByRole('heading', { name: article.Title }).waitFor();
    assert.equal(await seo.isVisible(), false, 'older adapters do not show a stale report');
    await dialog.getByRole('button', { name: 'Áp dụng' }).click();
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
    const accept = dialog.getByRole('button', { name: 'Áp dụng' });
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
      await dialog.locator('select[name="model"] option').filter({ hasText: text }).waitFor({ state: 'attached' });
      assert.equal(await modelMenu.inputValue(), text);
      assert.equal(await modelMenu.isDisabled(), true);
      assert.equal(await write.isDisabled(), true);
      assert.equal(await dialog.locator('input[name="model"]').count(), 0);
      await close.click();
    }
    await launch.click();
    await dialog.locator('select[name="model"] option').filter({ hasText: 'Claude biên tập' }).waitFor({ state: 'attached' });
    assert.equal(await modelMenu.inputValue(), 'Claude biên tập');
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
    await dialog.getByRole('button', { name: 'Áp dụng' }).click();
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
          'mount:"#tools",form:"#article",endpoint:"/admin/ai/previews",keyMode:"own",base_url:"https://personal-ai.example.com/v1",api_key:"sk-test-personal",model:"gpt-4.1-mini",fields:{Title:"[name=title]",Content:"[name=body]"}})</script>',
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
    assert.equal(await dialog.locator('.model-label').isVisible(), false, 'personal model is configured rather than selectable');
    await dialog.getByLabel('Từ khóa').fill('nội dung thử nghiệm');
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await dialog.getByRole('heading', { name: 'Bài thử nghiệm' }).waitFor();
    assert.deepEqual(payload, {
      provider: 'openai-compatible', base_url: 'https://personal-ai.example.com/v1', api_key: 'sk-test-personal', model: 'gpt-4.1-mini', keyword: 'nội dung thử nghiệm',
      tone: 'Thân thiện', style: 'Hướng dẫn', length: 800, use_research: true,
    });
  } finally {
    await browser.close();
  }
});

test('widget uses CRM key mode on every open and hides personal models and incomplete configuration', async () => {
  const { outputFiles } = await build({
    entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
  });
  const origin = 'http://localhost:3232';
  let catalog: Record<string, unknown> = { key_mode: 'own', own_key_configured: false, model: null, data: [] };
  let fail = false;
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  const posts: Record<string, unknown>[] = [];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body:
        '<!doctype html><meta charset="utf-8"><meta name="csrf-token" content="fixture-csrf">' +
        '<form id="article"><input name="title"><div id="tools"></div></form><script src="/widget.js"></script>' +
        '<script>AIWriter.mount({mount:"#tools",form:"#article",endpoint:"/admin/ai/previews",' +
        'modelsEndpoint:"/admin/ai/models",keyMode:"service",fields:{Title:"[name=title]"}});</script>',
      });
      if (path === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
      if (path === '/admin/ai/models') {
        if (gate) await gate;
        return route.fulfill(fail ? { status: 502, json: {} } : { json: catalog });
      }
      if (path === '/admin/ai/previews' && request.method() === 'POST') {
        posts.push(request.postDataJSON());
        return route.fulfill({ json: { job_id: 'mode-fixture', status: 'ready', result: [{
          Title: 'Bài thử', Content: '<p>Nội dung</p>', Slug: 'bai-thu', Desc: 'Mô tả', Description: 'SEO', Keywords: ['thử'],
        }] } });
      }
      return route.fulfill({ status: 204 });
    });
    await page.goto(origin);
    const launch = page.getByRole('button', { name: 'Viết bài AI' });
    const dialog = page.getByRole('dialog');
    const label = dialog.locator('.model-label');
    const menu = dialog.locator('[name=model]');
    const write = dialog.getByRole('button', { name: 'Viết ngay' });
    const reopen = async () => {
      await dialog.getByRole('button', { name: 'Đóng', exact: true }).first().click();
      await launch.click();
    };
    await launch.click();
    await dialog.getByText('Website dùng key riêng. Quản trị viên cần cấu hình Base URL, API key và model ở backend Laravel.').waitFor();
    assert.equal(await label.isVisible(), false);
    assert.equal(await write.isDisabled(), true);
    await dialog.getByLabel('Từ khóa', { exact: true }).fill('nội dung thử');
    await dialog.locator('form').dispatchEvent('submit');
    assert.equal(posts.length, 0, 'incomplete own-key websites cannot generate');

    catalog = { key_mode: 'own', own_key_configured: true, model: 'backend-model', data: [] };
    await reopen();
    await page.waitForFunction(() => !(document.querySelector('#tools > span')!.shadowRoot!.querySelector('.submit') as HTMLButtonElement).disabled);
    assert.equal(await label.isVisible(), false);
    assert.equal(await menu.inputValue(), 'backend-model');
    assert.equal(await dialog.locator('.form-intro small').innerText(), 'Mô tả nội dung cần triển khai.');
    await write.click();
    await dialog.getByRole('heading', { name: 'Bài thử', exact: true }).waitFor();
    assert.equal(posts[0].model, 'backend-model');
    assert.equal('api_key' in posts[0], false);
    assert.equal('provider' in posts[0], false);
    await dialog.getByRole('button', { name: 'Áp dụng' }).click();

    catalog = { key_mode: 'service', data: [{ model: 'service-model', display_name: 'Model dịch vụ' }] };
    gate = new Promise<void>(resolve => { release = resolve; });
    await launch.click();
    assert.equal(await label.isVisible(), false, 'stale model controls stay hidden during the current website lookup');
    assert.equal(await write.isDisabled(), true);
    release!();
    gate = undefined;
    release = undefined;
    await menu.getByText('Model dịch vụ').waitFor({ state: 'attached' });
    assert.equal(await label.isVisible(), true);
    assert.equal(await write.isEnabled(), true);
    assert.equal(await menu.inputValue(), 'service-model');
    await dialog.getByLabel('Từ khóa', { exact: true }).fill('nội dung thử');
    await write.click();
    await dialog.getByRole('heading', { name: 'Bài thử', exact: true }).waitFor();
    assert.equal(posts[1].model, 'service-model');
    await dialog.getByRole('button', { name: 'Áp dụng' }).click();

    fail = true;
    await launch.click();
    await dialog.getByText('Không tải được cấu hình website. Đóng rồi mở lại để thử.').waitFor();
    assert.equal(await write.isDisabled(), true);
    assert.equal(posts.length, 2);
  } finally {
    release?.();
    await browser.close();
  }
});

test('remote widget verifies the site before launch and sends only the selected AI configuration', async () => {
  const { outputFiles } = await build({
    entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
  });
  const siteOrigin = 'http://localhost:3240';
  const crmOrigin = 'http://localhost:3241';
  const wrongOrigin = 'http://localhost:3242';
  const siteId = '8dc71282-429e-4854-ac32-12a9bc65caf0';
  const jobId = '8d3d6a8f-6a2b-4e6f-a00a-8b6fc34b4a9e';
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const signature = 'e'.repeat(64);
  const readToken = 'a'.repeat(64);
  const base = `${crmOrigin}/v1/widget/${siteId}`;
  const browser = await chromium.launch();
  const personal = { base_url: 'https://personal-ai.example.com/v1', api_key: 'sk-test-direct', model: 'vendor/model:free' };
  const article = { Title: 'Bài từ CRM', Content: '<p>Nội dung</p>', Slug: 'bai-tu-crm', Desc: 'Mô tả', Description: 'SEO', Keywords: ['nội dung'] };
  type ApiCall = { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> };
  const calls: ApiCall[] = [];
  let keyMode: 'own' | 'service' = 'service';
  let release: (() => void) | undefined;
  const firstHandshake = new Promise<void>(resolve => { release = resolve; });
  try {
    const page = await browser.newPage();
    await page.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin === siteOrigin || url.origin === wrongOrigin) {
        if (url.pathname !== '/') return route.fulfill({ status: 204 });
        const credentials = url.searchParams.has('own') ? personal : { base_url: null, api_key: null, model: null };
        const script = `${crmOrigin}/widget/v1/ai-writer.js?site=${siteId}&amp;expires=${expires}&amp;signature=${url.searchParams.has('invalid') ? '0'.repeat(64) : signature}`;
        const config = JSON.stringify({ mount: '#tools', form: '#article', ...credentials, fields: { Title: '[name=title]' } });
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8">
          <form id="article"><input name="title"><div id="tools"></div></form>
          <script src="${script}"></script><script>AIWriter.mount(${config});</script>` });
      }
      if (url.origin === crmOrigin && url.pathname === '/widget/v1/ai-writer.js') {
        return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
      }
      if (!req.url().startsWith(base)) return route.abort();
      const headers = await req.allHeaders();
      const cors = {
        'Access-Control-Allow-Origin': siteOrigin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'content-type, idempotency-key, x-widget-expires, x-widget-signature, x-widget-read-token',
      };
      const method = req.method();
      if (method === 'OPTIONS') return route.fulfill({ headers: cors, status: 204 });
      calls.push({ url: req.url(), method, headers, body: method === 'POST' ? req.postDataJSON() : undefined });
      if (headers.origin !== siteOrigin) return route.fulfill({ status: 403, json: { error: { code: 'invalid_widget_grant' } } });
      if (req.url() === `${base}/models`) {
        if (headers['x-widget-signature'] !== signature) return route.fulfill({ headers: cors, status: 401, json: { error: { code: 'invalid_widget_grant' } } });
        if (calls.length === 1) await firstHandshake;
        return route.fulfill({ headers: cors, json: {
          key_mode: keyMode, grant_expires_at: expires,
          data: keyMode === 'own' ? [] : [
            { provider: 'openai', model: 'service-model', display_name: 'Model được cấp' },
            { provider: 'openai', model: 'second-model', display_name: 'Model thứ hai' },
          ],
        } });
      }
      if (req.url() === `${base}/previews` && method === 'POST') {
        return route.fulfill({ headers: cors, status: 202, json: { job_id: jobId, status: 'queued', read_token: readToken } });
      }
      if (req.url() === `${base}/previews/${jobId}`) {
        return route.fulfill({ headers: cors, json: { job_id: jobId, status: 'ready', keyword: 'nội dung' } });
      }
      if (req.url() === `${base}/previews/${jobId}/result`) return route.fulfill({ headers: cors, json: [article] });
      return route.abort();
    });

    const launch = page.getByRole('button', { name: 'Viết bài AI' });
    const launchElement = page.locator('#tools .launch');
    const dialog = page.getByRole('dialog');
    const model = dialog.getByRole('combobox', { name: 'Model' });
    const toggle = dialog.getByRole('checkbox', { name: 'Dùng key riêng' });
    const write = dialog.getByRole('button', { name: 'Viết ngay' });
    const waitForPreview = () => dialog.getByRole('heading', { name: article.Title }).waitFor();
    const apply = () => dialog.getByRole('button', { name: 'Áp dụng' }).click();
    const openModels = async () => {
      await launch.click();
      await dialog.locator('select[name="model"] option').filter({ hasText: 'Model được cấp' }).waitFor({ state: 'attached' });
    };

    await page.goto(siteOrigin);
    await launchElement.waitFor({ state: 'attached' });
    assert.equal(await launchElement.isVisible(), false);
    release!();
    await openModels();
    assert.equal(await toggle.isVisible(), false);
    await dialog.getByLabel('Từ khóa', { exact: true }).fill('nội dung');
    await write.click();
    await waitForPreview();
    await apply();
    assert.equal(await page.locator('[name=title]').inputValue(), article.Title);

    await page.goto(siteOrigin + '/?own=1');
    await openModels();
    assert.equal(await toggle.isChecked(), false);
    await model.fill('thu hai');
    await dialog.getByRole('option', { name: 'Model thứ hai', exact: true }).click();
    await toggle.check();
    assert.equal(await model.isVisible(), false);
    await toggle.uncheck();
    assert.equal(await model.inputValue(), 'Model thứ hai');
    await toggle.check();
    await dialog.getByLabel('Từ khóa', { exact: true }).fill('nội dung');
    await write.click();
    await dialog.getByText('Yêu cầu đang chờ xử lý…').waitFor();
    await page.clock.setFixedTime(new Date((expires + 10) * 1000));
    await waitForPreview();
    await apply();
    await launch.click();
    await dialog.getByText('Phiên viết bài đã hết hạn. Tải lại trang để tiếp tục.').waitFor();
    assert.equal(await write.isDisabled(), true);
    await page.clock.setFixedTime(new Date());

    keyMode = 'own';
    await page.goto(siteOrigin + '/?own=1');
    await launch.click();
    await dialog.getByText('Mô tả nội dung cần triển khai.').waitFor();
    assert.equal(await toggle.isVisible(), false);
    assert.equal(await model.isVisible(), false);
    await dialog.getByLabel('Từ khóa', { exact: true }).fill('nội dung');
    await write.click();
    await waitForPreview();

    for (const deniedUrl of [siteOrigin + '/?invalid=1', wrongOrigin]) {
      await Promise.all([
        page.waitForResponse(res => res.url() === `${base}/models` && !res.ok()),
        page.goto(deniedUrl),
      ]);
      assert.equal(await launchElement.isVisible(), false);
    }

    const posts = calls.filter(call => call.method === 'POST');
    assert.deepEqual(posts.map(call => call.body), [
      { model: 'service-model', keyword: 'nội dung', tone: 'Thân thiện', style: 'Hướng dẫn', length: 800, key_mode: 'service', use_research: true },
      ...Array.from({ length: 2 }, () => ({
        ...personal, provider: 'openai-compatible', keyword: 'nội dung', tone: 'Thân thiện', style: 'Hướng dẫn', length: 800, key_mode: 'own', use_research: true,
      })),
    ]);
    assert.equal(new Set(posts.map(call => call.headers['idempotency-key'])).size, 3);
    for (const call of posts) {
      assert.ok(call.headers['idempotency-key']);
      assert.equal(call.headers['x-widget-expires'], String(expires));
      assert.equal(call.headers['x-widget-signature'], signature);
      assert.equal(call.headers['x-csrf-token'], undefined);
    }
    const reads = calls.filter(call => call.url.includes(jobId));
    assert.equal(reads.length, 6);
    for (const call of reads) {
      assert.equal(call.headers['x-widget-read-token'], readToken);
      assert.equal(call.headers['x-widget-signature'], undefined);
    }
    for (const call of calls) {
      assert.equal(new URL(call.url).search, '');
      assert.equal(call.headers.cookie, undefined);
    }
  } finally {
    release?.();
    await browser.close();
  }
});
