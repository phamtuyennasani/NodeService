import type { IncomingMessage, ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'

/** Reuse the application and MongoDB pool across warm invocations. */
export function nodeServerlessHandler(initialize: () => Promise<FastifyInstance>, streamLifetimeMs = 240_000) {
  let ready: Promise<FastifyInstance> | undefined
  return async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const app = await (ready ??= initialize().catch(error => { ready = undefined; throw error }))
      await app.ready()
      await new Promise<void>(resolve => {
        // End SSE cleanly before Vercel's 300-second limit. EventSource reconnects.
        const stream = request.url?.split('?', 1)[0] === '/api/crm/jobs/events'
        const timer = stream ? setTimeout(() => response.end(), streamLifetimeMs) : undefined
        timer?.unref()
        const finish = () => {
          if (timer) clearTimeout(timer)
          response.off('finish', finish)
          response.off('close', finish)
          resolve()
        }
        response.once('finish', finish)
        response.once('close', finish)
        app.server.emit('request', request, response)
      })
    } catch (error) {
      console.error('Serverless application initialization failed:', error instanceof Error ? error.name : 'UnknownError')
      if (!response.headersSent) {
        response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      }
      if (!response.writableEnded) response.end(JSON.stringify({ error: { code: 'service_unavailable', message: 'Dịch vụ chưa sẵn sàng. Vui lòng thử lại sau.' } }))
    }
  }
}
