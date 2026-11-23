import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import test from 'node:test';
import nodemailer from 'nodemailer';
import { loadMailConfig, type Config } from '../src/config.js';
import { ApiError } from '../src/api/errors.js';
import { isCrmMailConfigured, sendCrmOtp, verifyCrmMailConnection } from '../src/mail.js';
import { renderCrmOtpEmail } from '../src/crm-otp-email.js';

function alternativeParts(message: string): Map<string, string> {
  const boundary = /boundary="([^"]+)"/i.exec(message)?.[1];
  assert.ok(boundary, 'email must declare a MIME boundary');
  const parts = new Map<string, string>();
  for (const part of message.split(`--${boundary}`).slice(1)) {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const headers = part.slice(0, separator);
    const type = /Content-Type:\s*([^;\r\n]+)/i.exec(headers)?.[1]?.toLowerCase();
    if (!type) continue;
    const content = part.slice(separator + 4).replace(/\r\n$/, '');
    const encoding = /Content-Transfer-Encoding:\s*([^\r\n]+)/i.exec(headers)?.[1]?.toLowerCase();
    let decoded: string;
    if (encoding === 'base64') decoded = Buffer.from(content, 'base64').toString('utf8');
    else if (encoding === 'quoted-printable') {
      const encoded = content.replace(/=\r\n/g, '');
      const bytes: number[] = [];
      for (let index = 0; index < encoded.length; index++) {
        if (encoded[index] === '=' && /^[0-9a-f]{2}$/i.test(encoded.slice(index + 1, index + 3))) {
          bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
          index += 2;
        } else bytes.push(encoded.charCodeAt(index));
      }
      decoded = Buffer.from(bytes).toString('utf8');
    } else decoded = content;
    assert.ok(!parts.has(type), `duplicate MIME alternative: ${type}`);
    parts.set(type, decoded.replace(/\r\n/g, '\n').trimEnd());
  }
  return parts;
}

