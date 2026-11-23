import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Config } from '../config.js'
import { collection, type Database } from '../db.js'
import { defaultSettings, invalidateSettings, readSettings, runtimeSettingsSchema, settingsId } from '../runtime-settings.js'
import { ApiError } from './errors.js'
import { registerCrmMailSettings } from './crm-mail-settings.js'

const updateSchema = z.object({ revision: z.number().int().nonnegative(), values: runtimeSettingsSchema }).strict()
const conflict = () => new ApiError(409, 'settings_conflict', 'Cấu hình đã được thay đổi ở phiên khác. Hãy tải lại trước khi lưu.')

/** Registered inside the CRM session/CSRF boundary. */
export function registerSettings(app: FastifyInstance, db: Database, config: Config) {
  registerCrmMailSettings(app, db, config)
  app.get('/settings', async () => readSettings(db, config))
  app.put('/settings', async request => {
    const { revision, values } = updateSchema.parse(request.body)
    const defaults = defaultSettings(config)
    const updated_at = new Date()
    const policy = (value: typeof values) => [value.job_retention_days, value.delivery_retention_days,
      value.cleanup_interval_minutes].join(':')
    if (revision === 0) {
      try {
        await collection(db, 'runtime_settings').insertOne({ _id: settingsId, revision: 1, values, updated_at,
          retention_updated_at: updated_at })
      } catch (error) {
        if ((error as { code?: number }).code === 11000) throw conflict()
        throw error
      }
    } else {
      const previous = await collection(db, 'runtime_settings').findOne({ _id: settingsId, revision })
      if (!previous) throw conflict()
      const result = await collection(db, 'runtime_settings').updateOne({ _id: settingsId, revision }, {
        $set: { values, updated_at,
          ...(policy(previous.values) !== policy(values) ? { retention_updated_at: updated_at } : {}),
        }, $inc: { revision: 1 },
      })
      if (!result.matchedCount) throw conflict()
    }
    invalidateSettings(db)
    return { values, defaults, revision: revision + 1, updated_at: updated_at.toISOString() }
  })
}
