import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { evaluateSeo } from '../src/worker/seo.js'

test('browser SEO script preserves the Laravel API and uses the same report as CRM', async () => {
  const { outputFiles } = await build({
    entryPoints: ['widget/seo-score.ts'],
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    bundle: true,
    write: false,
  })
  const window = {} as {
    SeoScore: {
      criteria: { key: string; label: string }[]
      limits: { metaDescription: { min: number; max: number } }
      evaluate: (value?: unknown) => Record<string, unknown>
      normalize: (value: unknown, locale?: string) => string
      slugify: (value: unknown) => string
      visibleText: (value: unknown) => string
    }
  }
  runInNewContext(outputFiles[0].text, { window, URL })
  const seo = window.SeoScore
  assert.equal(seo.normalize('  CÀ PHÊ  ', 'vi'), 'cà phê')
  assert.equal(seo.slugify('Cà phê đen'), 'ca-phe-den')
  assert.equal(seo.visibleText('<p>Cà phê</p><p>và&nbsp;trà</p>'), 'Cà phê và trà')
  assert.equal(seo.criteria.length, 21)
  assert.equal(seo.criteria[0].key, 'keywordNotUsed')
  assert.equal(seo.limits.metaDescription.min, 155)
  assert.equal(seo.evaluate().keywordPresent, false)

  const input = {
    locale: 'vi',
    keyword: 'cà phê',
    title: 'Cà phê pha tại nhà và cách chọn hương vị riêng',
    description: 'Cà phê ' + 'à'.repeat(149),
    slug: 'ca-phe',
    contentHtml: '<p>Mở đầu với cà phê ngon.</p><p><a href="//example.vn/huong-dan">Hướng dẫn</a></p>',
    siteHost: 'https://www.example.vn',
    sources: { name: false, desc: false, content: true, slug: true },
  }
  const { keyword, stats, summary, ...report } = JSON.parse(JSON.stringify(seo.evaluate(input)))
  const workerReport = evaluateSeo(
    { Title: input.title, Description: input.description, Slug: input.slug, Content: input.contentHtml },
    { keyword: input.keyword, siteUrl: input.siteHost },
  )
  assert.equal(keyword, input.keyword)
  assert.equal(typeof summary, 'string')
  assert.deepEqual(stats, {
    titleLength: workerReport.metrics.titleCharacters,
    descriptionLength: 156,
    contentLength: 8,
    permalinkLength: 6,
    keywordOccurrences: 1,
    keywordDensity: 12.5,
  })
  assert.deepEqual(report, workerReport)
})
