import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, type Locator, type Page } from 'playwright';
import { test } from 'node:test';

const bundle = build({
  entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
}).then(result => result.outputFiles[0].text);
const origin = 'http://localhost:3238';
const article = {
  Title: 'Nội dung đã hoàn tất', Slug: 'noi-dung-da-hoan-tat', Desc: 'Tóm tắt bài viết.',
  Description: 'Mô tả SEO của bài viết.', Keywords: ['nội dung doanh nghiệp'],
  Content: '<h2>Tiêu đề trong bài</h2><p style="color:#135724;text-align:center;font-weight:700;font-size:1.25rem;line-height:1.5rem;margin-bottom:.5rem">Định dạng biên tập được giữ lại.</p>' +
    '<table style="width:100%;border-collapse:collapse"><tbody><tr><td style="padding:.5rem;border:1px solid #123456">Ô dữ liệu</td></tr></tbody></table>',
};
const properties = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-stretch', 'font-variant', 'line-height',
  'letter-spacing', 'word-spacing', 'text-align', 'text-transform', 'text-indent', 'text-shadow',
  'direction', 'writing-mode', 'color-scheme', 'color', 'background-color', 'border-top-color',
  '-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
  'border-top-width', 'border-radius', 'box-sizing', 'display', 'padding-top', 'padding-right',
  'padding-bottom', 'padding-left', 'opacity', 'visibility',
];

async function appearance(locator: Locator, geometry = true) {
  return locator.evaluate((element, { properties, geometry }) => {
    const css = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      css: Object.fromEntries(properties.map(property => [property, css.getPropertyValue(property)])),
      ...(geometry ? { bounds: {
        x: Math.round(bounds.x * 100) / 100, y: Math.round(bounds.y * 100) / 100,
        width: Math.round(bounds.width * 100) / 100, height: Math.round(bounds.height * 100) / 100,
      } } : {}),
    };
  }, { properties, geometry });
}

function hostileCss(rootSize: number) {
  return `
    html { font-size: ${rootSize}px !important; }
    body, #tools { font: italic 900 31px/3 monospace; color: fuchsia; text-align: right;
      text-transform: uppercase; text-indent: 28px; letter-spacing: 7px; word-spacing: 11px;
      text-shadow: 3px 4px 1px red; direction: rtl; writing-mode: vertical-rl;
      color-scheme: dark; -webkit-text-fill-color: fuchsia;
      --ink: fuchsia; --muted: red; --line: red; --surface: black; --accent: lime; }
    #tools > span { all: unset !important; font: italic 900 31px/3 monospace !important;
      text-align: right !important; text-transform: uppercase !important; direction: rtl !important;
      writing-mode: vertical-rl !important; color: fuchsia !important; letter-spacing: 7px !important;
      --ink: fuchsia !important; --muted: red !important; --line: red !important;
      --surface: black !important; --accent: lime !important; }
    dialog, header, h2, h3, p, label, button, input, select, textarea, article, table, td,
    .primary, .modal-header, .writing-title, .scene-ink { color: red !important;
      background: black !important; border: 9px solid orange !important; padding: 40px !important;
      border-radius: 0 !important; font: italic 900 44px/4 monospace !important;
      text-transform: uppercase !important; text-align: right !important; }
  `;
}

async function assertDialogFitsViewport(page: Page, dialog: Locator, state: string) {
  const viewport = page.viewportSize();
  assert.ok(viewport);
  const bounds = await dialog.boundingBox();
  assert.ok(bounds, `${state}: the open modal has a visible box`);
  const gap = viewport.width <= 520 ? 18 : 28;
  const expectedWidth = Math.min(680, viewport.width - gap);
  assert.ok(bounds.x >= -1 && bounds.y >= -1, `${state}: the modal starts inside the viewport (${JSON.stringify(bounds)})`);
  assert.ok(bounds.x + bounds.width <= viewport.width + 1, `${state}: the modal's right edge stays inside the viewport`);
  assert.ok(bounds.y + bounds.height <= viewport.height + 1, `${state}: the modal's bottom edge stays inside the viewport`);
  assert.ok(Math.abs(bounds.width - expectedWidth) <= 1, `${state}: the modal follows its responsive width`);
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) <= 1, `${state}: the modal remains horizontally centered`);
  assert.ok(bounds.height <= viewport.height - gap + 1, `${state}: the modal respects its responsive maximum height`);
  const layout = await dialog.evaluate(element => {
    const css = getComputedStyle(element);
    return { position: css.position, maxHeight: css.maxHeight };
  });
  assert.equal(layout.position, 'fixed', `${state}: the modal is positioned against the viewport`);
  assert.equal(Number.parseFloat(layout.maxHeight), viewport.height - gap, `${state}: the height limit updates with the viewport`);
}

