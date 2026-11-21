import type { FastifyInstance } from 'fastify'
import { z, ZodError } from 'zod'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export function installErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message, details: error.details },
      })
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'Vui lòng kiểm tra dữ liệu đã nhập.',
          details: error.issues.map(({ path, message }) => ({ path, message })),
        },
      })
    }
    const problem = error as { code?: string | number, codeName?: string, statusCode?: number }
    if (problem.code === '23505' || problem.code === 11000 || problem.codeName === 'DuplicateKey') {
      return reply.code(409).send({ error: { code: 'duplicate', message: 'Dữ liệu này đã tồn tại.' } })
    }
    if (problem.code === '23503') {
      return reply.code(409).send({ error: { code: 'related_record', message: 'Hồ sơ liên quan không còn khả dụng.' } })
    }
    if (problem.code === 121 || problem.codeName === 'DocumentValidationFailure') {
      return reply.code(400).send({ error: { code: 'invalid_document', message: 'Dữ liệu không hợp lệ.' } })
    }
    if (problem.statusCode && problem.statusCode >= 400 && problem.statusCode < 500) {
      return reply.code(problem.statusCode).send({
        error: { code: problem.statusCode === 429 ? 'rate_limit' : 'invalid_request', message: error instanceof Error ? error.message : 'Yêu cầu không hợp lệ.' },
      })
    }
    request.log.error({ code: problem.code, requestId: request.id }, 'API request failed')
    return reply.code(500).send({
      error: { code: 'internal_error', message: 'Dịch vụ đang gặp lỗi. Vui lòng thử lại.' },
    })
  })
}

export const idSchema = z.string().uuid()
export const periodSchema = z.iso.date()
export const timestampSchema = z.iso.datetime({ offset: true })
export const quantitySchema = z.number().int().positive().max(25_000)
export const articleLengthSchema = z.number().int().min(600).max(2_500)
export const moneySchema = z.union([z.number(), z.string()]).transform(String).pipe(
  z.string().regex(/^\d{1,9}(?:\.\d{1,10})?$/),
)

export function notFound() {
  return new ApiError(404, 'not_found', 'Không tìm thấy dữ liệu.')
}
