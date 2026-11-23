import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, DatePicker, Descriptions, Drawer, Form, Grid, Input, InputNumber, Modal, Popconfirm, Select, Skeleton, Space, Table, Tabs, Tag, Tooltip } from 'antd';
import { ArrowRightOutlined, CalendarOutlined, CheckCircleOutlined, ControlOutlined, DeleteOutlined, FilePdfOutlined, MinusCircleOutlined, ReloadOutlined, SearchOutlined, WarningOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Decimal } from 'decimal.js';
import { mutate, useCatalog, useResource, useSearchValue, withQuery } from './api';
import { useLiveJobs } from './job-events';
import { compactId, CursorPagination, datetime, EmptyState, go, jobId, JobStatus, PageHeading, Panel, ResourceError, Status, submitVietnamTime, vnd } from './shared';
import type { Attempt, Collection, Delivery, Job, JobDetails } from './types';
import { DateTimeField } from './DateTimeField';
import { sanitizeArticleHtml } from './article-html';
import { downloadJobPdf, hasJobPdfContent } from './job-pdf';
import './records.css';

const jobStatuses = [['scheduled', 'Chờ đến lịch'], ['queued', 'Chờ viết'], ['writing', 'Đang viết'], ['ready', 'Đã viết'], ['failed', 'Lỗi viết'], ['canceled', 'Đã hủy']];
const deliveryStatuses = [['pending', 'Chờ giao'], ['sending', 'Đang giao'], ['delivered', 'Đã giao'], ['failed', 'Lỗi giao bài']];
const modeLabels: Record<string, string> = { schedule: 'Lên lịch', scheduled: 'Lên lịch', preview: 'Viết bài ngay', immediate: 'Viết bài ngay', widget: 'Widget', rewrite: 'Viết lại' };
const eventLabels: Record<string, string> = { 'article.ready': 'Bài đã viết', 'article.failed': 'Viết lỗi' };
const toneOptions = ['Thân thiện', 'Chuyên nghiệp', 'Tư vấn', 'Thuyết phục', 'Trang trọng', 'Hài hước'].map(value => ({ value, label: value }));
const styleOptions = ['Hướng dẫn', 'SEO', 'Chuyên gia', 'Kể chuyện', 'Danh sách', 'Tin tức'].map(value => ({ value, label: value }));
const attemptStageLabels = { outline: 'Lập dàn ý', draft: 'Viết nội dung', seo_repair: 'Chỉnh sửa SEO' };

type LiveJob = { job: JobDetails; requestedAt: number };

function newestJob(saved: Job, requestedAt: number | undefined, live?: LiveJob): Job {
  if (!live || (requestedAt !== undefined && requestedAt > live.requestedAt)) return saved;
  return live.job;
}

function dateMatches(value: string | null, filters: { from?: string; to?: string }) {
  if (!value) return false;
  return (!filters.from || new Date(value) >= new Date(`${filters.from}T00:00:00+07:00`)) &&
    (!filters.to || new Date(value).getTime() < new Date(`${filters.to}T00:00:00+07:00`).getTime() + 86_400_000);
}

function jobMatches(job: Job, filters: { customer_id?: string; website_id?: string; status?: string; from?: string; to?: string; cursor?: string }, search?: string, mode?: string, keyMode?: string, costDates = false) {
  const status = (value: string) => value === 'ready' ? 'completed' : value;
  if (filters.customer_id && job.customer_id !== filters.customer_id) return false;
  if (filters.website_id && job.website_id !== filters.website_id) return false;
  if (filters.status && status(job.status) !== status(filters.status)) return false;
  const source = (value: string) => value === 'widget' ? 'preview' : value === 'schedule' ? 'scheduled' : value;
  if (mode && source(job.mode) !== source(mode)) return false;
  if (keyMode && job.key_mode !== keyMode) return false;
  if (search && !`${job.keyword} ${jobId(job)}`.toLowerCase().includes(search.toLowerCase())) return false;
  if (costDates) {
    if (job.key_mode === 'own') return false;
    // Collection rows were filtered by the server; live detail snapshots carry attempts.
    const attempts = (job as JobDetails).attempts;
    if (attempts && !attempts.some(attempt => dateMatches(attempt.called_at ?? attempt.started_at, filters))) return false;
  } else {
    const reportDate = ['ready', 'completed'].includes(job.status) ? job.completed_at
      : job.status === 'failed' ? job.completed_at ?? job.updated_at ?? job.created_at
      : job.status === 'scheduled' ? job.scheduled_at : job.created_at;
    if ((filters.from || filters.to) && !dateMatches(reportDate ?? null, filters)) return false;
  }
  if (filters.cursor) {
    try {
      const [date, id] = JSON.parse(atob(filters.cursor.replace(/-/g, '+').replace(/_/g, '/'))) as [string, string];
      if (job.created_at > date || (job.created_at === date && jobId(job) >= id)) return false;
    } catch { return false; }
  }
  return true;
}

