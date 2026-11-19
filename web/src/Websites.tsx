import { useState } from 'react';
import { Alert, App, Button, Descriptions, Drawer, Form, Grid, Input, Modal, Select, Space, Table, Tabs } from 'antd';
import { CopyOutlined, EditOutlined, GlobalOutlined, KeyOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { mutate, useCatalog, useResource, useSearchValue, withQuery } from './api';
import { CursorPagination, datetime, EmptyState, go, PageHeading, Panel, ResourceError } from './shared';
import type { Collection, Website } from './types';
import './records.css';

type WebsiteDraft = Pick<Website, 'name' | 'customer_id' | 'domain' | 'webhook_url'>;
type Secret = { title: string; value: string };

const widgetSnippet = () => `<div id="ai-tools"></div>
<script src="${window.location.origin}/widget/v1/ai-writer.js"></script>
<script>
  const config = {
    mount: '#ai-tools',
    form: '#article-form',
    endpoint: '/admin/ai/previews',
    modelsEndpoint: '/admin/ai/models',
    fields: {
      Title: '[name="title"]',
      Content: '[name="body"]',
      Slug: '[name="slug"]',
      Desc: '[name="summary"]',
      Desction: '[name="seo_description"]',
      'Từ khóa': '[name="keywords"]'
    }
  };
  AIWriter.mount(config);
</script>`;

export function Websites({ query }: { query: URLSearchParams }) {
  const screens = Grid.useBreakpoint();
  const [customerId, setCustomerId] = useState(query.get('customer_id') ?? undefined);
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string[]>([]);
  const q = useSearchValue(search);
  const [selectedId, setSelectedId] = useState(query.get('website'));
  const [editing, setEditing] = useState<Website | 'new' | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<WebsiteDraft>();
  const { message, modal } = App.useApp();
  const formCustomer = Form.useWatch('customer_id', form);
  const customers = useCatalog('/customers', customerId);
  const formCustomers = useCatalog('/customers', formCustomer);
  const sites = useResource<Collection<Website>>(withQuery('/websites', { customer_id: customerId, q, cursor: cursor.at(-1), limit: 12 }));
  const details = useResource<Collection<Website>>(selectedId ? withQuery('/websites', { id: selectedId, limit: 1 }) : null);
  const selected = details.data?.data[0] ?? sites.data?.data.find((site) => site.id === selectedId);
  const rows = sites.data?.data ?? [];

  function open(site: Website | 'new') {
    setEditing(site);
    form.resetFields();
    form.setFieldsValue(site === 'new' ? { customer_id: customerId } : site);
  }

  async function save(values: WebsiteDraft) {
    if (!editing) return;
    setSaving(true);
    try {
      const saved = await mutate<Website>(editing === 'new' ? '/websites' : `/websites/${editing.id}`, editing === 'new' ? 'POST' : 'PATCH', {
        ...values,
        name: values.name.trim(),
        domain: values.domain.trim(),
        webhook_url: values.webhook_url?.trim(),
      });
      if (customerId && customerId !== values.customer_id) setCustomerId(values.customer_id);
      sites.reload();
      details.reload();
      setSelectedId(saved.id);
      setEditing(null);
      message.success(editing === 'new' ? 'Đã thêm website.' : 'Đã cập nhật website.');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      message.success('Đã sao chép.');
    } catch {
      message.error('Không thể sao chép tự động. Hãy chọn và sao chép văn bản.');
    }
  }

  function manageSecret(site: Website, action: 'token' | 'revoke' | 'webhook') {
    const title = action === 'revoke' ? 'Thu hồi token website' : action === 'webhook' ? 'Cấp khóa ký webhook' : 'Cấp token website';
    modal.confirm({
      title,
      content: action === 'revoke' ? 'Các lệnh gọi mới từ website dùng token này sẽ bị từ chối.' :
        action === 'webhook' ? 'Sau khi cấp, hãy cập nhật khóa ký trên Laravel trước lần giao bài tiếp theo.' :
          'Sau khi cấp, hãy lưu token mới trên backend của website. Token đang dùng sẽ hết hiệu lực.',
      okText: title,
      okButtonProps: { danger: action === 'revoke' },
      async onOk() {
        try {
          if (action === 'revoke') {
            await mutate(`/websites/${site.id}/token`, 'DELETE');
            message.success('Đã thu hồi token.');
          } else if (action === 'token') {
            const result = await mutate<{ token: string }>(`/websites/${site.id}/token`, 'POST');
            setSecret({ title: 'Token website', value: result.token });
          } else {
            const result = await mutate<{ secret: string }>(`/websites/${site.id}/webhook-secret`, 'POST');
            setSecret({ title: 'Khóa ký webhook', value: result.secret });
          }
          sites.reload();
          details.reload();
        } catch (error) {
          message.error((error as Error).message);
        }
      },
    });
  }

  return <>
    <PageHeading title="Website" description="Thiết lập kết nối Laravel, token truy cập và webhook nhận bài." action={<Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>Thêm website</Button>} />
    <ResourceError error={sites.error} onRetry={sites.reload} />
    <Panel className="table-panel record-panel">
      <div className="table-toolbar">
        <Input prefix={<SearchOutlined />} placeholder="Tìm website hoặc tên miền" aria-label="Tìm website" allowClear value={search} onChange={(event) => { setSearch(event.target.value); setCursor([]); }} />
        <Select allowClear value={customerId} placeholder="Tất cả khách hàng" aria-label="Khách hàng" loading={customers.loading} showSearch={customers.searchConfig}
          options={customers.options} onChange={(value) => { setCustomerId(value); setCursor([]); }} />
      </div>
      <Table rowKey="id" dataSource={rows} loading={sites.loading} scroll={screens.md ? { x: 810 } : undefined} pagination={false}
        locale={{ emptyText: <EmptyState description="Chưa có website phù hợp" /> }}
        columns={[
          { title: 'Website', key: 'name', render: (_, row) => <button className="table-link contact-name" onClick={() => setSelectedId(row.id)}>
            <span className="record-site-icon" aria-hidden="true"><GlobalOutlined /></span><span><strong>{row.name}</strong><small>{row.domain}</small></span>
          </button> },
          { title: 'Khách hàng', dataIndex: 'customer_name', responsive: ['md'] },
          { title: 'Token', dataIndex: 'token_hint', width: screens.md ? undefined : 100, render: (value) => <span className={'record-pill ' + (value ? 'is-service' : '')}>{value ? 'Đã cấp' : 'Chưa cấp'}</span> },
          { title: 'Bài đã viết', dataIndex: 'article_count', responsive: ['md'], align: 'right' },
          { title: 'API dùng gần nhất', dataIndex: 'last_seen_at', responsive: ['md'], render: datetime },
          { title: '', align: 'right', key: 'edit', width: 64, responsive: ['md'], render: (_, row) => <Button type="text" icon={<EditOutlined />} title={'Chỉnh sửa ' + row.name} aria-label={'Chỉnh sửa ' + row.name} onClick={() => open(row)} /> },
        ]} />
      <CursorPagination cursor={cursor} setCursor={setCursor} next={sites.data?.next_cursor} />
    </Panel>
    <Drawer title={selected?.name ?? 'Thông tin website'} open={Boolean(selectedId)} onClose={() => setSelectedId(null)} size={620}
      extra={selected && <Button onClick={() => open(selected)}>Chỉnh sửa</Button>}>
      <ResourceError error={details.error} onRetry={details.reload} />
      {!selected && !details.error && (details.loading ? <p className="muted">Đang tải website…</p> : <EmptyState description="Không tìm thấy website" />)}
      {selected && <Tabs items={[
        { key: 'connection', label: 'Kết nối API', children: <>
          <Descriptions column={1} size="small" items={[
            { key: 'customer', label: 'Khách hàng', children: selected.customer_name },
            { key: 'domain', label: 'Tên miền', children: selected.domain },
            { key: 'url', label: 'Webhook Laravel', children: selected.webhook_url || 'Chưa cấu hình' },
            { key: 'token', label: 'Token', children: selected.token_hint || 'Chưa cấp' },
            { key: 'seen', label: 'API dùng gần nhất', children: datetime(selected.last_seen_at) },
            { key: 'articles', label: 'Bài đã viết', children: selected.article_count },
          ]} />
          <div className="drawer-actions"><Space wrap>
            <Button icon={<KeyOutlined />} onClick={() => manageSecret(selected, 'token')}>{selected.token_hint ? 'Đổi token' : 'Cấp token'}</Button>
            {selected.token_hint && <Button danger onClick={() => manageSecret(selected, 'revoke')}>Thu hồi token</Button>}
            <Button onClick={() => manageSecret(selected, 'webhook')}>Cấp khóa webhook</Button>
          </Space></div>
          <Button type="link" onClick={() => go('jobs', { website_id: selected.id })}>Xem yêu cầu viết của website</Button>
        </> },
        { key: 'widget', label: 'Widget JavaScript', children: <>
          <p>Đặt đoạn nhúng cạnh form biên tập và thay selector theo các trường của website. Laravel nhận yêu cầu qua <code>POST /admin/ai/previews</code> và trả kết quả qua <code>GET /admin/ai/previews/&#123;job_id&#125;</code>.</p>
          <p>Thêm <code>GET /admin/ai/models</code> trên Laravel cho người có quyền biên tập. Route này dùng token website ở backend để gọi <code>GET /v1/models</code> và trả nguyên danh sách cho widget.</p>
          <pre className="code-block">{widgetSnippet()}</pre>
          <Button icon={<CopyOutlined />} onClick={() => void copy(widgetSnippet())}>Sao chép đoạn nhúng</Button>
        </> },
      ]} />}
    </Drawer>
    <Modal title={editing === 'new' ? 'Thêm website' : 'Chỉnh sửa website'} open={Boolean(editing)} onCancel={() => setEditing(null)}
      onOk={() => form.submit()} okText="Lưu website" confirmLoading={saving} forceRender>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="customer_id" label="Khách hàng" rules={[{ required: true, message: 'Chọn khách hàng.' }]}>
          <Select showSearch={formCustomers.searchConfig} loading={formCustomers.loading} disabled={editing !== 'new'} options={formCustomers.options} />
        </Form.Item>
        <Form.Item name="name" label="Tên hiển thị" rules={[{ required: true, whitespace: true, message: 'Nhập tên website.' }]}><Input /></Form.Item>
        <Form.Item name="domain" label="Tên miền" rules={[{ required: true, whitespace: true, message: 'Nhập tên miền website.' }]}><Input placeholder="example.vn" /></Form.Item>
        <Form.Item name="webhook_url" label="URL webhook nhận bài" rules={[{ required: true, whitespace: true, message: 'Nhập URL webhook.' }, { pattern: /^https?:\/\//i, message: 'Nhập URL hợp lệ.' }]}><Input placeholder="https://example.vn/api/webhooks/ai-articles" /></Form.Item>
      </Form>
    </Modal>
    <Modal title={secret?.title} open={Boolean(secret)} onCancel={() => setSecret(null)} footer={<Button type="primary" onClick={() => setSecret(null)}>Đóng</Button>}>
      {secret && <>
        <Alert type="info" showIcon title="Sao chép giá trị này vào Laravel. CRM chỉ hiển thị đầy đủ khi cấp mới." />
        <Space.Compact block className="secret-value"><Input value={secret.value} readOnly onFocus={(event) => event.target.select()} /><Button icon={<CopyOutlined />} onClick={() => void copy(secret.value)}>Sao chép</Button></Space.Compact>
      </>}
    </Modal>
  </>;
}
