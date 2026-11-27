import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, Input, InputNumber, Select, Switch } from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { mutate, useResource } from './api';
import { Panel, ResourceError } from './shared';
import type { KeywordSettings as Values } from '../../src/keywords/settings';

export type KeywordSettingsResponse = { values: Values; revision: number; api_key_configured: boolean; updated_at: string | null };
export function KeywordSettings() {
  const resource = useResource<KeywordSettingsResponse>('/settings/keywords');
  const [form] = Form.useForm<Values & { api_key?: string; clear_api_key?: boolean }>();
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();
  const mode = Form.useWatch('mode', form);
  useEffect(() => { if (resource.data) form.setFieldsValue({ ...resource.data.values, api_key: undefined, clear_api_key: false }); }, [resource.data, form]);
  async function save(draft: Values & { api_key?: string; clear_api_key?: boolean }) {
    if (!resource.data) return;
    setSaving(true);
    const { api_key, clear_api_key, ...edited } = draft;
    const values = { ...resource.data.values, ...edited };
    try {
      await mutate('/settings/keywords', 'PUT', { revision: resource.data.revision, values,
        ...(api_key?.trim() ? { api_key: api_key.trim() } : {}), clear_api_key: Boolean(clear_api_key) });
      form.resetFields(['api_key']); resource.reload(); message.success('Đã lưu cài đặt từ khóa.');
    } catch (error) { message.error((error as Error).message); }
    finally { setSaving(false); }
  }
  return <div className="settings-sections">
    <ResourceError error={resource.error} onRetry={resource.reload} />
    <Alert type="info" showIcon title="Bắt đầu bằng Keyword Tool Guest miễn phí" description="Không cần tài khoản hay API key. Pro chỉ được dùng khi bạn chủ động chọn và lưu API key của gói đã đăng ký; CRM không tự nâng cấp hoặc mua gói." />
    {resource.data && <Form form={form} layout="vertical" onFinish={save} disabled={saving}>
      <Panel title="Nguồn dữ liệu và hạn mức">
        <Form.Item name="enabled" label="Cho phép phân tích từ khóa" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="mode" label="Kết nối Keyword Tool"><Select options={[{ value: 'guest', label: 'Guest MCP · miễn phí' }, { value: 'paid', label: 'Pro REST API · dùng thuê bao riêng' }]} /></Form.Item>
        {mode === 'paid' && <>
          <Form.Item name="api_key" label="API key Keyword Tool" extra={resource.data.api_key_configured ? 'Đã có khóa. Để trống để giữ khóa hiện tại.' : 'Nhập khóa của gói Keyword Tool có quyền REST API.'}><Input.Password maxLength={2048} autoComplete="new-password" /></Form.Item>
          <Form.Item name="paid_daily_limit" label="Request Pro tối đa/ngày" rules={[{ required: true }]}><InputNumber min={1} max={10000} /></Form.Item>
        </>}
        <div className="settings-grid">
          <Form.Item name="daily_limit" label="Lượt mới/khách hàng/ngày" rules={[{ required: true }]}><InputNumber min={1} max={1000} /></Form.Item>
          <Form.Item name="monthly_limit" label="Lượt mới/khách hàng/tháng" rules={[{ required: true }]}><InputNumber min={1} max={25000} /></Form.Item>
          <Form.Item name="cache_hours" label="Dùng lại kết quả trong (giờ)" rules={[{ required: true }]}><InputNumber min={1} max={168} /></Form.Item>
          <Form.Item name="max_ai_cost_usd" label="Trần dự tính AI/lượt (USD)" rules={[{ required: true }, { pattern: /^0\.\d{1,4}$|^[1-9]\d?(?:\.\d{1,4})?$/, message: 'Nhập số USD lớn hơn 0, tối đa 4 số thập phân.' }]}><Input inputMode="decimal" /></Form.Item>
        </div>
        <p>Guest có hạn mức dùng chung. Xem lại kết quả đã lưu không gọi lại nguồn. AI phân loại là tùy chọn, dùng khóa dịch vụ của nhóm quản lý và được ghi chi phí riêng với bài viết.</p>
        <div className="heading-actions"><Button icon={<ReloadOutlined />} onClick={resource.reload}>Tải lại</Button><Button type="primary" htmlType="submit" loading={saving} icon={<SaveOutlined />}>Lưu cài đặt từ khóa</Button></div>
      </Panel>
    </Form>}
  </div>;
}