function OutlineReview({ job }: { job: JobDetails }) {
  const outline = job.outline;
  if (!outline) {
    if (job.status === 'writing' && job.writing_stage === 'outline') {
      return <EmptyState description="Đang lập dàn ý. Nội dung sẽ xuất hiện khi bước này hoàn tất." />;
    }
    if (['scheduled', 'queued'].includes(job.status) || (job.status === 'writing' && job.writing_stage === 'research')) {
      return <EmptyState description="Dàn ý sẽ xuất hiện sau khi hoàn tất bước lập dàn ý." />;
    }
    const attempt = job.attempts?.filter(item => item.stage === 'outline').at(-1);
    if (attempt?.status === 'failed') {
      return <Alert type="warning" showIcon title={attempt.error_code === 'AI_OUTLINE_TIMEOUT' ? 'Bước lập dàn ý đã hết thời gian chờ' : 'Lượt lập dàn ý không thành công'}
        description="Không có dàn ý được lưu. Hệ thống tiếp tục viết từ yêu cầu và tư liệu nghiên cứu. Xem chi tiết trong tab Lần gọi AI." />;
    }
    if (job.status === 'writing') return <EmptyState description="Dàn ý sẽ hiển thị khi yêu cầu viết hoàn tất." />;
    return <EmptyState description="Yêu cầu này chưa có dàn ý được lưu" />;
  }
  return <section className="outline-review" aria-label="Dàn ý bài viết">
    <h2>{outline.title}</h2>
    <Descriptions column={1} size="small" items={[
      { key: 'intent', label: 'Ý định tìm kiếm', children: outline.searchIntent },
      { key: 'audience', label: 'Đối tượng đọc', children: outline.audience },
      { key: 'angle', label: 'Góc tiếp cận', children: outline.angle },
    ]} />
    {outline.questions.length > 0 && <div className="outline-questions"><h3>Câu hỏi cần giải đáp</h3><ul>{outline.questions.map((question, index) => <li key={index}>{question}</li>)}</ul></div>}
    <h3>Bố cục bài viết</h3>
    <ol className="outline-sections">{outline.sections.map((section, index) => <li key={index}>
      <div className="outline-section-heading"><h4>{section.heading}</h4><span>{section.estimatedWords.toLocaleString('vi-VN')} từ dự kiến</span></div>
      <p>{section.purpose}</p>
      {section.subheadings.length > 0 && <><strong className="outline-section-label">Tiêu đề phụ (H3)</strong><ul>{section.subheadings.map((heading, subIndex) => <li key={subIndex}>{heading}</li>)}</ul></>}
      {section.evidence.length > 0 && <div className="outline-evidence"><strong>Dữ kiện tham khảo</strong><ul>{section.evidence.map((evidence, evidenceIndex) => <li key={evidenceIndex}>Nguồn {evidence.sourceIndex}: {evidence.fact}</li>)}</ul></div>}
    </li>)}</ol>
  </section>;
}

function SeoReview({ job }: { job: JobDetails }) {
  const report = job.seo_report;
  if (!report) return <EmptyState description={['completed', 'ready'].includes(job.status) ? 'Bài này chưa có báo cáo kiểm tra SEO' : 'Báo cáo SEO sẽ xuất hiện khi bài viết hoàn tất'} />;
  const warnings = report.warnings;
  const repairMessage = job.seo_repair_status === 'applied'
    ? 'Đã áp dụng một lượt chỉnh sửa SEO. Kết quả dưới đây được kiểm tra từ bản cuối.'
    : job.seo_repair_status === 'kept_draft'
      ? 'Lượt chỉnh sửa SEO chưa tạo được bản tốt hơn. Bản nháp đã lưu được giữ lại để bạn chỉnh sửa.'
      : job.seo_repair_status === 'skipped'
        ? 'Bài đã được lưu. Các tiêu chí còn thiếu được giữ lại để bạn tự chỉnh sửa.'
        : 'Bài đã được lưu và sẵn sàng chỉnh sửa.';
  return <section className="seo-review" aria-label="Kết quả kiểm tra SEO">
    <div className="seo-review-summary">
      <div className="seo-review-score"><strong>{report.score}<small>/100</small></strong><span>Điểm tiêu chí nội bộ</span></div>
      <p><b>{report.passed}/{report.applicable} tiêu chí đạt</b><span>{warnings.length ? `${warnings.length} tiêu chí cần xem lại` : 'Các tiêu chí đang áp dụng đều đạt'}.</span></p>
    </div>
    <Alert type={warnings.length ? 'warning' : 'success'} showIcon title={warnings.length ? 'Bài viết được chấp nhận và còn gợi ý SEO' : 'Đã hoàn tất kiểm tra SEO'} description={repairMessage} />
    <p className="seo-review-note">Điểm là checklist nội bộ, không xác nhận bài đã đáp ứng chính sách Google hoặc được kiểm chứng sự thật. Các mốc ký tự, số từ và mật độ từ khóa chỉ để tham khảo, không bảo đảm thứ hạng. Người biên tập cần kiểm tra cả nội dung, tiêu đề, mô tả và liên kết trước khi xuất bản. Tiêu chí chưa áp dụng không tính vào điểm.</p>
    {report.metrics && <Descriptions column={{ xs: 1, sm: 2 }} size="small" items={[
      { key: 'words', label: 'Nội dung', children: `${report.metrics.words.toLocaleString('vi-VN')} từ` },
      { key: 'title', label: 'Tiêu đề SEO', children: `${report.metrics.titleCharacters} ký tự` },
      { key: 'meta', label: 'Mô tả SEO', children: `${report.metrics.metaDescriptionCharacters} ký tự` },
      { key: 'density', label: 'Mật độ từ khóa', children: `${report.metrics.keywordDensity}% · ${report.metrics.keywordOccurrences} lần` },
    ]} />}
    <ul className="seo-findings">{report.findings.map(finding => <li key={finding.key} data-state={!finding.applicable ? 'excluded' : finding.passed ? 'passed' : 'warning'}>
      <span className="seo-finding-icon" aria-hidden="true">{!finding.applicable ? <MinusCircleOutlined /> : finding.passed ? <CheckCircleOutlined /> : <WarningOutlined />}</span>
      <div><strong>{finding.label}</strong>{!finding.passed && <p>{finding.message}</p>}</div>
      <span className="seo-finding-state">{!finding.applicable ? 'Chưa áp dụng' : finding.passed ? 'Đạt' : 'Cần xem lại'}</span>
    </li>)}</ul>
  </section>;
}

function rewriteUnavailableReason(job?: Job) {
  if (!job) return 'Đang tải yêu cầu viết.';
  if (job.status === 'canceled') return 'Yêu cầu đã hủy chưa có bài viết để viết lại.';
  return ['completed', 'ready'].includes(job.status)
    ? 'Yêu cầu chưa có nội dung bài viết để viết lại.'
    : 'Có thể viết lại sau khi bài viết hoàn tất.';
}

