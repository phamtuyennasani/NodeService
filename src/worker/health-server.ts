import { createServer } from 'node:http'

/** The daemon probe must verify the database, rather than just process uptime. */
export async function startWorkerHealthServer(ping: () => Promise<unknown>, port: number, host: string) {
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' || request.url !== '/health') {
      response.writeHead(404).end()
      return
    }
    let healthy = true
    try { await ping() } catch { healthy = false }
    if (response.destroyed) return
    response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ status: healthy ? 'ok' : 'unavailable' }))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  return { server, close: () => new Promise<void>(resolve => { server.close(() => resolve()) }) }
}
