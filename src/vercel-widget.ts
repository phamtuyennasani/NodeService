import { loadConfig } from './config.js'
import { assertTransactionSupport, close, connect } from './db.js'
import { assertEncryptionContext } from './encryption-context.js'
import { nodeServerlessHandler } from './serverless.js'
import { buildWidgetPreviewApp } from './widget-preview-app.js'

export default nodeServerlessHandler(async () => {
  const config = loadConfig()
  const db = connect(config.mongodbUri, config.mongodbDatabase, Math.min(config.poolSize, 5))
  try {
    await assertTransactionSupport(db)
    await assertEncryptionContext(db, config)
    const app = await buildWidgetPreviewApp(db, config, {
      origin: config.origin,
      csrfToken: process.env.WIDGET_DEMO_CSRF_TOKEN ?? '',
      passwordHash: process.env.WIDGET_DEMO_PASSWORD_HASH,
      siteId: process.env.WIDGET_SITE_ID,
    })
    app.addHook('onClose', () => close(db))
    await app.ready()
    return app
  } catch (error) {
    await close(db)
    throw error
  }
})