function ScheduleModal({ open, onClose, onCreated, immediate = false }: { open: boolean; onClose: () => void; onCreated: () => void; immediate?: boolean }) {
  const [form] = Form.useForm();
  const [customerId, setCustomerId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const customers = useCatalog('/customers', customerId);
  const websites = useCatalog('/websites', undefined, customerId);
  const providers = useResource<{ data: { provider: string; display_name: string; enabled: boolean; models: { model: string; display_name: string; enabled: boolean }[] }[] }>('/providers');
  const models = (providers.data?.data ?? []).flatMap(provider => provider.enabled ? provider.models.filter(model => model.enabled).map(model => ({ value: model.model, label: `${model.display_name} · ${provider.display_name}` })) : []);
  const { message } = App.useApp();
  function close() { if (saving) return; form.resetFields(); setCustomerId(undefined); onClose(); }
  async function submit(values: any) {
    setSaving(true);
    try {
      const payload = { ...values, length: Number(values.length) };
      await mutate(immediate ? '/jobs' : '/schedules', 'POST', immediate ? payload : { ...payload, scheduled_at: submitVietnamTime(values.scheduled_at) });
      message.success(immediate ? 'Đã đưa bài viết vào hàng đợi.' : 'Đã tạo lịch viết bài cho website.');
      close();
      onCreated();
    }
    catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  }
  return <Modal className="schedule-modal" title={immediate ? 'Viết bài ngay' : 'Lên lịch viết bài'} open={open} onCancel={close} onOk={() => form.submit()} okText={immediate ? 'Viết bài ngay' : 'Tạo lịch viết'} cancelText="Hủy" confirmLoading={saving} destroyOnHidden>
    <Form form={form} layout="vertical" initialValues={{ use_research: true }} onFinish={submit}>
      <Form.Item name="customer_id" label="Khách hàng" rules={[{ required: true, message: 'Chọn khách hàng.' }]}><Select showSearch {...customers.searchConfig} loading={customers.loading} options={customers.options} placeholder="Chọn khách hàng" onChange={value => { setCustomerId(value); form.setFieldValue('website_id', undefined); }} /></Form.Item>
      <Form.Item name="website_id" label="Website nhận bài" rules={[{ required: true, message: 'Chọn website.' }]}><Select showSearch {...websites.searchConfig} loading={websites.loading} options={websites.options} disabled={!customerId} placeholder="Chọn website" /></Form.Item>
      <Form.Item name="model" label="Model AI" rules={[{ required: true, message: 'Chọn model AI.' }]}><Select showSearch optionFilterProp="label" loading={providers.loading} options={models} placeholder="Chọn model" /></Form.Item>
      <div className="schedule-form-grid"><Form.Item name="keyword" label="Từ khóa" rules={[{ required: true, message: 'Nhập từ khóa.' }]}><Input placeholder="Ví dụ: dịch vụ thiết kế website" /></Form.Item><Form.Item name="length" label="Độ dài (600–2500 từ)" rules={[{ required: true, message: 'Nhập từ 600 đến 2500 từ.' }, { type: 'integer', min: 600, max: 2500, message: 'Độ dài phải là số nguyên từ 600 đến 2500 từ.' }]}><InputNumber step={1} changeOnBlur={false} style={{ width: '100%' }} /></Form.Item><Form.Item name="tone" label="Giọng văn" rules={[{ required: true, message: 'Chọn giọng văn.' }]}><Select options={toneOptions} placeholder="Chọn giọng văn" /></Form.Item><Form.Item name="style" label="Phong cách" rules={[{ required: true, message: 'Chọn phong cách.' }]}><Select options={styleOptions} placeholder="Chọn phong cách" /></Form.Item></div>
      {!immediate && <Form.Item name="scheduled_at" label="Thời gian viết (giờ Việt Nam)" rules={[{ required: true, message: 'Chọn thời gian viết.' }]}><DateTimeField seconds /></Form.Item>}
      <Form.Item name="use_research" valuePropName="checked"><Checkbox>Sử dụng dữ liệu tìm kiếm để hỗ trợ viết bài</Checkbox></Form.Item>
      <Form.Item name="instructions" label="Hướng dẫn thêm"><Input.TextArea rows={4} maxLength={4000} showCount placeholder="Yêu cầu bổ sung cho bài viết" /></Form.Item>
      <Form.Item name="keyAI" label="API key riêng"><Input.Password autoComplete="new-password" placeholder="Để trống nếu dùng key dịch vụ" /></Form.Item>
    </Form>
  </Modal>;
}

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

function JobDrawer({ id, liveJob, revision, close, onRewritten, onDeleted, startWithRewrite = false }: { id: string | null; liveJob?: LiveJob; revision: number; close: () => void; onRewritten: (id: string) => void; onDeleted: () => void; startWithRewrite?: boolean }) {
  const detail = useResource<JobDetails>(id ? `/jobs/${id}` : null);
  const [rewriteOpen, setRewriteOpen] = useState(startWithRewrite);
  const [rewriting, setRewriting] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const pdfRequest = useRef<AbortController | null>(null);
  const [form] = Form.useForm();
  const { message, modal } = App.useApp();
  const job = detail.data ? newestJob(detail.data, detail.requestedAt, liveJob) as JobDetails : liveJob?.job;
  const article = job?.result?.[0];
  const canExportPdf = useMemo(() => hasJobPdfContent(article?.Content), [article?.Content]);
  const rewriteKeyMode = job?.rewrite_key_mode ?? job?.key_mode;
  const isFailed = job?.status === 'failed';
  const canRewrite = isFailed || Boolean(article && (job?.status === 'completed' || job?.status === 'ready'));
  const canDelete = Boolean(job && ['scheduled', 'queued', 'completed', 'ready', 'failed', 'canceled'].includes(job.status));
  useEffect(() => { if (id && revision) detail.reload(); }, [id, revision]);
  useEffect(() => () => { pdfRequest.current?.abort(); }, [id]);
  async function exportPdf() {
    if (!job || !canExportPdf || pdfRequest.current) return;
    const controller = new AbortController();
    pdfRequest.current = controller;
    setExportingPdf(true);
    try {
      await downloadJobPdf(jobId(job), article?.Slug, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) message.error((error as Error).message);
    } finally {
      if (pdfRequest.current === controller) pdfRequest.current = null;
      if (!controller.signal.aborted) setExportingPdf(false);
    }
  }
  function closeRewrite() { if (rewriting) return; setRewriteOpen(false); form.resetFields(); }
  async function rewrite(values: { instructions?: string; keyAI?: string }) {
    if (!job) return;
    setRewriting(true);
    try {
      const result = await mutate<{ job_id: string }>(`/jobs/${jobId(job)}/rewrite`, 'POST', {
        ...(values.instructions?.trim() ? { instructions: values.instructions.trim() } : {}),
        ...(values.keyAI?.trim() ? { keyAI: values.keyAI.trim() } : {}),
      });
      setRewriteOpen(false); form.resetFields();
      message.success('Đã tạo yêu cầu viết lại. Bạn có thể theo dõi bản mới tại đây.');
      onRewritten(result.job_id);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setRewriting(false);
    }
  }
  function removeJob() {
    if (!job || !canDelete) return;
    const hasArticle = Boolean(job.result?.length);
    modal.confirm({ title: hasArticle ? 'Xóa bài viết?' : 'Xóa khỏi danh sách chờ?',
      content: hasArticle ? 'Bài viết, lịch sử gọi AI và sự kiện giao bài sẽ bị xóa vĩnh viễn.' : 'Yêu cầu viết và lịch sử xử lý sẽ bị xóa vĩnh viễn.',
      okText: hasArticle ? 'Xóa bài viết' : 'Xóa yêu cầu', cancelText: 'Hủy', okButtonProps: { danger: true },
      async onOk() { try { await mutate(`/jobs/${jobId(job)}`, 'DELETE'); message.success(hasArticle ? 'Đã xóa bài viết.' : 'Đã xóa yêu cầu khỏi danh sách chờ.'); close(); onDeleted(); } catch (error) { message.error((error as Error).message); } },
    });
  }
  return <Drawer className="job-detail-drawer" title={job?.keyword ?? 'Chi tiết yêu cầu viết'} open={Boolean(id)} size={760} onClose={close}
    extra={<Space wrap>{canExportPdf && <Button aria-label="Xuất PDF" icon={<FilePdfOutlined />} loading={exportingPdf} onClick={exportPdf}>Xuất PDF</Button>}<Tooltip title={canRewrite ? undefined : rewriteUnavailableReason(job)}><span><Button type="primary" icon={<ReloadOutlined />} disabled={!canRewrite} onClick={() => setRewriteOpen(true)}>Viết lại</Button></span></Tooltip>{canDelete && <Button danger icon={<DeleteOutlined />} onClick={removeJob}>{job?.result?.length ? 'Xóa bài' : 'Xóa khỏi hàng chờ'}</Button>}<Button icon={<ReloadOutlined />} loading={detail.loading} onClick={detail.reload}>Làm mới</Button></Space>}>
    <ResourceError error={detail.error} onRetry={detail.reload} />
    {detail.loading && !job && <Skeleton active />}
    {job && <>
      <Descriptions className="profile-description" column={{ xs: 1, sm: 2 }} size="small" items={[
        { key: 'status', label: 'Trạng thái', children: <JobStatus job={job} /> },
        { key: 'model', label: 'Model', children: <span className="mono">{job.upstream_model ?? job.model}{job.provider_display_name ? ` · ${job.provider_display_name}` : ''}</span> },
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
          ...(job.retry_of_job_id ? [{ key: 'retry', label: 'Yêu cầu lỗi gốc', children: <a href={`#jobs?job=${job.retry_of_job_id}`}>{job.retry_of_job_id}</a> }] : []),
          { key: 'keyword', label: 'Từ khóa', children: job.keyword },
          { key: 'tone', label: 'Giọng văn', children: job.tone },
          { key: 'style', label: 'Phong cách', children: job.style },
          { key: 'length', label: 'Độ dài', children: `${job.length} từ` },
          { key: 'research', label: 'Dữ liệu tìm kiếm', children: job.use_research === false ? 'Không sử dụng' : 'Có sử dụng' },
          { key: 'instructions', label: 'Hướng dẫn thêm', children: job.instructions ?? '—' },
        ]} /> },
        { key: 'outline', label: 'Dàn ý', children: <OutlineReview job={job} /> },
        { key: 'result', label: 'Bài viết', children: article ? <>
          <Alert className="editorial-review-notice" type="info" showIcon title="Kiểm tra trước khi xuất bản" description="Bài viết được tạo với hỗ trợ AI. Người biên tập cần đối chiếu dữ kiện và nguồn, kiểm tra tiêu đề, mô tả, liên kết và giá trị riêng cho người đọc. Trạng thái đã viết hoặc đã giao chưa xác nhận nội dung đã được con người kiểm duyệt." />
          <article className="article-preview">
          <h2>{article.Title}</h2>
          <div className="article-summary">{article.Desc}</div>
          <div dangerouslySetInnerHTML={{ __html: sanitizeArticleHtml(article.Content) }} />
          <Descriptions className="profile-description" column={1} size="small" items={[
            { key: 'slug', label: 'Slug', children: article.Slug },
            { key: 'seo', label: 'Mô tả SEO', children: article.Description },
            { key: 'tags', label: 'Từ khóa', children: article.Keywords?.map((keyword) => <Tag key={keyword}>{keyword}</Tag>) },
          ]} />
        </article></> : <EmptyState description="Chưa có bài viết" /> },
        { key: 'links', label: 'Liên kết nội bộ', children: job.internal_link_report ? <section aria-label="Liên kết nội bộ">
          <Alert className="editorial-review-notice" type="info" showIcon title={job.internal_link_report.status === 'unavailable' ? 'Chưa kiểm tra được danh mục liên kết' : job.internal_link_report.status === 'no_candidates' ? 'Chưa có ứng viên phù hợp' : 'Đã kiểm tra theo danh mục website'} description="Danh mục do Laravel cung cấp. CRM đối chiếu URL được phép, không tải trang đích để xác nhận nội dung hoặc trạng thái HTTP. Không ép chèn đủ số liên kết; các liên kết có sẵn trong bài nguồn được giữ riêng." />
          <Descriptions column={1} size="small" items={[
            { key: 'count', label: 'Ứng viên đã chọn', children: job.internal_link_report.candidates },
            { key: 'used', label: 'Liên kết từ danh mục', children: job.internal_link_report.used.length },
            { key: 'removed', label: 'Thẻ liên kết bị loại', children: job.internal_link_report.removed },
            { key: 'checked', label: 'Kiểm tra lúc', children: datetime(job.internal_link_report.checked_at) },
          ]} />
          {job.internal_link_report.used.length > 0 && <Table size="small" rowKey="url" pagination={false} dataSource={job.internal_link_report.used} scroll={{ x: 460 }} columns={[
            { title: 'Chữ liên kết', dataIndex: 'anchor' },
            { title: 'URL đích', dataIndex: 'url', render: (url: string) => /^https?:\/\//i.test(url) ? <a href={url} target="_blank" rel="noopener noreferrer">{url}</a> : url },
          ]} />}
        </section> : <EmptyState description="Bài này chưa có báo cáo liên kết nội bộ" /> },
        { key: 'seo', label: 'Kiểm tra SEO', children: <SeoReview job={job} /> },
        { key: 'json', label: 'JSON', children: job.result ? <pre className="code-block">{JSON.stringify(job.result, null, 2)}</pre> : <EmptyState description="Chưa có kết quả" /> },
        { key: 'attempts', label: `Lần gọi AI (${job.attempts?.length ?? 0})`, children: <AttemptList attempts={job.attempts ?? []} keyMode={job.key_mode} /> },
        { key: 'delivery', label: `Giao bài (${job.deliveries?.length ?? 0})`, children: job.deliveries?.length ? <>
          <Table size="small" rowKey="id" dataSource={job.deliveries} pagination={false} scroll={{ x: 590 }} columns={[
            { title: 'Sự kiện', dataIndex: 'event_type', render: (value) => eventLabels[value] ?? value },
            { title: 'Trạng thái', dataIndex: 'status', render: (value) => <Status value={value} /> },
            { title: 'Số lần gửi', dataIndex: 'attempts', align: 'right' },
            { title: 'ID bài', dataIndex: 'id_post', render: (value) => value ?? '—' },
            { title: '', key: 'view', render: (_, row) => <Button type="link" onClick={() => go('deliveries', { delivery: row.id })}>Chi tiết</Button> },
          ]} />
        </> : <EmptyState description="Chưa có sự kiện giao bài" /> },
      ]} />
    </>}
    <Modal title="Viết lại bài viết" open={rewriteOpen && Boolean(job) && canRewrite} onCancel={closeRewrite} onOk={() => form.submit()} okText="Tạo bản viết lại" cancelText="Hủy" confirmLoading={rewriting} destroyOnHidden>
      <Alert type="info" showIcon title={isFailed ? 'Viết lại từ yêu cầu bị lỗi' : 'Tạo một phiên bản bài viết mới'} description={isFailed ? 'Dùng lại từ khóa, model, giọng văn, phong cách, độ dài và hướng dẫn cũ để tạo lượt viết mới. Yêu cầu bị lỗi và lịch sử lỗi vẫn được giữ để đối chiếu.' : 'Giữ từ khóa, model, giọng văn và phong cách hiện tại. Bản viết lại được đưa vào hàng đợi và lưu thành yêu cầu mới để theo dõi trên CRM.'} />
      <Form form={form} layout="vertical" onFinish={rewrite} className="drawer-actions">
        <Form.Item name="instructions" label="Hướng dẫn viết lại"><Input.TextArea rows={5} maxLength={4000} showCount placeholder="Ví dụ: làm rõ phần lợi ích, cập nhật dữ liệu, viết ngắn gọn hơn…" /></Form.Item>
        <Form.Item name="keyAI" label="API key riêng" rules={rewriteKeyMode === 'own' ? [{ required: true, whitespace: true, message: 'Nhập API key riêng để viết lại bài.' }] : []} extra={rewriteKeyMode === 'own' ? 'Khách hàng hiện dùng key riêng. Vui lòng nhập API key để tạo bản viết lại.' : 'Khách hàng hiện dùng key dịch vụ. Để trống để sử dụng key dịch vụ.'}><Input.Password autoComplete="new-password" placeholder={rewriteKeyMode === 'own' ? 'Nhập API key riêng' : 'Để trống nếu dùng key dịch vụ'} /></Form.Item>
      </Form>
    </Modal>
  </Drawer>;
}

