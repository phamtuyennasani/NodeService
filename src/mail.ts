import nodemailer from 'nodemailer';
import { Socket } from 'node:net';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { ApiError } from './api/errors.js';
import { isCrmOtpPurpose, renderCrmOtpEmail, type CrmOtpPurpose } from './crm-otp-email.js';

export type CrmOtpMessage = { to: string; code: string; purpose: CrmOtpPurpose };
const unavailable = () => new ApiError(503, 'mail_unavailable', 'Chưa thể gửi email xác thực. Vui lòng liên hệ quản trị viên hoặc thử lại sau.');
const email = z.email().max(254);
let activeOperations = 0;

export function isCrmMailConfigured(config: Config): boolean {
  return Boolean(config.mail?.host && config.mail?.from);
}

function transportOptions(config: Config): SMTPTransport.Options {
  const mail = config.mail;
  if (!isCrmMailConfigured(config) || !mail || activeOperations >= 4) throw unavailable();
  // Enforce this again at the transport boundary for programmatically built configs.
  const local = ['127.0.0.1', '::1', 'localhost'].includes(mail.host.toLowerCase());
  if (mail.allowInsecureLocal && (config.production || !local)) throw unavailable();
  return {
    host: mail.host, port: mail.port, secure: mail.secure,
    requireTLS: !mail.allowInsecureLocal,
    ignoreTLS: mail.allowInsecureLocal,
    auth: mail.user ? { user: mail.user, pass: mail.password } : undefined,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 5_000, greetingTimeout: 5_000, dnsTimeout: 5_000, socketTimeout: 10_000,
    logger: false, debug: false,
    disableFileAccess: true, disableUrlAccess: true,
  };
}

/** Delivers fixed HTML and plain-text OTP templates. Never logs a code or SMTP error. */
export async function sendCrmOtp(config: Config, message: CrmOtpMessage): Promise<void> {
  if (!email.safeParse(message.to).success || !/^\d{8}$/.test(message.code) || !isCrmOtpPurpose(message.purpose)) throw unavailable();
  const transport = nodemailer.createTransport(transportOptions(config));
  activeOperations++;
  try {
    const messageOptions = {
      from: { name: 'Bàn biên tập', address: config.mail!.from },
      to: { name: '', address: message.to },
      ...renderCrmOtpEmail(message),
      disableFileAccess: true, disableUrlAccess: true,
      signal: AbortSignal.timeout(15_000),
    };
    const result = await transport.sendMail(messageOptions);
    if (result.rejected?.length || !result.accepted?.length) throw unavailable();
  } catch {
    // SMTP replies can contain recipient addresses, credentials or message data.
    // Do not rethrow the transport error (or attach it as a cause) to the API logger.
    throw unavailable();
  } finally {
    transport.close();
    activeOperations--;
  }
}

/** Checks TLS/auth only. Never sends MAIL/RCPT/DATA or chooses a recipient. */
export async function verifyCrmMailConnection(config: Config): Promise<void> {
  const options = transportOptions(config);
  // Non-pool close() does not cancel verify's private connection. Retain its
  // native socket so the absolute timeout closes the fd even after STARTTLS.
  const socket = new Socket();
  socket.on('error', () => {});
  const transport = nodemailer.createTransport({ ...options, socket, forceAuth: Boolean(config.mail?.user) });
  activeOperations++;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      transport.verify(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { socket.destroy(); reject(unavailable()); }, 15_000);
        timer.unref();
      }),
    ]);
  } catch { throw unavailable(); }
  finally {
    if (timer) clearTimeout(timer);
    socket.destroy();
    transport.close();
    activeOperations--;
  }
}
