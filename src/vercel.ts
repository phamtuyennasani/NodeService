import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { assertTransactionSupport, close, connect } from './db.js'
import { assertEncryptionContext } from './encryption-context.js'
import { nodeServerlessHandler } from './serverless.js'

export default nodeServerlessHandler(async () => {
  const config = loadConfig()
  const db = connect(config.mongodbUri, config.mongodbDatabase, Math.min(config.poolSize, 5))
  try {
    await assertTransactionSupport(db)
    await assertEncryptionContext(db, config)
    // Migrations and continuously running work belong to the deployed worker.
    const app = await buildApp(db, config, false)
    app.addHook('onClose', () => close(db))
    await app.ready()
    return app
  } catch (error) {
    await close(db)
    throw error
  }
})