function AttemptList({ attempts, keyMode }: { attempts: Attempt[]; keyMode?: string }) {
  const ownKey = keyMode === 'own';
  if (!attempts.length) return <EmptyState description="Chưa có lần gọi AI" />;
  return <div className="episode-list">{attempts.map((attempt) => <Panel key={attempt.id} title={attempt.upstream_model ?? attempt.model} extra={<Status value={attempt.status} />}>
    <Descriptions column={{ xs: 1, sm: 2 }} size="small" items={[
      { key: 'stage', label: 'Bước xử lý', children: attempt.stage ? attemptStageLabels[attempt.stage] ?? attempt.stage : 'Viết bài' },
      { key: 'request', label: 'Giờ gọi', children: datetime(attempt.called_at ?? attempt.started_at) },
      { key: 'done', label: 'Hoàn tất', children: datetime(attempt.finished_at) },
      { key: 'price', label: 'Chi phí', children: ownKey ? 'Không theo dõi chi phí' : attempt.cost_vnd == null || attempt.cost_vnd === '' ? 'Chưa có dữ liệu chi phí' : vnd(attempt.cost_vnd) },
      ...(!ownKey ? [
        { key: 'source', label: 'Nguồn chi phí', children: attempt.cost_source === 'provider' ? 'Nhà cung cấp' : attempt.cost_source === 'catalog' || attempt.cost_source === 'estimated' ? 'Ước tính theo bảng giá' : attempt.cost_source === 'pending' ? 'Chưa có dữ liệu chi phí' : attempt.cost_source ?? '—' },
        { key: 'version', label: 'Phiên bản giá', children: compactId(attempt.pricing_id ?? undefined) },
      ] : []),
      { key: 'response', label: 'Mã phản hồi AI', children: compactId(attempt.provider_response_id ?? undefined) },
    ]} />
    {attempt.error_message && <Alert type="error" title={attempt.error_code} description={attempt.error_message} />}
    {(attempt.usage || (!ownKey && attempt.pricing_snapshot)) && <details className="attempt-details"><summary>{ownKey ? 'Usage đã ghi' : 'Usage và đơn giá đã ghi'}</summary><pre className="code-block">{JSON.stringify(ownKey ? { usage: attempt.usage } : { usage: attempt.usage, pricing: attempt.pricing_snapshot }, null, 2)}</pre></details>}
  </Panel>)}</div>;
}

