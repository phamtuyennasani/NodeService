import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, DatePicker, Segmented, Select, Skeleton, Tabs } from 'antd';
import {
  ArrowRightOutlined, ArrowUpOutlined, CalendarOutlined, CheckCircleOutlined, FileTextOutlined,
  ClockCircleOutlined, GlobalOutlined, ReloadOutlined, SendOutlined, SyncOutlined, TeamOutlined, UndoOutlined,
  ThunderboltOutlined, WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer,
  Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import { useCatalog, useResource, withQuery } from './api';
import { subscribeCrmEvents } from './sse';
import { datetime, displayVietnamTime, EmptyState, go, jobId, number, PageHeading, Panel, ResourceError, Status, vnd, writingStageLabel } from './shared';
import type { DashboardData, DashboardRuntime, Delivery, Job } from './types';
import { OverviewCalendar } from './OverviewCalendar';
import './dashboard.css';

const vietnamToday = () => dayjs(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date()));
const shortDate = (date: string) => dayjs(date).format('DD/MM');
const fullDate = (date: unknown) => dayjs(String(date)).format('DD/MM/YYYY');
const runtimeTime = (date: string) => displayVietnamTime(date).format('HH:mm:ss');
const providerLabels: Record<string, string> = { openai: 'OpenAI', anthropic: 'Anthropic', xai: 'xAI', 'openai-compatible': 'OpenAI Compatible' };
const volumeSeries = [
  { key: 'articles', name: 'Đã viết', color: '#315b46' },
  { key: 'delivered', name: 'Đã giao', color: '#e3ac4b' },
] as const;

function periodFor(value: URLSearchParams): [dayjs.Dayjs, dayjs.Dayjs] {
  if (value.get('from') && value.get('to')) {
    const from = dayjs(value.get('from')), to = dayjs(value.get('to'));
    if (from.isValid() && to.isValid() && !from.isAfter(to)) return [from, to];
  }
  const today = vietnamToday();
  return [today.subtract(13, 'day'), today];
}

