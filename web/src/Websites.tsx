import { useState } from 'react';
import { Alert, App, Button, Descriptions, Drawer, Form, Grid, Input, Modal, Select, Space, Table, Tabs } from 'antd';
import { CopyOutlined, DeleteOutlined, EditOutlined, GlobalOutlined, KeyOutlined, PlusOutlined, SearchOutlined } from '@ant-design/icons';
import { mutate, useCatalog, useResource, useSearchValue, withQuery } from './api';
import { CursorPagination, datetime, EmptyState, go, PageHeading, Panel, ResourceError } from './shared';
import type { Collection, Website } from './types';
import { IntegrationGuide, laravelConnectionConfig } from './IntegrationGuide';
import './records.css';

type WebsiteDraft = Pick<Website, 'name' | 'customer_id' | 'domain' | 'webhook_url' | 'content_catalog_url'>;
type Secret = { title: string; value: string; laravelConfig?: string };
type CatalogCheck = { status: 'synced' | 'cached' | 'not_configured' | 'busy'; count: number; synced_at: string | null };

export function Websites({ query }: { query: URLSearchParams }) {
  const screens = Grid.useBreakpoint();
  const [customerId, setCustomerId] = useState(query.get('customer_id') ?? undefined);
  const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string[]>([]);
  const q = useSearchValue(search);
  const [selectedId, setSelectedId] = useState(query.get('website'));
  const [editing, setEditing] = useState<Website | 'new' | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const laravelConfig = secret?.laravelConfig;
  const [signingSite, setSigningSite] = useState<Website | null>(null);
  const [publicKey, setPublicKey] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkingCatalogId, setCheckingCatalogId] = useState<string | null>(null);
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
        webhook_url: values.webhook_url?.trim() || null,
        content_catalog_url: values.content_catalog_url?.trim() || null,
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

  async function saveSigningKey() {
    if (!signingSite || !publicKey.trim()) return;
    setSavingKey(true);
    try {
      await mutate(`/websites/${signingSite.id}/signing-key`, 'PUT', {
        public_key: publicKey.trim(), expected_fingerprint: signingSite.signing_key_fingerprint ?? null,
      });
      sites.reload();
      details.reload();
      setSigningSite(null);
      setPublicKey('');
      message.success('Đã bật xác thực bằng khóa ký máy chủ.');
    } catch (error) {
      message.error((error as Error).message);
    } finally { setSavingKey(false); }
  }

  async function checkCatalog(site: Website) {
    if (!site.content_catalog_url || checkingCatalogId) return;
    setCheckingCatalogId(site.id);
    try {
      const result = await mutate<CatalogCheck>(`/websites/${site.id}/content-catalog/check`, 'POST');
      if (result.status === 'busy') message.info('CRM đang kiểm tra danh mục của website. Hãy thử lại sau.');
      else if (result.status === 'not_configured') message.info('Hãy lưu URL danh mục liên kết trước khi kiểm tra.');
      else message.success(`Đã đọc danh mục: ${result.count} trang có thể liên kết.`);
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      sites.reload();
      details.reload();
      setCheckingCatalogId(null);
    }
  }

  function removeWebsite(site: Website) {
    modal.confirm({
      title: `Xóa website ${site.name}?`,
      content: 'Website chỉ xóa được khi chưa có yêu cầu viết hoặc lịch sử bài viết.',
      okText: 'Xóa website', cancelText: 'Hủy', okButtonProps: { danger: true },
      async onOk() {
        try {
          await mutate(`/websites/${site.id}`, 'DELETE');
          message.success('Đã xóa website.');
          setSelectedId(null); sites.reload(); details.reload();
        } catch (error) { message.error((error as Error).message); }
      },
    });
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
            setSecret({ title: 'Token website', value: result.token, laravelConfig: laravelConnectionConfig(site.id, result.token) });
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
    <PageHeading title="Website" description="Thiết lập kết nối website, token truy cập và webhook nhận bài." action={<Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>Thêm website</Button>} />
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
          { title: '', align: 'right', key: 'edit', width: 104, responsive: ['md'], render: (_, row) => <Space size={2}><Button type="text" icon={<EditOutlined />} title={'Chỉnh sửa ' + row.name} aria-label={'Chỉnh sửa ' + row.name} onClick={() => open(row)} /><Button type="text" danger icon={<DeleteOutlined />} title={'Xóa ' + row.name} aria-label={'Xóa ' + row.name} onClick={() => removeWebsite(row)} /></Space> },
        ]} />
      <CursorPagination cursor={cursor} setCursor={setCursor} next={sites.data?.next_cursor} />
    </Panel>
    <Drawer title={selected?.name ?? 'Thông tin website'} open={Boolean(selectedId)} onClose={() => setSelectedId(null)} size={620}
      extra={selected && <Space><Button onClick={() => open(selected)}>Chỉnh sửa</Button><Button danger icon={<DeleteOutlined />} onClick={() => removeWebsite(selected)}>Xóa website</Button></Space>}>
      <ResourceError error={details.error} onRetry={details.reload} />
      {!selected && !details.error && (details.loading ? <p className="muted">Đang tải website…</p> : <EmptyState description="Không tìm thấy website" />)}
      {selected && <Tabs items={[
        { key: 'connection', label: 'Kết nối API', children: <>
          <Descriptions column={1} size="small" items={[
            { key: 'customer', label: 'Khách hàng', children: selected.customer_name },
            { key: 'domain', label: 'Tên miền', children: selected.domain },
            { key: 'url', label: 'Webhook Laravel', children: selected.webhook_url || 'Chưa cấu hình' },
            { key: 'catalog', label: 'URL danh mục liên kết', children: <span style={{ overflowWrap: 'anywhere' }}>{selected.content_catalog_url || 'Chưa cấu hình'}</span> },
            ...(selected.content_catalog_url ? [
              { key: 'catalog-checked', label: 'Kiểm tra danh mục gần nhất', children: datetime(selected.content_catalog_checked_at) },
              { key: 'catalog-synced', label: 'Đồng bộ thành công gần nhất', children: datetime(selected.content_catalog_synced_at) },
              { key: 'catalog-count', label: 'Trang trong danh mục', children: selected.content_catalog_count ?? 0 },
            ] : []),
            { key: 'token', label: 'Token', children: selected.token_hint || 'Chưa cấp' },
            { key: 'signing', label: 'Xác thực máy chủ', children: selected.signing_key_fingerprint ? 'Đã đăng ký khóa ký' : selected.proof_required ? 'Cần đăng ký khóa ký trước khi dùng API' : 'Đang dùng kết nối cũ' },
            ...(selected.signing_key_fingerprint ? [{ key: 'fingerprint', label: 'Vân tay khóa ký', children: <code style={{ overflowWrap: 'anywhere' }}>{selected.signing_key_fingerprint}</code> }] : []),
            { key: 'seen', label: 'API dùng gần nhất', children: datetime(selected.last_seen_at) },
            { key: 'articles', label: 'Bài đã viết', children: selected.article_count },
          ]} />
          {selected.content_catalog_error && <Alert type="warning" showIcon title="Chưa đọc được danh mục liên kết" description={selected.content_catalog_error} />}
          <div className="drawer-actions"><Space wrap>
            <Button disabled={!selected.content_catalog_url || Boolean(checkingCatalogId && checkingCatalogId !== selected.id)} loading={checkingCatalogId === selected.id} onClick={() => void checkCatalog(selected)}>Kiểm tra danh mục</Button>
            <Button icon={<KeyOutlined />} onClick={() => manageSecret(selected, 'token')}>{selected.token_hint ? 'Đổi token' : 'Cấp token'}</Button>
            {selected.token_hint && <Button danger onClick={() => manageSecret(selected, 'revoke')}>Thu hồi token</Button>}
            <Button onClick={() => manageSecret(selected, 'webhook')}>Cấp khóa webhook</Button>
            <Button onClick={() => { setSigningSite(selected); setPublicKey(''); }}>{selected.signing_key_fingerprint ? 'Thay khóa ký' : 'Đăng ký khóa ký'}</Button>
          </Space></div>
          <Button type="link" onClick={() => go('jobs', { website_id: selected.id })}>Xem yêu cầu viết của website</Button>
        </> },
        { key: 'widget', label: 'Hướng dẫn tích hợp', children: <>
          {!selected.token_hint && <Alert type="warning" showIcon title="Cấp token ở tab Kết nối API trước khi gắn widget." />}
          <IntegrationGuide website={selected} copy={copy} />
        </> },
      ]} />}
    </Drawer>
    <Modal title="Đăng ký khóa ký máy chủ" open={Boolean(signingSite)} onCancel={() => setSigningSite(null)}
      confirmLoading={savingKey} onOk={() => void saveSigningKey()} okText="Xác nhận khóa ký" okButtonProps={{ disabled: !publicKey.trim() }}>
      <p>Với Laravel, mở <code>route('crm-ai.settings')</code> và bấm <strong>Tạo khóa máy chủ</strong>. Với PHP thuần, chạy lệnh <code>install</code> trong hướng dẫn PHP. Dán khóa công khai P-256 bên dưới.</p>
      <Input.TextArea aria-label="Khóa công khai máy chủ" value={publicKey} onChange={event => setPublicKey(event.target.value)} rows={6} maxLength={1024} placeholder="-----BEGIN PUBLIC KEY-----" />
    </Modal>
    <Modal title={editing === 'new' ? 'Thêm website' : 'Chỉnh sửa website'} open={Boolean(editing)} onCancel={() => setEditing(null)}
      onOk={() => form.submit()} okText="Lưu website" confirmLoading={saving} zIndex={1100} forceRender>
      <Form form={form} layout="vertical" onFinish={save}>
        <Form.Item name="customer_id" label="Khách hàng" rules={[{ required: true, message: 'Chọn khách hàng.' }]}>
          <Select showSearch={formCustomers.searchConfig} loading={formCustomers.loading} disabled={editing !== 'new'} options={formCustomers.options} />
        </Form.Item>
        <Form.Item name="name" label="Tên hiển thị" rules={[{ required: true, whitespace: true, message: 'Nhập tên website.' }]}><Input /></Form.Item>
        <Form.Item name="domain" label="Tên miền" rules={[{ required: true, whitespace: true, message: 'Nhập tên miền website.' }]}><Input placeholder="example.vn" /></Form.Item>
        <Form.Item name="webhook_url" label="URL webhook nhận bài" extra="Chỉ cần khi website nhận bài tự động theo lịch."
          rules={[{ pattern: /^https?:\/\//i, transform: (value: string | null | undefined) => value?.trim() || undefined, message: 'Nhập URL hợp lệ.' }]}>
          <Input placeholder="https://example.vn/api/webhooks/ai-articles" maxLength={2048} />
        </Form.Item>
        <Form.Item name="content_catalog_url" label="URL danh mục liên kết" extra="URL HTTPS cùng tên miền website, trả JSON {items: [{id, url, title, summary, categories?}]}. CRM đọc danh mục này để chọn liên kết khi viết bài. Để trống nếu chưa sử dụng."
          rules={[{ type: 'url', transform: (value: string | null | undefined) => value?.trim() || undefined, message: 'Nhập URL HTTPS hợp lệ.' }, { pattern: /^https:\/\//i, transform: (value: string | null | undefined) => value?.trim() || undefined, message: 'Nhập URL HTTPS hợp lệ.' }]}>
          <Input placeholder="https://example.vn/api/ai/content-catalog" maxLength={2048} />
        </Form.Item>
      </Form>
    </Modal>
    <Modal title={secret?.title} open={Boolean(secret)} onCancel={() => setSecret(null)} footer={<Button type="primary" onClick={() => setSecret(null)}>Đóng</Button>}>
      {secret && <>
        <Alert type="info" showIcon title="CRM chỉ hiển thị đầy đủ giá trị này khi cấp mới." />
        {laravelConfig && <>
          <p>Dán dòng này vào <code>config/crm-ai.php</code> của website Laravel.</p>
          <Space.Compact block className="secret-value"><Input aria-label="Cấu hình connection Laravel" value={laravelConfig} readOnly onFocus={(event) => event.target.select()} /><Button icon={<CopyOutlined />} onClick={() => void copy(laravelConfig)}>Sao chép connection</Button></Space.Compact>
          <p>Token gốc dùng cho API.</p>
        </>}
        <Space.Compact block className="secret-value"><Input value={secret.value} readOnly onFocus={(event) => event.target.select()} /><Button icon={<CopyOutlined />} onClick={() => void copy(secret.value)}>Sao chép</Button></Space.Compact>
      </>}
    </Modal>
  </>;
}