export function Jobs({ query }: { query: URLSearchParams }) {
  const screens = Grid.useBreakpoint();
  const [search, setSearch] = useState(query.get('q') ?? '');
  const searchValue = useSearchValue(search);
  const [keyMode, setKeyMode] = useState(query.get('date_basis') === 'cost' ? 'service' : query.get('key_mode') ?? undefined);
  const [mode, setMode] = useState(query.get('mode') ?? undefined);
  const [issue, setIssue] = useState(query.get('issue') ?? undefined);
  const [selected, setSelected] = useState(query.get('job'));
  const [startWithRewrite, setStartWithRewrite] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [liveJobs, setLiveJobs] = useState<Record<string, LiveJob | null>>({});
  const [liveError, setLiveError] = useState<Error>();
  const [reconcileRevision, setReconcileRevision] = useState(0);
  const { message, modal } = App.useApp();
  const [instantOpen, setInstantOpen] = useState(false);
  const filters = useFilters(query, !screens.sm);
  const jobs = useResource<Collection<Job>>(withQuery('/jobs', { ...filters.parameters, q: searchValue, source: mode, date_basis: query.get('date_basis') ?? undefined, key_mode: keyMode, issue }));
  useLiveJobs({
    changed(job, requestedAt) {
      if (issue) { setLiveJobs({}); jobs.reload(); return; }
      setLiveJobs(previous => ({ ...previous, [jobId(job)]: { job, requestedAt } }));
      setLiveError(undefined);
    },
    deleted(id) {
      setLiveJobs(previous => ({ ...previous, [id]: null }));
      if (id === selected) setSelected(null);
    },
    reconcile() {
      setLiveJobs({});
      setLiveError(undefined);
      setReconcileRevision(previous => previous + 1);
      jobs.reload();
    },
    failed: setLiveError,
  });
  const savedRows = jobs.data?.data ?? [];
  const rows = new Map(savedRows.map(row => [jobId(row), row]));
  const lastSavedRow = savedRows.at(-1);
  for (const [id, snapshot] of Object.entries(liveJobs)) {
    if (snapshot === null) rows.delete(id);
    else {
      const job = snapshot.job;
      if (!rows.has(id) && jobs.requestedAt !== undefined && jobs.requestedAt > snapshot.requestedAt) continue;
      // An older changed job must not jump over unseen rows on the next page.
      if (!rows.has(id) && jobs.data?.next_cursor && lastSavedRow &&
        (job.created_at < lastSavedRow.created_at || (job.created_at === lastSavedRow.created_at && id < jobId(lastSavedRow)))) continue;
      rows.set(id, rows.has(id) ? newestJob(rows.get(id)!, jobs.requestedAt, snapshot) : job);
    }
  }
  const matchingJobs = [...rows.values()]
    .filter(row => issue ? true : jobMatches(row, filters.parameters, searchValue, mode, keyMode, query.get('date_basis') === 'cost'))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || jobId(b).localeCompare(jobId(a)));
  const displayedJobs = matchingJobs.slice(0, filters.parameters.limit).map(job => {
    if (job.key_mode === 'own') return { ...job, cost_usd: null, cost_vnd: null };
    if (query.get('date_basis') !== 'cost' || !(job as JobDetails).attempts) return job;
    const priced = (job as JobDetails).attempts!.filter(attempt => dateMatches(attempt.called_at ?? attempt.started_at, filters.parameters) && attempt.cost_vnd != null && attempt.cost_vnd !== '');
    return { ...job, cost_vnd: priced.length ? priced.reduce((sum, attempt) => sum.plus(String(attempt.cost_vnd)), new Decimal(0)).toFixed(12) : null };
  });
  const lastJob = displayedJobs.at(-1);
  const nextCursor = lastJob && (matchingJobs.length > filters.parameters.limit || jobs.data?.next_cursor)
    ? btoa(JSON.stringify([lastJob.created_at, jobId(lastJob)])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : lastJob ? null : jobs.data?.next_cursor;
  function openJob(id: string, rewrite = false) { setStartWithRewrite(rewrite); setSelected(id); }
  function removeJob(row: Job) {
    const article = ['completed', 'ready'].includes(row.status);
    modal.confirm({
      title: article ? 'Xóa bài viết?' : 'Xóa khỏi danh sách chờ?',
      content: article ? 'Bài viết và toàn bộ lịch sử xử lý sẽ bị xóa vĩnh viễn.' : 'Yêu cầu viết sẽ bị xóa vĩnh viễn khỏi danh sách chờ.',
      okText: article ? 'Xóa bài viết' : 'Xóa yêu cầu',
      cancelText: 'Hủy',
      okButtonProps: { danger: true },
      async onOk() {
        try {
          await mutate(`/jobs/${jobId(row)}`, 'DELETE');
          message.success(article ? 'Đã xóa bài viết.' : 'Đã xóa yêu cầu khỏi danh sách chờ.');
          if (selected === jobId(row)) setSelected(null);
          jobs.reload();
        } catch (error) {
          message.error((error as Error).message);
        }
      },
    });
  }
  return <>
    <PageHeading title="Yêu cầu viết" description={query.get('date_basis') === 'cost' ? 'Chi phí các lần gọi AI dùng hạn mức được cấp trong khoảng thời gian đã chọn.' : 'Xem lịch viết, bản xem trước và các phiên bản viết lại.'} action={<Space><Button type="primary" onClick={() => setInstantOpen(true)}>Viết bài ngay</Button><Button icon={<CalendarOutlined />} onClick={() => setScheduleOpen(true)}>Lên lịch viết</Button><Button icon={<ReloadOutlined />} loading={jobs.loading} onClick={jobs.reload}>Làm mới</Button></Space>} />
    <ResourceError error={jobs.error} onRetry={jobs.reload} />
    <ResourceError error={liveError} onRetry={jobs.reload} />
    {issue && <Alert className="resource-error" type="info" showIcon title={`Đang lọc: ${{ queue: 'Chờ viết và lịch đã đến giờ', overdue: 'Lịch đã quá giờ', future: 'Lịch chưa đến giờ', stale: 'Yêu cầu viết chờ phục hồi', unpriced: 'Lần gọi AI dịch vụ chưa có dữ liệu chi phí' }[issue] ?? issue}`}
      action={<Button size="small" onClick={() => { setIssue(undefined); filters.setCursor([]); }}>Bỏ lọc này</Button>} />}
    <Panel className="table-panel record-panel">
      <div className="table-toolbar record-toolbar">
        <Input prefix={<SearchOutlined />} placeholder="Tìm từ khóa hoặc mã yêu cầu" aria-label="Tìm yêu cầu viết" allowClear value={search} onChange={(event) => { setSearch(event.target.value); filters.setCursor([]); }} />
        {filters.statusInput(jobStatuses)}
        {filters.toggle(Number(Boolean(mode)) + Number(Boolean(keyMode)))}
      </div>
      {filters.expanded && <div id="more-record-filters" className="table-toolbar record-more-filters">
        <Select aria-label="Nguồn" placeholder="Tất cả nguồn" value={mode} allowClear onChange={(value) => { setMode(value); filters.setCursor([]); }} options={[
          { value: 'scheduled', label: 'Lên lịch' }, { value: 'preview', label: 'Viết bài ngay' }, { value: 'rewrite', label: 'Viết lại' },
        ]} />
        {query.get('date_basis') === 'cost' && <Select aria-label="Nguồn API key" value={keyMode} placeholder="Key dịch vụ" onChange={(value) => { setKeyMode(value); filters.setCursor([]); }} options={[
          { value: 'service', label: 'Key dịch vụ · Hạn mức được cấp' },
        ]} />}
        {filters.inputs()}
      </div>}
      <Table rowKey={jobId} dataSource={displayedJobs} loading={jobs.loading} scroll={screens.md ? { x: 1060 } : undefined} pagination={false}
        locale={{ emptyText: <EmptyState description="Chưa có yêu cầu phù hợp" /> }}
        columns={[
          { title: 'Từ khóa / yêu cầu', key: 'keyword', render: (_, row) => <button className="table-link table-identity" onClick={() => openJob(jobId(row))}><strong>{row.keyword}</strong><small>{row.website_name} · <span className="mono">{compactId(jobId(row))}</span></small></button> },
          { title: 'Trạng thái', dataIndex: 'status', width: screens.md ? undefined : 118, render: (_, row) => <JobStatus job={row} /> },
          { title: 'Nguồn', dataIndex: 'mode', responsive: ['md'], render: (value) => modeLabels[value] ?? value },
          { title: 'Model', dataIndex: 'model', responsive: ['md'], render: (value) => <span className="mono">{value}</span> },
          { title: 'Giờ hẹn', dataIndex: 'scheduled_at', responsive: ['md'], render: datetime },
          { title: 'Chi phí (VNĐ)', dataIndex: 'cost_vnd', responsive: ['md'], align: 'right', render: (value, row) => row.key_mode === 'own' ? <Tooltip title="Key cá nhân không theo dõi chi phí"><span>—</span></Tooltip> : vnd(value) },
          { title: 'Thao tác', key: 'actions', width: 104, render: (_, row) => {
            const available = row.status === 'failed' || (row.can_rewrite ?? ['completed', 'ready'].includes(row.status));
            const deletable = ['scheduled', 'queued', 'completed', 'ready', 'failed', 'canceled'].includes(row.status);
            const deleteLabel = ['completed', 'ready'].includes(row.status) ? 'Xóa bài viết' : 'Xóa yêu cầu';
            return <Space size={4}>
              <Tooltip title={available ? 'Viết lại' : `Viết lại: ${rewriteUnavailableReason(row)}`}><span><Button size="small" icon={<ReloadOutlined />} aria-label="Viết lại" disabled={!available} onClick={() => openJob(jobId(row), true)} /></span></Tooltip>
              {deletable && <Tooltip title={deleteLabel}><Button size="small" danger icon={<DeleteOutlined />} aria-label={deleteLabel} onClick={() => removeJob(row)} /></Tooltip>}
            </Space>;
          } },
        ]} />
      <CursorPagination cursor={filters.cursor} setCursor={filters.setCursor} next={nextCursor} />
    </Panel>
    <JobDrawer key={selected} id={selected} liveJob={selected ? liveJobs[selected] ?? undefined : undefined} revision={reconcileRevision} startWithRewrite={startWithRewrite} close={() => { setSelected(null); setStartWithRewrite(false); }} onRewritten={id => { openJob(id); jobs.reload(); }} onDeleted={jobs.reload} />
    <ScheduleModal open={scheduleOpen} onClose={() => setScheduleOpen(false)} onCreated={jobs.reload} />
    <ScheduleModal open={instantOpen} onClose={() => setInstantOpen(false)} onCreated={jobs.reload} immediate />
  </>;
}

