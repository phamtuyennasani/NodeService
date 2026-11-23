import { useEffect, useState } from 'react';
import { Alert, App, Button, Form, Input, InputNumber, Select, Skeleton, Tag } from 'antd';
import { CheckCircleOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { ApiError, mutate, useResource } from './api';
import { datetime, Panel, ResourceError } from './shared';

type SmtpValues = { host: string; port: number; secure: boolean; from: string; user: string };
type SmtpDraft = SmtpValues & { password?: string };
export type SmtpSettingsResponse = {
  values: SmtpValues;
  revision: number;
  password_configured: boolean;
  configured: boolean;
  source: 'database' | 'environment' | 'none';
  updated_at: string | null;
};

function normalized(draft: SmtpDraft): SmtpDraft {
  return { host: draft.host?.trim() ?? '', port: draft.port, secure: draft.secure, from: draft.from?.trim() ?? '', user: draft.user ?? '', password: draft.password ?? '' };
}

function connectionChanged(draft: SmtpValues, saved: SmtpValues) {
  return draft.host.toLowerCase() !== saved.host.toLowerCase() || draft.port !== saved.port || draft.secure !== saved.secure || draft.user !== saved.user;
}

function validHost(value: unknown) {
  if (typeof value !== 'string') return false;
  const host = value.trim();
  if (host.includes(':')) {
    if (!/^[a-f\d:.]+$/i.test(host)) return false;
    try { return Boolean(new URL(`https://[${host}]/`).hostname); } catch { return false; }
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host);
}

export function SmtpSettings() {
  const resource = useResource<SmtpSettingsResponse>('/settings/smtp');
  const [current, setCurrent] = useState<SmtpSettingsResponse>();
  const [pending, setPending] = useState<'save' | 'test'>();
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState(false);
  const [testedRevision, setTestedRevision] = useState<number>();
  const [form] = Form.useForm<SmtpDraft>();
  const { message, modal } = App.useApp();

  function apply(result: SmtpSettingsResponse) {
    setCurrent(result);
    form.resetFields();
    form.setFieldsValue({ ...result.values, password: '' });
    setDirty(false); setError(undefined); setConflict(false); setTestedRevision(undefined);
  }

  useEffect(() => { if (resource.data) apply(resource.data); }, [resource.data]);

  function reload() {
    if (!dirty) return resource.reload();
    modal.confirm({
      title: 'Bỏ thay đổi SMTP chưa lưu?', content: 'Máy chủ, tài khoản và mật khẩu SMTP đang nhập sẽ được thay bằng cấu hình đã lưu.',
      okText: 'Tải lại SMTP', cancelText: 'Tiếp tục chỉnh sửa', onOk: () => resource.reload(),
    });
  }

  function reportError(cause: unknown) {
    const concurrent = cause instanceof ApiError && cause.status === 409;
    setConflict(concurrent);
    setError(concurrent ? 'Cấu hình SMTP đã được thay đổi ở phiên khác. Tải cấu hình mới nhất trước khi tiếp tục.' : (cause as Error).message);
  }

  async function save(draft: SmtpDraft) {
    if (!current || conflict) return;
    const { password, ...values } = normalized(draft);
    const needsPassword = Boolean(values.user) && (!current.password_configured || connectionChanged(values, current.values));
    if (needsPassword && !password) {
      form.setFields([{ name: 'password', errors: ['Nhập mật khẩu SMTP mới khi đổi máy chủ, cổng, bảo mật hoặc tên đăng nhập.'] }]);
      return;
    }
    setPending('save'); setError(undefined); setTestedRevision(undefined);
    try {
      const next = await mutate<SmtpSettingsResponse>('/settings/smtp', 'PUT', { revision: current.revision, values: { ...values, ...(values.user && password ? { password } : {}) } });
      apply(next); message.success('Đã lưu cấu hình SMTP. Email OTP tiếp theo sẽ dùng cấu hình này.');
    } catch (cause) { reportError(cause); }
    finally { setPending(undefined); }
  }

  async function testConnection() {
    if (!current?.configured || dirty || conflict || pending || resource.loading) return;
    setPending('test'); setError(undefined); setTestedRevision(undefined);
    try {
      await mutate<{ ok: true }>('/settings/smtp/test', 'POST', { revision: current.revision });
      setTestedRevision(current.revision); message.success('Kết nối SMTP thành công. Không có email nào được gửi.');
    } catch (cause) { reportError(cause); }
    finally { setPending(undefined); }
  }

  const busy = Boolean(pending) || resource.loading;
  return <div className="settings-smtp settings-sections">
    <ResourceError error={resource.error} onRetry={reload} />
    {error && <Alert type="error" showIcon title="Chưa hoàn tất thao tác SMTP" description={error} action={conflict ? <Button size="small" onClick={reload}>Tải cấu hình SMTP mới</Button> : undefined} />}
    {!current && resource.loading && <Panel><Skeleton active paragraph={{ rows: 6 }} /></Panel>}
    {current && <>
      <div className="settings-status settings-smtp-status"><span>{dirty ? 'Có thay đổi SMTP chưa lưu' : 'Đã đồng bộ cấu hình SMTP'}{current.updated_at ? ` · Cập nhật ${datetime(current.updated_at)}` : ''}</span><Tag>{current.source === 'database' ? 'Đã lưu trong CRM' : current.source === 'environment' ? 'Từ biến môi trường' : 'Chưa cấu hình'}</Tag></div>
      <Panel title="Email / SMTP" extra={<Tag color={current.configured ? 'success' : undefined}>{current.configured ? 'Đã cấu hình' : 'Chưa cấu hình'}</Tag>}>
        <p className="settings-description">Máy chủ này gửi mã OTP đăng nhập và xác minh email tài khoản. Cấu hình đã lưu trong CRM được áp dụng ngay cho các email tiếp theo.</p>
        <Form form={form} name="smtp-settings" layout="vertical" requiredMark={false} disabled={busy} autoComplete="off" onFinish={save} onValuesChange={() => {
          const draft = normalized(form.getFieldsValue(true));
          setDirty(Boolean(draft.password) || (current && (Object.entries(current.values) as [keyof SmtpValues, string | number | boolean][]).some(([key, value]) => draft[key] !== value)));
          setTestedRevision(undefined);
        }}>
          <div className="settings-grid">
            <Form.Item name="host" label="Máy chủ SMTP" rules={[{ required: true, whitespace: true, message: 'Nhập máy chủ SMTP.' }, { max: 253, message: 'Máy chủ SMTP tối đa 253 ký tự.' }, { validator: (_, value: unknown) => validHost(value) ? Promise.resolve() : Promise.reject(new Error('Nhập tên máy chủ hoặc địa chỉ IP, không kèm giao thức hoặc đường dẫn.')) }]}><Input placeholder="smtp.example.com" autoComplete="off" /></Form.Item>
            <Form.Item name="port" label="Cổng SMTP" rules={[{ required: true, message: 'Nhập cổng SMTP.' }, { validator: (_, value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 65535 ? Promise.resolve() : Promise.reject(new Error('Nhập cổng từ 1 đến 65535.')) }]}><InputNumber controls={false} min={1} max={65535} /></Form.Item>
            <Form.Item name="secure" label="Bảo mật kết nối" rules={[{ required: true, message: 'Chọn bảo mật kết nối.' }]} extra="Luôn xác minh chứng chỉ TLS. STARTTLS phải nâng cấp kết nối an toàn trước khi xác thực."><Select options={[{ value: true, label: 'TLS trực tiếp (thường cổng 465)' }, { value: false, label: 'STARTTLS bắt buộc (thường cổng 587)' }]} onChange={(secure: boolean) => { form.setFieldValue('port', secure ? 465 : 587); setDirty(true); setTestedRevision(undefined); }} /></Form.Item>
            <Form.Item name="from" label="Email người gửi" rules={[{ required: true, message: 'Nhập email người gửi.' }, { type: 'email', message: 'Nhập địa chỉ email hợp lệ, không kèm tên hiển thị.' }, { max: 254, message: 'Email tối đa 254 ký tự.' }]} extra="Địa chỉ gửi được nhà cung cấp SMTP cho phép."><Input type="email" placeholder="noreply@example.com" autoComplete="off" /></Form.Item>
            <Form.Item name="user" label="Tên đăng nhập SMTP" extra="Thường là địa chỉ email. Để trống để dùng relay không xác thực và xóa thông tin xác thực SMTP đã lưu." rules={[{ max: 512, message: 'Tên đăng nhập tối đa 512 ký tự.' }]}><Input autoComplete="off" /></Form.Item>
            <Form.Item name="password" label="Mật khẩu SMTP" dependencies={['host', 'port', 'secure', 'user']} rules={[{ max: 4096, message: 'Mật khẩu SMTP tối đa 4096 ký tự.' }, { validator: (_, value: string | undefined) => {
              const draft = normalized(form.getFieldsValue(true));
              return draft.user && (!current.password_configured || connectionChanged(draft, current.values)) && !value
                ? Promise.reject(new Error('Nhập mật khẩu SMTP mới khi đổi máy chủ, cổng, bảo mật hoặc tên đăng nhập.')) : Promise.resolve();
            } }]} extra={current.password_configured ? 'Đã lưu mật khẩu. Để trống để giữ nguyên khi máy chủ, cổng, bảo mật và tên đăng nhập không đổi.' : 'Dùng mật khẩu ứng dụng nếu nhà cung cấp yêu cầu, ví dụ khi tài khoản email bật xác minh hai bước.'}><Input.Password autoComplete="new-password" placeholder={current.password_configured ? 'Đã lưu · không hiển thị lại' : 'Mật khẩu ứng dụng hoặc SMTP'} /></Form.Item>
          </div>
          <Alert className="settings-apply-note" type="info" showIcon title="Mật khẩu SMTP chỉ được nhập mới" description="Mật khẩu được mã hóa khi lưu và không hiển thị lại. Với Gmail và các nhà cung cấp có xác minh hai bước, hãy tạo mật khẩu ứng dụng dành riêng cho SMTP." />
          <div className="settings-smtp-actions">
            <Button type="primary" htmlType="submit" aria-label="Lưu SMTP" icon={<SaveOutlined />} loading={pending === 'save'} disabled={!dirty || conflict || busy}>Lưu SMTP</Button>
            <Button icon={<ReloadOutlined />} onClick={reload} disabled={busy}>Tải lại SMTP</Button>
            <Button icon={<CheckCircleOutlined />} onClick={() => void testConnection()} loading={pending === 'test'} disabled={!current.configured || dirty || conflict || busy}>Kiểm tra kết nối</Button>
          </div>
          <p className="settings-smtp-test-note">Kiểm tra kết nối chỉ dùng cấu hình đã lưu và không gửi email. Hãy lưu thay đổi trước khi kiểm tra.</p>
          {testedRevision === current.revision && <Alert className="settings-apply-note" type="success" showIcon title="Kết nối SMTP thành công" description="Không có email nào được gửi. Bạn có thể quay lại Tài khoản để gửi mã xác minh email." />}
        </Form>
      </Panel>
    </>}
  </div>;
}
