import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import test from 'node:test';

test('CRM article preview sanitizes untrusted stored HTML in a real browser', async t => {
  const { outputFiles } = await build({
    entryPoints: ['web/src/article-html.ts'], bundle: true, format: 'iife',
    globalName: 'ArticleHtml', platform: 'browser', write: false,
  });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const unexpected: string[] = [];
  try {
    await page.route('**/*', route => {
      if (route.request().url() === 'https://crm.example/preview') {
        return route.fulfill({ contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><main id="article"></main>' });
      }
      unexpected.push(route.request().url());
      return route.fulfill({ status: 204 });
    });
    await page.goto('https://crm.example/preview');
    await page.addScriptTag({ content: outputFiles[0].text });

    await t.test('removes active content, event handlers and unrelated attributes', async () => {
      const result = await page.evaluate(() => {
        const root = document.getElementById('article')!;
        root.innerHTML = (window as any).ArticleHtml.sanitizeArticleHtml(
          '<script>window.__articleAttack = true</script>' +
          '<svg onload="window.__articleAttack=true"><foreignObject><p>SVG payload</p></foreignObject></svg>' +
          '<iframe src="https://attacker.example/frame" srcdoc="<script>alert(1)</script>"></iframe>' +
          '<img src="https://attacker.example/pixel" onerror="window.__articleAttack=true">' +
          '<form action="https://attacker.example"><input autofocus onfocus="window.__articleAttack=true"></form>' +
          '<p onclick="window.__articleAttack=true" onmouseover="window.__articleAttack=true" id="clobber" class="injected" data-secret="1" aria-label="injected">Nội dung an toàn</p>',
        );
        return {
          activeElements: root.querySelectorAll('script,svg,math,iframe,img,form,input,object,embed,style,link').length,
          attributes: [...root.querySelectorAll('*')].flatMap(element => [...element.attributes].map(attribute => attribute.name)),
          text: root.textContent,
          executed: (window as any).__articleAttack === true,
        };
      });
      assert.equal(result.activeElements, 0);
      assert.deepEqual(result.attributes, []);
      assert.match(result.text ?? '', /Nội dung an toàn/);
      assert.equal(result.executed, false);
    });

    await t.test('removes dangerous and protocol-relative link targets', async () => {
      const hrefs = [
        'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java&#x0A;script:alert(1)',
        'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)',
        '//attacker.example/path', '  //attacker.example/path',
        '/\\attacker.example/path', '\\\\attacker.example/path',
        '/&#x09;/attacker.example/path', '/&#x0a;/attacker.example/path',
      ];
      for (const href of hrefs) {
        const actual = await page.evaluate(value => {
          const html = (window as any).ArticleHtml.sanitizeArticleHtml(`<a href="${value}">Link</a>`);
          const root = document.getElementById('article')!;
          root.innerHTML = html;
          return root.querySelector('a')?.getAttribute('href') ?? null;
        }, href);
        assert.equal(actual, null, `unsafe href survived: ${href}`);
      }
    });

    await t.test('retains article structure, safe links and presentational table styles', async () => {
      const result = await page.evaluate(() => {
        const root = document.getElementById('article')!;
        root.innerHTML = (window as any).ArticleHtml.sanitizeArticleHtml(
          '<h2>Hướng dẫn</h2><h3>So sánh</h3><p><strong>Đậm</strong> và <em>nghiêng</em><br>nội dung.</p>' +
          '<ul><li>Mục một</li></ul><blockquote>Trích dẫn</blockquote><pre><code>const safe = 1;</code></pre><hr>' +
          '<a href="https://docs.example/guide?q=1" title="Tài liệu">HTTPS</a>' +
          '<a href="http://docs.example/guide">HTTP</a><a href="mailto:help@example.com">Email</a>' +
          '<a href="/bai-viet">Nội bộ</a><a href="#phan-hai">Mục</a>' +
          '<table style="width:100%;border-collapse:collapse;table-layout:fixed"><thead><tr>' +
          '<th scope="col" style="text-align:left;background-color:#f0f0f0;padding:8px;border:1px solid #ddd">Tiêu chí</th>' +
          '</tr></thead><tbody><tr><td colspan="2" rowspan="1" style="color:#123456;font-weight:bold;vertical-align:top">Giá trị</td></tr></tbody></table>',
        );
        const table = root.querySelector('table')!;
        const heading = root.querySelector('th')!;
        const cell = root.querySelector('td')!;
        return {
          tags: [...root.querySelectorAll('*')].map(element => element.tagName.toLowerCase()),
          links: [...root.querySelectorAll('a')].map(element => ({ href: element.getAttribute('href'), title: element.getAttribute('title') })),
          table: { width: table.style.width, borderCollapse: table.style.borderCollapse, layout: table.style.tableLayout },
          heading: { scope: heading.scope, align: heading.style.textAlign, padding: heading.style.padding, border: heading.style.border },
          cell: { colspan: cell.colSpan, rowspan: cell.rowSpan, color: cell.style.color, weight: cell.style.fontWeight, vertical: cell.style.verticalAlign },
        };
      });
      for (const tag of ['h2', 'h3', 'p', 'strong', 'em', 'br', 'ul', 'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td']) {
        assert.ok(result.tags.includes(tag), `safe article tag missing: ${tag}`);
      }
      assert.deepEqual(result.links, [
        { href: 'https://docs.example/guide?q=1', title: 'Tài liệu' },
        { href: 'http://docs.example/guide', title: null },
        { href: 'mailto:help@example.com', title: null },
        { href: '/bai-viet', title: null }, { href: '#phan-hai', title: null },
      ]);
      assert.deepEqual(result.table, { width: '100%', borderCollapse: 'collapse', layout: 'fixed' });
      assert.deepEqual(result.heading, { scope: 'col', align: 'left', padding: '8px', border: '1px solid rgb(221, 221, 221)' });
      assert.deepEqual(result.cell, { colspan: 2, rowspan: 1, color: 'rgb(18, 52, 86)', weight: 'bold', vertical: 'top' });
    });

    await t.test('removes CSS URLs, expressions, variables, positioning and parser tricks', async () => {
      const result = await page.evaluate(() => {
        const root = document.getElementById('article')!;
        root.innerHTML = (window as any).ArticleHtml.sanitizeArticleHtml(
          '<p style="color:#123456;text-align:center;padding:8px;background:url(https://attacker.example/pixel);width:expression(alert(1));position:fixed;top:0;left:0;z-index:999999;--secret:red;border-image:url(https://attacker.example/border);font-size:var(--secret);behavior:url(https://attacker.example/css);font-family:evil/*comment*/;margin:\\31px">Nội dung</p>' +
          '<span style="position:fixed;background:url(https://attacker.example/other)">Không có style hợp lệ</span>',
        );
        const paragraph = root.querySelector('p')!;
        return { style: paragraph.getAttribute('style'), color: paragraph.style.color, align: paragraph.style.textAlign, padding: paragraph.style.padding, unsafeOnly: root.querySelector('span')!.getAttribute('style') };
      });
      assert.equal(result.style, 'color:#123456;text-align:center;padding:8px');
      assert.equal(result.color, 'rgb(18, 52, 86)');
      assert.equal(result.align, 'center');
      assert.equal(result.padding, '8px');
      assert.equal(result.unsafeOnly, null);
    });

    assert.deepEqual(unexpected, [], 'untrusted article HTML must not initiate resource requests');
  } finally {
    await page.close();
    await browser.close();
  }
});
