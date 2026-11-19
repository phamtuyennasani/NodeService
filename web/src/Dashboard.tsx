import { useState, type ReactNode } from 'react';
import { Alert, Button, DatePicker, Segmented, Select, Skeleton } from 'antd';
import {
  ArrowRightOutlined, ArrowUpOutlined, CalendarOutlined, CheckCircleOutlined, FileTextOutlined,
  GlobalOutlined, ReloadOutlined, SendOutlined, TeamOutlined, WarningOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer,
  Tooltip as ChartTooltip, XAxis, YAxis,
} from 'recharts';
import { useCatalog, useResource, withQuery } from './api';
import { datetime, displayVietnamTime, EmptyState, go, jobId, number, PageHeading, Panel, ResourceError, Status, usd } from './shared';
import type { DashboardData, Job } from './types';
import './dashboard.css';

const vietnamToday = () => dayjs(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date()));
const costNumber = new Intl.NumberFormat('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 12 });
const shortDate = (date: string) => dayjs(date).format('DD/MM');
const fullDate = (date: unknown) => dayjs(String(date)).format('DD/MM/YYYY');
const volumeSeries = [
  { key: 'articles', name: 'Đã viết', color: '#315b46' },
  { key: 'delivered', name: 'Đã giao', color: '#e3ac4b' },
] as const;

function periodFor(value: URLSearchParams): [dayjs.Dayjs, dayjs.Dayjs] {
  if (value.get('from') && value.get('to')) return [dayjs(value.get('from')), dayjs(value.get('to'))];
  const today = vietnamToday();
  return [today.subtract(13, 'day'), today];
}

function Metric({ label, value, detail, icon, featured, onClick }: {
  label: string; value: number; detail: string; icon: ReactNode; featured?: boolean; onClick: () => void;
}) {
  return <button type="button" className={`dash-metric${featured ? ' dash-metric-featured' : ''}`} onClick={onClick}>
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
  metrics: DashboardData['metrics']; series: DashboardData['series']; onOpen: (keyMode: string) => void;
}) {
  const total = Number(metrics.service_cost_usd) + Number(metrics.customer_cost_usd);
  const data = series.map(point => ({
    date: point.date, service: Number(point.service_cost_usd), own: Number(point.customer_cost_usd),
  }));
  return <section className="dash-cost">
    <header className="dash-panel-header"><h2>Chi phí AI</h2></header>
    <div className="dash-cost-total">{costNumber.format(total)} <span>USD</span></div>
    <div className="dash-cost-plot">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart title="Chi phí theo ngày của từng nguồn API key" data={data} margin={{ top: 6, right: 3, bottom: 2, left: 3 }}>
          <defs><linearGradient id="dash-cost-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#edc47b" stopOpacity={.23} /><stop offset="100%" stopColor="#edc47b" stopOpacity={0} />
          </linearGradient></defs>
          <XAxis dataKey="date" hide />
          <YAxis hide domain={[0, (max: number) => max || 1]} />
          <ChartTooltip labelFormatter={fullDate} formatter={value => usd(Number(value))}
            cursor={{ stroke: '#a2b39b', strokeDasharray: '3 4' }} />
          <Area dataKey="service" name="Key dịch vụ" stroke="#f2c372" fill="url(#dash-cost-fill)" strokeWidth={2.25}
            dot={data.length === 1} activeDot={{ r: 3 }} isAnimationActive={false} />
          <Area dataKey="own" name="Key khách hàng" stroke="#a7cbb3" fill="transparent" strokeDasharray="4 3" strokeWidth={1.5}
            dot={data.length === 1} activeDot={{ r: 3 }} isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
    <div className="dash-cost-sources">
      <button onClick={() => onOpen('service')}><i />Key dịch vụ<strong>{usd(metrics.service_cost_usd)}</strong><ArrowRightOutlined /></button>
      <button onClick={() => onOpen('own')}><i />Key khách hàng<strong>{usd(metrics.customer_cost_usd)}</strong><ArrowRightOutlined /></button>
    </div>
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
          <span className="dash-job-label"><strong>{job.keyword}</strong><span>{job.website_name} · {datetime(job.scheduled_at ?? job.created_at)}</span></span>
          <Status value={job.status} />
        </button>
      </li>;
    })}
  </ul>;
}

