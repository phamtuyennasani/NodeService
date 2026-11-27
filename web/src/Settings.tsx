import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, InputNumber, Skeleton, Switch, Tabs } from 'antd';
import { ReloadOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import { ApiError, mutate, useResource } from './api';
import { datetime, PageHeading, Panel, ResourceError } from './shared';
import { SmtpSettings } from './SmtpSettings';
import { KeywordSettings } from './KeywordSettings';
import './settings.css';

type Provider = 'openai' | 'anthropic' | 'xai' | 'openai-compatible';
type ProviderLimits = { concurrency: number; requests_per_minute: number; tokens_per_minute: number };
export type RuntimeSettings = {
  usd_to_vnd: number;
  writer_concurrency: number;
  delivery_concurrency: number;
  worker_poll_ms: number;
  ai_timeout_ms: number;
  outline_timeout_ms: number;
  seo_repair_timeout_ms: number;
  writer_max_attempts: number;
  delivery_max_attempts: number;
  delivery_retry_minutes: number;
  webhook_timeout_ms: number;
  research_enabled: boolean;
  research_timeout_ms: number;
  research_max_results: number;
  job_retention_days: number;
  delivery_retention_days: number;
  cleanup_interval_minutes: number;
  provider_limits: Record<Provider, ProviderLimits>;
};
type SettingsResponse = { values: RuntimeSettings; defaults: RuntimeSettings; revision: number; updated_at: string | null };
const secondsFields = ['ai_timeout_ms', 'outline_timeout_ms', 'seo_repair_timeout_ms', 'webhook_timeout_ms', 'research_timeout_ms'] as const;
const providerNames: [Provider, string][] = [['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['xai', 'xAI'], ['openai-compatible', 'OpenAI Compatible · mỗi kết nối']];

function formValues(values: RuntimeSettings) {
  const draft = structuredClone(values);
  for (const key of secondsFields) draft[key] /= 1000;
  return draft;
}
function runtimeValues(values: RuntimeSettings) {
  const result = structuredClone(values);
  for (const key of secondsFields) result[key] = Math.round(result[key] * 1000);
  return result;
}
function reducedRetention(before: number, after: number) {
  return after > 0 && (before === 0 || after < before);
}

function NumericField({ name, label, min, max, extra, seconds = false }: {
  name: string | string[]; label: string; min: number; max: number; extra?: string; seconds?: boolean;
}) {
  return <Form.Item name={name} label={label} extra={extra} rules={[
    { required: true, message: 'Nhập giá trị cấu hình.' },
    { validator: (_, value: unknown) => typeof value === 'number' && Number.isFinite(value)
      && (seconds ? Math.abs(value * 1000 - Math.round(value * 1000)) < 1e-7 : Number.isSafeInteger(value)) && value >= min && value <= max
      ? Promise.resolve() : Promise.reject(new Error(`${seconds ? 'Nhập số' : 'Nhập số nguyên'} từ ${min.toLocaleString('vi-VN')} đến ${max.toLocaleString('vi-VN')}${seconds ? ' (tối đa 3 số thập phân)' : ''}.`)) },
  ]}>
    <InputNumber controls={false} step={1} changeOnBlur={false} />
  </Form.Item>;
}

export function Settings({ query }: { query?: URLSearchParams } = {}) {
  const resource = useResource<SettingsResponse>('/settings');
  const [current, setCurrent] = useState<SettingsResponse>();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [activeTab, setActiveTab] = useState(query?.get('tab') === 'keywords' ? 'keywords' : 'operations');
  const [smtpVisited, setSmtpVisited] = useState(false);
  const [keywordsVisited, setKeywordsVisited] = useState(query?.get('tab') === 'keywords');
  const [form] = Form.useForm<RuntimeSettings>();
  const { message, modal } = App.useApp();

  function apply(result: SettingsResponse) {
    setCurrent(result);
    form.setFieldsValue(formValues(result.values));
    setDirty(false);
    setSaveError(undefined);
    setConflict(false);
  }

  useEffect(() => { if (resource.data) apply(resource.data); }, [resource.data]);

  function reload() {
    const run = () => resource.reload();
    if (!dirty) return run();
    modal.confirm({ title: 'Bỏ thay đổi chưa lưu?', content: 'Các giá trị đang nhập sẽ được thay bằng cấu hình đã lưu.', okText: 'Tải lại cấu hình', cancelText: 'Tiếp tục chỉnh sửa', onOk: run });
  }

  async function persist(values: RuntimeSettings) {
    if (!current) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      const result = await mutate<SettingsResponse>('/settings', 'PUT', { revision: current.revision, values });
      apply(result);
      message.success('Đã lưu cài đặt. Hệ thống sẽ áp dụng trong tối đa 5 giây.');
    } catch (error) {
      const isConflict = error instanceof ApiError && error.status === 409;
      setConflict(isConflict);
      setSaveError(isConflict ? 'Cấu hình đã được thay đổi ở phiên khác. Tải lại cấu hình mới nhất trước khi chỉnh sửa và lưu lại.' : (error as Error).message);
    } finally { setSaving(false); }
  }

  function save(draft: RuntimeSettings) {
    if (!current) return;
    const values = runtimeValues(draft);
    if (reducedRetention(current.values.job_retention_days, values.job_retention_days)
      || reducedRetention(current.values.delivery_retention_days, values.delivery_retention_days)) {
      modal.confirm({
        title: 'Bật hoặc rút ngắn thời gian lưu dữ liệu?',
        content: 'Dữ liệu đã kết thúc quá thời gian lưu mới sẽ bị xóa trong các đợt dọn dẹp tiếp theo. Nội dung bài viết, lịch sử và chi phí liên quan có thể mất vĩnh viễn; hạn mức đã sử dụng vẫn được giữ lại.',
        okText: 'Xác nhận và lưu', cancelText: 'Kiểm tra lại', okButtonProps: { danger: true },
        onOk: () => persist(values),
      });
    } else void persist(values);
  }

  function defaults() {
    if (!current) return;
    modal.confirm({ title: 'Điền giá trị mặc định?', content: 'Giá trị mặc định từ cấu hình khởi động sẽ được điền vào biểu mẫu. Bấm Lưu cài đặt để áp dụng.', okText: 'Điền mặc định', cancelText: 'Hủy', onOk: () => {
      form.setFieldsValue(formValues(current.defaults)); setDirty(true); setSaveError(undefined);
    } });
  }

  const operating = <div className="settings-sections">
    <Panel title="Tỷ giá quy đổi">
      <p className="settings-description">Dùng để quy đổi chi phí USD sang VND trong CRM. Các phiên bản giá đã lưu giữ nguyên tỷ giá tại thời điểm nhập.</p>
      <div className="settings-grid"><NumericField name="usd_to_vnd" label="VND cho 1 USD" min={1} max={1_000_000_000} /></div>
    </Panel>
    <Panel title="Luồng xử lý">
      <p className="settings-description">Số luồng áp dụng cho mỗi tiến trình worker. Giảm số luồng sẽ chờ tác vụ đang chạy hoàn thành.</p>
      <div className="settings-grid">
        <NumericField name="writer_concurrency" label="Số luồng viết bài" min={1} max={100} />
        <NumericField name="delivery_concurrency" label="Số luồng giao bài" min={1} max={100} />
        <NumericField name="writer_max_attempts" label="Số lần thử viết tối đa" min={1} max={10} extra="Bao gồm lần xử lý đầu tiên." />
        <NumericField name="delivery_max_attempts" label="Số lần báo lỗi tối đa" min={1} max={10} extra="Áp dụng sự kiện article.failed, bao gồm lần đầu. Bài viết hoàn tất được gửi 1 lần và thử lại tối đa 3 lần." />
        <NumericField name="delivery_retry_minutes" label="Khoảng chờ gửi lại (phút)" min={1} max={1_440} extra="Bài viết hoàn tất được thử lại tối đa 3 lần nếu Laravel chưa xác nhận; mặc định 5 phút giữa các lần." />
        <NumericField name="worker_poll_ms" label="Chu kỳ kiểm tra hàng đợi (ms)" min={100} max={60_000} />
      </div>
    </Panel>
    <Panel title="Thời gian chờ">
      <p className="settings-description">Thời gian chờ AI được tính khi không nhận thêm dữ liệu từ nhà cung cấp.</p>
      <div className="settings-grid">
        <NumericField name="ai_timeout_ms" label="AI ngừng phản hồi (giây)" min={1} max={900} seconds />
        <NumericField name="outline_timeout_ms" label="Lập dàn ý (giây)" min={1} max={900} seconds />
        <NumericField name="seo_repair_timeout_ms" label="Chỉnh sửa SEO (giây)" min={1} max={900} seconds />
        <NumericField name="webhook_timeout_ms" label="Giao bài qua webhook (giây)" min={1} max={60} seconds />
      </div>
    </Panel>
    <Panel title="Nghiên cứu trước khi viết">
      <Form.Item name="research_enabled" label="Cho phép nghiên cứu" valuePropName="checked" extra="Từng yêu cầu viết vẫn có thể chọn không nghiên cứu."><Switch /></Form.Item>
      <div className="settings-grid">
        <NumericField name="research_timeout_ms" label="Chờ kết quả nghiên cứu (giây)" min={1} max={60} seconds />
        <NumericField name="research_max_results" label="Số kết quả nghiên cứu tối đa" min={1} max={8} />
      </div>
    </Panel>
  </div>;

  const limits = <div className="settings-sections">
    <Alert type="info" showIcon title="Giới hạn dùng chung giữa các worker" description="Giới hạn theo từng nhà cung cấp được phối hợp qua MongoDB. Khi hết công suất, yêu cầu chờ lượt; tăng số luồng không vượt qua các giới hạn này." />
    {providerNames.map(([provider, name]) => <Panel key={provider} title={name}>
      <div className="settings-grid settings-grid-three">
        <NumericField name={['provider_limits', provider, 'concurrency']} label="Số yêu cầu đồng thời" min={1} max={100} />
        <NumericField name={['provider_limits', provider, 'requests_per_minute']} label="Yêu cầu / phút" min={1} max={100_000} />
        <NumericField name={['provider_limits', provider, 'tokens_per_minute']} label="Token / phút" min={1_000} max={100_000_000} />
      </div>
    </Panel>)}
  </div>;

  const retention = <div className="settings-sections">
    <Alert type="warning" showIcon title="Dọn dẹp tự động có thể xóa dữ liệu vĩnh viễn" description="Chỉ áp dụng cho dữ liệu đã kết thúc. Hệ thống bỏ qua yêu cầu đang chờ, đang viết hoặc đang giao; giữ lại hạn mức đã tiêu thụ. Xóa yêu cầu viết cũng xóa nội dung bài, lịch sử AI, giao bài và chi phí liên quan, ảnh hưởng báo cáo lịch sử." />
    <Panel title="Thời gian lưu dữ liệu">
      <p className="settings-description">Nhập 0 để tắt tự xóa cho từng loại dữ liệu. Dữ liệu đủ điều kiện sẽ được dọn theo chu kỳ bên dưới.</p>
      <div className="settings-grid">
        <NumericField name="job_retention_days" label="Lưu yêu cầu viết bài (ngày)" min={0} max={3650} extra="Áp dụng sau khi yêu cầu hoàn thành, thất bại hoặc bị hủy." />
        <NumericField name="delivery_retention_days" label="Lưu lịch sử giao bài (ngày)" min={0} max={3650} extra="Áp dụng cho lượt giao thành công hoặc thất bại; gồm các lần thử giao." />
        <NumericField name="cleanup_interval_minutes" label="Chu kỳ dọn dẹp (phút)" min={5} max={1440} />
      </div>
    </Panel>
  </div>;

  return <div className="settings-page">
    <PageHeading title="Cài đặt" description="Cấu hình vận hành và email CRM dùng chung cho các máy kết nối cùng database." action={activeTab !== 'smtp' && activeTab !== 'keywords' ? <div className="heading-actions">
      <Button icon={<ReloadOutlined />} onClick={reload} disabled={saving || resource.loading}>Tải lại</Button>
      <Button type="primary" aria-label="Lưu cài đặt" icon={<SaveOutlined />} onClick={() => form.submit()} loading={saving} disabled={!current || !dirty || conflict || resource.loading}>Lưu cài đặt</Button>
    </div> : undefined} />
    <Tabs className="settings-navigation" activeKey={activeTab} onChange={key => { setActiveTab(key); if (key === 'smtp') setSmtpVisited(true); if (key === 'keywords') setKeywordsVisited(true); }} items={[
      { key: 'operations', label: 'Vận hành' }, { key: 'limits', label: 'Giới hạn AI' },
      { key: 'retention', label: 'Lưu trữ dữ liệu' }, { key: 'smtp', label: 'Email / SMTP' }, { key: 'keywords', label: 'Từ khóa' },
    ]} />
    <div hidden={activeTab === 'smtp' || activeTab === 'keywords'}>
    <ResourceError error={resource.error} onRetry={reload} />
    {saveError && <Alert className="resource-error" type="error" showIcon title="Chưa lưu cài đặt" description={saveError} action={conflict ? <Button size="small" onClick={reload}>Tải cấu hình mới</Button> : undefined} />}
    {!current && resource.loading && <Panel><Skeleton active paragraph={{ rows: 8 }} /></Panel>}
    {current && <>
      <div className="settings-status"><span>{dirty ? 'Có thay đổi chưa lưu' : 'Đã đồng bộ cấu hình'}{current.updated_at ? ` · Cập nhật ${datetime(current.updated_at)}` : ' · Đang dùng giá trị mặc định'}</span>
        <Button type="link" size="small" icon={<UndoOutlined />} disabled={saving || resource.loading} onClick={defaults}>Điền mặc định</Button></div>
      <Alert className="settings-apply-note" type="info" showIcon title="Áp dụng trong tối đa 5 giây sau khi lưu" description="Tác vụ đang chạy giữ cấu hình lúc bắt đầu. Các tác vụ mới sẽ dùng cài đặt mới, không cần khởi động lại dịch vụ." />
      <Form form={form} layout="vertical" requiredMark={false} disabled={saving || resource.loading} onValuesChange={() => setDirty(true)} onFinish={save} onFinishFailed={({ errorFields }) => {
        const first = errorFields[0]?.name[0];
        setActiveTab(first === 'provider_limits' ? 'limits' : ['job_retention_days', 'delivery_retention_days', 'cleanup_interval_minutes'].includes(String(first)) ? 'retention' : 'operations');
        message.error('Kiểm tra các giá trị cấu hình chưa hợp lệ.');
      }}>
        <div hidden={activeTab !== 'operations'}>{operating}</div>
        <div hidden={activeTab !== 'limits'}>{limits}</div>
        <div hidden={activeTab !== 'retention'}>{retention}</div>
      </Form>
      <p className="settings-infrastructure">Kết nối MongoDB, ENCRYPTION_KEY, tên miền, cổng dịch vụ và các khóa bí mật tiếp tục được quản lý qua biến môi trường. API key và model được quản lý tại menu Nhà cung cấp AI.</p>
    </>}
    </div>
    {smtpVisited && <div hidden={activeTab !== 'smtp'}><SmtpSettings /></div>}
    {keywordsVisited && <div hidden={activeTab !== 'keywords'}><KeywordSettings /></div>}
  </div>;
}
