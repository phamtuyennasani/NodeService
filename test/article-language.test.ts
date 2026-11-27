import assert from 'node:assert/strict'
import test from 'node:test'
import { languageConfig, languageTag } from '../src/language-config.js'
import { validateWritingLanguage, translationSourceSchema } from '../src/article-language.js'
import { cleanArticle, generateArticle, type GenerateInput } from '../src/worker/provider.js'
import { evaluateSeo } from '../src/worker/seo.js'

test('language configuration accepts non-Vietnamese sources and canonical regional tags, rejecting ambiguous targets', () => {
  assert.deepEqual(languageConfig({ source: 'EN-us', targets: ['vi', 'zh-hant', 'ar'] }), { source: 'en-US', targets: ['vi', 'zh-Hant', 'ar'] })
  for (const config of [{ source: 'en', targets: ['EN'] }, { source: 'en', targets: ['vi', 'VI'] }, { source: 'en', targets: Array(11).fill('vi') }, { source: 'en', targets: [], extra: true }]) {
    assert.throws(() => languageConfig(config))
  }
  for (const locale of ['en_US', 'en\nignore', 'und', '', 'en-u-ca-gregory']) assert.throws(() => languageTag(locale))
  assert.doesNotThrow(() => validateWritingLanguage({}))
  assert.throws(() => validateWritingLanguage({ locale: 'en' }))
  const languages = { source: 'ja', targets: ['en', 'vi'] }
  assert.throws(() => validateWritingLanguage({ languages, locale: 'fr' }))
  assert.throws(() => validateWritingLanguage({ languages, locale: 'en' }))
  const translation_source = translationSourceSchema.parse({ Title: '原稿', Content: '<p>元の内容</p>' })
  assert.doesNotThrow(() => validateWritingLanguage({ languages, locale: 'en', translation_source }))
  assert.throws(() => validateWritingLanguage({ languages, locale: 'ja', translation_source }))
})

test('provider receives explicit output language and approved source without generating other configured languages', async () => {
  const translated = { Title: '日本語の記事', Content: '<p>確認済みの内容です。</p>', Slug: '日本語の記事', Desc: '説明', Description: '記事の説明', Keywords: ['記事'] }
  const input: GenerateInput = {
    provider: 'openai', key: 'fixture', model: 'fixture', keyword: 'article', tone: 'clear', style: 'guide', length: 800,
    instructions: null, source: null, signal: new AbortController().signal,
    languages: { source: 'en', targets: ['ja', 'vi'] }, locale: 'ja',
    translationSource: { Title: 'Approved article', Content: '<p>The reviewed text is version two.</p>' },
  }
  const result = await generateArticle(input, async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    assert.match(request.instructions, /Ngôn ngữ kết quả bắt buộc là ja/)
    assert.match(request.instructions, /Không nghiên cứu lại/)
    assert.match(request.instructions, /phiên âm theo cách đọc của ngôn ngữ đích/)
    const prompt = JSON.parse(request.input)
    assert.equal(prompt.ngôn_ngữ_bản_gốc, 'en')
    assert.equal(prompt.ngôn_ngữ_kết_quả, 'ja')
    assert.deepEqual(prompt.ngôn_ngữ_đích_của_website, ['ja', 'vi'])
    assert.deepEqual(prompt.bản_gốc_đã_duyệt, input.translationSource)
    return new Response(JSON.stringify({ output_text: JSON.stringify(translated) }), { headers: { 'Content-Type': 'application/json' } })
  })
  assert.deepEqual(result.article, { ...translated, Slug: 'approved-article' })
  assert.equal(cleanArticle({ ...translated, Slug: 'دليل-المحتوى' }).Slug, 'دليل-المحتوى')
  assert.equal(cleanArticle({ ...translated, Slug: 'ガイド' }).Slug, 'ガイド')
  const report = evaluateSeo({ ...translated, Content: '<p>日本語の記事を書くためのガイドです。</p>' }, { keyword: '記事', locale: 'ja' })
  assert.ok(report.metrics.words > 2, 'Japanese text is segmented rather than counted as one whitespace token')
})
