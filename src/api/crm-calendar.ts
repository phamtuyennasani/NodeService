import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { collection, type Database } from '../db.js'
import { idSchema, periodSchema } from './errors.js'

const DAY = 86_400_000
const VIETNAM_OFFSET = 7 * 60 * 60 * 1000
const calendarQuery = z.object({
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).refine(value => Number(value.slice(0, 4)) > 0),
  date: periodSchema.optional(),
  customer_id: idSchema.optional(),
  website_id: idSchema.optional(),
}).refine(value => !value.date || value.date.startsWith(`${value.month}-`), {
  path: ['date'], message: 'Ngày được chọn phải thuộc tháng đang xem.',
})

type Counts = { scheduled: number; written: number; delivered: number }
const emptyCounts = (): Counts => ({ scheduled: 0, written: 0, delivered: 0 })
const validTime = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime())
const localDate = (value: Date) => new Date(value.getTime() + VIETNAM_OFFSET).toISOString().slice(0, 10)
const localHour = (value: Date) => new Date(value.getTime() + VIETNAM_OFFSET).getUTCHours()

export function registerCalendar(app: FastifyInstance, db: Database) {
  app.get('/dashboard/calendar', async (request, reply) => {
    const filters = calendarQuery.parse(request.query)
    const start = new Date(`${filters.month}-01T00:00:00+07:00`)
    const [year, month] = filters.month.split('-').map(Number)
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
    const dayCount = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    const end = new Date(start.getTime() + dayCount * DAY)
    const period = { $gte: start, $lt: end }
    // Date-bounded reads avoid pulling article bodies, credentials or all-time job history.
    const deliveries = await collection(db, 'webhook_deliveries').find({
      event: 'article.ready', status: 'delivered', delivered_at: period,
      ...(filters.website_id ? { site_id: filters.website_id } : {}),
    }, { projection: { _id: 1, job_id: 1, site_id: 1, delivered_at: 1 } }).toArray()
    const deliveryIds = [...new Set(deliveries.map(row => row.job_id).filter((id): id is string => typeof id === 'string'))]
    const jobs = await collection(db, 'jobs').find({
      ...(filters.customer_id ? { customer_id: filters.customer_id } : {}),
      ...(filters.website_id ? { site_id: filters.website_id } : {}),
      $or: [
        { scheduled_at: period, status: { $ne: 'canceled' } },
        { completed_at: period, status: { $in: ['ready', 'completed'] } },
        ...(deliveryIds.length ? [{ _id: { $in: deliveryIds } }] : []),
      ],
    }, { projection: { _id: 1, customer_id: 1, site_id: 1, status: 1, scheduled_at: 1, completed_at: 1 } }).toArray()

    const days = Array.from({ length: dayCount }, (_, index) => ({
      date: `${filters.month}-${String(index + 1).padStart(2, '0')}`, ...emptyCounts(),
    }))
    const byDay = new Map(days.map(day => [day.date, day]))
    const hours = filters.date ? Array.from({ length: 24 }, (_, hour) => ({ hour, ...emptyCounts() })) : []
    const add = (time: unknown, metric: keyof Counts) => {
      if (!validTime(time) || time < start || time >= end) return
      const date = localDate(time)
      const day = byDay.get(date)
      if (!day) return
      day[metric] += 1
      if (date === filters.date) hours[localHour(time)][metric] += 1
    }
    for (const job of jobs) {
      if (job.status !== 'canceled') add(job.scheduled_at, 'scheduled')
      if (job.status === 'ready' || job.status === 'completed') add(job.completed_at, 'written')
    }
    const jobMap = new Map(jobs.map(job => [job._id, job]))
    // Count an article once per delivery day; retries on that day use the earliest
    // successful hour so the day's hourly total matches the monthly calendar cell.
    const successfulDays = new Map<string, Date>()
    for (const delivery of deliveries) {
      const job = jobMap.get(delivery.job_id)
      const time = delivery.delivered_at
      if (!job || job.site_id !== delivery.site_id || !validTime(time) || time < start || time >= end) continue
      const key = `${delivery.job_id}:${localDate(time)}`
      const previous = successfulDays.get(key)
      if (!previous || time < previous) successfulDays.set(key, time)
    }
    for (const time of successfulDays.values()) add(time, 'delivered')
    const totals = days.reduce((sum, day) => ({
      scheduled: sum.scheduled + day.scheduled,
      written: sum.written + day.written,
      delivered: sum.delivered + day.delivered,
    }), emptyCounts())
    reply.header('Cache-Control', 'no-store')
    return { timezone: 'Asia/Ho_Chi_Minh', month: filters.month, date: filters.date ?? null, totals, days, hours }
  })
}