export function Deliveries({ query }: { query: URLSearchParams }) {
  const screens = Grid.useBreakpoint();
  const [selected, setSelected] = useState(query.get('delivery'));
  const [actions, setActions] = useState<Record<string, 'retry' | 'delete'>>({});
  const busyIds = useRef(new Set<string>());
  const [event, setEvent] = useState(query.get('event') ?? undefined);
  const [issue, setIssue] = useState(query.get('issue') ?? undefined);
  const filters = useFilters(query, !screens.sm);
  const { message, modal } = App.useApp();
  const deliveries = useResource<Collection<Delivery>>(withQuery('/deliveries', { ...filters.parameters, event, issue }));
  const detail = useResource<Delivery>(selected ? `/deliveries/${selected}` : null);
  const delivery = detail.data;

  async function act(id: string, action: 'retry' | 'delete') {
    if (busyIds.current.has(id)) return;
    busyIds.current.add(id);
    setActions(previous => ({ ...previous, [id]: action }));
    try {
      await mutate(`/deliveries/${id}${action === 'retry' ? '/retry' : ''}`, action === 'retry' ? 'POST' : 'DELETE');
      if (action === 'delete') setSelected(current => current === id ? null : current);
      else detail.reload();
      deliveries.reload();
      message.success(action === 'retry' ? 'Đã đưa vào hàng đợi giao lại.' : 'Đã xóa lượt giao và lịch sử gửi trong CRM.');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      busyIds.current.delete(id);
      setActions(previous => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
    }
  }

  function retry(row: Delivery) {
    if (!['failed', 'delivered'].includes(row.status) || busyIds.current.has(row.id)) return;
    if (row.status === 'failed') { void act(row.id, 'retry'); return; }
    modal.confirm({
      title: 'Gửi lại bài đã giao?',
      content: 'Website đã xác nhận lượt giao này. Gửi lại có thể tạo nội dung trùng lặp nếu website chưa xử lý chống trùng.',
      okText: 'Gửi lại',
      cancelText: 'Hủy',
      onOk: () => act(row.id, 'retry'),
    });
  }

  function actionButtons(row: Delivery, compact = false) {
    const busy = Boolean(actions[row.id]);
    const retryable = ['failed', 'delivered'].includes(row.status);
    const deletable = ['pending', 'delivered', 'failed'].includes(row.status);
    return <Space size={compact ? 4 : 8}>
      <Tooltip title="Gửi lại" styles={{ root: { pointerEvents: 'none' } }}><span><Button size={compact ? 'small' : 'middle'} type={compact ? 'default' : 'primary'} icon={<ReloadOutlined />} aria-label="Gửi lại" loading={actions[row.id] === 'retry'} disabled={!retryable || busy} onClick={() => retry(row)}>{compact ? null : 'Gửi lại'}</Button></span></Tooltip>
      <Popconfirm title="Xóa lượt giao bài?" description="Chỉ xóa lượt giao và lịch sử gửi trong CRM. Bài viết trên website vẫn được giữ lại." okText="Xóa" cancelText="Hủy" okButtonProps={{ danger: true }} disabled={!deletable || busy} onConfirm={() => act(row.id, 'delete')}>
        <Tooltip title="Xóa lượt giao" styles={{ root: { pointerEvents: 'none' } }}><span><Button size={compact ? 'small' : 'middle'} danger icon={<DeleteOutlined />} aria-label="Xóa lượt giao" loading={actions[row.id] === 'delete'} disabled={!deletable || busy}>{compact ? null : 'Xóa'}</Button></span></Tooltip>
      </Popconfirm>
    </Space>;
  }

  return <>
    <PageHeading title="Giao bài" description="Theo dõi webhook về Laravel và gửi lại kết quả khi cần." action={<Button icon={<ReloadOutlined />} loading={deliveries.loading} onClick={deliveries.reload}>Làm mới</Button>} />
    <ResourceError error={deliveries.error} onRetry={deliveries.reload} />
    {issue && <Alert className="resource-error" type="info" showIcon title={`Đang lọc: ${issue === 'stale' ? 'Lượt giao chờ phục hồi' : 'Lượt giao đã đến giờ'}`}
      action={<Button size="small" onClick={() => { setIssue(undefined); filters.setCursor([]); }}>Bỏ lọc này</Button>} />}
    <Panel className="table-panel record-panel">
      <div className="table-toolbar record-toolbar">
        <Select aria-label="Loại sự kiện" value={event} allowClear placeholder="Tất cả sự kiện" onChange={(value) => { setEvent(value); filters.setCursor([]); }}
          options={Object.entries(eventLabels).map(([value, label]) => ({ value, label }))} />
        {filters.statusInput(deliveryStatuses)}
        {filters.toggle()}
      </div>
      {filters.expanded && <div id="more-record-filters" className="table-toolbar record-more-filters">{filters.inputs()}</div>}
      <Table rowKey="id" dataSource={deliveries.data?.data ?? []} loading={deliveries.loading} scroll={screens.md ? { x: 1134 } : undefined} pagination={false}
        locale={{ emptyText: <EmptyState description="Chưa có sự kiện giao bài phù hợp" /> }}
        columns={[
          { title: 'Yêu cầu', key: 'job', render: (_, row) => <button className="table-link table-identity" onClick={() => setSelected(row.id)}><strong>{row.keyword ?? compactId(row.job_id)}</strong><small>{eventLabels[row.event_type] ?? row.event_type}</small></button> },
          { title: 'Trạng thái', dataIndex: 'status', width: screens.md ? undefined : 100, render: (value) => <Status value={value} /> },
          { title: 'Website', dataIndex: 'website_name', responsive: ['md'] },
          { title: 'Số lần gửi', dataIndex: 'attempts', responsive: ['md'], align: 'right' },
          { title: 'HTTP', dataIndex: 'last_http_status', responsive: ['md'], render: (value) => value ?? '—', align: 'right' },
          { title: 'ID bài', dataIndex: 'id_post', responsive: ['md'], render: (value) => value ?? '—' },
          { title: 'Đã giao lúc', dataIndex: 'delivered_at', responsive: ['md'], render: datetime },
          { title: 'Lần thử tiếp theo', dataIndex: 'next_attempt_at', responsive: ['md'], render: datetime },
          { title: 'Thao tác', key: 'actions', width: 104, render: (_, row) => actionButtons(row, true) },
        ]} />
      <CursorPagination cursor={filters.cursor} setCursor={filters.setCursor} next={deliveries.data?.next_cursor} />
    </Panel>
    <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Chi tiết giao bài" size={655}
      extra={delivery && actionButtons(delivery, !screens.sm)}>
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
          { key: 'post', label: 'ID bài', children: delivery.id_post ?? '—' },
          { key: 'acknowledged', label: 'Xác nhận lúc', children: datetime(delivery.acknowledged_at) },
          { key: 'retry', label: 'Lần thử tiếp theo', children: datetime(delivery.next_attempt_at) },
          { key: 'delivered', label: 'Giờ xác nhận', children: datetime(delivery.delivered_at) },
        ]} />
        {delivery.last_error && <Alert type="error" showIcon title="Lỗi giao bài" description={delivery.last_error} />}
        <h3>Lịch sử gửi</h3>
        <Table size="small" rowKey="id" dataSource={delivery.history ?? []} pagination={false} scroll={{ x: 660 }} columns={[
          { title: 'Giờ gửi', key: 'time', render: (_, row) => datetime(row.attempted_at ?? row.started_at) },
          { title: 'HTTP', dataIndex: 'http_status', render: (value) => value ?? '—' },
          { title: 'ID bài', dataIndex: 'id_post', render: (value) => value ?? '—' },
          { title: 'Xác nhận lúc', dataIndex: 'acknowledged_at', render: (value) => datetime(value) },
          { title: 'Lỗi', dataIndex: 'error', render: (value) => value ?? '—' },
        ]} locale={{ emptyText: <EmptyState description="Chưa có lần gửi" /> }} />
        <Space className="drawer-actions"><Button onClick={() => go('jobs', { job: delivery.job_id })}>Mở yêu cầu viết <ArrowRightOutlined /></Button></Space>
      </>}
    </Drawer>
  </>;
}