async function assertOpenDialogResizes(page: Page, dialog: Locator, state: string) {
  const viewport = page.viewportSize();
  assert.ok(viewport);
  if (viewport.width !== 1120) return;
  const style = await page.addStyleTag({ content: hostileCss(22) });
  const waitForResponsiveLayout = async (width: number, height: number) => {
    const element = await dialog.elementHandle();
    assert.ok(element);
    try {
      await page.waitForFunction(({ element, width, height }) => {
        const mobile = matchMedia('(max-width: 520px)').matches;
        return innerWidth === width && innerHeight === height && mobile === (width <= 520)
          && Number.parseFloat(getComputedStyle(element).maxHeight) === height - (mobile ? 18 : 28);
      }, { element, width, height });
    } finally {
      await element.dispose();
    }
  };
  try {
    await assertDialogFitsViewport(page, dialog, `${state}, hostile desktop`);
    await page.setViewportSize({ width: 375, height: 812 });
    await waitForResponsiveLayout(375, 812);
    await assertDialogFitsViewport(page, dialog, `${state}, resized mobile`);
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true,
      `${state}: resizing an open modal creates no horizontal overflow`);
    await page.setViewportSize(viewport);
    await waitForResponsiveLayout(viewport.width, viewport.height);
    await assertDialogFitsViewport(page, dialog, `${state}, restored desktop`);
  } finally {
    await style.evaluate(element => element.parentNode?.removeChild(element));
    await page.setViewportSize(viewport);
  }
}

async function assertIsolated(page: Page, dialog: Locator, selectors: string[]) {
  await assertDialogFitsViewport(page, dialog, 'default site CSS');
  const baseline = await Promise.all(selectors.map(selector => appearance(dialog.locator(selector))));
  const launch = page.getByRole('button', { name: 'Viết bài AI', exact: true });
  const launchBaseline = await appearance(launch, false);
  const dialogBaseline = await appearance(dialog);
  for (const rootSize of [10, 22]) {
    const style = await page.addStyleTag({ content: hostileCss(rootSize) });
    try {
      await assertDialogFitsViewport(page, dialog, `hostile site CSS with a ${rootSize}px root`);
      assert.deepEqual(await appearance(dialog), dialogBaseline, `the modal keeps its own layout with a ${rootSize}px document root`);
      for (const [index, selector] of selectors.entries()) {
        assert.deepEqual(await appearance(dialog.locator(selector)), baseline[index], `${selector} keeps widget styles under aggressive host CSS`);
      }
      assert.deepEqual(await appearance(launch, false), launchBaseline, 'the launch control also keeps widget typography and colors');
      assert.equal(await page.locator('#outside-button').evaluate(element => getComputedStyle(element).color), 'rgb(255, 0, 0)',
        'host selectors apply to the customer page rather than being disabled globally');
      assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'the modal has no horizontal overflow');
    } finally {
      await style.evaluate(element => element.parentNode?.removeChild(element));
    }
  }
}

