import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { assertTransactionSupport, close, connect } from './db.js';
import { migrate } from './migrate.js';
import { runWorkers } from './worker/index.js';
import { runMaintenance } from './worker/maintenance.js';
import { effectiveConfig } from './runtime-settings.js';
import { assertEncryptionContext } from './encryption-context.js';
import { initializeExistingPartners, runPartnerServices } from './partner-runtime.js';

const role = process.argv[2] || 'all';
if (!['all', 'api', 'writer', 'webhook'].includes(role)) {
  throw new Error('Role must be all, api, writer or webhook');
}

const config = loadConfig();
const db = connect(config.mongodbUri, config.mongodbDatabase, config.poolSize);
const controller = new AbortController();
let closeApp: (() => Promise<void>) | undefined;
const components: Promise<void>[] = [];

function stop() {
  controller.abort();
  void closeApp?.();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await assertTransactionSupport(db);
  await assertEncryptionContext(db, config, role === 'api' || role === 'all');
  await migrate(db);
  await initializeExistingPartners(db, config);
  // Validate persisted operational settings before starting any role.
  await effectiveConfig(db, config);
  components.push(runMaintenance(db, config, controller.signal));
  components.push(runPartnerServices(db, config, controller.signal, role));
  if (role === 'api' || role === 'all') {
    const app = await buildApp(db, config);
    closeApp = () => app.close();
    await app.listen({ host: config.host, port: config.port });
  }
  if (role === 'writer' || role === 'all') components.push(runWorkers(db, config, controller.signal, 'writer'));
  if (role === 'webhook' || role === 'all') components.push(runWorkers(db, config, controller.signal, 'webhook'));
  if (!controller.signal.aborted) {
    await Promise.race([
      new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true })),
      ...components,
    ]);
  }
} finally {
  controller.abort();
  await closeApp?.();
  await Promise.allSettled(components);
  await close(db);
}
