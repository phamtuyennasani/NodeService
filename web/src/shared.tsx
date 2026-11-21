import type { ReactNode } from 'react';
import { Alert, Button, Empty } from 'antd';
import { ArrowLeftOutlined, ArrowRightOutlined, InboxOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { Job, WritingStage } from './types';

export const number = new Intl.NumberFormat('vi-VN');
const vietnameseMoney = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 });
const vietnamWallTime = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Ho_Chi_Minh' });
const dateTime = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' });

export function vnd(value?: string | number | null) {
  if (value == null || value === '') return '—';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return amount > 0 && amount < 1 ? '< 1 ₫' : vietnameseMoney.format(amount);
}

export function datetime(value?: string | null) {
  return value ? dateTime.format(new Date(value)) : '—';
}

export function displayVietnamTime(value: string | Date) {
  return dayjs(vietnamWallTime.format(new Date(value)).replace(' ', 'T'));
}

export function submitVietnamTime(value: dayjs.Dayjs) {
  return new Date(value.format('YYYY-MM-DDTHH:mm:ss') + '+07:00').toISOString();
}

export function compactId(id?: string) {
  return id && id.length > 12 ? `${id.slice(0, 8)}…` : id ?? '—';
}

export function jobId(job: Job) {
  return job.id ?? job.job_id ?? '';
}

const statuses: Record<string, [string, string]> = {
  scheduled: ['Chờ đến lịch', 'waiting'],
  queued: ['Chờ viết', 'waiting'],
  pending: ['Chờ xử lý', 'waiting'],
  retry: ['Chờ thử lại', 'active'],
  retrying: ['Chờ thử lại', 'active'],
  writing: ['Đang viết', 'active'],
  running: ['Đang gọi AI', 'active'],
  ready: ['Đã viết', 'success'],
  completed: ['Đã viết', 'success'],
  succeeded: ['Thành công', 'success'],
  failed: ['Lỗi', 'error'],
  canceled: ['Đã hủy', 'default'],
  sending: ['Đang giao', 'active'],
  delivered: ['Đã giao', 'success'],
};

export function Status({ value }: { value: string }) {
  const [label, tone] = statuses[value] ?? [value, 'default'];
  return <span data-tone={tone} className="status-tag"><span className="status-dot" aria-hidden="true" />{label}</span>;
}

const writingStages: Record<WritingStage, string> = {
  research: 'Đang nghiên cứu',
  outline: 'Đang lập dàn ý',
  draft: 'Đang viết nội dung',
  seo_check: 'Đang kiểm tra SEO',
  seo_repair: 'Đang chỉnh sửa SEO',
};

export function writingStageLabel(stage?: WritingStage | null) {
  return stage ? writingStages[stage] ?? 'Đang viết' : 'Đang viết';
}

export function JobStatus({ job }: { job: Job }) {
  return job.status === 'writing'
    ? <span data-tone="active" className="status-tag job-stage-status"><span className="status-dot" aria-hidden="true" />{writingStageLabel(job.writing_stage)}</span>
    : <Status value={job.status} />;
}

export function PageHeading({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <header className="page-heading">
      <div><h1>{title}</h1>{description && <p>{description}</p>}</div>
      {action}
    </header>
  );
}

export function Panel({ title, extra, children, className = '' }: { title?: string; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      {(title || extra) && <header className="panel-heading">{title && <h2>{title}</h2>}{extra}</header>}
      {children}
    </section>
  );
}

export function EmptyState({ description = 'Chưa có dữ liệu' }: { description?: string }) {
  return <Empty image={<span className="empty-symbol" aria-hidden="true"><InboxOutlined /></span>} description={description} className="empty-state" />;
}

export function ResourceError({ error, onRetry }: { error?: Error; onRetry: () => void }) {
  if (!error) return null;
  return (
    <Alert
      className="resource-error"
      type="error"
      showIcon
      title="Không thể tải dữ liệu"
      description={error.message}
      action={<Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>Tải lại</Button>}
    />
  );
}

export function go(page: string, query?: Record<string, string>) {
  const parameters = query ? new URLSearchParams(query) : undefined;
  window.location.hash = parameters?.size ? `${page}?${parameters}` : page;
}

export function CursorPagination({ cursor, setCursor, next }: { cursor: string[]; setCursor: (cursor: string[]) => void; next?: string | null }) {
  if (!next && !cursor.length) return null;
  return <div className="table-pagination">
    <Button icon={<ArrowLeftOutlined />} disabled={!cursor.length} onClick={() => setCursor(cursor.slice(0, -1))}>Trang trước</Button>
    <span>Trang {cursor.length + 1}</span>
    <Button icon={<ArrowRightOutlined />} iconPlacement="end" disabled={!next} onClick={() => next && setCursor([...cursor, next])}>Trang sau</Button>
  </div>;
}
