import Fastify from 'fastify';
import serveStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerApi } from './api/index.js';
import type { Config } from './config.js';
import type { Database } from './db.js';

export async function buildApp(db: Database, config: Config, logger = true) {
  const app = Fastify({
    logger: logger ? { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'] } : false,
    bodyLimit: 1024 * 1024,
  });

  app.addHook('onRequest', async (_, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
  });

  app.get('/health', async () => {
    await db.query('SELECT 1');
    return { status: 'ok' };
  });

  const webRoot = resolve('dist/web');
  const widgetRoot = resolve('dist/widget');
  if (existsSync(webRoot)) {
    // Keep the static wildcard enabled so Vite's hashed JS and CSS assets are
    // served alongside the SPA entry point. The previous `wildcard: false`
    // setting served `/` but returned 404 for every `/assets/*` request,
    // leaving the CRM root empty after the HTML loaded.
    await app.register(serveStatic, { root: webRoot, prefix: '/' });
  }
  if (existsSync(widgetRoot)) {
    await app.register(serveStatic, {
      root: widgetRoot, prefix: '/widget/', decorateReply: !existsSync(webRoot), maxAge: '1h',
    });
  }
  await registerApi(app, db, config);
  app.setNotFoundHandler((request, reply) => {
    if (existsSync(webRoot) && request.method === 'GET' &&
        !/^\/(api|v1|widget|assets)(\/|$)/.test(request.url) &&
        request.headers.accept?.includes('text/html')) {
      return reply.sendFile('index.html', webRoot, { cacheControl: false });
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Không tìm thấy đường dẫn.' } });
  });
  return app;
}
