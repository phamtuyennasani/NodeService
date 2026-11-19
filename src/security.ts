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
  const salt = randomBytes(24);
  const hash = await derive(password, salt, 64) as Buffer;
  return [salt, hash].map(part => part.toString('base64url')).join('.');
}

export async function verifyPassword(password: string, value: string): Promise<boolean> {
  const [salt, expected] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  if (!salt || expected?.length !== 64) return false;
  const entered = await derive(password, salt, expected.length) as Buffer;
  return timingSafeEqual(entered, expected);
}
