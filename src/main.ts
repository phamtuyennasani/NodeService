import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { close, connect } from './db.js';
import { migrate } from './migrate.js';
import { runWorkers } from './worker/index.js';

const role = process.argv[2] || 'all';
if (!['all', 'api', 'writer', 'webhook'].includes(role)) {
  throw new Error('Role must be all, api, writer or webhook');
}

const config = loadConfig();
const db = connect(config.mongodbUri, config.mongodbDatabase);
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
  await migrate(db);
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
