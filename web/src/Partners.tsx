import { useState } from 'react';
import { App, Button, Form, Input, Modal, Popconfirm, Space, Table, Tag } from 'antd';
import { EditOutlined, KeyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { mutate, useResource } from './api';
import { EmptyState, PageHeading, Panel, ResourceError } from './shared';
import type { PartnerAccount } from './types';
import './records.css';

type PartnerDraft = { name: string; username: string; email: string; password: string };

export function Partners({ onOpen, onChanged }: { onOpen: (id: string) => void; onChanged: () => void }) {
  const partners = useResource<{ data: PartnerAccount[] }>('/partners');
  const [editing, setEditing] = useState<PartnerAccount | 'new'>();
  const [resetting, setResetting] = useState<PartnerAccount>();
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [form] = Form.useForm<PartnerDraft>();
  const [passwordForm] = Form.useForm<{ password: string }>();
  const { message } = App.useApp();
  function reload() { partners.reload(); onChanged(); }
  function edit(partner?: PartnerAccount) {
    form.resetFields();
    if (partner) form.setFieldsValue({ name: partner.name });
    setEditing(partner ?? 'new');
  }
  async function save(values: PartnerDraft) {
    setSaving(true);
    try {
      if (editing === 'new') await mutate('/partners', 'POST', values);
      else if (editing) await mutate(`/partners/${editing.id}`, 'PATCH', { name: values.name });
      setEditing(undefined);
      form.resetFields();
      reload();
      message.success('Đã lưu tài khoản đối tác.');
    } catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  }
  async function changeAccess(partner: PartnerAccount) {
    setBusy(partner.id);
    try {
      await mutate(`/partners/${partner.id}`, 'PATCH', { enabled: !partner.enabled });
      reload();
      message.success(partner.enabled ? 'Đã khóa nhóm đối tác.' : 'Đã mở lại nhóm đối tác.');
    } catch (error) { message.error((error as Error).message); }
    finally { setBusy(undefined); }
  }
  async function resetPassword(values: { password: string }) {
    if (!resetting) return;
    setSaving(true);
    try {
      await mutate(`/partners/${resetting.id}/password`, 'POST', values);
      setResetting(undefined);
      passwordForm.resetFields();
      message.success('Đã đặt lại mật khẩu và thu hồi các phiên đăng nhập của đối tác.');
    } catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  }
  return <>
    <PageHeading title="Đối tác" description="Cấp tài khoản quản trị cho từng nhóm khách hàng, website và cấu hình riêng." action={<Space wrap>
      <Button icon={<ReloadOutlined />} loading={partners.loading} onClick={reload}>Làm mới</Button>
      <Button type="primary" icon={<PlusOutlined />} onClick={() => edit()}>Thêm đối tác</Button>
    </Space>} />
    <ResourceError error={partners.error} onRetry={reload} />
    <Panel className="table-panel record-panel" title="Tài khoản đối tác">
      <Table<PartnerAccount> rowKey="id" dataSource={partners.data?.data ?? []} loading={partners.loading} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 900 }}
        locale={{ emptyText: <EmptyState description="Chưa có đối tác" /> }} columns={[
          { title: 'Đối tác', key: 'name', render: (_, row) => <button className="table-link table-identity" onClick={() => onOpen(row.id)}><strong>{row.name}</strong><small>{row.email}</small></button> },
          { title: 'Tài khoản', dataIndex: 'username' },
          { title: 'Trạng thái', key: 'status', render: (_, row) => <Tag color={row.enabled ? 'success' : 'default'}>{row.enabled ? 'Hoạt động' : 'Đã khóa'}</Tag> },
          { title: 'Khách hàng', dataIndex: 'customer_count', align: 'right' },
          { title: 'Website', dataIndex: 'website_count', align: 'right' },
          { title: 'Bài viết', dataIndex: 'article_count', align: 'right' },
          { title: 'Thao tác', key: 'actions', render: (_, row) => <Space wrap>
            <Button onClick={() => onOpen(row.id)}>Quản lý</Button>
            <Button icon={<EditOutlined />} aria-label={`Sửa ${row.name}`} onClick={() => edit(row)} />
            <Button icon={<KeyOutlined />} aria-label={`Đặt lại mật khẩu ${row.name}`} onClick={() => { passwordForm.resetFields(); setResetting(row); }} />
            <Popconfirm title={row.enabled ? 'Khóa nhóm đối tác?' : 'Mở lại nhóm đối tác?'} description={row.enabled ? 'Thu hồi đăng nhập và tạm dừng nhận yêu cầu, xử lý bài mới của nhóm.' : undefined}
              onConfirm={() => changeAccess(row)} okText="Xác nhận" cancelText="Hủy">
              <Button danger={row.enabled} loading={busy === row.id}>{row.enabled ? 'Khóa' : 'Mở khóa'}</Button>
            </Popconfirm>
          </Space> },
        ]} />
    </Panel>
    <Modal title={editing === 'new' ? 'Thêm đối tác' : 'Sửa đối tác'} open={Boolean(editing)} onCancel={() => setEditing(undefined)}
      onOk={() => form.submit()} confirmLoading={saving} okText="Lưu đối tác" cancelText="Hủy" destroyOnHidden>
      <Form form={form} layout="vertical" preserve={false} onFinish={save}>
        <Form.Item name="name" label="Tên đối tác" rules={[{ required: true, max: 160 }]}><Input autoComplete="organization" /></Form.Item>
        {editing === 'new' && <>
          <Form.Item name="username" label="Tên đăng nhập" rules={[{ required: true, pattern: /^[\w.@-]{3,100}$/, message: 'Dùng 3–100 chữ, số hoặc các ký tự . @ _ -' }]}><Input autoComplete="off" /></Form.Item>
          <Form.Item name="email" label="Email nhận OTP" rules={[{ required: true, type: 'email', max: 254 }]}><Input type="email" autoComplete="off" /></Form.Item>
          <Form.Item name="password" label="Mật khẩu ban đầu" rules={[{ required: true, min: 12, max: 256 }]}><Input.Password autoComplete="new-password" /></Form.Item>
        </>}
      </Form>
    </Modal>
    <Modal title={`Đặt lại mật khẩu ${resetting?.name ?? ''}`} open={Boolean(resetting)} onCancel={() => setResetting(undefined)}
      onOk={() => passwordForm.submit()} confirmLoading={saving} okText="Đặt lại mật khẩu" cancelText="Hủy" destroyOnHidden>
      <Form form={passwordForm} layout="vertical" preserve={false} onFinish={resetPassword}>
        <Form.Item name="password" label="Mật khẩu mới" rules={[{ required: true, min: 12, max: 256 }]}><Input.Password autoComplete="new-password" /></Form.Item>
      </Form>
    </Modal>
  </>;
}