async function smtpFixture(t: { after(fn: () => Promise<void>): void }, reject = false, auth: 'none' | 'reject' = 'none') {
  const messages: string[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 localhost synthetic SMTP\r\n');
    let input = ''; let message = ''; let inData = false;
    socket.on('data', bytes => {
      input += bytes.toString();
      while (input.includes('\r\n')) {
        const offset = input.indexOf('\r\n');
        const line = input.slice(0, offset); input = input.slice(offset + 2);
        if (inData) {
          if (line === '.') { messages.push(message); message = ''; inData = false; socket.write('250 accepted\r\n'); }
          else message += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
          continue;
        }
        commands.push(line.split(' ')[0]);
        if (/^EHLO|^HELO/.test(line)) socket.write(`250-localhost\r\n${auth === 'reject' ? '250-AUTH PLAIN\r\n' : ''}250 SIZE 100000\r\n`);
        else if (line === 'STARTTLS') socket.write('454 TLS unavailable in synthetic fixture\r\n');
        else if (line.startsWith('AUTH ')) socket.write('535 synthetic rejection\r\n');
        else if (line.startsWith('MAIL FROM')) socket.write('250 sender accepted\r\n');
        else if (line.startsWith('RCPT TO')) socket.write(reject ? '550 synthetic rejection\r\n' : '250 recipient accepted\r\n');
        else if (line === 'DATA') { inData = true; socket.write('354 enter message\r\n'); }
        else if (line === 'QUIT') socket.end('221 closing\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('SMTP fixture did not listen');
  const config = { production: false, mail: { host: '127.0.0.1', port: address.port, secure: false,
    from: 'crm@example.test', allowInsecureLocal: true } } as Config;
  return { config, messages, commands };
}

function isSafeFailure(error: unknown): boolean {
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 503);
  assert.equal(error.code, 'mail_unavailable');
  assert.equal(error.cause, undefined);
  assert.ok(!JSON.stringify(error).includes('synthetic rejection'));
  assert.ok(!error.message.includes('12345678'));
  return true;
}

test('mail config is optional but validates TLS and loopback-only development exceptions', () => {
  assert.equal(loadMailConfig(false, {}), undefined);
  assert.equal(isCrmMailConfigured({} as Config), false);
  const base = { SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'crm@example.test' };
  assert.equal(loadMailConfig(true, base)?.secure, true);
  assert.equal(loadMailConfig(true, { ...base, SMTP_PORT: '587', SMTP_SECURE: 'false' })?.secure, false);
  for (const values of [
    { ...base, SMTP_HOST: 'https://smtp.example.test' },
    { ...base, SMTP_HOST: 'smtp.example.test\r\nBcc:evil@example.test' },
    { ...base, SMTP_PORT: '65536' },
    { ...base, SMTP_FROM: 'CRM <crm@example.test>' },
    { ...base, SMTP_FROM: 'crm@example.test\r\nBcc:evil@example.test' },
    { ...base, SMTP_SECURE: 'invalid' },
    { ...base, SMTP_USER: 'synthetic-user' },
    { ...base, SMTP_ALLOW_INSECURE_LOCAL: 'true' },
  ]) assert.throws(() => loadMailConfig(false, values));
  assert.throws(() => loadMailConfig(true, { ...base, SMTP_HOST: '127.0.0.1', SMTP_ALLOW_INSECURE_LOCAL: 'true' }));
  assert.equal(loadMailConfig(false, { ...base, SMTP_HOST: '127.0.0.1', SMTP_ALLOW_INSECURE_LOCAL: 'true' })?.allowInsecureLocal, true);
});

test('OTP email delivers matching HTML and plain-text alternatives to a local synthetic SMTP capture', async t => {
  const f = await smtpFixture(t);
  const purposes = ['login', 'email_current', 'email_new'] as const;
  for (const purpose of purposes) {
    await sendCrmOtp(f.config, { to: 'synthetic@example.test', code: '12345678', purpose });
  }
  assert.equal(f.messages.length, 3);
  for (const [index, message] of f.messages.entries()) {
    assert.ok(message.includes('To: synthetic@example.test'));
    assert.match(message, /Content-Type: multipart\/alternative;/i);
    assert.ok(!message.includes('Content-Disposition: attachment'));
    const parts = alternativeParts(message);
    assert.deepEqual([...parts.keys()], ['text/plain', 'text/html']);
    const expected = renderCrmOtpEmail({ code: '12345678', purpose: purposes[index]! });
    assert.equal(parts.get('text/plain'), expected.text.replace(/\r\n/g, '\n').trimEnd());
    assert.equal(parts.get('text/html'), expected.html.replace(/\r\n/g, '\n').trimEnd());
    assert.ok(!message.slice(0, message.indexOf('\r\n\r\n')).includes('12345678'), 'OTP must not appear in email headers');
  }
});

test('SMTP without STARTTLS fails closed by default before transmitting message content', async t => {
  const f = await smtpFixture(t);
  f.config.mail!.allowInsecureLocal = false;
  await assert.rejects(sendCrmOtp(f.config, { to: 'synthetic@example.test', code: '12345678', purpose: 'login' }), isSafeFailure);
  assert.equal(f.messages.length, 0);
  assert.ok(!f.commands.includes('MAIL'));
});

test('rejected recipient and missing mail configuration expose only a sanitized service error', async t => {
  const f = await smtpFixture(t, true);
  await assert.rejects(sendCrmOtp(f.config, { to: 'synthetic@example.test', code: '12345678', purpose: 'login' }), isSafeFailure);
  await assert.rejects(sendCrmOtp({} as Config, { to: 'synthetic@example.test', code: '12345678', purpose: 'login' }), isSafeFailure);
  assert.equal(f.messages.length, 0);
});

test('invalid destinations, OTPs and insecure remote/production overrides fail before network use', async t => {
  const f = await smtpFixture(t);
  await assert.rejects(sendCrmOtp(f.config, { to: 'synthetic@example.test\r\nBcc:evil@example.test', code: '12345678', purpose: 'login' }), isSafeFailure);
  await assert.rejects(sendCrmOtp(f.config, { to: 'synthetic@example.test', code: 'short', purpose: 'login' }), isSafeFailure);
  await assert.rejects(sendCrmOtp({ ...f.config, production: true }, { to: 'synthetic@example.test', code: '12345678', purpose: 'login' }), isSafeFailure);
  await assert.rejects(sendCrmOtp({ ...f.config, mail: { ...f.config.mail!, host: 'smtp.example.test' } }, { to: 'synthetic@example.test', code: '12345678', purpose: 'login' }), isSafeFailure);
  assert.equal(f.commands.length, 0);
  assert.equal(f.messages.length, 0);
});

test('SMTP connection verification sends no message and requires STARTTLS outside the explicit local override', async t => {
  const f = await smtpFixture(t);
  await verifyCrmMailConnection(f.config);
  assert.ok(f.commands.includes('EHLO'));
  assert.equal(f.messages.length, 0);
  assert.ok(!f.commands.some(command => ['MAIL', 'RCPT', 'DATA', 'AUTH'].includes(command)));
  f.config.mail!.allowInsecureLocal = false;
  await assert.rejects(verifyCrmMailConnection(f.config), isSafeFailure);
  assert.equal(f.messages.length, 0);
  assert.ok(!f.commands.includes('MAIL'));
  await assert.rejects(verifyCrmMailConnection({} as Config), isSafeFailure);
});

test('SMTP verification has a shared concurrency cap and rejects overflow without opening another socket', async t => {
  const f = await smtpFixture(t);
  let open = 0; let closed = 0;
  const release: (() => void)[] = [];
  t.mock.method(nodemailer, 'createTransport', (() => {
    open++;
    return { verify: () => new Promise<true>(resolve => release.push(() => resolve(true))), close() { closed++; } };
  }) as unknown as typeof nodemailer.createTransport);
  const pending = Array.from({ length: 4 }, () => verifyCrmMailConnection(f.config));
  assert.equal(open, 4);
  await assert.rejects(verifyCrmMailConnection(f.config), isSafeFailure);
  await assert.rejects(sendCrmOtp(f.config, { to: 'synthetic@example.test', code: '12345678', purpose: 'login' }), isSafeFailure);
  assert.equal(open, 4);
  release.forEach(resolve => resolve());
  await Promise.all(pending);
  assert.equal(closed, 4);
});

test('SMTP verification rejects incorrect supplied credentials and never silently succeeds without advertised AUTH', async t => {
  const rejected = await smtpFixture(t, false, 'reject');
  rejected.config.mail!.user = 'synthetic-user';
  rejected.config.mail!.password = 'synthetic-wrong-password';
  await assert.rejects(verifyCrmMailConnection(rejected.config), isSafeFailure);
  assert.ok(rejected.commands.includes('AUTH'));
  assert.ok(!rejected.commands.some(command => ['MAIL', 'RCPT', 'DATA'].includes(command)));
  const noAuth = await smtpFixture(t);
  noAuth.config.mail!.user = 'synthetic-user';
  noAuth.config.mail!.password = 'synthetic-wrong-password';
  await assert.rejects(verifyCrmMailConnection(noAuth.config), isSafeFailure);
  assert.ok(!noAuth.commands.some(command => ['MAIL', 'RCPT', 'DATA'].includes(command)));
});

test('SMTP verification absolute timeout destroys its retained socket and sanitizes failure', async t => {
  const f = await smtpFixture(t);
  let socket: Socket | undefined;
  let closed = false;
  t.mock.method(nodemailer, 'createTransport', ((options: { socket: Socket }) => {
    socket = options.socket;
    return { verify: () => new Promise<never>(() => {}), close() { closed = true; } };
  }) as unknown as typeof nodemailer.createTransport);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = assert.rejects(verifyCrmMailConnection(f.config), isSafeFailure);
  assert.equal(socket?.destroyed, false);
  t.mock.timers.tick(15_000);
  await result;
  assert.equal(socket?.destroyed, true);
  assert.equal(closed, true);
});
