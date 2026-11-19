import { useState } from 'react';
import { Alert, App, Button, DatePicker, Descriptions, Drawer, Grid, Input, Select, Skeleton, Space, Table, Tabs, Tag } from 'antd';
import { ArrowRightOutlined, ControlOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { mutate, useCatalog, useResource, useSearchValue, withQuery } from './api';
import { compactId, CursorPagination, datetime, EmptyState, go, jobId, PageHeading, Panel, ResourceError, Status, usd } from './shared';
import type { Attempt, Collection, Delivery, Job, JobDetails } from './types';
import './records.css';

const jobStatuses = [['scheduled', 'Chờ đến lịch'], ['queued', 'Chờ viết'], ['writing', 'Đang viết'], ['ready', 'Đã viết'], ['failed', 'Lỗi viết'], ['canceled', 'Đã hủy']];
const deliveryStatuses = [['pending', 'Chờ giao'], ['sending', 'Đang giao'], ['delivered', 'Đã giao'], ['failed', 'Lỗi giao bài']];
const modeLabels: Record<string, string> = { schedule: 'Lên lịch', scheduled: 'Lên lịch', preview: 'Widget', rewrite: 'Viết lại' };
const eventLabels: Record<string, string> = { 'article.ready': 'Bài đã viết', 'article.failed': 'Viết lỗi' };

function useFilters(query: URLSearchParams, compact: boolean) {
  const [customerId, setCustomerId] = useState(query.get('customer_id') ?? undefined);
  const [websiteId, setWebsiteId] = useState(query.get('website_id') ?? undefined);
  const [status, setStatus] = useState(query.get('status') ?? undefined);
  const [dates, setDates] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(() => {
    const from = query.get('from');
    const to = query.get('to');
    return from || to ? [from ? dayjs(from) : null, to ? dayjs(to) : null] : null;
  });
  const [cursor, setCursor] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(() => ['customer_id', 'website_id', 'from', 'to', 'key_mode', 'mode'].some(key => query.has(key)));
  const customers = useCatalog('/customers', customerId);
  const websites = useCatalog('/websites', websiteId, customerId);
  const fromDate = dates?.[0]?.format('YYYY-MM-DD');
  const toDate = dates?.[1]?.format('YYYY-MM-DD');

  function changeDate(which: 'from' | 'to', input: string) {
    const date = input ? dayjs(input) : null;
    const start = which === 'from' ? date : dates?.[0] ?? null;
    const end = which === 'to' ? date : dates?.[1] ?? null;
    if (start && end && start.isAfter(end, 'day')) return;
    setDates(start || end ? [start, end] : null);
    setCursor([]);
  }

  return {
    parameters: {
      customer_id: customerId,
      website_id: websiteId,
      status,
      from: fromDate,
      to: toDate,
      cursor: cursor.at(-1),
      limit: 20,
    },
    cursor,
    setCursor,
    expanded,
    toggle(extraCount = 0) {
      const count = [customerId, websiteId, dates].filter(Boolean).length + extraCount;
      return <Button className="record-filter-button" icon={<ControlOutlined />} aria-expanded={expanded} aria-controls="more-record-filters"
        onClick={() => setExpanded(!expanded)}>Bộ lọc{count > 0 && <span className="record-filter-count">{count}</span>}</Button>;
    },
    statusInput(statuses: string[][]) {
      return <Select aria-label="Trạng thái" placeholder="Tất cả trạng thái" value={status} allowClear onChange={(value) => { setStatus(value); setCursor([]); }}
        options={statuses.map(([value, label]) => ({ value, label }))} />;
    },
    inputs() {
      return <>
        <Select aria-label="Khách hàng" placeholder="Tất cả khách hàng" value={customerId} allowClear showSearch={customers.searchConfig} loading={customers.loading} onChange={(value) => { setCustomerId(value); setWebsiteId(undefined); setCursor([]); }}
          options={customers.options} />
        <Select aria-label="Website" placeholder="Tất cả website" value={websiteId} allowClear showSearch={websites.searchConfig} loading={websites.loading} onChange={(value) => { setWebsiteId(value); setCursor([]); }}
          options={websites.options} />
        {compact ? <div className="record-native-range">
          <label>Từ ngày<Input type="date" value={fromDate ?? ''} max={toDate} onChange={event => changeDate('from', event.target.value)} /></label>
          <label>Đến ngày<Input type="date" value={toDate ?? ''} min={fromDate} onChange={event => changeDate('to', event.target.value)} /></label>
        </div> : <DatePicker.RangePicker value={dates} format="DD/MM/YYYY" onChange={(value) => { setDates(value); setCursor([]); }} />}
      </>;
    },
  };
}

function JobDrawer({ id, close }: { id: string | null; close: () => void }) {
  const detail = useResource<JobDetails>(id ? `/jobs/${id}` : null);
  const job = detail.data;
  const article = job?.result?.[0];
  return <Drawer title={job?.keyword ?? 'Chi tiết yêu cầu viết'} open={Boolean(id)} size={760} onClose={close}
    extra={<Button icon={<ReloadOutlined />} loading={detail.loading} onClick={detail.reload}>Làm mới</Button>}>
    <ResourceError error={detail.error} onRetry={detail.reload} />
    {detail.loading && !job && <Skeleton active />}
    {job && <>
      <Descriptions className="profile-description" column={{ xs: 1, sm: 2 }} size="small" items={[
        { key: 'status', label: 'Trạng thái', children: <Status value={job.status} /> },
        { key: 'model', label: 'Model', children: <span className="mono">{job.model}</span> },
        { key: 'client', label: 'Khách hàng', children: job.customer_name },
        { key: 'website', label: 'Website', children: job.website_name },
        { key: 'mode', label: 'Nguồn', children: modeLabels[job.mode] ?? job.mode },
        { key: 'key', label: 'Nguồn key', children: job.key_mode === 'service' ? 'Key dịch vụ' : 'Key riêng' },
        { key: 'sent', label: 'Giờ nhận', children: datetime(job.created_at) },
        { key: 'schedule', label: 'Giờ hẹn', children: datetime(job.scheduled_at) },
        { key: 'start', label: 'Giờ bắt đầu', children: datetime(job.started_at) },
        { key: 'end', label: 'Giờ hoàn tất', children: datetime(job.completed_at) },
      ]} />
      {job.error_message && <Alert type="error" showIcon title={job.error_code} description={job.error_message} />}
      <Tabs items={[
        { key: 'input', label: 'Yêu cầu', children: <Descriptions column={1} size="small" items={[
          { key: 'id', label: 'Mã yêu cầu', children: <span className="mono">{jobId(job)}</span> },
          { key: 'client', label: 'Mã yêu cầu Laravel', children: job.idempotency_key ?? '—' },
          { key: 'source', label: 'Phiên bản nguồn', children: job.source_article_id ? <a href={`#jobs?job=${job.source_article_id}`}>{job.source_article_id}</a> : '—' },
          { key: 'keyword', label: 'Từ khóa', children: job.keyword },
          { key: 'tone', label: 'Giọng văn', children: job.tone },
          { key: 'style', label: 'Phong cách', children: job.style },
          { key: 'length', label: 'Độ dài', children: `${job.length} từ` },
          { key: 'instructions', label: 'Hướng dẫn thêm', children: job.instructions ?? '—' },
        ]} /> },
        { key: 'result', label: 'Bài viết', children: article ? <article className="article-preview">
          <h2>{article.Title}</h2>
          <div className="article-summary">{article.Desc}</div>
          <div dangerouslySetInnerHTML={{ __html: article.Content }} />
          <Descriptions className="profile-description" column={1} size="small" items={[
            { key: 'slug', label: 'Slug', children: article.Slug },
            { key: 'seo', label: 'Mô tả SEO', children: article.Desction },
            { key: 'tags', label: 'Từ khóa', children: article['Từ khóa']?.map((keyword) => <Tag key={keyword}>{keyword}</Tag>) },
          ]} />
        </article> : <EmptyState description="Chưa có bài viết" /> },
        { key: 'json', label: 'JSON', children: job.result ? <pre className="code-block">{JSON.stringify(job.result, null, 2)}</pre> : <EmptyState description="Chưa có kết quả" /> },
        { key: 'attempts', label: `Lần gọi AI (${job.attempts?.length ?? 0})`, children: <AttemptList attempts={job.attempts ?? []} /> },
        { key: 'delivery', label: `Giao bài (${job.deliveries?.length ?? 0})`, children: job.deliveries?.length ? <>
          <Table size="small" rowKey="id" dataSource={job.deliveries} pagination={false} scroll={{ x: 470 }} columns={[
            { title: 'Sự kiện', dataIndex: 'event_type', render: (value) => eventLabels[value] ?? value },
            { title: 'Trạng thái', dataIndex: 'status', render: (value) => <Status value={value} /> },
            { title: 'Số lần gửi', dataIndex: 'attempts', align: 'right' },
            { title: '', key: 'view', render: (_, row) => <Button type="link" onClick={() => go('deliveries', { delivery: row.id })}>Chi tiết</Button> },
          ]} />
        </> : <EmptyState description="Chưa có sự kiện giao bài" /> },
      ]} />
    </>}
  </Drawer>;
}

function AttemptList({ attempts }: { attempts: Attempt[] }) {
  if (!attempts.length) return <EmptyState description="Chưa có lần gọi AI" />;
  return <div className="episode-list">{attempts.map((attempt) => <Panel key={attempt.id} title={attempt.model} extra={<Status value={attempt.status} />}>
    <Descriptions column={{ xs: 1, sm: 2 }} size="small" items={[
      { key: 'request', label: 'Giờ gọi', children: datetime(attempt.called_at ?? attempt.started_at) },
      { key: 'done', label: 'Hoàn tất', children: datetime(attempt.finished_at) },
      { key: 'price', label: 'Chi phí', children: attempt.cost_usd == null ? 'Chờ đối soát' : usd(attempt.cost_usd) },
      { key: 'source', label: 'Nguồn chi phí', children: attempt.cost_source === 'provider' ? 'Nhà cung cấp' : attempt.cost_source === 'catalog' || attempt.cost_source === 'estimated' ? 'Ước tính theo bảng giá' : attempt.cost_source === 'pending' ? 'Chờ đối soát' : attempt.cost_source ?? '—' },
      { key: 'version', label: 'Phiên bản giá', children: compactId(attempt.pricing_id ?? undefined) },
      { key: 'response', label: 'Mã phản hồi AI', children: compactId(attempt.provider_response_id ?? undefined) },
    ]} />
    {attempt.error_message && <Alert type="error" title={attempt.error_code} description={attempt.error_message} />}
    {(attempt.usage || attempt.pricing_snapshot) && <details className="attempt-details"><summary>Usage và đơn giá đã ghi</summary><pre className="code-block">{JSON.stringify({ usage: attempt.usage, pricing: attempt.pricing_snapshot }, null, 2)}</pre></details>}
  </Panel>)}</div>;
}

export function Jobs({ query }: { query: URLSearchParams }) {
  const screens = Grid.useBreakpoint();
  const [search, setSearch] = useState(query.get('q') ?? '');
  const searchValue = useSearchValue(search);
  const [keyMode, setKeyMode] = useState(query.get('key_mode') ?? undefined);
  const [mode, setMode] = useState(query.get('mode') ?? undefined);
  const [selected, setSelected] = useState(query.get('job'));
  const filters = useFilters(query, !screens.sm);
  const jobs = useResource<Collection<Job>>(withQuery('/jobs', { ...filters.parameters, q: searchValue, source: mode, date_basis: query.get('date_basis') ?? undefined, key_mode: keyMode }));
  return <>
    <PageHeading title="Yêu cầu viết" description={query.get('date_basis') === 'cost' ? 'Chi phí các lần gọi AI trong khoảng thời gian đã chọn.' : 'Xem lịch viết, bản xem trước và các phiên bản viết lại.'} action={<Button icon={<ReloadOutlined />} loading={jobs.loading} onClick={jobs.reload}>Làm mới</Button>} />
    <ResourceError error={jobs.error} onRetry={jobs.reload} />
    <Panel className="table-panel record-panel">
      <div className="table-toolbar record-toolbar">
        <Input prefix={<SearchOutlined />} placeholder="Tìm từ khóa hoặc mã yêu cầu" aria-label="Tìm yêu cầu viết" allowClear value={search} onChange={(event) => { setSearch(event.target.value); filters.setCursor([]); }} />
        {filters.statusInput(jobStatuses)}
        {filters.toggle(Number(Boolean(mode)) + Number(Boolean(keyMode)))}
      </div>
      {filters.expanded && <div id="more-record-filters" className="table-toolbar record-more-filters">
        <Select aria-label="Nguồn" placeholder="Tất cả nguồn" value={mode} allowClear onChange={(value) => { setMode(value); filters.setCursor([]); }} options={[
          { value: 'scheduled', label: 'Lên lịch' }, { value: 'preview', label: 'Widget' }, { value: 'rewrite', label: 'Viết lại' },
        ]} />
        {query.get('date_basis') === 'cost' && <Select aria-label="Nguồn API key" value={keyMode} allowClear placeholder="Tất cả nguồn API key" onChange={(value) => { setKeyMode(value); filters.setCursor([]); }} options={[
          { value: 'service', label: 'Key dịch vụ' }, { value: 'own', label: 'Key khách hàng' },
        ]} />}
        {filters.inputs()}
      </div>}
      <Table rowKey={jobId} dataSource={jobs.data?.data ?? []} loading={jobs.loading} scroll={screens.md ? { x: 940 } : undefined} pagination={false}
        locale={{ emptyText: <EmptyState description="Chưa có yêu cầu phù hợp" /> }}
        columns={[
          { title: 'Từ khóa / yêu cầu', key: 'keyword', render: (_, row) => <button className="table-link table-identity" onClick={() => setSelected(jobId(row))}><strong>{row.keyword}</strong><small>{row.website_name} · <span className="mono">{compactId(jobId(row))}</span></small></button> },
          { title: 'Trạng thái', dataIndex: 'status', width: screens.md ? undefined : 108, render: (value) => <Status value={value} /> },
          { title: 'Nguồn', dataIndex: 'mode', responsive: ['md'], render: (value) => modeLabels[value] ?? value },
          { title: 'Model', dataIndex: 'model', responsive: ['md'], render: (value) => <span className="mono">{value}</span> },
          { title: 'Giờ hẹn', dataIndex: 'scheduled_at', responsive: ['md'], render: datetime },
          { title: 'Chi phí', dataIndex: 'cost_usd', responsive: ['md'], align: 'right', render: usd },
        ]} />
      <CursorPagination cursor={filters.cursor} setCursor={filters.setCursor} next={jobs.data?.next_cursor} />
    </Panel>
    <JobDrawer id={selected} close={() => setSelected(null)} />
  </>;
}

export function Deliveries({ query }: { query: URLSearchParams }) {
  const screens = Grid.useBreakpoint();
  const [selected, setSelected] = useState(query.get('delivery'));
  const [retrying, setRetrying] = useState(false);
  const [event, setEvent] = useState(query.get('event') ?? undefined);
  const filters = useFilters(query, !screens.sm);
  const { message } = App.useApp();
  const deliveries = useResource<Collection<Delivery>>(withQuery('/deliveries', { ...filters.parameters, event }));
  const detail = useResource<Delivery>(selected ? `/deliveries/${selected}` : null);
  const delivery = detail.data;

  async function retry(id: string) {
    setRetrying(true);
    try {
      await mutate(`/deliveries/${id}/retry`, 'POST');
      detail.reload();
      deliveries.reload();
      message.success('Đã đưa vào hàng đợi giao lại.');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setRetrying(false);
    }
  }

  return <>
    <PageHeading title="Giao bài" description="Theo dõi webhook về Laravel và gửi lại kết quả khi cần." action={<Button icon={<ReloadOutlined />} loading={deliveries.loading} onClick={deliveries.reload}>Làm mới</Button>} />
    <ResourceError error={deliveries.error} onRetry={deliveries.reload} />
    <Panel className="table-panel record-panel">
      <div className="table-toolbar record-toolbar">
        <Select aria-label="Loại sự kiện" value={event} allowClear placeholder="Tất cả sự kiện" onChange={(value) => { setEvent(value); filters.setCursor([]); }}
          options={Object.entries(eventLabels).map(([value, label]) => ({ value, label }))} />
        {filters.statusInput(deliveryStatuses)}
        {filters.toggle()}
      </div>
      {filters.expanded && <div id="more-record-filters" className="table-toolbar record-more-filters">{filters.inputs()}</div>}
      <Table rowKey="id" dataSource={deliveries.data?.data ?? []} loading={deliveries.loading} scroll={screens.md ? { x: 910 } : undefined} pagination={false}
        locale={{ emptyText: <EmptyState description="Chưa có sự kiện giao bài phù hợp" /> }}
        columns={[
          { title: 'Yêu cầu', key: 'job', render: (_, row) => <button className="table-link table-identity" onClick={() => setSelected(row.id)}><strong>{row.keyword ?? compactId(row.job_id)}</strong><small>{eventLabels[row.event_type] ?? row.event_type}</small></button> },
          { title: 'Trạng thái', dataIndex: 'status', width: screens.md ? undefined : 100, render: (value) => <Status value={value} /> },
          { title: 'Website', dataIndex: 'website_name', responsive: ['md'] },
          { title: 'Số lần gửi', dataIndex: 'attempts', responsive: ['md'], align: 'right' },
          { title: 'HTTP', dataIndex: 'last_http_status', responsive: ['md'], render: (value) => value ?? '—', align: 'right' },
          { title: 'Đã giao lúc', dataIndex: 'delivered_at', responsive: ['md'], render: datetime },
          { title: 'Lần thử tiếp theo', dataIndex: 'next_attempt_at', responsive: ['md'], render: datetime },
        ]} />
      <CursorPagination cursor={filters.cursor} setCursor={filters.setCursor} next={deliveries.data?.next_cursor} />
    </Panel>
    <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Chi tiết giao bài" size={655}
      extra={delivery?.status === 'failed' && <Button type="primary" loading={retrying} onClick={() => void retry(delivery.id)}>Gửi lại</Button>}>
      <ResourceError error={detail.error} onRetry={detail.reload} />
      {detail.loading && !delivery && <Skeleton active />}
      {delivery && <>
        <Descriptions className="profile-description" column={1} size="small" items={[
          { key: 'id', label: 'Mã sự kiện', children: <span className="mono">{delivery.id}</span> },
          { key: 'website', label: 'Website', children: delivery.website_name },
          { key: 'event', label: 'Sự kiện', children: eventLabels[delivery.event_type] ?? delivery.event_type },
          { key: 'status', label: 'Trạng thái', children: <Status value={delivery.status} /> },
          { key: 'count', label: 'Số lần gửi', children: delivery.attempts },
          { key: 'http', label: 'HTTP gần nhất', children: delivery.last_http_status ?? '—' },
          { key: 'retry', label: 'Lần thử tiếp theo', children: datetime(delivery.next_attempt_at) },
          { key: 'delivered', label: 'Giờ xác nhận', children: datetime(delivery.delivered_at) },
        ]} />
        {delivery.last_error && <Alert type="error" showIcon title="Lỗi giao bài" description={delivery.last_error} />}
        <h3>Lịch sử gửi</h3>
        <Table size="small" rowKey="id" dataSource={delivery.history ?? []} pagination={false} scroll={{ x: 480 }} columns={[
          { title: 'Giờ gửi', key: 'time', render: (_, row) => datetime(row.attempted_at ?? row.started_at) },
          { title: 'HTTP', dataIndex: 'http_status', render: (value) => value ?? '—' },
          { title: 'Lỗi', dataIndex: 'error', render: (value) => value ?? '—' },
        ]} locale={{ emptyText: <EmptyState description="Chưa có lần gửi" /> }} />
        <Space className="drawer-actions"><Button onClick={() => go('jobs', { job: delivery.job_id })}>Mở yêu cầu viết <ArrowRightOutlined /></Button></Space>
      </>}
    </Drawer>
  </>;
}
