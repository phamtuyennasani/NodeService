import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Form, Input, Select, Space, Spin, Table, Tag } from 'antd';
import { ArrowRightOutlined, CopyOutlined, ReloadOutlined, SearchOutlined, SettingOutlined } from '@ant-design/icons';
import { mutate, request, useCatalog, useResource, withQuery } from './api';
import { datetime, EmptyState, PageHeading, Panel, ResourceError } from './shared';
import { ScheduleModal, type KeywordWritingPreset } from './Jobs';
import { keywordLanguages, keywordMarkets, type KeywordAnalysisView, type KeywordCandidate, type KeywordInput } from '../../src/keywords/contracts';
import type { Collection, CatalogProvider } from './types';
import type { KeywordSettingsResponse } from './KeywordSettings';
import './keywords.css';

const statusNames: Record<string, string> = { queued: 'Chờ xử lý', running: 'Đang xử lý', ready: 'Hoàn tất', partial: 'Kết quả một phần', failed: 'Chưa có kết quả', canceled: 'Đã hủy' };
type History = { id: string; website_id: string; seed: string; status: string; created_at: string; source_mode: string };
type Draft = Omit<KeywordInput, 'client_request_id'> & { use_ai?: boolean; customer_id?: string };
export function Keywords({ query }: { query: URLSearchParams }) {
  const [form] = Form.useForm<Draft>();
  const [customerId, setCustomerId] = useState<string>();
  const [websiteId, setWebsiteId] = useState<string>(query.get('website_id') ?? '');
  const customers = useCatalog('/customers', customerId);
  const websites = useCatalog('/websites', websiteId || undefined, customerId);
  const providers = useResource<Collection<CatalogProvider>>('/providers');
  const settings = useResource<KeywordSettingsResponse>('/settings/keywords');
  const history = useResource<{ data: History[] }>(withQuery('/keyword-analyses', { website_id: websiteId || undefined }));
  const [analysis, setAnalysis] = useState<KeywordAnalysisView>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState('');
  const [preset, setPreset] = useState<KeywordWritingPreset>();
  const generation = useRef(0);
  const retry = useRef<{ key: string; id: string } | null>(null);
  const { message } = App.useApp();
  const useAi = Form.useWatch('use_ai', form);
  const models = (providers.data?.data ?? []).flatMap(p => p.enabled && (p.service_key_configured || p.api_key_configured) ? p.models.filter(m => m.enabled).map(m => ({ value: m.model, label: `${m.display_name} · ${p.display_name}` })) : []);
  const active = analysis && ['queued', 'running'].includes(analysis.status);
  useEffect(() => { form.setFieldValue('website_id', websiteId || undefined); }, [websiteId, form]);
  useEffect(() => {
    if (!active || !analysis) return;
    const abort = new AbortController();
    const id = analysis.id;
    const timer = window.setTimeout(() => {
      request<KeywordAnalysisView>(`/keyword-analyses/${id}`, { signal: abort.signal }).then(value => {
        setAnalysis(current => current?.id === id ? value : current);
        if (!['queued', 'running'].includes(value.status)) history.reload();
      }).catch(cause => { if (!abort.signal.aborted) setError((cause as Error).message); });
    }, 1500);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [analysis, active]);
  useEffect(() => () => { generation.current++; }, []);
  async function submit(values: Draft) {
    const turn = ++generation.current;
    const { use_ai, ai_model, customer_id, ...fields } = values;
    const payload = { ...fields, ...(use_ai && ai_model ? { ai_model } : {}) };
    const key = JSON.stringify(payload);
    if (retry.current?.key !== key) retry.current = { key, id: crypto.randomUUID() };
    setPending(true); setError(undefined);
    try {
      const result = await mutate<KeywordAnalysisView>('/keyword-analyses', 'POST', { ...payload, client_request_id: retry.current.id });
      if (turn !== generation.current) return;
      setAnalysis(result); setWebsiteId(result.website_id); history.reload();
      if (result.reused) message.info('Đã mở kết quả cùng tiêu chí, không tạo lượt gọi nguồn mới.');
      retry.current = null;
    } catch (cause) { if (turn === generation.current) setError((cause as Error).message); }
    finally { if (turn === generation.current) setPending(false); }
  }
  async function open(id: string) {
    const turn = ++generation.current;
    setPending(true); setError(undefined);
    try {
      const row = await request<KeywordAnalysisView>(`/keyword-analyses/${id}`);
      if (turn !== generation.current) return;
      setAnalysis(row); setCustomerId(row.customer_id); setWebsiteId(row.website_id);
      form.setFieldsValue({ ...row.input, customer_id: row.customer_id, use_ai: Boolean(row.input.ai_model) });
    } catch (cause) { if (turn === generation.current) setError((cause as Error).message); }
    finally { if (turn === generation.current) setPending(false); }
  }
  async function cancel() {
    if (!analysis) return;
    try { setAnalysis(await mutate<KeywordAnalysisView>(`/keyword-analyses/${analysis.id}/cancel`, 'POST')); history.reload(); }
    catch (cause) { message.error((cause as Error).message); }
  }
  function write(candidate: KeywordCandidate) {
    if (!analysis || !['ready', 'partial'].includes(analysis.status)) return;
    setPreset({ customer_id: analysis.customer_id, website_id: analysis.website_id, keyword: candidate.keyword, locale: analysis.input.locale,
      keyword_selection: { analysis_id: analysis.id, candidate_id: candidate.id } });
  }
  const result = analysis?.result;
  const volumeCount = result?.candidates.filter(candidate => candidate.volume !== null).length ?? 0;
  const candidateMap = new Map(result?.candidates.map(c => [c.id, c]));
  const rows = (result?.candidates ?? []).filter(c => c.keyword.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <div className="keywords-page">
    <PageHeading title="Phân tích từ khóa" description="Tìm chủ đề từ sản phẩm hoặc dịch vụ, kể cả khi website chưa có bài viết." action={<Button icon={<SettingOutlined />} href="#settings?tab=keywords">Cài đặt từ khóa</Button>} />
    <ResourceError error={settings.error ?? websites.error ?? customers.error} onRetry={() => { settings.reload(); websites.reload(); customers.reload(); }} />
    {settings.data && <Alert type="info" showIcon title={settings.data.values.mode === 'guest' ? 'Keyword Tool Guest · miễn phí' : 'Keyword Tool Pro · thuê bao đã cấu hình'}
      description={settings.data.values.mode === 'guest' ? 'Bản miễn phí trả gợi ý thật từ Google; tối đa 5 dòng có số liệu cache khi sẵn có. Các dòng thiếu dữ liệu không được hiểu là không có người tìm.' : 'Dữ liệu từ REST API của tài khoản Keyword Tool đã cấu hình. Phí thuê bao chưa phân bổ vào từng lượt.'} />}
    <div className="keywords-layout">
      <div className="keywords-sidebar"><Panel title="Chủ đề cần nghiên cứu">
        <Form form={form} layout="vertical" initialValues={{ country: 'VN', locale: 'vi', type: 'suggestions', business: '', audience: '', use_ai: false }} onFinish={submit} disabled={pending || Boolean(active)}>
          <Form.Item name="customer_id" label="Khách hàng"><Select allowClear showSearch {...customers.searchConfig} options={customers.options} onChange={value => { setCustomerId(value); setWebsiteId(''); }} placeholder="Lọc website theo khách hàng" /></Form.Item>
          <Form.Item name="website_id" label="Website" rules={[{ required: true, message: 'Chọn website.' }]}><Select showSearch {...websites.searchConfig} options={websites.options} loading={websites.loading} onChange={setWebsiteId} placeholder="Chọn website, có thể chưa có bài" /></Form.Item>
          <Form.Item name="seed" label="Chủ đề hoặc sản phẩm/dịch vụ" rules={[{ required: true, whitespace: true, message: 'Nhập một chủ đề để bắt đầu.' }]} extra="Không cần biết từ khóa SEO trước. Ví dụ: máy lọc nước, thiết kế website."><Input maxLength={80} placeholder="Ví dụ: máy lọc nước" /></Form.Item>
          <div className="keywords-form-row"><Form.Item name="country" label="Thị trường"><Select options={Object.entries(keywordMarkets).map(([value, m]) => ({ value, label: m.name }))} /></Form.Item><Form.Item name="locale" label="Ngôn ngữ"><Select options={Object.entries(keywordLanguages).map(([value, l]) => ({ value, label: l.name }))} /></Form.Item></div>
          <Form.Item name="type" label="Dạng gợi ý"><Select options={[{ value: 'suggestions', label: 'Từ khóa liên quan' }, { value: 'questions', label: 'Câu hỏi của người tìm' }, { value: 'prepositions', label: 'Cụm từ mở rộng' }]} /></Form.Item>
          <Form.Item name="business" label="Sản phẩm/dịch vụ thực tế"><Input.TextArea rows={3} maxLength={1500} placeholder="Bạn cung cấp gì? Thương hiệu nào? Khu vực phục vụ?" /></Form.Item>
          <Form.Item name="audience" label="Khách hàng mục tiêu"><Input maxLength={300} placeholder="Ví dụ: hộ gia đình tại TP.HCM" /></Form.Item>
          <Form.Item name="use_ai" valuePropName="checked"><Checkbox>Nhờ AI chọn và nhóm chủ đề</Checkbox></Form.Item>
          {useAi && <><Alert type="info" title="Có tính token AI" description="Dùng khóa dịch vụ của nhóm quản lý, ghi chi phí riêng. Không cần bật để xem dữ liệu Guest." /><Form.Item name="ai_model" label="Model phân loại" rules={[{ required: true, message: 'Chọn model AI.' }]}><Select options={models} placeholder="Chọn model đã có khóa dịch vụ" /></Form.Item></>}
          <Button block type="primary" aria-label="Phân tích từ khóa" htmlType="submit" loading={pending || Boolean(active)} disabled={settings.data?.values.enabled === false} icon={<SearchOutlined />}>Phân tích từ khóa</Button>
        </Form>
        {active && <Button className="keyword-cancel" onClick={() => void cancel()}>Hủy tác vụ đang chờ/xử lý</Button>}
      </Panel><Panel title="Lịch sử gần đây" extra={<Button aria-label="Tải lại lịch sử" type="text" icon={<ReloadOutlined />} onClick={history.reload} />}>
        <ResourceError error={history.error} onRetry={history.reload} />
        <div className="keyword-history">{history.data?.data.map(row => <button key={row.id} onClick={() => void open(row.id)} disabled={pending} aria-current={analysis?.id === row.id}><strong>{row.seed}</strong><span>{statusNames[row.status]} · {datetime(row.created_at)}</span></button>)}</div>
        {!history.data?.data.length && <EmptyState description="Chưa có lượt phân tích" />}
      </Panel></div>
      <div className="keywords-results" aria-live="polite">
        {error && <Alert type="error" showIcon title={error} action={analysis ? <Button onClick={() => void open(analysis.id)}>Tải lại kết quả</Button> : undefined} />}
        {active && <Panel><Space><Spin /><span>{analysis.stage === 'ai' ? 'Đang nhờ AI lọc chủ đề phù hợp…' : 'Đang lấy gợi ý từ Keyword Tool…'}</span></Space><p>Bạn có thể rời trang rồi mở lại từ lịch sử. Không cần bấm tạo thêm lượt.</p></Panel>}
        {analysis?.error && <Alert type="error" showIcon title={analysis.error} />}
        {analysis?.ai_note && <Alert type="warning" showIcon title="Đã có dữ liệu nguồn, chưa hoàn tất phân loại AI" description={analysis.ai_note} />}
        {result ? <>
          <Panel title={`${result.candidates.length} từ khóa đã lấy / ${result.total_count.toLocaleString('vi-VN')} gợi ý nguồn`} extra={<Tag>{result.source === 'keywordtool_guest' ? 'Guest MCP' : 'Pro API'}</Tag>}>
            <p>{result.country} · {result.language} · Lấy lúc {datetime(result.fetched_at)}. Thứ tự nguồn không phải thứ tự ưu tiên viết.</p>
            {result.source === 'keywordtool_guest' && <p className="keyword-coverage" role="status"><strong>{volumeCount}/{result.candidates.length} từ khóa có lượng tìm kiếm.</strong> Guest chỉ trả tối đa 5 dòng có số liệu khi cache sẵn có, có thể ít hơn hoặc không có dòng nào. Các từ còn lại vẫn là gợi ý từ nguồn.</p>}
            {result.metrics_scope === 'unverified_cache' && <Alert type="warning" showIcon title="Số liệu cache chỉ để tham khảo" description="Guest chưa xác nhận thị trường và kỳ thống kê của các số liệu cache. Không coi đây là lượng tìm kiếm đã xác minh cho thị trường đang chọn. Cạnh tranh quảng cáo không phải độ khó SEO." />}
            {result.partial && <Alert type="warning" showIcon title="Nguồn trả kết quả chưa đầy đủ" description="Các dữ liệu đã lấy vẫn được giữ; không tự tạo số liệu cho phần còn thiếu." />}
            {analysis && <p className="keyword-cost">Phí nguồn: {analysis.source_cost === 'free' ? '0 USD (Guest)' : 'theo thuê bao, chưa phân bổ'} · AI: {!analysis.ai_called ? 'không gọi' : analysis.ai_cost_usd === null ? 'chưa đủ dữ liệu chi phí' : `${analysis.ai_cost_usd} USD`}</p>}
            <Input aria-label="Lọc từ khóa trong kết quả" prefix={<SearchOutlined />} placeholder="Lọc trong kết quả đã lấy" value={filter} onChange={e => setFilter(e.target.value)} allowClear />
            <Table<KeywordCandidate> rowKey="id" dataSource={rows} size="small" pagination={{ pageSize: 15, showSizeChanger: false }} scroll={{ x: 740 }} columns={[
              { title: 'Từ khóa', dataIndex: 'keyword', render: value => <span className="keyword-text">{value}</span> },
              { title: 'Tìm kiếm/tháng', dataIndex: 'volume', render: value => value === null ? <span className="keyword-missing">Chưa có</span> : Number(value).toLocaleString('vi-VN') },
              { title: 'Xu hướng nguồn', dataIndex: 'trend', render: value => value === null ? '—' : `${value > 0 ? '+' : ''}${value}%` },
              { title: 'Giá thầu đầu trang (USD)', render: (_, row) => row.bid_low === null && row.bid_high === null ? '—' : `${row.bid_low ?? '—'} – ${row.bid_high ?? '—'}` },
              { title: 'Cạnh tranh Ads', dataIndex: 'ads_competition', render: value => value === null ? '—' : value },
              { title: 'Thao tác', render: (_, row) => <Space><Button aria-label={`Sao chép ${row.keyword}`} icon={<CopyOutlined />} onClick={() => void navigator.clipboard.writeText(row.keyword).then(() => message.success('Đã sao chép từ khóa.')).catch(() => message.error('Trình duyệt chưa cho phép sao chép.'))} /><Button disabled={!analysis || !['ready', 'partial'].includes(analysis.status)} onClick={() => write(row)}>Viết bài</Button></Space> },
            ]} locale={{ emptyText: 'Chưa có từ khóa phù hợp với bộ lọc.' }} />
          </Panel>
          {analysis?.suggestions.length ? <Panel title="Chủ đề AI đề xuất"><p>AI đánh giá mức phù hợp với hoạt động kinh doanh; chưa phải dự báo thứ hạng hoặc thống kê nhu cầu.</p><div className="keyword-suggestions">{analysis.suggestions.map(s => {
            const candidate = candidateMap.get(s.candidate_id); if (!candidate) return null;
            return <article key={s.candidate_id}><div><Tag>Nhận định AI</Tag><Tag>{s.intent}</Tag></div><h3>{s.title}</h3><p><strong>Từ khóa chính:</strong> {candidate.keyword}</p><p>{s.reason}</p><p><strong>Góc viết:</strong> {s.angle}</p><div>{s.related_ids.map(id => candidateMap.get(id)).filter(Boolean).map(c => <Tag key={c!.id}>{c!.keyword}</Tag>)}</div><Button icon={<ArrowRightOutlined />} onClick={() => write(candidate)}>Dùng để viết bài</Button></article>;
          })}</div></Panel> : null}
        </> : !active && !error && <Panel><EmptyState description="Nhập chủ đề để lấy gợi ý tìm kiếm. Website mới chưa có nội dung vẫn dùng được." /></Panel>}
      </div>
    </div>
    <ScheduleModal open={Boolean(preset)} preset={preset} immediate onClose={() => setPreset(undefined)} onCreated={() => { setPreset(undefined); message.success('Đã tạo yêu cầu viết từ đề xuất. Xem tại Yêu cầu viết.'); }} />
  </div>;
}
