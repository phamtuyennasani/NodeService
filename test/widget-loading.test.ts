import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, type Locator, type Page, type Route } from 'playwright';
import { test } from 'node:test';

const bundle = build({
  entryPoints: ['widget/ai-writer.ts'], bundle: true, format: 'iife', loader: { '.css': 'text' }, write: false,
}).then(result => result.outputFiles[0].text);
const origin = 'http://localhost:3228';
const endpoint = '/admin/ai/previews';
const article = {
  Title: 'Bài viết đã hoàn tất', Content: '<p>Nội dung được trả về từ CRM.</p>', Slug: 'bai-viet-da-hoan-tat',
  Desc: 'Tóm tắt.', Description: 'Mô tả SEO.', Keywords: ['máy lọc nước'],
};
const ready = { job_id: 'loading-fixture', status: 'ready', result: [article] };
const sceneStages = ['waiting', 'research', 'outline', 'draft', 'seo_check', 'seo_repair'] as const;

async function assertStageVisual(dialog: Locator, expected: typeof sceneStages[number], reducedMotion = false) {
  const visual = dialog.locator('.writing-visual');
  assert.equal(await visual.getAttribute('data-stage'), expected, 'the illustration uses the current CRM checkpoint');
  const svg = visual.locator('svg.stage-illustration');
  assert.equal(await svg.count(), 1, 'the loading visual has one native SVG illustration');
  assert.equal(await svg.getAttribute('focusable'), 'false');
  assert.equal(await svg.evaluate(element => !!element.closest('[aria-hidden="true"]')), true, 'decorative scenes stay outside the accessibility tree');
  const scenes = await svg.locator('g[data-scene]').evaluateAll(elements => elements.map(element => ({
    stage: element.getAttribute('data-scene'),
    visible: getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden',
  })));
  assert.deepEqual(scenes.map(scene => scene.stage).sort(), [...sceneStages, 'translation'].sort(), 'writing checkpoints and translation each have their own scene');
  assert.deepEqual(scenes.filter(scene => scene.visible).map(scene => scene.stage), [expected], 'only the matching scene is displayed');
  const animations = await svg.locator(`g[data-scene="${expected}"] .scene-motion`).evaluateAll(elements =>
    elements.map(element => getComputedStyle(element).animationName));
  assert.ok(animations.length > 0, 'each scene includes moving feedback');
  if (reducedMotion) assert.ok(animations.every(name => name === 'none'), 'reduced motion disables SVG animations');
  else assert.ok(animations.some(name => name !== 'none'), 'the active SVG scene animates');
  assert.equal(await svg.locator('animate, animateMotion, animateTransform, set, image').count(), 0, 'scenes use CSS animation without SMIL or image requests');
  const externalReferences = await svg.locator('[href], [xlink\\:href]').evaluateAll(elements => elements
    .map(element => element.getAttribute('href') ?? element.getAttribute('xlink:href') ?? '')
    .filter(value => !value.startsWith('#')));
  assert.deepEqual(externalReferences, [], 'the illustration has no external asset dependencies');
  const bounds = await svg.boundingBox();
  const containerBounds = await visual.boundingBox();
  assert.ok(bounds && containerBounds && bounds.x >= containerBounds.x && bounds.x + bounds.width <= containerBounds.x + containerBounds.width + 1,
    'the illustration fits inside its container');
}

async function assertVisualStopped(dialog: Locator) {
  const visual = dialog.locator('.writing-visual');
  assert.equal(await visual.getAttribute('data-stage'), null, 'finished tasks clear the active scene');
  assert.equal(await visual.isVisible(), false, 'the illustration is hidden outside the busy state');
}