export function Dashboard({ query }: { query: URLSearchParams }) {
  const [dates, setDates] = useState(() => periodFor(query));
  const [customerId, setCustomerId] = useState(query.get('customer_id') ?? undefined);
  const [websiteId, setWebsiteId] = useState(query.get('website_id') ?? undefined);
  const customers = useCatalog('/customers', customerId);
  const websites = useCatalog('/websites', websiteId, customerId);
  const scope = { ...(customerId ? { customer_id: customerId } : {}), ...(websiteId ? { website_id: websiteId } : {}) };
  const filters = { ...scope, from: dates[0].format('YYYY-MM-DD'), to: dates[1].format('YYYY-MM-DD') };
  const report = useResource<DashboardData>(withQuery('/dashboard', filters));
  const metrics = report.data?.metrics;
  const today = vietnamToday();

  return <div className="dash">
    <PageHeading title="Tổng quan" description="Hoạt động viết, giao bài và sử dụng ngân sách AI." action={
      <Button icon={<ReloadOutlined />} loading={report.loading} onClick={report.reload}>Làm mới</Button>
    } />
    <div className="dash-filters">
      <DatePicker.RangePicker classNames={{ popup: { root: 'dash-period-popup' } }} allowClear={false} value={dates} format="DD/MM/YYYY" presets={[
        { label: 'Hôm nay', value: [today, today] },
        { label: '14 ngày qua', value: [today.subtract(13, 'day'), today] },
        { label: 'Tháng này', value: [today.startOf('month'), today] },
      ]} onChange={(value) => {
        if (value?.[0] && value[1]) setDates([value[0], value[1]]);
      }} />
      <Select prefix={<TeamOutlined />} placeholder="Tất cả khách hàng" aria-label="Khách hàng" allowClear showSearch={customers.searchConfig} value={customerId}
        loading={customers.loading} options={customers.options} onChange={(value) => { setCustomerId(value); setWebsiteId(undefined); }} />
      <Select prefix={<GlobalOutlined />} placeholder="Tất cả website" aria-label="Website" allowClear showSearch={websites.searchConfig} value={websiteId}
        loading={websites.loading} options={websites.options} onChange={setWebsiteId} />
    </div>
    <ResourceError error={report.error} onRetry={report.reload} />
    {(customers.error || websites.error) && <Alert type="warning" showIcon title="Không thể tải đầy đủ bộ lọc." className="resource-error" />}
    {!report.data && report.loading && <Panel><Skeleton active paragraph={{ rows: 12 }} /></Panel>}
    {metrics && report.data && <>
      <div className="dash-metrics">
        <Metric label="Bài đã viết" value={metrics.articles} detail={`${number.format(metrics.pending)} yêu cầu đang chờ`}
          icon={<FileTextOutlined />} featured onClick={() => go('jobs', { ...filters, status: 'ready' })} />
        <Metric label="Bài đã giao" value={metrics.delivered} detail={`${number.format(metrics.delivery_errors)} lỗi giao bài`}
          icon={<SendOutlined />} onClick={() => go('deliveries', { ...filters, status: 'delivered', event: 'article.ready' })} />
        <Metric label="Khách hàng" value={metrics.customers} detail={`${number.format(metrics.websites)} website tích hợp`}
          icon={<TeamOutlined />} onClick={() => go('customers', customerId ? { customer: customerId } : undefined)} />
      </div>
      <div className="dash-charts">
        <VolumePanel series={report.data.series} />
        <CostPanel series={report.data.series} metrics={metrics} onOpen={key_mode => go('jobs', { ...filters, date_basis: 'cost', key_mode })} />
      </div>
      {metrics.unpriced_attempts > 0 && <Alert className="resource-error" type="warning" showIcon title={`${number.format(metrics.unpriced_attempts)} lần gọi AI đang chờ đối soát chi phí`} />}
      <div className="dash-queues">
        <Panel title="Lịch sắp chạy" extra={<Button type="link" icon={<ArrowRightOutlined />} iconPlacement="end" onClick={() => go('jobs', { ...scope, status: 'scheduled' })}>Xem lịch</Button>}>
          <JobList rows={report.data.upcoming} scheduled />
        </Panel>
        <Panel title="Yêu cầu cần xử lý" extra={<Button type="link" icon={<ArrowRightOutlined />} iconPlacement="end" onClick={() => go('jobs', { ...filters, status: 'failed' })}>Xem lỗi viết</Button>}>
          <JobList rows={report.data.failures} />
        </Panel>
      </div>
    </>}
  </div>;
}
