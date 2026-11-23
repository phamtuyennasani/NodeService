import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { collection, type Database } from '../db.js'
import { JobPdfError, renderJobPdf } from '../job-pdf.js'
import { ApiError, idSchema, notFound } from './errors.js'

const paramsSchema = z.object({ id: idSchema })

/** Export remains inside the CRM plugin so the existing session and browser proof apply. */
export function registerJobPdfRoute(app: FastifyInstance, db: Database, renderer: typeof renderJobPdf = renderJobPdf) {
  app.get('/jobs/:id/pdf', { exposeHeadRoute: false, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    const { id } = paramsSchema.parse(request.params)
    const job = await collection<any>(db, 'jobs').findOne({ _id: id }, {
      projection: { _id: 1, status: 1, result: 1, outline: 1 },
    })
    if (!job) throw notFound()
    const article = Array.isArray(job.result) ? job.result[0] : undefined
    if (job.status !== 'ready' || !article) {
      throw new ApiError(409, 'job_pdf_empty', 'Yêu cầu chưa có nội dung bài viết để xuất PDF.')
    }
    const controller = new AbortController()
    const abort = () => controller.abort()
    const responseClosed = () => { if (!reply.raw.writableEnded) abort() }
    request.raw.once('aborted', abort)
    reply.raw.once('close', responseClosed)
    if (request.raw.aborted || reply.raw.destroyed) abort()
    try {
      const pdf = await renderer({ id, article, outline: job.outline ?? null }, controller.signal)
      // Keep even an alternate renderer from putting control characters in response headers.
      const filename = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,179}\.pdf$/.test(pdf.filename)
        ? pdf.filename : `bai-viet-${id}.pdf`
      return reply.type('application/pdf').header('Content-Disposition', `attachment; filename="${filename}"`).send(pdf.bytes)
    } catch (error) {
      if (error instanceof JobPdfError) {
        if (error.code === 'empty') throw new ApiError(409, 'job_pdf_empty', 'Yêu cầu chưa có nội dung bài viết để xuất PDF.')
        if (error.code === 'limit') throw new ApiError(413, 'job_pdf_limit', 'Nội dung vượt giới hạn xuất PDF. Vui lòng rút gọn nội dung rồi thử lại.')
        if (error.code === 'busy') {
          reply.header('Retry-After', '5')
          throw new ApiError(503, 'job_pdf_busy', 'Hệ thống đang xuất PDF. Vui lòng thử lại sau ít giây.')
        }
      }
      // Do not expose Chromium diagnostics, paths, article text, or infrastructure details.
      request.log.warn({ requestId: request.id }, 'CRM PDF export unavailable')
      throw new ApiError(503, 'job_pdf_unavailable', 'Chưa thể xuất PDF lúc này. Vui lòng thử lại sau.')
    } finally {
      request.raw.off('aborted', abort)
      reply.raw.off('close', responseClosed)
    }
  })
}
