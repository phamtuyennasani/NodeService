import { useEffect, useState } from 'react';
import { Alert, App, Button, Empty, Form, Input, Skeleton, Tag } from 'antd';
import { DeleteOutlined, LaptopOutlined, LockOutlined, MailOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { mutate, useResource } from './api';
import { datetime, PageHeading, Panel, ResourceError } from './shared';
import type { AccountProfile, EmailChallenge } from './types';
import './account.css';

const otpRules = [{ required: true, message: 'Nhập mã OTP.' }, { pattern: /^\d{8}$/, message: 'Mã OTP gồm 8 chữ số.' }];

export function Account({ onProfile, onPasswordChange }: { onProfile: (profile: AccountProfile) => void; onPasswordChange: () => void }) {
  const resource = useResource<AccountProfile>('/account');
  const [profile, setProfile] = useState<AccountProfile>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const [challenge, setChallenge] = useState<EmailChallenge>();
  const [resendAt, setResendAt] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [profileForm] = Form.useForm();
  const [emailForm] = Form.useForm();
  const [verificationForm] = Form.useForm();
  const { message, modal } = App.useApp();

  function apply(next: AccountProfile) {
    setProfile(next);
    profileForm.setFieldsValue({ display_name: next.display_name });
    onProfile(next);
  }

  useEffect(() => { if (resource.data) apply(resource.data); }, [resource.data]);
  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);

  async function saveProfile(values: { display_name: string }) {
    setPending('profile'); setError(undefined);
    try {
      const next = await mutate<AccountProfile>('/account', 'PATCH', { display_name: values.display_name });
      apply(next); message.success('Đã cập nhật thông tin tài khoản.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(undefined); }
  }

  function applyChallenge(next: EmailChallenge) {
    const time = Date.now();
    setChallenge(next); setResendAt(time + next.resend_after * 1000); setExpiresAt(time + next.expires_in * 1000); setNow(time);
    verificationForm.resetFields();
  }

  async function startEmail(values: { email: string }) {
    if (!profile?.mail_configured) {
      setError('Chưa thể gửi mã xác minh vì máy chủ chưa cấu hình SMTP. Địa chỉ bạn nhập chưa được lưu.');
      return;
    }
    setPending('email'); setError(undefined);
    try { applyChallenge(await mutate<EmailChallenge>('/account/email/start', 'POST', values)); }
    catch (cause) { setError((cause as Error).message); }
    finally { setPending(undefined); }
  }

  async function verifyEmail(values: { code: string; current_code?: string }) {
    if (!challenge) return;
    setPending('verify'); setError(undefined);
    try {
      const next = await mutate<AccountProfile>('/account/email/verify', 'POST', { challenge_id: challenge.challenge_id, ...values });
      apply(next); setChallenge(undefined); emailForm.resetFields(); verificationForm.resetFields();
      message.success('Đã xác minh email. Thiết bị mới sẽ cần OTP gửi đến địa chỉ này.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(undefined); }
  }

  async function resendEmail() {
    if (!challenge) return;
    setPending('resend'); setError(undefined);
    try {
      applyChallenge(await mutate<EmailChallenge>('/account/email/resend', 'POST', { challenge_id: challenge.challenge_id }));
      message.success('Đã gửi lại mã xác minh. Mã cũ không còn hiệu lực.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(undefined); }
  }

  function revokeDevice(id?: string) {
    modal.confirm({
      title: id ? 'Xóa tin cậy thiết bị?' : 'Xóa tất cả thiết bị tin cậy?',
      content: id ? 'Lần đăng nhập tiếp theo trên thiết bị này sẽ cần OTP qua email. Các phiên khác trên thiết bị bị thu hồi; phiên hiện tại vẫn hoạt động.' : 'Thu hồi mọi thiết bị tin cậy và các phiên đăng nhập khác. Phiên hiện tại vẫn hoạt động.',
      okText: 'Xóa tin cậy', cancelText: 'Hủy', okButtonProps: { danger: true },
      onOk: () => { void performRevoke(id); },
    });
  }

  async function performRevoke(id?: string) {
    setPending('devices'); setError(undefined);
    try {
      await mutate(`/account/devices${id ? `/${encodeURIComponent(id)}` : ''}`, 'DELETE');
      resource.reload(); message.success('Đã xóa thiết bị tin cậy.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(undefined); }
  }

  return <div className="account-page">
    <PageHeading title="Tài khoản" description="Cập nhật thông tin đăng nhập, email nhận OTP và thiết bị tin cậy." action={<Button icon={<ReloadOutlined />} onClick={resource.reload} disabled={Boolean(pending)}>Tải lại</Button>} />
    <ResourceError error={resource.error} onRetry={resource.reload} />
    {error && <Alert className="resource-error" type="error" title={error} showIcon />}
    {!profile ? resource.loading && <Skeleton active paragraph={{ rows: 7 }} /> : <div className="account-sections">
      {!profile.email_verified && <Alert type="warning" showIcon title="Cần xác minh email tài khoản" description="Thêm và xác minh email trước khi đăng xuất để có thể nhận OTP khi đăng nhập trên thiết bị mới." />}
      <Panel title="Thông tin tài khoản">
        <Form form={profileForm} layout="vertical" onFinish={saveProfile} requiredMark={false}>
          <div className="account-form-grid">
            <Form.Item name="display_name" label="Tên hiển thị" rules={[{ required: true, whitespace: true, message: 'Nhập tên hiển thị.' }, { max: 120, message: 'Tối đa 120 ký tự.' }]}><Input maxLength={120} autoComplete="name" /></Form.Item>
            <Form.Item label="Tên đăng nhập" htmlFor="account-username"><Input id="account-username" value={profile.username} readOnly autoComplete="username" /></Form.Item>
          </div>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={pending === 'profile'} disabled={Boolean(pending) && pending !== 'profile'}>Lưu thông tin</Button>
        </Form>
      </Panel>
      <Panel title="Email nhận OTP" extra={profile.email_verified ? <Tag color="success">Đã xác minh</Tag> : <Tag>Chưa xác minh</Tag>}>
        <p className="account-description">{profile.email ? <>Email hiện tại: <strong>{profile.email}</strong>. </> : 'Tài khoản chưa có email nhận OTP. '}Khi đăng nhập trên thiết bị mới, CRM gửi mã xác minh đến email đã xác minh.</p>
        {!profile.mail_configured && <Alert className="account-mail-warning" type="warning" showIcon title="Chưa thể gửi mã xác minh" description="Bạn vẫn có thể nhập email bên dưới. Máy chủ cần được cấu hình SMTP để gửi mã; email chỉ được lưu làm địa chỉ nhận OTP sau khi xác minh." />}
        {challenge ? <Form form={verificationForm} layout="vertical" requiredMark={false} preserve={false} onFinish={verifyEmail}>
          <Alert type="info" showIcon title={`Mã đã gửi đến ${challenge.email_hint}`} description={challenge.requires_current_code ? `Để đổi email, nhập thêm mã đã gửi đến ${challenge.current_email_hint ?? 'email hiện tại'}.` : 'Nhập mã để xác minh quyền sở hữu email.'} />
          <div className="account-form-grid account-otp-fields">
            {challenge.requires_current_code && <Form.Item name="current_code" label="Mã OTP email hiện tại" rules={otpRules}><Input inputMode="numeric" autoComplete="one-time-code" maxLength={8} /></Form.Item>}
            <Form.Item name="code" label="Mã OTP email mới" rules={otpRules}><Input inputMode="numeric" autoComplete="one-time-code" maxLength={8} autoFocus /></Form.Item>
          </div>
          <p className="account-description" role="status">{now >= expiresAt ? 'Mã đã hết hạn. Gửi lại mã để tiếp tục.' : `Mã có hiệu lực trong ${Math.ceil((expiresAt - now) / 60000)} phút.`}</p>
          <div className="account-actions">
            <Button type="primary" htmlType="submit" loading={pending === 'verify'} disabled={Boolean(pending) || now >= expiresAt}>Xác minh email</Button>
            <Button onClick={() => void resendEmail()} disabled={Boolean(pending) || now < resendAt}>{now < resendAt ? `Gửi lại mã sau ${Math.ceil((resendAt - now) / 1000)}s` : 'Gửi lại mã'}</Button>
            <Button type="text" disabled={Boolean(pending)} onClick={() => { setChallenge(undefined); verificationForm.resetFields(); }}>Đổi địa chỉ email</Button>
          </div>
        </Form> : <Form form={emailForm} layout="vertical" requiredMark={false} onFinish={startEmail}>
          <Form.Item name="email" label={profile.email_verified ? 'Email mới' : 'Email tài khoản'} rules={[{ required: true, message: 'Nhập địa chỉ email.' }, { type: 'email', message: 'Email không hợp lệ.' }, { max: 254, message: 'Email quá dài.' }]} extra={profile.email_verified ? 'Đổi email cần xác nhận bằng mã gửi đến cả email hiện tại và email mới.' : 'Email chỉ được lưu làm địa chỉ nhận OTP sau khi xác minh.'}>
            <Input type="email" autoComplete="email" prefix={<MailOutlined />} disabled={Boolean(pending)} />
          </Form.Item>
          <Button htmlType="submit" icon={<MailOutlined />} loading={pending === 'email'} disabled={!profile.mail_configured || Boolean(pending)}>Gửi mã xác minh</Button>
        </Form>}
      </Panel>
      <Panel title="Mật khẩu & phiên đăng nhập">
        <div className="account-security-row"><div><h3>Mật khẩu đăng nhập</h3><p className="account-description">Đổi mật khẩu sẽ đăng xuất các phiên cũ và xóa tin cậy trên các thiết bị.</p></div><Button icon={<LockOutlined />} onClick={onPasswordChange}>Đổi mật khẩu</Button></div>
        <div className="account-session-note"><strong>{profile.remember_me ? 'Đã bật ghi nhớ đăng nhập cho phiên này' : 'Phiên đăng nhập thông thường'}</strong><p className="account-description">{profile.remember_me ? 'Thời hạn tối đa 30 ngày, tự hết hạn sau 7 ngày không hoạt động.' : 'Thời hạn tối đa 12 giờ, tự hết hạn sau 30 phút không hoạt động.'} Chọn “Ghi nhớ đăng nhập” ở lần đăng nhập tiếp theo để thay đổi.</p></div>
      </Panel>
      <Panel title="Thiết bị tin cậy" extra={profile.devices.length > 0 && <Button size="small" danger onClick={() => revokeDevice()} disabled={Boolean(pending)}>Xóa tất cả</Button>}>
        <p className="account-description">Thiết bị tin cậy được bỏ qua bước OTP trong 30 ngày, nhưng vẫn cần mật khẩu. Ghi nhớ đăng nhập là tùy chọn riêng.</p>
        {profile.devices.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có thiết bị tin cậy" /> : <ul className="account-devices">{profile.devices.map(device => <li key={device.id}>
          <LaptopOutlined className="account-device-icon" aria-hidden="true" />
          <div className="account-device-detail"><strong>{device.label || 'Trình duyệt'} {device.current && <Tag color="green">Thiết bị này</Tag>}</strong><span>Hoạt động gần nhất: {datetime(device.last_used_at)}</span><span>Tin cậy đến: {datetime(device.expires_at)}</span></div>
          <Button danger type="text" icon={<DeleteOutlined />} aria-label={`Xóa tin cậy ${device.label || 'trình duyệt'}`} disabled={Boolean(pending)} onClick={() => revokeDevice(device.id)}>Xóa</Button>
        </li>)}</ul>}
      </Panel>
    </div>}
  </div>;
}
