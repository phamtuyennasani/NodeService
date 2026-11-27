import { randomBytes } from 'node:crypto'
import { loadConfig } from '../src/config.js'
import { assertEncryptionContext } from '../src/encryption-context.js'
import { assertTransactionSupport, close, connect } from '../src/db.js'
import { buildWidgetPreviewApp } from '../src/widget-preview-app.js'

// Local adapter; the CRM and its workers run separately.
const config = loadConfig()
const port = Number(process.env.WIDGET_PREVIEW_PORT ?? 3220)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('Invalid WIDGET_PREVIEW_PORT')
const db = connect(config.mongodbUri, config.mongodbDatabase, config.poolSize)
await assertTransactionSupport(db)
await assertEncryptionContext(db, config)
const app = await buildWidgetPreviewApp(db, config, {
  origin: `http://127.0.0.1:${port}`,
  csrfToken: randomBytes(32).toString('base64url'),
  siteId: process.env.WIDGET_SITE_ID,
})
let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  await app.close()
  await close(db)
}
process.once('SIGINT', () => { void shutdown() })
process.once('SIGTERM', () => { void shutdown() })
try {
  await app.listen({ host: '127.0.0.1', port })
  console.log(`Widget CRM preview: http://127.0.0.1:${port}`)
  console.log('Viết bài thật qua CRM; sử dụng quota và provider hiện có. Preview không tự chạy worker hoặc migration.')
} catch (error) {
  await shutdown()
  throw error
}
