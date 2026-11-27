import assert from 'node:assert/strict'
import test from 'node:test'
import type { Config } from '../src/config.js'
import type { Database } from '../src/db.js'
import { digest } from '../src/security.js'
import { buildWidgetPreviewApp } from '../src/widget-preview-app.js'

const origin = 'https://widget.example.test'
const site = { _id: '11111111-1111-4111-8111-111111111111', customer_id: 'customer', name: 'Demo', domain: 'example.test' }
const customer = { _id: 'customer', key_mode: 'service', name: 'Khách demo', allowed_models: [], max_length: 1500 }
const config = { production: true } as Config
const options = { origin, siteId: site._id, csrfToken: 'c'.repeat(43), passwordHash: digest('demo:fixture-password') }
const authorization = 'Basic ' + Buffer.from('demo:fixture-password').toString('base64')

test('public demo rejects missing authentication, foreign origins, bad CSRF and jobs outside its website', async t => {
  let jobQuery: unknown
  const db = { db: {
    command: async () => ({ ok: 1 }),
    collection: (name: string) => ({
      findOne: async (query: unknown) => {
        if (name === 'sites') return site
        if (name === 'customers') return customer
        if (name === 'jobs') { jobQuery = query; return null }
        throw new Error('Unexpected collection: ' + name)
      },
      find: () => ({ toArray: async () => [] }),
    }),
  } } as unknown as Database
  const app = await buildWidgetPreviewApp(db, config, options)
  t.after(() => app.close())
  const base = { host: 'widget.example.test', authorization }
  assert.equal((await app.inject({ url: '/', headers: { host: base.host } })).statusCode, 401)
  assert.equal((await app.inject({ method: 'POST', url: '/admin/ai/previews', headers: { host: base.host }, payload: {} })).statusCode, 401)
  assert.equal((await app.inject({ url: '/', headers: { ...base, host: 'attacker.test' } })).statusCode, 403)
  const page = await app.inject({ url: '/', headers: base })
  assert.equal(page.statusCode, 200)
  assert.match(page.body, /preview\/editor.js/)
  assert.match(page.body, new RegExp(options.csrfToken))
  for (const url of ['/admin/ai/models', '/preview/editor.js', '/widget/v1/ai-writer.js']) {
    assert.equal((await app.inject({ url, headers: { host: base.host } })).statusCode, 401)
  }
  const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/admin/ai/previews', headers: { ...base, ...headers }, payload: {} })
  assert.equal((await post({ origin: 'https://attacker.test', 'x-csrf-token': options.csrfToken })).statusCode, 403)
  assert.equal((await post({ origin, 'x-csrf-token': 'wrong' })).statusCode, 403)
  const admitted = await post({ origin, 'x-csrf-token': options.csrfToken })
  assert.equal(admitted.statusCode, 400, 'valid authentication and shared CSRF reach input validation without creating an AI job')
  const id = '22222222-2222-4222-8222-222222222222'
  assert.equal((await app.inject({ url: '/admin/ai/previews/' + id, headers: base })).statusCode, 404)
  assert.deepEqual(jobQuery, { _id: id, site_id: site._id, customer_id: site.customer_id })
  await assert.rejects(buildWidgetPreviewApp(db, config, { ...options, passwordHash: undefined }), /requires HTTPS and demo authentication/)
})
