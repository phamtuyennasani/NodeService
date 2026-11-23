import {
  createCipheriv, createDecipheriv, createHash, randomBytes, scrypt, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const issueToken = () => randomBytes(32).toString('base64url');

export function seal(value: string, key: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [nonce, cipher.getAuthTag(), encrypted].map(part => part.toString('base64url')).join('.');
}

export function unseal(value: string, key: Buffer): string {
  const parts = value.split('.').map(part => Buffer.from(part, 'base64url'));
  if (parts.length !== 3) throw new Error('Malformed encrypted value');
  const [nonce, tag, encrypted] = parts;
  const cipher = createDecipheriv('aes-256-gcm', key, nonce);
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(encrypted), cipher.final()]).toString('utf8');
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length > 256) throw new Error('Password exceeds the supported length');
  const salt = randomBytes(24);
  const hash = await derive(password, salt, 64) as Buffer;
  return [salt, hash].map(part => part.toString('base64url')).join('.');
}

export async function verifyPassword(password: string, value: string): Promise<boolean> {
  // Reject malformed or unbounded stored parameters before scheduling scrypt.
  // Our hashes always contain a 24-byte salt and a 64-byte derived key.
  if (password.length > 256 || !/^[A-Za-z0-9_-]{32}\.[A-Za-z0-9_-]{86}$/.test(value)) return false;
  const [salt, expected] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  if (salt.length !== 24 || expected.length !== 64 ||
      `${salt.toString('base64url')}.${expected.toString('base64url')}` !== value) return false;
  const entered = await derive(password, salt, expected.length) as Buffer;
  return timingSafeEqual(entered, expected);
}
