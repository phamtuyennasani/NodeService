import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createSseDecoder, type SseEvent } from '../web/src/sse';

test('SSE decoder handles UTF-8 byte boundaries, CRLF, multiline payloads and event boundaries', () => {
  const events: SseEvent[] = [];
  const parser = createSseDecoder(event => events.push(event));
  const bytes = new TextEncoder().encode('\uFEFF: heartbeat\r\nevent: job.updated\r\ndata: Tiếng Việt\r\ndata: dòng hai\r\n\r\ndata:\n\nevent: discarded\n\ndata: next\r\rdata: incomplete');
  for (const byte of bytes) parser.push(Uint8Array.of(byte));
  parser.finish();
  assert.deepEqual(events, [
    { type: 'job.updated', data: 'Tiếng Việt\ndòng hai' },
    { type: 'message', data: '' },
    { type: 'message', data: 'next' },
  ]);
});

test('SSE decoder bounds individual lines and accumulated event data', () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  assert.throws(() => createSseDecoder(() => undefined, 32).push(encode(`data: ${'x'.repeat(40)}`)), RangeError);
  const parser = createSseDecoder(() => undefined, 32);
  parser.push(encode('data: 12345\ndata: 12345\n'));
  assert.throws(() => parser.push(encode('data: 12345\n')), RangeError);
  const heartbeats = createSseDecoder(() => undefined, 32);
  for (let index = 0; index < 100; index++) heartbeats.push(encode(': heartbeat\n\n'));
  assert.throws(() => createSseDecoder(() => undefined, 32).push(encode('data:\n'.repeat(20))), RangeError);
});

