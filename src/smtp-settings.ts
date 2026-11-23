import { z } from 'zod';
import { loadMailConfig, type Config, type CrmMailConfig } from './config.js';
import { collection, type Database } from './db.js';
import { seal, unseal } from './security.js';
import { ApiError } from './api/errors.js';

export const smtpSettingsCollection = 'crm_mail_settings';
export const smtpSettingsId = 'smtp';
const valuesSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  from: z.string().trim().min(1).max(254),
  user: z.string().max(512).refine(value => !/[\r\n\u0000]/.test(value)),
});
export const smtpUpdateSchema = z.object({
  revision: z.number().int().nonnegative(),
  values: valuesSchema.extend({ password: z.string().max(4096).optional() }).strict(),
}).strict();
export type SmtpUpdate = z.infer<typeof smtpUpdateSchema>;
type StoredSmtp = {
  _id: string;
  revision: number;
  values: z.infer<typeof valuesSchema>;
  password_encrypted: string | null;
  updated_at: Date;
};
export const smtpSettingsConflict = () => new ApiError(409, 'settings_conflict', 'Cấu hình đã được thay đổi ở phiên khác. Hãy tải lại trước khi lưu.');
const unavailable = () => new ApiError(503, 'mail_unavailable', 'Chưa thể sử dụng cấu hình email. Vui lòng liên hệ quản trị viên hoặc thử lại sau.');
const invalid = () => new ApiError(400, 'invalid_request', 'Vui lòng kiểm tra máy chủ, cổng, email gửi và thông tin đăng nhập SMTP.');

function validated(values: z.infer<typeof valuesSchema>, password?: string): CrmMailConfig {
  // Share host/from/auth validation with environment config. Database settings
  // deliberately never permit the development plaintext exception.
  const result = loadMailConfig(true, {
    SMTP_HOST: values.host, SMTP_PORT: String(values.port), SMTP_SECURE: String(values.secure),
    SMTP_FROM: values.from, SMTP_USER: values.user || undefined, SMTP_PASSWORD: password,
  });
  if (!result) throw invalid();
  return result;
}
function publicValues(mail?: CrmMailConfig) {
  return { host: mail?.host || '', port: mail?.port ?? 465, secure: mail?.secure ?? true,
    from: mail?.from || '', user: mail?.user || '' };
}
async function current(db: Database, config: Config): Promise<{ row: StoredSmtp | null; mail: Config['mail'] }> {
  const row = await collection(db, smtpSettingsCollection).findOne({ _id: smtpSettingsId }) as StoredSmtp | null;
  if (!row) return { row: null, mail: config.mail };
  try {
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !(row.updated_at instanceof Date) || !Number.isFinite(row.updated_at.getTime())) throw unavailable();
    const values = valuesSchema.strict().parse(row.values);
    if (row.password_encrypted !== null && typeof row.password_encrypted !== 'string') throw unavailable();
    const password = row.password_encrypted === null ? undefined : unseal(row.password_encrypted, config.encryptionKey);
    if (!values.user && password !== undefined) throw unavailable();
    return { row, mail: validated(values, password) };
  } catch { throw unavailable(); }
}
function response(state: Awaited<ReturnType<typeof current>>) {
  return { values: publicValues(state.mail), revision: state.row?.revision ?? 0,
    password_configured: Boolean(state.mail?.password), configured: Boolean(state.mail?.host && state.mail?.from),
    source: state.row ? 'database' as const : state.mail ? 'environment' as const : 'none' as const,
    updated_at: state.row?.updated_at.toISOString() ?? null };
}

/** No cache: a save applies to the next OTP/test request on every replica. */
export async function resolveCrmMailConfig(db: Database, config: Config): Promise<Config['mail']> {
  return (await current(db, config)).mail;
}
export async function readCrmMailSettings(db: Database, config: Config) {
  return response(await current(db, config));
}
export async function saveCrmMailSettings(db: Database, config: Config, input: SmtpUpdate) {
  const { revision, values } = smtpUpdateSchema.parse(input);
  const state = await current(db, config);
  if ((state.row?.revision ?? 0) !== revision) throw smtpSettingsConflict();
  const sameIdentity = state.mail && state.mail.host.toLowerCase() === values.host.toLowerCase() &&
    state.mail.port === values.port && state.mail.secure === values.secure && (state.mail.user || '') === values.user;
  const password = values.user ? values.password || (sameIdentity ? state.mail?.password : undefined) : undefined;
  let mail: CrmMailConfig;
  try { mail = validated(values, password); } catch { throw invalid(); }
  const row: StoredSmtp = { _id: smtpSettingsId, revision: revision + 1, values: publicValues(mail),
    password_encrypted: password ? seal(password, config.encryptionKey) : null, updated_at: new Date() };
  const store = collection(db, smtpSettingsCollection);
  if (revision === 0) {
    try { await store.insertOne(row); }
    catch (error) {
      if ((error as { code?: number }).code === 11000) throw smtpSettingsConflict();
      throw error;
    }
  } else {
    const updated = await store.updateOne({ _id: smtpSettingsId, revision }, {
      $set: { values: row.values, password_encrypted: row.password_encrypted, updated_at: row.updated_at }, $inc: { revision: 1 },
    });
    if (!updated.matchedCount) throw smtpSettingsConflict();
  }
  return response({ row, mail });
}

/** Resolve one coherent saved snapshot, rejecting a test from a stale form. */
export async function crmMailConfigAtRevision(db: Database, config: Config, revision: number): Promise<Config['mail']> {
  const state = await current(db, config);
  if ((state.row?.revision ?? 0) !== revision) throw smtpSettingsConflict();
  return state.mail;
}
