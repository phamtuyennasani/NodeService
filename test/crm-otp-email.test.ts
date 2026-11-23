import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDocument } from 'htmlparser2';
import { renderCrmOtpEmail } from '../src/crm-otp-email.js';

const purposes = ['login', 'email_current', 'email_new'] as const;
const subjects = {
  login: 'Mã xác thực đăng nhập CRM',
  email_current: 'Xác nhận thay đổi email tài khoản CRM',
  email_new: 'Xác minh email tài khoản CRM',
};

function bodyText(html: string): string {
  const nodes = [...parseDocument(html).children];
  const text: string[] = [];
  while (nodes.length) {
    const node = nodes.shift()!;
    if (node.type === 'text') text.push(node.data);
    else if ('children' in node && !['head', 'style', 'script'].includes('name' in node ? node.name : '')) {
      nodes.unshift(...node.children);
    }
  }
  return text.join(' ').replace(/\s+/g, ' ').trim();
}

test('all OTP purposes have a branded, readable HTML email and an equally informative text fallback', () => {
  for (const purpose of purposes) {
    const rendered = renderCrmOtpEmail({ code: '12345678', purpose });
    assert.equal(rendered.subject, subjects[purpose]);
    assert.ok(!rendered.subject.includes('12345678'));
    const htmlText = bodyText(rendered.html);
    for (const content of [rendered.text, htmlText]) {
      assert.match(content, /Bàn biên tập/);
      assert.equal(content.match(/12345678/g)?.length, 1, 'OTP stays contiguous and appears once per alternative');
      assert.match(content, /10 phút/);
      assert.match(content, /CRM/);
      assert.match(content, /một lần|1 lần/i);
      assert.match(content, /không chia sẻ/i);
      assert.match(content, /nếu bạn không/i);
    }
    assert.match(rendered.html, /<html\b[^>]*\blang=["']vi["']/i);
    assert.match(rendered.html, /<meta\b[^>]*\bname=["']viewport["']/i);
    assert.match(rendered.html, /<table\b[^>]*\brole=["']presentation["']/i);
    assert.match(rendered.html, /style=["'][^"']*font-family:/i);
  }
});

test('OTP email instructions distinguish login, current-email confirmation and new-email verification', () => {
  const [login, currentEmail, newEmail] = purposes.map(purpose => renderCrmOtpEmail({ code: '12345678', purpose }));
  assert.match(login!.text, /đăng nhập/i);
  assert.match(currentEmail!.text, /thay đổi email/i);
  assert.match(newEmail!.text, /xác minh email/i);
  assert.equal(new Set([login!.text, currentEmail!.text, newEmail!.text]).size, purposes.length);
  assert.equal(new Set([login!.html, currentEmail!.html, newEmail!.html]).size, purposes.length);
});

test('OTP HTML is self-contained and contains no executable or remotely loaded resources', () => {
  for (const purpose of purposes) {
    const { html } = renderCrmOtpEmail({ code: '12345678', purpose });
    assert.doesNotMatch(html, /<(?:script|iframe|object|embed|link|form|input|button)\b/i);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
    assert.doesNotMatch(html, /\b(?:src|srcset)\s*=/i);
    assert.doesNotMatch(html, /url\s*\(/i);
    assert.doesNotMatch(html, /(?:javascript|data|https?):/i);
  }
});

test('template rejects malformed OTPs and unknown purposes before generating content', () => {
  for (const code of ['', '1234567', '123456789', '1234 5678', '<script>', '１２３４５６７８', '1234567\n']) {
    assert.throws(() => renderCrmOtpEmail({ code, purpose: 'login' }), TypeError);
  }
  for (const purpose of ['<img src=x>', '__proto__', 'constructor', 'toString']) {
    assert.throws(() => renderCrmOtpEmail({ code: '12345678', purpose: purpose as 'login' }), TypeError);
  }
});
