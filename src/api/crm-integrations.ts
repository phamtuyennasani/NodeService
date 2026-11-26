import type { FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { z } from 'zod'
import { ApiError, notFound } from './errors.js'

const releaseSchema = z.object({
  platform: z.enum(['laravel', 'php']),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  filename: z.string().regex(/^[a-z0-9-]+-\d+\.\d+\.\d+\.zip$/),
  compatibility: z.string().min(1),
  bytes: z.number().int().positive().max(16 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
})

export function registerIntegrations(app: FastifyInstance, packageRoot = resolve('dist/packages')) {
  async function catalog() {
    try {
      return z.object({ data: z.array(releaseSchema).length(2) }).parse(JSON.parse(await readFile(resolve(packageRoot, 'releases.json'), 'utf8')))
    } catch {
      throw new ApiError(503, 'integration_unavailable', 'Bộ tích hợp chưa sẵn sàng. Vui lòng thử lại sau.')
    }
  }

  app.get('/integrations', async (_request, reply) => {
    return reply.header('Cache-Control', 'no-store').send(await catalog())
  })

  app.get('/integrations/:platform/:version/download', async (request, reply) => {
    const parameters = z.object({ platform: z.enum(['laravel', 'php']), version: releaseSchema.shape.version }).safeParse(request.params)
    if (!parameters.success) throw notFound()
    const release = (await catalog()).data.find(row => row.platform === parameters.data.platform && row.version === parameters.data.version)
    if (!release) throw notFound()
    let contents: Buffer
    try {
      contents = await readFile(resolve(packageRoot, release.filename))
      if (contents.length !== release.bytes || createHash('sha256').update(contents).digest('hex') !== release.sha256) throw new Error('Invalid release')
    } catch {
      throw new ApiError(503, 'integration_unavailable', 'File ZIP chưa sẵn sàng. Vui lòng thử lại sau.')
    }
    return reply.type('application/zip')
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `attachment; filename="${release.filename}"`)
      .send(contents)
  })
}
