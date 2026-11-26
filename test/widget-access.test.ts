import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import test from 'node:test'
import { sameWidgetToken, widgetOrigin, widgetReadToken, widgetSignature } from '../src/widget-access.js'

test('widget origins match the canonical host and port without trusting sibling domains or unsafe schemes', () => {
  assert.equal(widgetOrigin('https://example.com', 'example.com'), 'https://example.com')
  assert.equal(widgetOrigin('https://example.com:8443', 'example.com:8443'), 'https://example.com:8443')
  assert.equal(widgetOrigin('https://example.com', 'example.com:8443'), null)
  for (const origin of ['http://example.com', 'https://www.example.com', 'https://example.com.attacker.com', 'https://example.com/', 'https://user@example.com', 'null', 'file://example.com']) {
    assert.equal(widgetOrigin(origin, 'example.com', true), null, origin)
  }
  for (const domain of ['localhost:8000', '127.0.0.1:8000', '[::1]:8000', 'basecodeaw.test']) {
    assert.equal(widgetOrigin(`http://${domain}`, domain), null)
    assert.equal(widgetOrigin(`http://${domain}`, domain, true), `http://${domain}`)
  }
})

test('widget grants use the documented PHP-compatible HMAC and read tokens bind site, customer, origin and job', () => {
  const hash = createHash('sha256').update('fixture-site-token').digest('hex')
  const signature = widgetSignature(hash, 'site-id', 'https://example.com', '2000000000')
  assert.equal(signature, createHmac('sha256', hash).update('widget\nsite-id\nhttps://example.com\n2000000000').digest('hex'))
  assert.equal(sameWidgetToken(signature, signature), true)
  for (const value of [undefined, null, '', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), signature.toUpperCase(), ['a'.repeat(64)]]) {
    assert.equal(sameWidgetToken(value, signature), false)
  }
  const base = widgetReadToken(hash, 'site', 'customer', 'https://example.com', 'job')
  for (const changed of [
    widgetReadToken(hash, 'another-site', 'customer', 'https://example.com', 'job'),
    widgetReadToken(hash, 'site', 'another-customer', 'https://example.com', 'job'),
    widgetReadToken(hash, 'site', 'customer', 'https://another.example.com', 'job'),
    widgetReadToken(hash, 'site', 'customer', 'https://example.com', 'another-job'),
    widgetReadToken(createHash('sha256').update('rotated-site-token').digest('hex'), 'site', 'customer', 'https://example.com', 'job'),
  ]) assert.equal(sameWidgetToken(changed, base), false)
})
