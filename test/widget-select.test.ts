import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { test } from 'node:test';

test('widget searches all selects without accents, supports keyboard selection, and submits only selected values', async () => {
  const { outputFiles } = await build({ entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false });
  const browser = await chromium.launch();
  const posts: Record<string, unknown>[] = [];
  let catalogReads = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const origin = 'http://localhost:3268';
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf-token" content="fixture"><form id="article"><input name="title"><span id="tools"></span></form><script src="/widget.js"></script><script>AIWriter.mount({mount:'#tools',form:'#article',endpoint:'/admin/ai/previews',modelsEndpoint:'/admin/ai/models',fields:{Title:'[name=title]'},defaults:{model:'second',tone:'Chuyên nghiệp',style:'SEO'}})</script>` });
      if (path === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: outputFiles[0].text });
      if (path === '/admin/ai/models') {
        catalogReads++;
        return route.fulfill({ json: { key_mode: 'service', data: catalogReads === 1 ? [
          { model: 'first', display_name: 'Model nhanh', provider_display_name: 'Đối tác A' },
          { model: 'second', display_name: 'Model chuyên sâu', provider_display_name: 'Đối tác B' },
        ] : [{ model: 'new', display_name: 'Model mới' }] } });
      }
      if (path === '/admin/ai/previews' && request.method() === 'POST') {
        posts.push(request.postDataJSON());
        return route.fulfill({ json: { job_id: 'fixture', status: 'ready', result: [{ Title: 'Kết quả kiểm thử', Content: '<p>Nội dung</p>', Slug: 'ket-qua', Desc: 'Tóm tắt', Description: 'Mô tả', Keywords: ['từ khóa'] }] } });
      }
      return route.fulfill({ status: 204 });
    });
    await page.goto(origin);
    const dialog = page.getByRole('dialog');
    const launch = page.getByRole('button', { name: 'Viết bài AI', exact: true });
    await launch.click();
    const model = dialog.getByRole('combobox', { name: 'Model', exact: true });
    const tone = dialog.getByRole('combobox', { name: 'Giọng văn', exact: true });
    const style = dialog.getByRole('combobox', { name: 'Phong cách viết', exact: true });
    await dialog.locator('select[name=model] option[value=second]').waitFor({ state: 'attached' });
    assert.equal(await model.inputValue(), 'Model chuyên sâu · Đối tác B');
    assert.equal(await tone.inputValue(), 'Chuyên nghiệp');
    assert.equal(await style.inputValue(), 'SEO');
    assert.equal(await dialog.getByRole('listbox').count(), 0, 'autofocus does not open a dropdown');

    await model.fill('doi tac a');
    assert.equal(await dialog.getByRole('option').count(), 1);
    await dialog.getByRole('option', { name: 'Model nhanh · Đối tác A' }).click();
    assert.equal(await model.inputValue(), 'Model nhanh · Đối tác A');

    await tone.click();
    assert.equal(await tone.getAttribute('aria-expanded'), 'true');
    assert.equal(await dialog.getByRole('option').count(), 6);
    await tone.fill('thuYET');
    const persuasive = dialog.getByRole('option', { name: 'Thuyết phục', exact: true });
    await persuasive.waitFor();
    assert.equal(await dialog.getByRole('option').count(), 1);
    assert.equal(await tone.getAttribute('aria-activedescendant'), await persuasive.getAttribute('id'));
    await tone.press('Enter');
    assert.equal(await tone.inputValue(), 'Thuyết phục');
    assert.equal(await tone.getAttribute('aria-expanded'), 'false');
    assert.equal(posts.length, 0, 'Enter selects an option without submitting the form');

    await tone.fill('khong co ket qua');
    await dialog.getByRole('status').filter({ hasText: 'Không tìm thấy kết quả' }).waitFor();
    await tone.press('Enter');
    assert.equal(posts.length, 0);
    await tone.press('Escape');
    assert.equal(await tone.inputValue(), 'Thuyết phục');
    assert.equal(await dialog.isVisible(), true, 'Escape dismisses the list before the dialog');

    await style.fill('ke chuyen');
    await style.press('Enter');
    assert.equal(await style.inputValue(), 'Kể chuyện');
    await style.press('ArrowDown');
    await style.press('ArrowDown');
    await style.press('Enter');
    assert.equal(await style.inputValue(), 'Danh sách');
    await style.fill('huong dan');
    await style.press('Tab');
    assert.equal(await style.inputValue(), 'Danh sách', 'unconfirmed search text is discarded on blur');

    await tone.click();
    const popup = await dialog.getByRole('listbox').boundingBox();
    const bounds = await dialog.boundingBox();
    assert.ok(popup && bounds && popup.x >= bounds.x && popup.x + popup.width <= bounds.x + bounds.width);
    assert.ok(popup && bounds && popup.y >= bounds.y && popup.y + popup.height <= bounds.y + bounds.height, 'list fits inside the mobile dialog');
    await dialog.getByLabel('Từ khóa', { exact: true }).fill('từ khóa kiểm thử');
    assert.equal(await tone.getAttribute('aria-expanded'), 'false', 'clicking another field closes the list');
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await dialog.getByRole('heading', { name: 'Kết quả kiểm thử' }).waitFor();
    assert.equal(posts[0].model, 'first');
    assert.equal(posts[0].tone, 'Thuyết phục');
    assert.equal(posts[0].style, 'Danh sách');
    await dialog.getByRole('button', { name: 'Áp dụng', exact: true }).click();

    await launch.click();
    await dialog.locator('select[name=model] option[value=new]').waitFor({ state: 'attached' });
    assert.equal(await model.inputValue(), 'Model mới', 'reopening reflects refreshed model options');
    assert.equal(await tone.inputValue(), 'Chuyên nghiệp', 'new articles restore configured defaults');
    assert.equal(await style.inputValue(), 'SEO');
    await model.fill('moi');
    await model.press('Enter');
    assert.equal(await dialog.locator('select[name=model]').inputValue(), 'new');
  } finally { await browser.close(); }
});