test('signed event transport reconnects with fresh proofs, stops auth failures and aborts on unsubscribe', async t => {
  const { outputFiles } = await build({
    stdin: {
      contents: `export {subscribeCrmEvents} from './web/src/sse';
        export {prepareBrowserLogin,setBrowserSession} from './web/src/browser-proof';`,
      resolveDir: process.cwd(), loader: 'ts',
    },
    bundle: true, format: 'iife', globalName: 'CrmEvents', platform: 'browser', write: false,
  });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Stream fixture</title>' }));
    await page.goto('https://crm.example/');
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.evaluate(() => { (window as any).__name = (value: unknown) => value; });
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.evaluate(async () => {
      const api = (window as any).CrmEvents;
      await api.prepareBrowserLogin();
      api.setBrowserSession({ browser_binding: 'b'.repeat(43), server_time: Date.now() });
      const state: any = (window as any).__sse = { calls: [], events: [], cancellations: 0, expired: 0, status: 200, stop: undefined, stream: undefined };
      window.addEventListener('crm-session-expired', () => state.expired++);
      window.fetch = async (input, init = {}) => {
        state.calls.push({ url: String(input), proof: new Headers(init.headers).get('x-crm-proof'), signal: init.signal });
        if (state.status !== 200) return new Response(JSON.stringify({ error: { code: 'session_required', message: 'Expired fixture' } }), { status: state.status, headers: { 'Content-Type': 'application/json' } });
        const stream = new ReadableStream({
          start(controller) { state.stream = controller; },
          cancel() { state.cancellations++; state.stream = undefined; },
        });
        init.signal?.addEventListener('abort', () => { state.aborted = true; }, { once: true });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
      };
      state.subscribe = () => {
        state.stop = api.subscribeCrmEvents('/jobs/events', {
          open: () => state.events.push(['open']), error: () => state.events.push(['error']),
          'job.updated': (data: string) => state.events.push(['job.updated', data]),
        });
      };
    });

    await t.test('receives split bytes and reconnects with a new proof', async () => {
      await page.evaluate(() => (window as any).__sse.subscribe());
      await page.waitForFunction(() => (window as any).__sse.calls.length === 1 && (window as any).__sse.stream);
      await page.evaluate(() => {
        const state = (window as any).__sse;
        const bytes = new TextEncoder().encode('event: job.updated\r\ndata: Tiếng\r\ndata: Việt\r\n\r\n');
        for (const byte of bytes) state.stream.enqueue(Uint8Array.of(byte));
      });
      await page.waitForFunction(() => (window as any).__sse.events.some((event: string[]) => event[0] === 'job.updated'));
      await page.evaluate(() => (window as any).__sse.stream.close());
      await page.waitForFunction(() => (window as any).__sse.events.at(-1)[0] === 'error');
      await page.clock.fastForward(999);
      assert.equal(await page.evaluate(() => (window as any).__sse.calls.length), 1);
      await page.clock.fastForward(1);
      await page.waitForFunction(() => (window as any).__sse.calls.length === 2);
      const result = await page.evaluate(() => {
        const state = (window as any).__sse;
        return { urls: state.calls.map((call: any) => call.url), proofs: state.calls.map((call: any) => call.proof), events: state.events };
      });
      assert.deepEqual(result.urls, ['/api/crm/jobs/events', '/api/crm/jobs/events']);
      assert.ok(result.proofs.every((proof: string) => proof?.split('.').length === 3));
      assert.notEqual(result.proofs[0], result.proofs[1]);
      assert.ok(result.events.some((event: string[]) => event[0] === 'job.updated' && event[1] === 'Tiếng\nViệt'));
    });

    await t.test('unsubscribe aborts active fetch and prevents reconnects', async () => {
      await page.evaluate(() => (window as any).__sse.stop());
      await page.waitForFunction(() => (window as any).__sse.cancellations === 1);
      await page.clock.fastForward(60_000);
      assert.deepEqual(await page.evaluate(() => ({ count: (window as any).__sse.calls.length, aborted: (window as any).__sse.aborted })), { count: 2, aborted: true });
    });

    for (const status of [401, 403]) await t.test(`HTTP ${status} stops automatic reconnect`, async () => {
      const before = await page.evaluate(value => { const state = (window as any).__sse; state.status = value; state.subscribe(); return state.calls.length; }, status);
      await page.waitForFunction(count => (window as any).__sse.calls.length === count + 1, before);
      await page.waitForFunction(() => (window as any).__sse.events.at(-1)[0] === 'error');
      await page.clock.fastForward(60_000);
      assert.equal(await page.evaluate(() => (window as any).__sse.calls.length), before + 1);
    });

    await t.test('transient failures back off exponentially up to thirty seconds and cleanup cancels retries', async () => {
      let count = await page.evaluate(() => { const state = (window as any).__sse; state.status = 503; state.subscribe(); return state.calls.length; });
      await page.waitForFunction(expected => (window as any).__sse.calls.length === expected + 1, count);
      count++;
      for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        await page.waitForFunction(() => (window as any).__sse.events.at(-1)[0] === 'error');
        await page.clock.fastForward(delay - 1);
        assert.equal(await page.evaluate(() => (window as any).__sse.calls.length), count);
        await page.clock.fastForward(1);
        await page.waitForFunction(expected => (window as any).__sse.calls.length === expected + 1, count);
        count++;
      }
      await page.waitForFunction(() => (window as any).__sse.events.at(-1)[0] === 'error');
      await page.evaluate(() => (window as any).__sse.stop());
      await page.clock.fastForward(60_000);
      assert.equal(await page.evaluate(() => (window as any).__sse.calls.length), count);
    });

    await t.test('a missing browser key stops without any fetch or retry', async () => {
      const empty = await browser.newPage();
      try {
        await empty.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>No browser key</title>' }));
        await empty.goto('https://fresh-crm.example/');
        await empty.clock.install();
        await empty.clock.pauseAt(new Date());
        await empty.addScriptTag({ content: outputFiles[0].text });
        await empty.evaluate(() => {
          (window as any).__name = (value: unknown) => value;
          const state = (window as any).__missing = { calls: 0, errors: 0 };
          window.fetch = async () => { state.calls++; throw new Error('Unexpected fixture fetch'); };
          (window as any).CrmEvents.subscribeCrmEvents('/jobs/events', { error: () => state.errors++ });
        });
        await empty.waitForFunction(() => (window as any).__missing.errors === 1);
        await empty.clock.fastForward(60_000);
        assert.deepEqual(await empty.evaluate(() => (window as any).__missing), { calls: 0, errors: 1 });
      } finally { await empty.close(); }
    });
    assert.equal(await page.evaluate(() => (window as any).__sse.expired), 1);
  } finally { await page.close(); await browser.close(); }
});
