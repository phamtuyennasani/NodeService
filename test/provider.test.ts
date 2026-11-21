import test from 'node:test'
import assert from 'node:assert/strict'
import { cleanArticle, generateArticle, generateOutline, repairArticle, type GenerateInput, type RepairInput } from '../src/worker/provider.js'
import { researchTopic } from '../src/worker/research.js'

function assertOriginalWritingPolicy(value: unknown) {
  const prompt = String(value)
  assert.match(prompt, /tư liệu để lấy dữ kiện, thuật ngữ và bối cảnh/)
  assert.match(prompt, /góc tiếp cận và dàn ý độc lập/)
  assert.match(prompt, /Không sao chép câu văn, tiêu đề phụ, bố cục hoặc thứ tự triển khai của nguồn/)
  assert.match(prompt, /không chỉ thay từ đồng nghĩa, dịch lại hay nối các đoạn diễn giải sát từng nguồn/)
  assert.match(prompt, /không sáng tác dữ kiện/)
  assert.match(prompt, /tình huống giả định/)
  assert.match(prompt, /Không thêm mục “Nguồn tham khảo”, “Tài liệu tham khảo”, “References”, danh sách nguồn/)
  assert.match(prompt, /URL và tên nguồn là dữ liệu đối chiếu nội bộ/)
  assert.doesNotMatch(prompt, /hãy thêm cuối Content một mục h2/)
}

test('cleanArticle normalizes legacy article field names for reading and rewriting', () => {
  const article = cleanArticle({
    Title: 'Bài cũ', Content: '<p>Nội dung cũ.</p>', Slug: 'bai-cu', Desc: 'Tóm tắt cũ.',
    Desction: 'Mô tả SEO cũ.', 'Từ khóa': ['bài cũ'],
  })
  assert.deepEqual(article, {
    Title: 'Bài cũ', Content: '<p>Nội dung cũ.</p>', Slug: 'bai-cu', Desc: 'Tóm tắt cũ.',
    Description: 'Mô tả SEO cũ.', Keywords: ['bài cũ'],
  })
})

