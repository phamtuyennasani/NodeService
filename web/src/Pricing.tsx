import { useState } from 'react';
import { App, Button, Descriptions, Drawer, Form, Grid, Input, InputNumber, Modal, Select, Table } from 'antd';
import { ExportOutlined, PlusOutlined, SearchOutlined, SyncOutlined } from '@ant-design/icons';
import type dayjs from 'dayjs';
import { mutate, useResource, useSearchValue, withQuery } from './api';
import { CursorPagination, datetime, displayVietnamTime, EmptyState, PageHeading, Panel, ResourceError, submitVietnamTime, vnd } from './shared';
import type { CatalogProvider, Collection, Price } from './types';
import { DateTimeField } from './DateTimeField';
import './records.css';

type PriceDraft = Omit<Price, 'id' | 'effective_at'> & { effective_at: dayjs.Dayjs };
const standardFields: { key: keyof PriceDraft; label: string; required?: boolean }[] = [
  { key: 'total_vnd', label: 'Tổng token', required: true },
];

export function Pricing() {
  const screens = Grid.useBreakpoint();
  const [provider, setProvider] = useState<string>();
  const [model, setModel] = useState('');
  const [cursor, setCursor] = useState<string[]>([]);
  const [selected, setSelected] = useState<Price>();
  const q = useSearchValue(model);
  const [editing, setEditing] = useState(false);
  const [copiedPrice, setCopiedPrice] = useState<Price>();
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [form] = Form.useForm<PriceDraft>();
  const draftProvider = Form.useWatch('provider', form);
  const { message } = App.useApp();
  const prices = useResource<Collection<Price>>(withQuery('/prices', { provider, q, cursor: cursor.at(-1), limit: 12 }));
  const providers = useResource<{ data: CatalogProvider[] }>('/providers');
  const catalog = providers.data?.data ?? [];
  const providerOptions = catalog.map(item => ({ value: item.provider, label: item.display_name }));
  const providerNames = Object.fromEntries(providerOptions.map(item => [item.value, item.label]));
  const priceModels = (catalog.find(item => item.provider === draftProvider)?.models ?? []).map(item => ({
    value: item.model, label: item.display_name === (item.upstream_model ?? item.model) ? item.display_name : `${item.display_name} (${item.upstream_model ?? item.model})`,
  }));
  const modelNames = new Map(catalog.flatMap(item => item.models.map(model => [model.model, model.upstream_model ?? model.model] as const)));
  if (copiedPrice && copiedPrice.provider === draftProvider && !priceModels.some(item => item.value === copiedPrice.model)) {
    priceModels.push({ value: copiedPrice.model, label: copiedPrice.model });
  }

  function open(price?: Price) {
    setCopiedPrice(price);
    form.resetFields();
    form.setFieldsValue(price ? { ...price, total_vnd: price.total_vnd, effective_at: displayVietnamTime(new Date()) } : { provider, effective_at: displayVietnamTime(new Date()) });
    setEditing(true);
  }

  async function save(values: PriceDraft) {
    setSaving(true);
    try {
      const body = {
        ...values,
        model: values.model.trim(),
        effective_at: submitVietnamTime(values.effective_at),
        source_url: values.source_url?.trim() || null,
      };
      await mutate('/prices', 'POST', body);
      setEditing(false);
      prices.reload();
      message.success('Đã thêm phiên bản giá.');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const result = await mutate<{ count: number }>('/prices/sync-xai', 'POST');
      prices.reload();
      message.success(`Đã ghi ${result.count} phiên bản giá xAI mới.`);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  return <>
    <PageHeading title="Bảng giá model" description="Quản lý đơn giá theo model và thời điểm bắt đầu hiệu lực." action={<div className="heading-actions">
      <Button icon={<SyncOutlined />} loading={syncing} disabled={!providers.data?.data.some((item) => item.provider === 'xai' && item.service_key_configured)} onClick={() => void sync()}>Đồng bộ xAI</Button>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => open()}>Thêm phiên bản giá</Button>
    </div>} />
    <ResourceError error={prices.error ?? providers.error} onRetry={() => { prices.reload(); providers.reload(); }} />
    <Panel className="table-panel record-panel" title="Lịch sử đơn giá" extra={<span className="record-unit">VND / 1M token</span>}>
      <div className="table-toolbar">
        <Input prefix={<SearchOutlined />} aria-label="Lọc theo mã model" allowClear placeholder="Lọc theo mã model" value={model} onChange={(event) => { setModel(event.target.value); setCursor([]); }} />
        <Select aria-label="Nhà cung cấp" allowClear placeholder="Tất cả nhà cung cấp" value={provider} options={providerOptions} onChange={(value) => { setProvider(value); setCursor([]); }} />
      </div>
      <Table rowKey="id" dataSource={prices.data?.data ?? []} loading={prices.loading} scroll={screens.md ? { x: 910 } : undefined} pagination={false}
        locale={{ emptyText: <EmptyState description={q || provider ? 'Không tìm thấy phiên bản giá phù hợp' : 'Chưa có phiên bản giá'} /> }}
        columns={[
          { title: 'Model', key: 'model', render: (_, row) => <button className="table-link table-identity" onClick={() => setSelected(row)}><strong className="mono">{modelNames.get(row.model) ?? row.model}</strong><small>{providerNames[row.provider] ?? row.provider}</small></button> },
          { title: 'Hiệu lực từ', dataIndex: 'effective_at', responsive: ['md'], render: datetime },
          { title: 'Tổng token', dataIndex: 'total_vnd', align: 'right', render: vnd },
          { title: 'Nguồn', dataIndex: 'source_url', responsive: ['md'], render: (value) => value ? <a href={value} target="_blank" rel="noreferrer" className="record-source">Bảng giá gốc <ExportOutlined /></a> : '—' },
          { title: '', key: 'view', responsive: ['md'], render: (_, row) => <Button type="text" onClick={() => open(row)}>Tạo bản mới</Button> },
        ]} />
      <CursorPagination cursor={cursor} setCursor={setCursor} next={prices.data?.next_cursor} />
    </Panel>
    <Drawer title={(selected && (modelNames.get(selected.model) ?? selected.model)) ?? 'Chi tiết đơn giá'} open={Boolean(selected)} size={560} onClose={() => setSelected(undefined)}
      extra={selected && <Button onClick={() => open(selected)}>Tạo bản mới</Button>}>
      {selected && <>
        <Descriptions column={1} size="small" className="profile-description" items={[
          { key: 'provider', label: 'Nhà cung cấp', children: providerNames[selected.provider] ?? selected.provider },
          { key: 'effective', label: 'Hiệu lực từ', children: datetime(selected.effective_at) },
          { key: 'source', label: 'Nguồn', children: selected.source_url ? <a href={selected.source_url} target="_blank" rel="noreferrer">Bảng giá gốc</a> : '—' },
        ]} />
        <h3>Đơn giá tổng (VND / 1M token)</h3>
        <Descriptions column={1} size="small" className="profile-description" items={standardFields.map(({ key, label }) => ({
          key, label, children: vnd(selected[key as keyof Price]),
        }))} />
      </>}
    </Drawer>
    <Modal className="pricing-modal" title="Thêm phiên bản giá" width={760} open={editing} onCancel={() => setEditing(false)} onOk={() => form.submit()}
      okText="Lưu phiên bản giá" confirmLoading={saving} forceRender>
      <Form form={form} layout="vertical" onFinish={save}>
        <div className="pricing-section-heading"><div><strong>Thông tin phiên giá</strong><span>Chọn model và thời điểm bắt đầu áp dụng.</span></div></div>
        <div className="pricing-meta-grid">
          <Form.Item name="provider" label="Nhà cung cấp" rules={[{ required: true, message: 'Chọn nhà cung cấp.' }]}><Select options={providerOptions} onChange={() => form.setFieldValue('model', undefined)} /></Form.Item>
          <Form.Item name="model" label="Model" rules={[{ required: true, message: 'Chọn model.' }]}>
            <Select disabled={!draftProvider} options={priceModels} showSearch={{ optionFilterProp: 'label' }} placeholder="Chọn model của nhà cung cấp" />
          </Form.Item>
          <Form.Item name="effective_at" label="Hiệu lực từ (giờ VN)" rules={[{ required: true, message: 'Chọn thời điểm hiệu lực.' }]}><DateTimeField seconds /></Form.Item>
          <Form.Item name="source_url" label="URL nguồn công bố" rules={[{ required: true, type: 'url', message: 'Nhập URL bảng giá công bố.' }, { pattern: /^https?:\/\//i, message: 'Dùng URL http hoặc https.' }]}><Input /></Form.Item>
        </div>
        <div className="pricing-section-heading"><div><strong>Đơn giá chuẩn</strong><span>VND trên mỗi triệu token.</span></div></div>
        <div className="price-field-grid">
          {standardFields.map((field) => <Form.Item className="price-field" style={{ width: '100%' }} key={field.key} name={field.key} label={field.label} rules={field.required ? [{ required: true, message: 'Nhập đơn giá.' }] : undefined}><InputNumber className="price-input" style={{ width: '100%', display: 'flex' }} min={0} stringMode step="1000" addonAfter="₫" /></Form.Item>)}
        </div>
      </Form>
    </Modal>
  </>;
}