test('widget isolates form, progress and article CSS from host resets, inherited properties and root font sizes', async t => {
  const browser = await chromium.launch();
  try {
    for (const viewport of [{ width: 1120, height: 1000 }, { width: 375, height: 812 }]) {
      await t.test(`${viewport.width}px viewport`, async () => {
        const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
        let releasePost!: () => void;
        const heldPost = new Promise<void>(resolve => { releasePost = resolve; });
        const requests: unknown[] = [];
        const script = await bundle;
        try {
          await page.route(origin + '/**', async route => {
            const request = route.request();
            const path = new URL(request.url()).pathname;
            if (path === '/') return route.fulfill({ contentType: 'text/html', body:
              '<!doctype html><html lang="vi"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
              '<meta name="csrf-token" content="fixture-csrf"><form id="article"><input name="title"><textarea name="content"></textarea><button id="outside-button" type="button">Nút website</button></form>' +
              '<div id="tools"></div><script src="/widget.js"></script><script>AIWriter.mount({' +
              'mount:"#tools",form:"#article",endpoint:"/admin/ai/previews",models:[{value:"test-model",label:"Model kiểm thử"}],' +
              'fields:{Title:"[name=title]",Content:"[name=content]"}});</script></html>',
            });
            if (path === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: script });
            if (path === '/admin/ai/previews' && request.method() === 'POST') {
              requests.push(request.postDataJSON());
              await heldPost;
              return route.fulfill({ json: { job_id: 'css-isolation', status: 'ready', result: [article] } });
            }
            return route.fulfill({ status: 404 });
          });
          await page.goto(origin);
          const outsideBefore = await appearance(page.locator('#outside-button'), false);
          await page.getByRole('button', { name: 'Viết bài AI', exact: true }).click();
          const dialog = page.getByRole('dialog');
          await dialog.waitFor();
          const formSelectors = ['.modal-header', '.heading-group h2', '.heading-group p', '.model-label', '[name="keyword"]', '[name="model"]',
            '[name="instructions"]', '.research-option', '.submit'];
          await assertIsolated(page, dialog, formSelectors);
          await assertOpenDialogResizes(page, dialog, 'input form');
          assert.deepEqual(await appearance(page.locator('#outside-button'), false), outsideBefore,
            'widget styling does not leak into the customer form');

          await dialog.getByLabel('Từ khóa', { exact: true }).fill('nội dung doanh nghiệp');
          await dialog.getByRole('button', { name: 'Viết ngay' }).click();
          await dialog.getByRole('status').getByText('Đang gửi yêu cầu viết bài…').waitFor();
          await assertIsolated(page, dialog, ['.writing-title', '.writing-keyword', '.stage-illustration', '.status', '.writing-hint']);
          await assertOpenDialogResizes(page, dialog, 'busy state');
          assert.equal(await dialog.locator('.close').isDisabled(), true);

          releasePost();
          await dialog.getByRole('heading', { name: article.Title, exact: true }).waitFor();
          await assertIsolated(page, dialog, ['.preview .title', '.metadata', '.body', '.body h2', '.body p', '.body td', '.accept']);
          await assertOpenDialogResizes(page, dialog, 'article preview');
          const inline = await appearance(dialog.locator('.body p'), false);
          assert.equal(inline.css.color, 'rgb(19, 87, 36)', 'safe article colors survive modal isolation');
          assert.equal(inline.css['text-align'], 'center', 'article alignment remains editable by its own inline formatting');
          assert.equal(inline.css['font-weight'], '700');
          assert.equal(inline.css['font-size'], '20px', 'article rem typography uses the isolated 16px widget root in the preview');
          assert.equal(inline.css['line-height'], '24px');
          assert.equal(await dialog.locator('.body td').evaluate(element => getComputedStyle(element).padding), '8px');
          assert.equal(requests.length, 1, 'all generation is mocked by the test adapter');
          await dialog.getByRole('button', { name: 'Áp dụng' }).click();
          await dialog.waitFor({ state: 'hidden' });
          assert.equal(await page.locator('#article [name="title"]').inputValue(), article.Title);
          const acceptedContent = await page.locator('#article [name="content"]').inputValue();
          assert.match(acceptedContent, /font-size:1\.25rem/, 'preview isolation does not rewrite the article applied to the customer form');
          assert.match(acceptedContent, /padding:\.5rem/);
          assert.deepEqual(await appearance(page.locator('#outside-button'), false), outsideBefore);
        } finally {
          releasePost();
          await page.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});
