import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Database } from '../db.js';
import { verifyCrmMailConnection } from '../mail.js';
import { crmMailConfigAtRevision, readCrmMailSettings, saveCrmMailSettings, smtpUpdateSchema } from '../smtp-settings.js';

const testSchema = z.object({ revision: z.number().int().nonnegative() }).strict();

/** Signed CRM requests use CSRF, with password confirmation when saving settings. */
export function registerCrmMailSettings(app: FastifyInstance, db: Database, config: Config) {
  app.get('/settings/smtp', async () => readCrmMailSettings(db, config));
  app.put('/settings/smtp', { bodyLimit: 8 * 1024 }, async request =>
    saveCrmMailSettings(db, config, smtpUpdateSchema.parse(request.body)));
  app.post('/settings/smtp/test', { bodyLimit: 1024, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } }, async request => {
    const { revision } = testSchema.parse(request.body);
    const mail = await crmMailConfigAtRevision(db, config, revision);
    await verifyCrmMailConnection({ ...config, mail });
    return { ok: true };
  });
}