test('OpenAI Compatible generation assembles JSON from SSE chunks', async () => {
  const article = {
    Title: 'Bài viết thử nghiệm',
    Content: '<p>Nội dung bài viết.</p>',
    Slug: 'bai-viet-thu-nghiem',
    Desc: 'Mô tả ngắn.',
    Description: 'Mô tả SEO.',
    Keywords: ['thử nghiệm'],
  }
  const encoded = JSON.stringify(article)
  const split = Math.floor(encoded.length / 2)
  const chunks = [
    { id: 'chatcmpl-test', model: 'test-model', choices: [{ delta: { content: encoded.slice(0, split) } }] },
    { choices: [{ delta: { content: encoded.slice(split) }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 9 } },
  ]
  const body = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  let requestBody: Record<string, unknown> | undefined
  const input: GenerateInput = {
    provider: 'openai-compatible',
    key: 'test-key',
    model: 'test-model',
    baseUrl: 'https://example.test/v1',
    keyword: 'thử nghiệm',
    tone: 'rõ ràng',
    style: 'hướng dẫn',
    length: 300,
    instructions: null,
    source: null,
    signal: new AbortController().signal,
  }
  const result = await generateArticle(input, async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  assert.equal(requestBody?.stream, true)
  const systemMessage = (requestBody?.messages as Array<Record<string, unknown>>)[0]
  assertOriginalWritingPolicy(systemMessage?.content)
  assert.match(String(systemMessage?.content), /ý định tìm kiếm/)
  assert.match(String(systemMessage?.content), /Meta description|meta description/i)
  assert.deepEqual(result.article, article)
  assert.deepEqual(result.usage, { input: 4, output: 9, cachedInput: 0, reasoning: undefined, costTicks: undefined })
  assert.equal(result.responseId, 'chatcmpl-test')
  assert.equal(result.model, 'test-model')
})

function input(provider: GenerateInput['provider']): GenerateInput {
  return {
    provider,
    key: 'test-key',
    model: 'test-model',
    baseUrl: provider === 'openai-compatible' ? 'https://example.test/v1' : undefined,
    keyword: 'thử nghiệm',
    tone: 'rõ ràng',
    style: 'hướng dẫn',
    length: 300,
    instructions: null,
    source: null,
    signal: new AbortController().signal,
  }
}

const streamArticle = JSON.stringify({
  Title: 'Bài viết stream',
  Content: '<p>Nội dung stream.</p>',
  Slug: 'bai-viet-stream',
  Desc: 'Mô tả ngắn.',
  Description: 'Mô tả SEO.',
  Keywords: ['stream'],
})

test('OpenAI Responses generation assembles SSE chunks and returns at response.completed', { timeout: 2_000 }, async () => {
  const midpoint = Math.floor(streamArticle.length / 2)
  const body = [
    { type: 'response.output_text.delta', delta: streamArticle.slice(0, midpoint) },
    { type: 'response.output_text.delta', delta: streamArticle.slice(midpoint) },
    { type: 'response.completed', response: { id: 'resp-test', model: 'gpt-test', usage: { input_tokens: 5, output_tokens: 7 }, status: 'completed' } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
  let requestBody: Record<string, unknown> | undefined
  let streamCancelled = false
  const result = await generateArticle(input('openai'), async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(body)) },
      cancel() { streamCancelled = true },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
  })
  assert.equal(requestBody?.stream, true)
  assert.equal(streamCancelled, true)
  assertOriginalWritingPolicy(requestBody?.instructions)
  assert.equal(result.responseId, 'resp-test')
  assert.equal(result.model, 'gpt-test')
  assert.equal(result.usage?.input, 5)
  assert.deepEqual(result.article, JSON.parse(streamArticle))
})

test('xAI Responses generation uses the streaming response format', async () => {
  const body = [
    { type: 'response.output_text.delta', delta: streamArticle },
    { type: 'response.completed', response: { id: 'xai-resp-test', model: 'grok-test', status: 'completed' } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
  let requestBody: Record<string, unknown> | undefined
  const result = await generateArticle(input('xai'), async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  assert.equal(requestBody?.stream, true)
  assertOriginalWritingPolicy(requestBody?.instructions)
  assert.equal(result.responseId, 'xai-resp-test')
  assert.equal(result.model, 'grok-test')
  assert.deepEqual(result.article, JSON.parse(streamArticle))
})

test('Anthropic Messages generation assembles content_block_delta SSE chunks', async () => {
  const midpoint = Math.floor(streamArticle.length / 2)
  const body = [
    { type: 'message_start', message: { id: 'msg-test', model: 'claude-test', usage: { input_tokens: 6 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: streamArticle.slice(0, midpoint) } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: streamArticle.slice(midpoint) } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')
  let requestBody: Record<string, unknown> | undefined
  const result = await generateArticle(input('anthropic'), async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  assert.equal(requestBody?.stream, true)
  assertOriginalWritingPolicy(requestBody?.system)
  assert.equal(result.responseId, 'msg-test')
  assert.equal(result.model, 'claude-test')
  assert.equal(result.usage?.input, 6)
  assert.equal(result.usage?.output, 8)
  assert.deepEqual(result.article, JSON.parse(streamArticle))
})

test('generation injects bounded web research into the writing prompt', async () => {
  const body = [
    { choices: [{ delta: { content: streamArticle } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'
  let requestBody: Record<string, unknown> | undefined
  const articleInput = input('openai-compatible')
  articleInput.research = {
    query: 'cà phê cold brew',
    researchedAt: '2026-11-20T00:00:00.000Z',
    sources: [{ title: 'Cold brew guide', url: 'https://example.test/cold-brew', snippet: 'Ngâm cà phê trong nước lạnh từ 12 đến 24 giờ.' }],
  }
  await generateArticle(articleInput, async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  const messages = requestBody?.messages as Array<Record<string, unknown>>
  assertOriginalWritingPolicy(messages[0]?.content)
  const userPrompt = String(messages[1]?.content)
  assert.deepEqual(JSON.parse(userPrompt).nghiên_cứu_web, articleInput.research)
})

test('rewriting uses source material with the same originality policy and preserves extra instructions', async () => {
  const articleInput = input('openai-compatible')
  articleInput.source = {
    ...JSON.parse(streamArticle),
    Content: '<h2>Cấu trúc của bài cũ</h2><p>Dữ kiện cần giữ đúng.</p><h2>Nguồn tham khảo</h2><ul><li><a href="https://example.test/source">Nguồn cũ</a></li></ul>',
  }
  articleInput.instructions = 'Bổ sung hướng dẫn thực hành và CSS inline cho bảng.'
  let requestBody: Record<string, unknown> | undefined
  const result = await generateArticle(articleInput, async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: streamArticle } }] })}\n\ndata: [DONE]\n\n`
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  })
  const messages = requestBody?.messages as Array<Record<string, unknown>>
  assertOriginalWritingPolicy(messages[0]?.content)
  assert.match(String(messages[0]?.content), /không mang theo mục nguồn hay danh sách tham khảo của bản cũ/)
  assert.match(String(messages[0]?.content), /phải đặt CSS inline bằng thuộc tính style/)
  const userPrompt = JSON.parse(String(messages[1]?.content))
  assert.deepEqual(userPrompt.bài_tham_chiếu, articleInput.source)
  assert.equal(userPrompt.yêu_cầu_bổ_sung, articleInput.instructions)
  assert.equal(userPrompt.tác_vụ, 'Viết lại bài bằng văn phong và cấu trúc mới')
  assert.deepEqual(result.article, JSON.parse(streamArticle))
})

test('provider streams a structured outline, drops unknown evidence references, and passes it into writing', async () => {
  const articleInput = input('openai')
  articleInput.instructions = 'Giải thích bằng ví dụ thực hành.'
  articleInput.research = {
    query: 'cà phê cold brew',
    researchedAt: '2026-11-20T00:00:00.000Z',
    sources: [{ title: 'Hướng dẫn pha', url: 'https://example.test/pha', snippet: 'Cà phê được ngâm trong nước lạnh.' }],
  }
  const outline = {
    title: 'Cà phê cold brew: cách pha dễ áp dụng tại nhà',
    searchIntent: 'Cách pha',
    audience: 'Người mới bắt đầu',
    angle: 'Dùng dụng cụ sẵn có ở nhà',
    questions: ['Nên dùng nước ở nhiệt độ nào?'],
    sections: [{
      heading: 'Chuẩn bị cà phê và nước',
      purpose: 'Giải thích cách chuẩn bị',
      estimatedWords: 250,
      subheadings: [],
      evidence: [{ sourceIndex: 1, fact: 'Dùng nước lạnh.' }, { sourceIndex: 2, fact: 'Không có nguồn cho nhận định này.' }],
    }],
  }
  const requests: Array<Record<string, unknown>> = []
  const answer = (value: string) => async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)))
    return new Response([
      { type: 'response.output_text.delta', delta: value },
      { type: 'response.completed', response: { id: 'resp-test', status: 'completed', usage: { input_tokens: 8, output_tokens: 10 } } },
    ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''))
  }
  const result = await generateOutline(articleInput, answer(JSON.stringify(outline)))
  assert.equal(result.responseId, 'resp-test')
  assert.equal(result.usage?.output, 10)
  assert.deepEqual(result.outline.sections[0]?.evidence, [outline.sections[0]?.evidence[0]])
  await generateArticle({ ...articleInput, outline: result.outline }, answer(streamArticle))

  assert.equal(requests[0]?.stream, true)
  assert.match(JSON.stringify(requests[0]?.text), /article_outline/)
  assert.deepEqual(JSON.parse(String(requests[0]?.input)).nghiên_cứu_web, articleInput.research)
  assert.equal(JSON.parse(String(requests[0]?.input)).yêu_cầu_bổ_sung, articleInput.instructions)
  assert.deepEqual(JSON.parse(String(requests[1]?.input)).dàn_ý_nội_bộ, result.outline)
  assert.match(String(requests[1]?.instructions), /155\s*[–-]\s*160/)
})

test('outline parsing accepts optional empty arrays, common aliases, numeric strings and extra provider fields', async () => {
  const generationInput = input('openai')
  const result = await generateOutline(generationInput, async () => new Response([
    { type: 'response.output_text.delta', delta: JSON.stringify({
      title: 'Dàn ý tối giản', search_intent: 'Tìm hướng dẫn', targetAudience: 'Người mới', approach: 'Giải thích theo bước',
      key_questions: [], sections: [{ title: 'Bắt đầu', description: 'Nêu bước đầu tiên', estimated_words: '300', h3: [] }], provider_note: 'ignore',
    }) },
    { type: 'response.completed', response: { id: 'outline-aliases', status: 'completed' } },
  ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('')))
  assert.equal(result.outline.searchIntent, 'Tìm hướng dẫn')
  assert.deepEqual(result.outline.questions, [])
  assert.deepEqual(result.outline.sections[0], {
    heading: 'Bắt đầu', purpose: 'Nêu bước đầu tiên', estimatedWords: 300, subheadings: [], evidence: [],
  })
})

test('outline parsing falls back to a valid plan when the provider wraps or damages its JSON', async () => {
  const generationInput = input('openai-compatible')
  const result = await generateOutline(generationInput, async () => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Đây là dàn ý: {"title":' } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: ' "Dàn ý"}' } }] })}\n\n` +
    'data: [DONE]\n\n',
  ))
  assert.match(result.outline.title, /Dàn ý|Hướng dẫn/)
  assert.ok(result.outline.sections.length >= 1)
  assert.ok(result.outline.sections.every(section => section.estimatedWords > 0))
})

function compatibleStream(value: unknown) {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(value) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
}

test('metadata repair limits the JSON patch and keeps the original HTML', async () => {
  const draft = { ...JSON.parse(streamArticle), Content: '<p style="text-align: center">Giữ định dạng này.</p>' }
  const repairInput: RepairInput = {
    ...input('openai-compatible'),
    draft,
    issues: [{ key: 'lengthTitle', message: 'Dùng từ 41 đến 70 ký tự.' }],
  }
  const Title = 'Tiêu đề đã được sửa để người đọc dễ nắm nội dung'
  const result = await repairArticle(repairInput, async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    const prompt = JSON.parse(request.messages[1].content)
    assert.equal(request.stream, true)
    assert.ok(request.max_tokens < 1_024)
    assert.deepEqual(prompt.trường_được_phép_sửa, ['Title'])
    assert.equal(prompt.bản_nháp.Content, undefined)
    return compatibleStream({ Title })
  })
  assert.deepEqual(result.article, { ...draft, Title })
  await assert.rejects(repairArticle(repairInput, async () => compatibleStream({ Title, Content: '<p>Bị sửa ngoài phạm vi.</p>' })), { code: 'AI_REPAIR' })
})

test('content repair preserves safe inline formatting and existing URLs', async () => {
  const Content = '<table style="width:100%"><tbody><tr><td style="padding:8px">Thử nghiệm</td></tr></tbody></table><p><a href="/huong-dan">Xem hướng dẫn</a></p>'
  const draft = { ...JSON.parse(streamArticle), Content }
  const repairInput: RepairInput = {
    ...input('openai-compatible'),
    draft,
    issues: [{ key: 'keywordInSubheadings', message: 'Đưa từ khóa vào một đề mục.' }],
  }
  const improved = '<h2>Thử nghiệm với một bảng đơn giản</h2>' + Content
  const accepted = await repairArticle(repairInput, async () => compatibleStream({ Content: improved }))
  assert.match(accepted.article.Content, /^<h2>/)
  assert.match(accepted.article.Content, /style="padding:8px"/)
  for (const unsafeChange of [improved.replace(' style="padding:8px"', ''), improved.replace('/huong-dan', '/tu-tao-url')]) {
    const retained = await repairArticle(repairInput, async () => compatibleStream({ Content: unsafeChange }))
    assert.equal(retained.article.Content, Content)
  }
})

test('researchTopic parses search results and fails open on search errors', async () => {
  const html = `
    <a class="result__a" href="https://example.test/a?x=1&amp;y=2">Kết quả A</a>
    <div class="result__snippet">Thông tin A hữu ích.</div>
    <a class="result__a" href="https://example.test/a?x=1&amp;y=2">Trùng lặp</a>
    <div class="result__snippet">Không lấy bản trùng.</div>
  `
  const context = await researchTopic('cà phê', { enabled: true, provider: 'duckduckgo', timeoutMs: 1_000, maxResults: 5 }, async () => new Response(html))
  assert.equal(context?.sources.length, 1)
  assert.equal(context?.sources[0]?.url, 'https://example.test/a?x=1&y=2')
  assert.equal(context?.sources[0]?.snippet, 'Thông tin A hữu ích.')

  const unavailable = await researchTopic('cà phê', { enabled: true, provider: 'duckduckgo', timeoutMs: 1_000, maxResults: 5 }, async () => { throw new Error('offline') })
  assert.equal(unavailable, null)
})