async function fixture(page: Page, handleRequest: (route: Route) => Promise<void>) {
  const script = await bundle;
  await page.route(origin + '/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body:
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<meta name="csrf-token" content="fixture-csrf"><form id="article"><input name="title"><div id="tools"></div></form>' +
      '<script src="/widget.js"></script><script>window.widget=AIWriter.mount({' +
      'mount:"#tools",form:"#article",endpoint:"/admin/ai/previews",models:[{value:"test-model",label:"Model kiểm thử"}],' +
      'fields:{Title:"[name=title]"}});</script>',
    });
    if (path === '/widget.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    if (path.startsWith(endpoint)) return handleRequest(route);
    return route.fulfill({ status: 204 });
  });
  await page.goto(origin);
  await page.clock.install();
  await page.getByRole('button', { name: 'Viết bài AI' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Từ khóa', { exact: true }).fill('máy lọc nước');
  return dialog;
}

test('widget immediately animates writing, prevents dismissal and duplicate requests, then unlocks the result', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    let releasePost!: () => void;
    const heldPost = new Promise<void>(resolve => { releasePost = resolve; });
    let posts = 0;
    let polls = 0;
    const states = [
      { status: 'writing', writing_stage: 'research', message: 'Đang nghiên cứu…' },
      { status: 'writing', writing_stage: 'outline', message: 'Đang lập dàn ý…' },
      { status: 'writing', writing_stage: 'draft', message: 'Đang viết nội dung…' },
      { status: 'writing', writing_stage: 'seo_check', message: 'Đang kiểm tra SEO…' },
      { status: 'writing', writing_stage: 'seo_repair', message: 'Đang chỉnh sửa SEO…' },
      { status: 'writing', message: 'CRM đang xử lý bài viết…' },
      { status: 'writing', writing_stage: null, message: 'CRM đang xử lý bài viết…' },
      { status: 'writing', writing_stage: 'future-stage', message: 'CRM đang xử lý bài viết…' },
      { status: 'writing', writing_stage: '__proto__', message: 'CRM đang xử lý bài viết…' },
      { status: 'scheduled', writing_stage: 'draft', message: 'Bài viết đã được lên lịch. Đang chờ CRM xử lý…' },
      { status: 'queued', writing_stage: 'seo_repair', message: 'Yêu cầu đang chờ xử lý…' },
      { status: 'retrying', writing_stage: 'outline', message: 'CRM đang thử xử lý lại bài viết…' },
    ];
    const dialog = await fixture(page, async route => {
      if (route.request().method() === 'POST') {
        posts++;
        await heldPost;
        return route.fulfill({ status: 202, json: { job_id: ready.job_id, status: 'queued' } });
      }
      const state = states[polls++];
      return route.fulfill({ json: state ? { ...ready, status: state.status, writing_stage: state.writing_stage } : ready });
    });
    const close = dialog.locator('.close');
    const activity = dialog.getByRole('region', { name: 'Tiến trình viết bài' });
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await dialog.getByRole('status').getByText('Đang gửi yêu cầu viết bài…').waitFor();
    assert.equal(await activity.isVisible(), true, 'feedback appears before the POST completes');
    assert.equal(await close.isDisabled(), true);
    assert.equal(await dialog.locator('.accept').isDisabled(), true);
    assert.equal(await dialog.locator('form').getAttribute('aria-busy'), 'true');
    assert.equal(await dialog.locator('form').isVisible(), false);
    assert.equal(await activity.locator('.writing-keyword').textContent(), 'máy lọc nước');
    assert.equal(await activity.getByRole('progressbar').getAttribute('aria-valuenow'), null, 'progress is indeterminate');
    await assertStageVisual(dialog, 'waiting');
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true, 'mobile modal does not overflow horizontally');
    const bounds = await activity.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 812, 'waiting feedback fits the mobile viewport');

    await close.dispatchEvent('click');
    await dialog.locator('.accept').dispatchEvent('click');
    await dialog.locator('form').dispatchEvent('submit');
    await page.keyboard.press('Escape');
    await page.mouse.click(1, 1);
    assert.equal(await dialog.evaluate(element => (element as HTMLDialogElement).open), true);
    assert.equal(posts, 1, 'duplicate submit does not create another job');
    await page.clock.runFor(1000);
    assert.match(await activity.locator('.writing-elapsed').innerText(), /Đã chờ 00:01/);

    releasePost();
    await dialog.getByRole('status').getByText('Yêu cầu đang chờ xử lý…').waitFor();
    await assertStageVisual(dialog, 'waiting');
    for (let index = 0; index < states.length; index++) {
      const nextPoll = page.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/${ready.job_id}`);
      await page.clock.runFor(1500);
      await nextPoll;
      await page.waitForFunction(message =>
        document.querySelector('#tools > span')!.shadowRoot!.querySelector('.status')!.textContent === message,
      states[index].message);
      assert.equal(polls, index + 1, 'each response reflects the current CRM checkpoint');
      assert.equal(await close.isDisabled(), true);
      await assertStageVisual(dialog, index < 5 ? sceneStages[index + 1] : 'waiting');
    }
    await page.clock.runFor(1500);
    await dialog.getByRole('heading', { name: article.Title }).waitFor();
    assert.equal(await activity.isVisible(), false);
    await assertVisualStopped(dialog);
    assert.equal(await close.isEnabled(), true);
    assert.equal(await dialog.locator('form').getAttribute('aria-busy'), 'false');
    assert.equal(await dialog.evaluate(element => element.classList.contains('is-writing')), false);
    const elapsed = await dialog.locator('.writing-elapsed').textContent();
    await page.clock.runFor(2500);
    assert.equal(await dialog.locator('.writing-elapsed').textContent(), elapsed, 'timer stops once complete');
    await close.click();
    await dialog.waitFor({ state: 'hidden' });
  } finally {
    await browser.close();
  }
});

test('widget restores controls after request or result errors and retries the existing task safely', async t => {
  const browser = await chromium.launch();
  try {
    for (const failure of ['post', 'poll', 'failed-job', 'malformed-result'] as const) {
      await t.test(failure, async () => {
        const page = await browser.newPage();
        try {
          const keys: string[] = [];
          let posts = 0;
          let polls = 0;
          let releaseRetry!: () => void;
          const heldRetry = new Promise<void>(resolve => { releaseRetry = resolve; });
          const message = `Lỗi kiểm thử ${failure}`;
          const dialog = await fixture(page, async route => {
            const request = route.request();
            if (request.method() === 'POST') {
              posts++;
              keys.push(request.headers()['idempotency-key']);
              if (posts > 1) {
                await heldRetry;
                return route.fulfill({ json: ready });
              }
              if (failure === 'post') return route.fulfill({ status: 503, json: { error: { message } } });
              if (failure === 'failed-job') return route.fulfill({ json: { job_id: ready.job_id, status: 'failed', error_message: message } });
              if (failure === 'malformed-result') return route.fulfill({ json: { ...ready, result: [] } });
              return route.fulfill({ status: 202, json: { job_id: ready.job_id, status: 'queued' } });
            }
            polls++;
            if (failure === 'poll' && polls === 1) return route.fulfill({ status: 503, json: { error: { message } } });
            await heldRetry;
            return route.fulfill({ json: ready });
          });
          const write = dialog.getByRole('button', { name: 'Viết ngay' });
          await write.click();
          if (failure === 'poll') {
            await dialog.getByRole('status').getByText('Yêu cầu đang chờ xử lý…').waitFor();
            await page.clock.runFor(1500);
          }
          await dialog.getByRole('status').getByText(failure === 'malformed-result' ? 'Phản hồi phải chứa một bài viết.' : message).waitFor();
          assert.equal(await dialog.locator('.close').isEnabled(), true);
          assert.equal(await dialog.locator('form').isVisible(), true);
          assert.equal(await write.isEnabled(), true);
          assert.equal(await dialog.locator('form').getAttribute('aria-busy'), 'false');
          assert.equal(await dialog.getByRole('progressbar').count(), 0, 'no animated progress remains accessible after an error');
          await assertVisualStopped(dialog);
          const elapsed = await dialog.locator('.writing-elapsed').textContent();
          await page.clock.runFor(2500);
          assert.equal(await dialog.locator('.writing-elapsed').textContent(), elapsed, 'failure stops the elapsed timer');
          await write.click();
          await assertStageVisual(dialog, 'waiting');
          releaseRetry();
          await dialog.getByRole('heading', { name: article.Title }).waitFor();
          await assertVisualStopped(dialog);
          if (failure === 'post') assert.equal(keys[0], keys[1], 'an uncertain POST retries with its original idempotency key');
          if (failure === 'failed-job') assert.notEqual(keys[0], keys[1], 'a terminal failed job starts a fresh task');
          if (failure === 'poll' || failure === 'malformed-result') assert.equal(posts, 1, 'an accepted job is fetched again instead of duplicated');
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden' });
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});

test('widget honors reduced motion while retaining visible waiting feedback', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
    let releasePost!: () => void;
    const heldPost = new Promise<void>(resolve => { releasePost = resolve; });
    let polls = 0;
    const stages = sceneStages.slice(1);
    const dialog = await fixture(page, async route => {
      if (route.request().method() === 'POST') {
        await heldPost;
        return route.fulfill({ status: 202, json: { job_id: ready.job_id, status: 'queued' } });
      }
      const stage = stages[polls++];
      return route.fulfill({ json: stage ? { ...ready, status: 'writing', writing_stage: stage } : ready });
    });
    await dialog.getByRole('button', { name: 'Viết ngay' }).click();
    await dialog.getByRole('heading', { name: 'Đang tạo bài viết của bạn' }).waitFor();
    await assertStageVisual(dialog, 'waiting', true);
    assert.equal(await dialog.locator('.writing-track').evaluate(element => getComputedStyle(element, '::after').animationName), 'none');
    assert.equal(await dialog.getByRole('progressbar').isVisible(), true);
    assert.equal(await dialog.locator('.close').isDisabled(), true);
    releasePost();
    await dialog.getByRole('status').getByText('Yêu cầu đang chờ xử lý…').waitFor();
    for (const stage of stages) {
      const nextPoll = page.waitForResponse(response => new URL(response.url()).pathname === `${endpoint}/${ready.job_id}`);
      await page.clock.runFor(1500);
      await nextPoll;
      await dialog.locator(`.writing-visual[data-stage="${stage}"]`).waitFor();
      await assertStageVisual(dialog, stage, true);
    }
    await page.clock.runFor(1500);
    await dialog.getByRole('heading', { name: article.Title }).waitFor();
    await assertVisualStopped(dialog);
  } finally {
    await browser.close();
  }
});
