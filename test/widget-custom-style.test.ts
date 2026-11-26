import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = (await build({ entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false })).outputFiles[0].text;
const origin = 'http://localhost:3267';
const hostCss = '#tools > .crm-ai-launch { display:inline-flex !important; background:rgb(12,80,40);color:rgb(240,220,120);border:0;border-radius:2px;padding:7px 11px;font:600 17px/1.4 serif;box-shadow:none; }';

test('customStyle exposes only the launch button to page CSS and preserves keyboard access, form behavior and cleanup', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route(origin + '/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
    return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>${hostCss} #tools > .brand-action {border-radius:9px}</style>
      <form id="article" onsubmit="event.preventDefault();window.submitted=true"><input name="title"><span id="tools"></span></form>
      <script src="/widget.js"></script><script>window.writer=AIWriter.mount({mount:'#tools',form:'#article',customStyle:true,customClass:'  brand-action btn brand-action\\n btn-primary  ',endpoint:'/preview',models:[{value:'test',label:'Test'}],fields:{Title:'[name=title]'}})</script>` });
  });
  await page.goto(origin);
  const launch = page.locator('#tools > .crm-ai-launch');
  assert.equal(await launch.count(), 1);
  assert.deepEqual(await launch.evaluate(element => [...element.classList]), ['crm-ai-launch', 'brand-action', 'btn', 'btn-primary']);
  assert.equal(await page.locator('#tools .launch').count(), 0, 'there is exactly one launch button');
  assert.equal(await launch.evaluate(element => element.getRootNode() === document), true);
  const appearance = await launch.evaluate(element => {
    const css = getComputedStyle(element);
    return [css.backgroundColor, css.color, css.borderRadius, css.fontSize, css.boxShadow];
  });
  assert.deepEqual(appearance, ['rgb(12, 80, 40)', 'rgb(240, 220, 120)', '9px', '17px', 'none']);
  await launch.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await dialog.locator('.brand-action, .btn, .btn-primary').count(), 0, 'custom classes apply only to the launch button');
  assert.equal(await launch.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => (window as any).submitted), undefined, 'the trigger never submits the host form');
  const submit = dialog.getByRole('button', { name: 'Viết ngay' });
  const before = await submit.evaluate(element => getComputedStyle(element).backgroundColor);
  await page.addStyleTag({ content: 'button,.primary,.submit,dialog {background:red !important;color:orange !important;font-size:42px !important;padding:50px !important}' });
  assert.equal(await submit.evaluate(element => getComputedStyle(element).backgroundColor), before, 'page CSS cannot restyle the popup');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.querySelector('#tools > .crm-ai-launch')?.getAttribute('aria-expanded') === 'false');
  assert.equal(await launch.getAttribute('aria-expanded'), 'false');
  await page.evaluate(() => (window as any).writer.destroy());
  assert.equal(await page.locator('#tools > *').count(), 0, 'destroy removes the external button and shadow host');
});

test('omitting customStyle or setting it false retains the isolated widget button', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const option of ['', 'customStyle:false,', "customStyle:false,customClass:'inside-action',"]) {
    const page = await browser.newPage();
    await page.route(origin + '/**', route => {
      if (new URL(route.request().url()).pathname === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>${hostCss}</style><form id="article"><input name="title"><span id="tools"></span></form>
        <script src="/widget.js"></script><script>AIWriter.mount({mount:'#tools',form:'#article',${option}endpoint:'/preview',models:[{value:'test',label:'Test'}],fields:{Title:'[name=title]'}})</script>` });
    });
    await page.goto(origin);
    assert.equal(await page.locator('#tools > .crm-ai-launch').count(), 0);
    const launch = page.getByRole('button', { name: 'Viết bài AI' });
    assert.equal(await launch.evaluate(element => element.getRootNode() instanceof ShadowRoot), true);
    if (option.includes('inside-action')) assert.equal(await launch.evaluate(element => element.classList.contains('inside-action')), true);
    assert.equal(await launch.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(36, 85, 214)');
    await page.close();
  }
});

test('a custom launch remains detached until CRM validates the website even if site CSS overrides hidden', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const reject of [false, true]) {
    const page = await browser.newPage();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const site = '11111111-1111-4111-8111-111111111111';
    await page.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/widget/v1/ai-writer.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
      if (path.endsWith('/models')) {
        await gate;
        return route.fulfill({ status: reject ? 403 : 200,
          headers: { 'Access-Control-Allow-Origin': origin },
          json: reject ? { error: { message: 'Website không hợp lệ.' } } : { key_mode: 'service', data: [{ model: 'test', display_name: 'Test' }] } });
      }
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><style>${hostCss}</style><form id="article"><input name="title"><span id="tools"></span></form>
        <script src="http://localhost:3268/widget/v1/ai-writer.js?site=${site}&expires=${Math.floor(Date.now() / 1000) + 3600}&signature=${'e'.repeat(64)}"></script>
        <script>window.writer=AIWriter.mount({mount:'#tools',form:'#article',customStyle:true,fields:{Title:'[name=title]'}})</script>` });
    });
    try {
      await page.goto(origin);
      assert.equal(await page.locator('#tools > .crm-ai-launch').count(), 0);
      const response = page.waitForResponse(response => response.url().endsWith('/models'));
      release();
      await response;
      if (reject) {
        await page.waitForFunction(() => document.querySelector('#tools > span')!.shadowRoot!.querySelector('.status')?.classList.contains('error'));
        assert.equal(await page.locator('#tools > .crm-ai-launch').count(), 0);
      } else {
        await page.locator('#tools > .crm-ai-launch').waitFor();
        await page.locator('#tools > .crm-ai-launch').click();
        await page.getByRole('dialog').waitFor();
      }
      await page.evaluate(() => (window as any).writer.destroy());
      assert.equal(await page.locator('#tools > *').count(), 0);
    } finally { release(); await page.close(); }
  }
});
