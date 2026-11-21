import { useState } from 'react';
import {
  App, Button, Descriptions, Drawer, Form, Grid, Input, InputNumber, Modal, Progress, Select, Space, Table, Tabs, Tag,
} from 'antd';
import { ArrowRightOutlined, DeleteOutlined, EditOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import type dayjs from 'dayjs';
import { mutate, useResource, useSearchValue, withQuery } from './api';
import { CursorPagination, datetime, displayVietnamTime, EmptyState, go, number, PageHeading, Panel, ResourceError, submitVietnamTime } from './shared';
import type { CatalogProvider, Collection, Customer, Usage, UsagePeriod, Website } from './types';
import { DateTimeField } from './DateTimeField';
import './records.css';

function initials(name: string) {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [name];
  return words.slice(0, 2).map(word => word.charAt(0)).join('').toLocaleUpperCase('vi');
}

function Quota({ title, period }: { title: string; period: UsagePeriod | null }) {
  if (!period) return null;
  const used = period.limit ? Math.min(100, 100 * period.used / period.limit) : 0;
  const held = period.limit ? Math.min(100, 100 * (period.used + period.reserved) / period.limit) : 0;
  return <div className="quota">
    <div className="quota-header"><strong>{title}</strong><span>{number.format(period.remaining)} lượt còn lại</span></div>
    <Progress percent={held} success={{ percent: used, strokeColor: '#42644c' }} strokeColor="#e4b653" showInfo={false} aria-label={title} />
    <div className="quota-detail"><span>{number.format(period.used)} đã dùng</span><span>{number.format(period.reserved)} đang giữ</span><span>{number.format(period.limit)} tổng lượt</span></div>
    <div className="muted quota-reset">Kỳ mới {datetime(period.resets_at)}</div>
  </div>;
}

function Profile({ customer }: { customer: Customer }) {
  const usage = useResource<Usage>(`/customers/${customer.id}/usage`);
  const websites = useResource<Collection<Website>>(withQuery('/websites', { customer_id: customer.id }));
  return <>
    <Descriptions className="profile-description" column={1} size="small" items={[
      { key: 'mode', label: 'Gói viết', children: customer.key_mode === 'service' ? 'Key dịch vụ' : 'Key riêng' },
      { key: 'email', label: 'Email', children: customer.email || '—' },
      { key: 'phone', label: 'Điện thoại', children: customer.phone || '—' },
      { key: 'notes', label: 'Ghi chú', children: customer.notes || '—' },
    ]} />
    {customer.key_mode === 'service' && <>
      <ResourceError error={usage.error} onRetry={usage.reload} />
      {usage.loading && <div className="muted">Đang tải hạn mức…</div>}
      {usage.data && <div className="quota-grid"><Quota title="Hôm nay" period={usage.data.day} /><Quota title="Tháng này" period={usage.data.month} /></div>}
      <Descriptions className="profile-description" column={1} size="small" items={[
        { key: 'models', label: 'Model được phép', children: customer.allowed_models?.join(', ') || '—' },
        { key: 'words', label: 'Độ dài tối đa', children: customer.max_length ? `${number.format(customer.max_length)} từ` : '—' },
        { key: 'period', label: 'Hiệu lực', children: `${datetime(customer.active_from)} → ${datetime(customer.active_until)}` },
      ]} />
    </>}
    <Tabs items={[
      { key: 'websites', label: `Website (${customer.website_count})`, children: <>
        <ResourceError error={websites.error} onRetry={websites.reload} />
        <Table size="small" rowKey="id" loading={websites.loading} dataSource={websites.data?.data ?? []} pagination={false} columns={[
          { title: 'Website', dataIndex: 'name' },
          { title: 'Tên miền', dataIndex: 'domain' },
        ]} locale={{ emptyText: <EmptyState description="Khách hàng chưa có website" /> }} />
        <Button type="link" onClick={() => go('websites', { customer_id: customer.id })}>Quản lý website <ArrowRightOutlined /></Button>
      </> },
      { key: 'jobs', label: 'Bài viết', children: <Button onClick={() => go('jobs', { customer_id: customer.id, status: 'ready' })}>Xem {number.format(customer.article_count)} bài đã viết <ArrowRightOutlined /></Button> },
      ...(customer.key_mode === 'service' ? [{ key: 'quota', label: 'Lịch sử hạn mức', children: <>
        <ResourceError error={usage.error} onRetry={usage.reload} />
        <Table size="small" rowKey="job_id" loading={usage.loading} dataSource={usage.data?.reservations ?? []} scroll={{ x: 500 }} pagination={{ pageSize: 8, hideOnSinglePage: true }} columns={[
          { title: 'Yêu cầu', key: 'job', render: (_, row) => <button className="table-link" onClick={() => go('jobs', { job: row.job_id })}><strong>{row.keyword}</strong></button> },
          { title: 'Website', dataIndex: 'website_name' },
          { title: 'Ngày giữ lượt', dataIndex: 'quota_day' },
          { title: 'Trạng thái', dataIndex: 'status', render: (value) => <Tag color={value === 'used' ? 'success' : 'blue'}>{value === 'used' ? 'Đã dùng' : 'Đang giữ'}</Tag> },
        ]} locale={{ emptyText: <EmptyState description="Chưa có lượt trong tháng" /> }} />
      </> }] : []),
      { key: 'cost', label: 'Chi phí', children: <Button onClick={() => go('overview', { customer_id: customer.id })}>Xem chi phí AI của khách hàng <ArrowRightOutlined /></Button> },
    ]} />
  </>;
}

type CustomerDraft = Omit<Customer, 'id' | 'website_count' | 'article_count' | 'active_from' | 'active_until'> & {
  active_from?: dayjs.Dayjs | null;
  active_until?: dayjs.Dayjs | null;
};

export function Customers({ query }: { query: URLSearchParams }) {
  const screens = Grid.useBreakpoint();
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string[]>([]);
  const q = useSearchValue(search);
  const [selectedId, setSelectedId] = useState(query.get('customer'));
  const [editing, setEditing] = useState<Customer | 'new' | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<CustomerDraft>();
  const mode = Form.useWatch('key_mode', form);
  const selectedModels = Form.useWatch('allowed_models', form) ?? [];
  const catalog = useResource<{ data: CatalogProvider[] }>(editing && mode === 'service' ? '/providers' : null);
  const modelGroups = (catalog.data?.data ?? []).map(provider => ({
    label: provider.display_name,
    options: provider.models.filter(item => provider.enabled && item.enabled).map(item => ({
      value: item.model, label: item.display_name === item.model ? item.model : `${item.display_name} (${item.model})`,
    })),
  })).filter(group => group.options.length);
  const available = new Set(modelGroups.flatMap(group => group.options.map(option => option.value)));
  const previousModels = editing && editing !== 'new' ? editing.allowed_models ?? [] : [];
  if (catalog.data) {
    const inactive = previousModels.filter(model => selectedModels.includes(model) && !available.has(model));
    if (inactive.length) modelGroups.push({ label: 'Đã ngừng cung cấp', options: inactive.map(model => ({ value: model, label: model })) });
  }
  const { message, modal } = App.useApp();
  const customers = useResource<Collection<Customer>>(withQuery('/customers', { q, cursor: cursor.at(-1), limit: 12 }));
  const details = useResource<Collection<Customer>>(selectedId ? withQuery('/customers', { id: selectedId, limit: 1 }) : null);
  const selected = details.data?.data[0] ?? customers.data?.data.find((item) => item.id === selectedId);
  const rows = customers.data?.data ?? [];

  function open(customer: Customer | 'new') {
    setEditing(customer);
    form.resetFields();
    if (customer === 'new') form.setFieldsValue({ key_mode: 'own' });
    else form.setFieldsValue({
      ...customer,
      active_from: customer.active_from ? displayVietnamTime(customer.active_from) : null,
      active_until: customer.active_until ? displayVietnamTime(customer.active_until) : null,
    });
  }

  async function save(values: CustomerDraft) {
    if (!editing) return;
    setSaving(true);
    const service = values.key_mode === 'service';
    const body = {
      name: values.name.trim(),
      email: values.email || null,
      phone: values.phone || null,
      notes: values.notes || null,
      key_mode: values.key_mode,
      daily_limit: service ? values.daily_limit ?? null : null,
      monthly_limit: service ? values.monthly_limit ?? null : null,
      allowed_models: service ? values.allowed_models ?? [] : [],
      max_length: service ? values.max_length ?? null : null,
      active_from: service && values.active_from ? submitVietnamTime(values.active_from) : null,
      active_until: service && values.active_until ? submitVietnamTime(values.active_until) : null,
    };
    try {
      const saved = await mutate<Customer>(editing === 'new' ? '/customers' : `/customers/${editing.id}`, editing === 'new' ? 'POST' : 'PATCH', body);
      customers.reload();
      details.reload();
      setEditing(null);
      setSelectedId(saved.id);
      message.success(editing === 'new' ? 'Đã thêm khách hàng.' : 'Đã cập nhật khách hàng.');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function removeCustomer(customer: Customer) {
    modal.confirm({
      title: `Xóa khách hàng ${customer.name}?`,
      content: 'Khách hàng chỉ xóa được khi chưa có website hoặc yêu cầu viết.',
      okText: 'Xóa khách hàng', cancelText: 'Hủy', okButtonProps: { danger: true },
      async onOk() {
        try {
          await mutate(`/customers/${customer.id}`, 'DELETE');
          message.success('Đã xóa khách hàng.');
          setSelectedId(null); customers.reload(); details.reload();
        } catch (error) { message.error((error as Error).message); }
      },
    });
  }

  return <>
    <PageHeading title="Khách hàng" description="Quản lý hồ sơ, gói viết bài và hạn mức của từng khách hàng." action={<Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>Thêm khách hàng</Button>} />
    <ResourceError error={customers.error} onRetry={customers.reload} />
    <Panel className="table-panel record-panel">
      <div className="table-toolbar"><Input prefix={<SearchOutlined />} placeholder="Tên, email hoặc số điện thoại" aria-label="Tìm khách hàng" allowClear value={search} onChange={(event) => { setSearch(event.target.value); setCursor([]); }} /></div>
      <Table rowKey="id" dataSource={rows} loading={customers.loading} scroll={screens.md ? { x: 760 } : undefined}
        locale={{ emptyText: <EmptyState description={q ? 'Không tìm thấy khách hàng' : 'Chưa có khách hàng'} /> }}
        pagination={false}
        columns={[
          { title: 'Khách hàng', key: 'name', render: (_, row) => <button className="table-link contact-name" onClick={() => setSelectedId(row.id)}>
            <span className="record-avatar" aria-hidden="true">{initials(row.name)}</span>
            <span><strong>{row.name}</strong>
              {(row.email || row.phone) ? <small>{row.email || row.phone}</small> : !screens.md && <small>{number.format(row.website_count)} website · {number.format(row.article_count)} bài</small>}
            </span>
          </button> },
          { title: 'Gói viết bài', dataIndex: 'key_mode', width: screens.md ? undefined : 105, render: (value) => <span className={'record-pill ' + (value === 'service' ? 'is-service' : '')}>{value === 'service' ? 'Key dịch vụ' : 'Key riêng'}</span> },
          { title: 'Website', dataIndex: 'website_count', responsive: ['md'], align: 'right', render: (value) => number.format(value) },
          { title: 'Bài đã viết', dataIndex: 'article_count', responsive: ['md'], align: 'right', render: (value) => number.format(value) },
          { title: '', key: 'actions', width: 104, responsive: ['md'], align: 'right', render: (_, row) => <Space size={2}><Button type="text" icon={<EditOutlined />} title={'Chỉnh sửa ' + row.name} aria-label={'Chỉnh sửa ' + row.name} onClick={() => open(row)} /><Button type="text" danger icon={<DeleteOutlined />} title={'Xóa ' + row.name} aria-label={'Xóa ' + row.name} onClick={() => removeCustomer(row)} /></Space> },
        ]} />
      <CursorPagination cursor={cursor} setCursor={setCursor} next={customers.data?.next_cursor} />
    </Panel>
    <Drawer size={600} title={selected?.name ?? 'Hồ sơ khách hàng'} open={Boolean(selectedId)} onClose={() => setSelectedId(null)}
      extra={selected && <Space><Button onClick={() => open(selected)}>Chỉnh sửa</Button><Button danger icon={<DeleteOutlined />} onClick={() => removeCustomer(selected)}>Xóa khách hàng</Button></Space>}>
      <ResourceError error={details.error} onRetry={details.reload} />
      {!selected && !details.error && (details.loading ? <p className="muted">Đang tải hồ sơ…</p> : <EmptyState description="Không tìm thấy khách hàng" />)}
      {selected && <Profile key={selected.id} customer={selected} />}
    </Drawer>
    <Modal title={editing === 'new' ? 'Thêm khách hàng' : 'Chỉnh sửa khách hàng'} open={Boolean(editing)} onCancel={() => setEditing(null)}
      onOk={() => form.submit()} okText="Lưu khách hàng" confirmLoading={saving} forceRender>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="name" label="Tên khách hàng" rules={[{ required: true, whitespace: true, message: 'Nhập tên khách hàng.' }]}><Input /></Form.Item>
        <div className="form-grid">
          <Form.Item name="email" label="Email" rules={[{ type: 'email', message: 'Email không hợp lệ.' }]}><Input /></Form.Item>
          <Form.Item name="phone" label="Điện thoại"><Input /></Form.Item>
        </div>
        <Form.Item name="key_mode" label="Gói viết bài" rules={[{ required: true }]}><Select options={[{ value: 'own', label: 'Dùng key riêng' }, { value: 'service', label: 'Dùng key dịch vụ' }]} /></Form.Item>
        {mode === 'service' && <>
          <div className="form-grid">
            <Form.Item name="daily_limit" label="Số bài/ngày" rules={[{ required: true, message: 'Nhập giới hạn theo ngày.' }]}><InputNumber min={0} precision={0} /></Form.Item>
            <Form.Item name="monthly_limit" label="Số bài/tháng" rules={[{ required: true, message: 'Nhập giới hạn theo tháng.' }]}><InputNumber min={0} precision={0} /></Form.Item>
          </div>
          <ResourceError error={catalog.error} onRetry={catalog.reload} />
          <Form.Item name="allowed_models" label="Model được phép" rules={[{ required: true, message: 'Chọn ít nhất một model.' }]}>
            <Select mode="multiple" showSearch={{ optionFilterProp: 'label' }} loading={catalog.loading}
              options={modelGroups} placeholder="Chọn model cho gói" notFoundContent="Chưa có model phù hợp" />
          </Form.Item>
          <Form.Item name="max_length" label="Độ dài tối đa (từ)"><InputNumber min={1} precision={0} /></Form.Item>
          <div className="form-grid">
            <Form.Item name="active_from" label="Bắt đầu hiệu lực (giờ VN)"><DateTimeField /></Form.Item>
            <Form.Item name="active_until" label="Hết hạn (giờ VN)"><DateTimeField /></Form.Item>
          </div>
        </>}
        <Form.Item name="notes" label="Ghi chú"><Input.TextArea rows={2} /></Form.Item>
      </Form>
    </Modal>
  </>;
}