function Metric({ label, value, detail, icon, featured, disabled, onClick }: {
  label: string; value: number; detail: string; icon: ReactNode; featured?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return <button type="button" className={`dash-metric${featured ? ' dash-metric-featured' : ''}`} disabled={disabled} onClick={onClick}>
    <span className="dash-metric-top"><span className="dash-metric-icon" aria-hidden="true">{icon}</span>{label}<ArrowUpOutlined className="dash-action-arrow" aria-hidden="true" /></span>
    <strong>{number.format(value)}</strong>
    <span className="dash-metric-detail">{detail}</span>
  </button>;
}

function VolumePanel({ series }: { series: DashboardData['series'] }) {
  const [view, setView] = useState<'daily' | 'running'>('daily');
  let articles = 0;
  let delivered = 0;
  const data = view === 'daily' ? series : series.map((point) => {
    articles += point.articles;
    delivered += point.delivered;
    return { ...point, articles, delivered };
  });
  const dense = data.length > 45;
  return <section className="panel dash-volume">
    <header className="dash-panel-header">
      <h2>Sản lượng bài viết</h2>
      <Segmented aria-label="Cách hiển thị sản lượng" size="small" value={view} onChange={setView}
        options={[{ value: 'daily', label: 'Theo ngày' }, { value: 'running', label: 'Lũy kế' }]} />
    </header>
    <div className="dash-volume-legend">{volumeSeries.map(({ key, name, color }) =>
      <span key={key}><i style={{ backgroundColor: color }} />{name}</span>)}</div>
    <div className="dash-volume-plot">
      {!data.length ? <EmptyState description="Chưa có số liệu trong khoảng này" /> : (
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ComposedChart title={`Số bài đã viết và đã giao ${view === 'daily' ? 'theo ngày' : 'lũy kế'}`}
            data={data} margin={{ top: 8, right: 2, left: 0, bottom: 0 }} barCategoryGap="23%" barGap={1}>
            <CartesianGrid vertical={false} stroke="#dde2d8" strokeDasharray="3 5" />
            <XAxis dataKey="date" minTickGap={14} axisLine={false} tickLine={false} tickMargin={10}
              tick={{ fill: '#647164', fontSize: 10 }} tickFormatter={shortDate} />
            <YAxis width="auto" tickMargin={8} allowDecimals={false} tickCount={5} axisLine={false} tickLine={false}
              tick={{ fill: '#647164', fontSize: 10 }} domain={[0, (max: number) => Math.max(2, max)]} />
            <ChartTooltip cursor={{ fill: '#eef0e8' }} labelFormatter={fullDate} formatter={value => number.format(Number(value))} />
            {volumeSeries.map(({ key, name, color }) => dense
              ? <Line key={key} dataKey={key} name={name} stroke={color} strokeWidth={2} strokeDasharray={key === 'delivered' ? '4 3' : undefined}
                  dot={false} isAnimationActive={false} />
              : <Bar key={key} dataKey={key} name={name} fill={color} maxBarSize={26} radius={[3, 3, 0, 0]} isAnimationActive={false} />)}
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </div>
  </section>;
}

function CostPanel({ metrics, series, onOpen }: {
  metrics: DashboardData['metrics']; series: DashboardData['series']; onOpen: () => void;
}) {
  const data = series.map(point => ({
    date: point.date, service: Number(point.service_cost_vnd),
  }));
  return <section className="dash-cost">
    <header className="dash-panel-header"><h2>Chi phí AI</h2></header>
    <div className="dash-cost-total">{vnd(metrics.service_cost_vnd).replace(/\s*₫$/, '')} <span>VNĐ</span></div>
    <div className="dash-cost-plot">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart title="Chi phí theo ngày của bài viết dùng hạn mức được cấp" data={data} margin={{ top: 6, right: 3, bottom: 2, left: 3 }}>
          <defs><linearGradient id="dash-cost-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#edc47b" stopOpacity={.23} /><stop offset="100%" stopColor="#edc47b" stopOpacity={0} />
          </linearGradient></defs>
          <XAxis dataKey="date" hide />
          <YAxis hide domain={[0, (max: number) => max || 1]} />
          <ChartTooltip labelFormatter={fullDate} formatter={value => vnd(Number(value))}
            cursor={{ stroke: '#a2b39b', strokeDasharray: '3 4' }} />
          <Area dataKey="service" name="Key dịch vụ" stroke="#f2c372" fill="url(#dash-cost-fill)" strokeWidth={2.25}
            dot={data.length === 1} activeDot={{ r: 3 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <div className="dash-cost-sources">
      <button onClick={onOpen}><i />Key dịch vụ<strong>{vnd(metrics.service_cost_vnd)}</strong><ArrowRightOutlined /></button>
    </div>
    <p className="dash-cost-note">Chỉ ghi nhận chi phí bài viết dùng hạn mức được cấp, theo ngày gọi AI. Key cá nhân không được theo dõi chi phí.</p>
  </section>;
}

function JobList({ rows, scheduled }: { rows: Job[]; scheduled?: boolean }) {
  if (!rows.length) return <div className="dash-list-empty">
    {scheduled ? <CalendarOutlined /> : <CheckCircleOutlined />}
    {scheduled ? 'Chưa có lịch sắp chạy' : 'Chưa có yêu cầu lỗi'}
  </div>;
  return <ul className="dash-jobs">
    {rows.map(job => {
      const when = scheduled && job.scheduled_at ? displayVietnamTime(job.scheduled_at) : undefined;
      return <li key={jobId(job)}>
        <button onClick={() => go('jobs', { job: jobId(job) })}>
          {when ? <span className="dash-date" aria-hidden="true"><small>Th{when.format('MM')}</small><b>{when.format('DD')}</b></span>
            : <span className="dash-issue-icon"><WarningOutlined /></span>}
          <span className="dash-job-label"><strong>{job.keyword}</strong><span>{job.website_name} · {datetime(scheduled ? job.scheduled_at : job.completed_at ?? job.updated_at ?? job.created_at)}</span>{!scheduled && <span className="dash-failure-cause">{job.error_message || job.error_code || 'Mở chi tiết để xem nguyên nhân'}</span>}</span>
          <Status value={job.status} />
        </button>
      </li>;
    })}
  </ul>;
}

function DeliveryFailures({ rows }: { rows: Delivery[] }) {
  if (!rows.length) return <div className="dash-list-empty"><CheckCircleOutlined />Chưa có lượt giao lỗi</div>;
  return <ul className="dash-jobs">{rows.map(row => <li key={row.id}>
    <button type="button" onClick={() => go('deliveries', { delivery: row.id })}>
      <span className="dash-issue-icon" aria-hidden="true"><SendOutlined /></span>
      <span className="dash-job-label"><strong>{row.keyword || row.job_id}</strong><span>{row.website_name} · {number.format(row.attempt_count ?? row.attempts)} lần gửi</span>
        <span className="dash-failure-cause">{row.last_error || (row.last_http_status ? `Website trả về HTTP ${row.last_http_status}` : 'Mở chi tiết để xem nguyên nhân')}</span></span>
      <ArrowRightOutlined aria-hidden="true" />
    </button>
  </li>)}</ul>;
}

function AttentionPanel({ data, scope }: { data: DashboardRuntime; scope: Record<string, string> }) {
  const attention = data.attention;
  if (!attention) return null;
  const recovery = attention.stale_writing + attention.stale_sending;
  const items = [
    { label: 'Lỗi viết', count: attention.write_errors, detail: 'Yêu cầu chưa viết thành công', onClick: () => go('jobs', { ...scope, status: 'failed' }) },
    { label: 'Lỗi giao bài', count: attention.delivery_errors, detail: 'Mở chi tiết để gửi lại', onClick: () => go('deliveries', { ...scope, status: 'failed' }) },
    { label: 'Chờ phục hồi', count: recovery, detail: `${number.format(attention.stale_writing)} viết · ${number.format(attention.stale_sending)} giao`, onClick: () => go(attention.stale_writing ? 'jobs' : 'deliveries', { ...scope, issue: 'stale' }) },
  ];
  return <section className="dash-attention" aria-labelledby="dash-attention-title">
    <header><h2 id="dash-attention-title"><WarningOutlined aria-hidden="true" />Cần xử lý</h2><span>Các vấn đề hiện tại · Không phụ thuộc khoảng ngày</span></header>
    <div className="dash-attention-items">{items.map(item => <button type="button" key={item.label} disabled={!item.count} onClick={item.onClick}>
      <span>{item.label}<ArrowRightOutlined aria-hidden="true" /></span><strong>{number.format(item.count)}</strong><small>{item.detail}</small>
    </button>)}</div>
    {attention.stale_writing > 0 && attention.stale_sending > 0 && <button className="dash-recovery-link" type="button" onClick={() => go('deliveries', { ...scope, issue: 'stale' })}>Xem lượt giao chờ phục hồi <ArrowRightOutlined /></button>}
  </section>;
}

function elapsedTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  if (value < 60) return `${value} giây`;
  if (value < 3600) return `${Math.floor(value / 60)} phút ${value % 60} giây`;
  return `${Math.floor(value / 3600)} giờ ${Math.floor(value % 3600 / 60)} phút`;
}

function useEventRefresh(revision: number, loading: boolean, reload: () => void) {
  const refreshed = useRef(0);
  useEffect(() => {
    if (loading || document.hidden || revision <= refreshed.current) return;
    const timer = window.setTimeout(() => {
      refreshed.current = revision;
      reload();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [revision, loading]);
}

type ConnectionState = 'connecting' | 'live' | 'reconnecting';

function RuntimePanel({ data, requestedAt, loading, error, onRetry, scope, connection }: {
  data?: DashboardRuntime; requestedAt?: number; loading: boolean; error?: Error; onRetry: () => void; scope: Record<string, string>; connection: ConnectionState;
}) {
  const summary = data?.summary;
  const received = useMemo(() => requestedAt ?? performance.now(), [data, requestedAt]);
  const [clock, setClock] = useState(() => performance.now());
  const [showIdle, setShowIdle] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(performance.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const snapshotAge = Math.max(0, Math.floor((clock - received) / 1_000));
  const stale = Boolean(error) || snapshotAge >= 30;
  const live = Boolean(data) && !stale && connection === 'live';
  const liveLabel = stale ? 'Chưa cập nhật được' : connection === 'reconnecting' ? 'Đang kết nối lại' : !data || connection === 'connecting' ? 'Đang kết nối' : 'Trực tiếp';
  const deliveries = data?.deliveries;
  const hasActivity = Boolean(summary?.writing || summary?.queued || deliveries?.pending || deliveries?.sending);
  return <section className={`panel dash-runtime${data && !hasActivity ? ' dash-runtime-idle' : ''}`} aria-labelledby="dash-runtime-title" aria-busy={loading}>
    <header className="dash-panel-header dash-runtime-header">
      <div><h2 id="dash-runtime-title">Hoạt động hiện tại</h2><p>Theo khách hàng và website đã chọn · Không phụ thuộc khoảng ngày</p></div>
      <span className={`dash-live${live ? '' : ' dash-live-error'}`} role="status"><i aria-hidden="true" />{liveLabel}<small>{data ? `Cập nhật ${runtimeTime(data.observed_at)}` : 'Đang tải dữ liệu'}</small></span>
    </header>
    {error && <Alert className="dash-runtime-error" type="warning" showIcon title="Không thể cập nhật hoạt động hiện tại" description={error.message}
      action={<Button size="small" onClick={onRetry}>Thử lại</Button>} />}
    {!data && loading && <Skeleton active paragraph={{ rows: 3 }} />}
    {data && summary && <>
      <div className="dash-runtime-stats">
        <button type="button" className="dash-runtime-stat" onClick={() => go('jobs', { ...scope, status: 'writing' })}>
          <span><SyncOutlined aria-hidden="true" />Đang viết</span><strong>{number.format(summary.writing)}</strong><small>Job đang được xử lý<ArrowRightOutlined aria-hidden="true" /></small>
        </button>
        <button type="button" className="dash-runtime-stat" onClick={() => go('jobs', { ...scope, issue: 'queue' })}>
          <span><ClockCircleOutlined aria-hidden="true" />Đang chờ</span><strong>{number.format(summary.queued)}</strong><small>Bao gồm lịch đã đến giờ</small>
        </button>
        <div className="dash-runtime-stat dash-runtime-threads">
          <span><ThunderboltOutlined aria-hidden="true" />Lease viết còn hiệu lực</span><strong>{number.format(summary.active_threads)}</strong><small>Yêu cầu đang được worker giữ</small>
        </div>
      </div>
      {deliveries && <div className="dash-delivery-stats" aria-label="Hoạt động giao bài">
        <button type="button" className="dash-runtime-stat" onClick={() => go('deliveries', { ...scope, status: 'pending' })}>
          <span><ClockCircleOutlined aria-hidden="true" />Chờ giao</span><strong>{number.format(deliveries.pending)}</strong><small>{deliveries.oldest_wait_seconds == null ? 'Chưa có lượt chờ đến giờ' : `Lâu nhất ${elapsedTime(deliveries.oldest_wait_seconds)}`}</small>
        </button>
        <button type="button" className="dash-runtime-stat" onClick={() => go('deliveries', { ...scope, status: 'sending' })}>
          <span><SendOutlined aria-hidden="true" />Đang giao</span><strong>{number.format(deliveries.sending)}</strong><small>{number.format(deliveries.active_threads)} lượt có lease hợp lệ</small>
        </button>
        <button type="button" className="dash-runtime-stat dash-runtime-threads" onClick={() => go('deliveries', { ...scope, status: 'failed' })}>
          <span><WarningOutlined aria-hidden="true" />Giao lỗi</span><strong>{number.format(deliveries.failed)}</strong><small>Mở danh sách để kiểm tra và gửi lại</small>
        </button>
      </div>}
      {(summary.oldest_wait_seconds != null || Boolean(summary.overdue_schedules)) && <div className="dash-queue-age">
        {summary.oldest_wait_seconds != null && <span>Chờ viết lâu nhất: <b>{elapsedTime(summary.oldest_wait_seconds)}</b></span>}
        {Boolean(summary.overdue_schedules) && <button type="button" onClick={() => go('jobs', { ...scope, issue: 'overdue' })}>{number.format(summary.overdue_schedules!)} lịch đã quá giờ <ArrowRightOutlined /></button>}
      </div>}
      <div className="dash-runtime-context">
        <span>Cấu hình mỗi tiến trình: <b>{number.format(data.capacity.writer_per_process)}</b> luồng viết · <b>{number.format(data.capacity.webhook_per_process)}</b> luồng giao bài</span>
        <button type="button" onClick={() => go('jobs', { ...scope, status: 'scheduled', issue: 'future' })}><CalendarOutlined aria-hidden="true" />{number.format(summary.scheduled)} lịch chưa đến giờ<ArrowRightOutlined aria-hidden="true" /></button>
      </div>
      {data.workers && <div className="dash-worker-health" aria-label="Tiến trình worker thực tế">
        <span className="dash-worker-scope">Toàn hệ thống · heartbeat trong 15 giây</span>
        {(['writer', 'webhook'] as const).map(role => {
          const worker = data.workers![role];
          return <div key={role} className={worker.processes ? '' : 'dash-worker-offline'}>
            <i aria-hidden="true" /><b>{role === 'writer' ? 'Worker viết' : 'Worker giao'}</b>
            <span>{number.format(worker.processes)} tiến trình · {number.format(worker.concurrency)} luồng nhận việc</span>
            <small>{number.format(worker.active_tasks)} lượt kiểm tra / xử lý đang chạy</small>
            <small>{worker.last_heartbeat_at ? `Heartbeat ${runtimeTime(worker.last_heartbeat_at)}` : 'Chưa nhận heartbeat còn hiệu lực'}</small>
            {worker.accepting_processes != null && worker.accepting_processes < worker.processes && <small>{number.format(worker.processes - worker.accepting_processes)} tiến trình đang tạm ngừng nhận việc</small>}
          </div>;
        })}
        <p>Số tiến trình và luồng là tổng toàn hệ thống; số yêu cầu phía trên theo bộ lọc đã chọn. Lượt kiểm tra / xử lý bao gồm cả kiểm tra hàng đợi.</p>
      </div>}
      {summary.stale_writing > 0 && <p className="dash-runtime-lease-note">Có job viết quá thời gian lease: {number.format(summary.stale_writing)} job đang chờ worker phục hồi và không tính vào số lease còn hiệu lực.</p>}
      {data.providers.some(provider => provider.writing || provider.queued) && <div className="dash-runtime-providers" aria-label="Hoạt động theo nhà cung cấp">
        {data.providers.filter(provider => provider.writing || provider.queued).map(provider => <div key={provider.provider}>
          <b>{provider.display_name ?? providerLabels[provider.provider] ?? provider.provider}</b><span>{number.format(provider.active_threads)} luồng bận · {number.format(provider.queued)} chờ</span>
        </div>)}
      </div>}
      {!hasActivity && <div className="dash-idle-heading"><span><CheckCircleOutlined /> Hàng đợi đang trống</span><Button type="text" size="small" aria-expanded={showIdle} onClick={() => setShowIdle(value => !value)}>{showIdle ? 'Thu gọn' : 'Xem chi tiết'}</Button></div>}
      {(hasActivity || showIdle) && <><div className="dash-runtime-jobs-heading"><h3>Đang xử lý</h3><Button type="link" icon={<ArrowRightOutlined />} iconPlacement="end" onClick={() => go('jobs', { ...scope, status: 'writing' })}>Xem tất cả</Button></div>
      {!data.running.length ? <div className="dash-list-empty"><CheckCircleOutlined aria-hidden="true" />Hiện không có job đang viết</div>
        : <ul className="dash-running-jobs">{data.running.map(job => <li key={jobId(job)}>
          <button type="button" onClick={() => go('jobs', { job: jobId(job) })} aria-label={`Xem chi tiết ${job.keyword}`}>
            <span className={`dash-running-icon${job.lease_active ? '' : ' dash-running-stale'}`} aria-hidden="true">{job.lease_active ? <SyncOutlined /> : <WarningOutlined />}</span>
            <span className="dash-running-identity"><strong>{job.keyword}</strong><span>{job.website_name || 'Website chưa xác định'} · {job.customer_name || 'Khách hàng chưa xác định'}</span></span>
            <span className="dash-running-model"><b>{job.provider_display_name ?? providerLabels[job.provider ?? ''] ?? job.provider ?? '—'}</b><span>{job.upstream_model ?? job.model}</span></span>
            <span className="dash-running-time"><b>{elapsedTime(job.elapsed_seconds + (job.lease_active ? Math.min(snapshotAge, 30) : 0))}</b><span>Bắt đầu {datetime(job.started_at)}</span></span>
            <span className={`dash-running-state${job.lease_active ? '' : ' dash-running-state-stale'}`}>{job.lease_active ? writingStageLabel(job.writing_stage) : 'Chờ phục hồi'}</span>
            <ArrowRightOutlined className="dash-running-arrow" aria-hidden="true" />
          </button>
        </li>)}</ul>}
      {summary.writing > data.running.length && <p className="dash-runtime-more">Đang hiển thị {number.format(data.running.length)} / {number.format(summary.writing)} job. Chọn “Xem tất cả” để mở danh sách đầy đủ.</p>}</>}
    </>}
  </section>;
}

export function Dashboard({ query }: { query: URLSearchParams }) {
  const [dates, setDates] = useState(() => periodFor(query));
  const [calendarOpen, setCalendarOpen] = useState(query.get('view') === 'calendar');
  const [customerId, setCustomerId] = useState(query.get('customer_id') ?? undefined);
  const [websiteId, setWebsiteId] = useState(query.get('website_id') ?? undefined);
  const customers = useCatalog('/customers', customerId);
  const websites = useCatalog('/websites', websiteId, customerId);
  const customerMetricId = customerId ?? websites.selected?.customer_id;
  const scope = { ...(customerId ? { customer_id: customerId } : {}), ...(websiteId ? { website_id: websiteId } : {}) };
  const filters = { ...scope, from: dates[0].format('YYYY-MM-DD'), to: dates[1].format('YYYY-MM-DD') };
  const report = useResource<DashboardData>(calendarOpen ? null : withQuery('/dashboard', filters));
  const runtime = useResource<DashboardRuntime>(calendarOpen ? null : withQuery('/dashboard/runtime', scope));
  const [refreshRequest, setRefreshRequest] = useState(0);
  const [runtimeRefresh, setRuntimeRefresh] = useState(0);
  const [reportRefresh, setReportRefresh] = useState(0);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  useEventRefresh(refreshRequest + runtimeRefresh, runtime.loading, runtime.reload);
  useEventRefresh(refreshRequest + reportRefresh, report.loading, report.reload);
  useEffect(() => {
    const runtimeTimer = window.setInterval(() => { if (!document.hidden) setRuntimeRefresh(value => value + 1); }, 10_000);
    const reportTimer = window.setInterval(() => { if (!document.hidden) setReportRefresh(value => value + 1); }, 60_000);
    return () => { window.clearInterval(runtimeTimer); window.clearInterval(reportTimer); };
  }, []);
  useEffect(() => {
    const readLocation = () => {
      const [page, search] = window.location.hash.slice(1).split('?');
      if (page !== 'overview') return;
      const next = new URLSearchParams(search);
      setDates(periodFor(next));
      setCalendarOpen(next.get('view') === 'calendar');
      setCustomerId(next.get('customer_id') ?? undefined);
      setWebsiteId(next.get('website_id') ?? undefined);
    };
    window.addEventListener('hashchange', readLocation);
    window.addEventListener('popstate', readLocation);
    return () => {
      window.removeEventListener('hashchange', readLocation);
      window.removeEventListener('popstate', readLocation);
    };
  }, []);
  function changeFilters(nextDates: [dayjs.Dayjs, dayjs.Dayjs], nextCustomer?: string, nextWebsite?: string) {
    setDates(nextDates); setCustomerId(nextCustomer); setWebsiteId(nextWebsite);
    const next = new URLSearchParams({ from: nextDates[0].format('YYYY-MM-DD'), to: nextDates[1].format('YYYY-MM-DD') });
    if (nextCustomer) next.set('customer_id', nextCustomer);
    if (nextWebsite) next.set('website_id', nextWebsite);
    const hash = `#overview?${next}`;
    if (window.location.hash !== hash) window.history.pushState(null, '', hash);
  }
  function changeView(open: boolean) {
    setCalendarOpen(open);
    const next = new URLSearchParams(filters);
    if (open) next.set('view', 'calendar');
    const hash = `#overview?${next}`;
    if (window.location.hash !== hash) window.history.pushState(null, '', hash);
  }
  useEffect(() => {
    const scheduleRefresh = () => setRefreshRequest(previous => previous + 1);
    const connected = () => setConnection('live');
    const ready = () => { connected(); scheduleRefresh(); };
    const disconnected = () => setConnection('reconnecting');
    const receive = (data: string) => {
      if (!data) return;
      try {
        const payload = JSON.parse(data) as { job_id?: string };
        if (typeof payload.job_id === 'string' && payload.job_id) scheduleRefresh();
      } catch {
        // Ignore malformed event frames; the event transport reconnects itself.
      }
    };
    const unsubscribe = subscribeCrmEvents('/jobs/events', {
      'job.created': receive, 'job.updated': receive, 'job.deleted': receive,
      message: receive, open: connected, ready, error: disconnected,
    });
    document.addEventListener('visibilitychange', scheduleRefresh);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', scheduleRefresh);
    };
  }, []);
  const metrics = report.data?.metrics;
  const today = vietnamToday();
  const periodPresets = [
    { label: 'Hôm nay', value: [today, today] as [dayjs.Dayjs, dayjs.Dayjs] },
    { label: '14 ngày qua', value: [today.subtract(13, 'day'), today] as [dayjs.Dayjs, dayjs.Dayjs] },
    { label: 'Tháng này', value: [today.startOf('month'), today] as [dayjs.Dayjs, dayjs.Dayjs] },
  ];
  const [failureTab, setFailureTab] = useState('writing');

  if (calendarOpen) return <OverviewCalendar initialDate={dates[1].format('YYYY-MM-DD')} customerId={customerId} websiteId={websiteId}
    scopeLabel={[customers.selected?.name, websites.selected?.name].filter(Boolean).join(' · ')} revision={refreshRequest + reportRefresh}
    onClose={() => changeView(false)} />;

  return <div className="dash">
    <PageHeading title="Tổng quan" description="Hoạt động viết, giao bài và sử dụng ngân sách AI." action={
      <div className="dash-heading-actions"><Button icon={<CalendarOutlined />} onClick={() => changeView(true)}>Xem dạng lịch</Button>
        <Button icon={<ReloadOutlined />} loading={report.loading || runtime.loading} onClick={() => { report.reload(); runtime.reload(); }}>Làm mới</Button></div>
    } />
    <div className="dash-filters">
      <DatePicker.RangePicker aria-label="Khoảng ngày báo cáo" classNames={{ popup: { root: 'dash-period-popup' } }} allowClear={false} value={dates} format="DD/MM/YYYY" presets={periodPresets} onChange={(value) => {
        if (value?.[0] && value[1]) changeFilters([value[0], value[1]], customerId, websiteId);
      }} />
      <Select prefix={<TeamOutlined />} placeholder="Tất cả khách hàng" aria-label="Khách hàng" allowClear showSearch={customers.searchConfig} value={customerId}
        loading={customers.loading} options={customers.options} onChange={(value) => changeFilters(dates, value)} />
      <Select prefix={<GlobalOutlined />} placeholder="Tất cả website" aria-label="Website" allowClear showSearch={websites.searchConfig} value={websiteId}
        loading={websites.loading} options={websites.options} onChange={value => changeFilters(dates, customerId, value)} />
      <Button type="text" icon={<UndoOutlined />} onClick={() => changeFilters([today.subtract(13, 'day'), today])}>Xóa bộ lọc</Button>
    </div>
    <div className="dash-period-summary" aria-label="Kỳ báo cáo">Số liệu kỳ: {dates[0].format('DD/MM')}–{dates[1].format('DD/MM/YYYY')}</div>
    <ResourceError error={report.error} onRetry={report.reload} />
    {(customers.error || websites.error) && <Alert type="warning" showIcon title="Không thể tải đầy đủ bộ lọc." className="resource-error" />}
    {runtime.data && <AttentionPanel data={runtime.data} scope={scope} />}
    <RuntimePanel data={runtime.data} requestedAt={runtime.requestedAt} loading={runtime.loading} error={runtime.error} onRetry={runtime.reload} scope={scope} connection={connection} />
    {!report.data && report.loading && <Panel><Skeleton active paragraph={{ rows: 12 }} /></Panel>}
    {metrics && report.data && <>
      <p className="dash-period-caption">Bài viết / lượt giao theo ngày hoàn tất trong kỳ · Khách hàng và hàng đợi theo hiện trạng</p>
      <div className="dash-metrics">
        <Metric label="Bài đã viết" value={metrics.articles} detail={`${number.format(metrics.pending)} yêu cầu hiện đang chờ`}
          icon={<FileTextOutlined />} featured onClick={() => go('jobs', { ...filters, status: 'ready' })} />
        <Metric label="Bài đã giao" value={metrics.delivered} detail={`${number.format(metrics.delivery_errors)} lỗi giao bài`}
          icon={<SendOutlined />} onClick={() => go('deliveries', { ...filters, status: 'delivered', event: 'article.ready' })} />
        <Metric label="Khách hàng" value={metrics.customers} detail={`${number.format(metrics.websites)} website hiện tại`}
          icon={<TeamOutlined />} disabled={Boolean(websiteId && !customerMetricId)}
          onClick={() => go('customers', customerMetricId ? { customer: customerMetricId } : undefined)} />
      </div>
      <div className="dash-charts">
        <VolumePanel series={report.data.series} />
        <CostPanel series={report.data.series} metrics={metrics} onOpen={() => go('jobs', { ...filters, date_basis: 'cost', key_mode: 'service' })} />
      </div>
      <div className="dash-queues">
        <Panel title="Lịch đang chờ" extra={<Button type="link" icon={<ArrowRightOutlined />} iconPlacement="end" onClick={() => go('jobs', { ...scope, status: 'scheduled' })}>Xem lịch</Button>}>
          <JobList rows={report.data.upcoming} scheduled />
        </Panel>
        <Panel title="Lỗi gần đây" extra={<Button type="link" icon={<ArrowRightOutlined />} iconPlacement="end" onClick={() => go(failureTab === 'writing' ? 'jobs' : 'deliveries', { ...scope, status: 'failed' })}>Xem tất cả</Button>}>
          <Tabs activeKey={failureTab} onChange={setFailureTab} size="small" items={[
            { key: 'writing', label: 'Lỗi viết', children: <JobList rows={(runtime.data?.write_failures ?? report.data.failures).slice(0, 5)} /> },
            { key: 'delivery', label: 'Lỗi giao bài', children: <DeliveryFailures rows={(runtime.data?.delivery_failures ?? []).slice(0, 5)} /> },
          ]} />
        </Panel>
      </div>
    </>}
  </div>;
}
