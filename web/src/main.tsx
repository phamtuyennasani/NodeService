import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert, App, Button, Checkbox, ConfigProvider, Drawer, Dropdown, Form, Input, Modal, Select, Skeleton, Spin, theme as antdTheme,
} from 'antd';
import viVN from 'antd/locale/vi_VN';
import dayjs from 'dayjs';
import 'dayjs/locale/vi';
import {
  AppstoreOutlined, ArrowRightOutlined, BookOutlined, CalendarOutlined, ClusterOutlined,
  DollarOutlined, DownOutlined, FileTextOutlined, GlobalOutlined, LockOutlined, LogoutOutlined,
  MenuOutlined, RightOutlined, SearchOutlined, SendOutlined, SettingOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/vietnamese-400.css';
import '@fontsource/inter/vietnamese-500.css';
import '@fontsource/inter/vietnamese-600.css';
import '@fontsource/inter/vietnamese-700.css';
import { cancelLoginChallenge, mutate, request, setCsrfToken, setReauthenticationHandler, setWorkspace, useResource } from './api';
import { setBrowserSession } from './browser-proof';
import type { LoginChallenge, PartnerAccount, Session } from './types';
import { crmTheme } from './theme.js';
import './styles.css';
import './shell.css';

dayjs.locale('vi');

const Dashboard = lazy(() => import('./Dashboard').then((page) => ({ default: page.Dashboard })));
const Customers = lazy(() => import('./Customers').then((page) => ({ default: page.Customers })));
const Websites = lazy(() => import('./Websites').then((page) => ({ default: page.Websites })));
const Jobs = lazy(() => import('./Jobs').then((page) => ({ default: page.Jobs })));
const Deliveries = lazy(() => import('./Jobs').then((page) => ({ default: page.Deliveries })));
const Providers = lazy(() => import('./Providers').then((page) => ({ default: page.Providers })));
const Pricing = lazy(() => import('./Pricing').then((page) => ({ default: page.Pricing })));
const Settings = lazy(() => import('./Settings').then((page) => ({ default: page.Settings })));
const Account = lazy(() => import('./Account').then((page) => ({ default: page.Account })));
const Partners = lazy(() => import('./Partners').then((page) => ({ default: page.Partners })));
const Keywords = lazy(() => import('./Keywords').then((page) => ({ default: page.Keywords })));

const navigationGroups = [
  { label: 'Vận hành', items: [
    { key: 'overview', label: 'Tổng quan', icon: AppstoreOutlined },
    { key: 'jobs', label: 'Yêu cầu viết', icon: FileTextOutlined },
    { key: 'keywords', label: 'Phân tích từ khóa', icon: SearchOutlined },
    { key: 'deliveries', label: 'Giao bài', icon: SendOutlined },
  ] },
  { label: 'Khách hàng & website', items: [
    { key: 'customers', label: 'Khách hàng', icon: TeamOutlined },
    { key: 'websites', label: 'Website', icon: GlobalOutlined },
  ] },
  { label: 'Cấu hình AI', items: [
    { key: 'providers', label: 'Nhà cung cấp AI', icon: ClusterOutlined },
    { key: 'prices', label: 'Bảng giá model', icon: DollarOutlined },
  ] },
  { label: 'Hệ thống', items: [
    { key: 'partners', label: 'Đối tác', icon: TeamOutlined },
    { key: 'settings', label: 'Cài đặt', icon: SettingOutlined },
    { key: 'account', label: 'Tài khoản', icon: UserOutlined },
  ] },
];
const navigation = navigationGroups.flatMap((group) => group.items.map((item) => ({ ...item, group: group.label })));

function Brand() {
  return (
    <span className="crm-brand">
      <span className="crm-mark" aria-hidden="true"><i /><i /><i /></span>
      <span>Bàn biên tập</span>
    </span>
  );
}

const dateFormatter = new Intl.DateTimeFormat('vi-VN', {
  weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh',
});
function Today() {
  const [date, setDate] = useState(() => dateFormatter.format(new Date()));
  useEffect(() => {
    const timer = window.setInterval(() => setDate(dateFormatter.format(new Date())), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="crm-today"><CalendarOutlined aria-hidden="true" />{date}</span>;
}

function Login({ onLogin, sessionError }: { onLogin: (session: Session) => void; sessionError?: string }) {
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [challenge, setChallenge] = useState<LoginChallenge>();
  const [resendAt, setResendAt] = useState(0);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [loginForm] = Form.useForm();
  const [otpForm] = Form.useForm();
  const { message } = App.useApp();

  useEffect(() => {
    if (!challenge) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challenge]);

  function applyChallenge(next: LoginChallenge) {
    const time = Date.now();
    setChallenge(next);
    setResendAt(time + next.resend_after * 1000);
    setExpiresAt(time + next.expires_in * 1000);
    setNow(time);
    otpForm.resetFields(['code']);
  }

  async function submit(values: { username: string; password: string; remember_me?: boolean }) {
    setError(undefined);
    setPending(true);
    try {
      const response = await mutate<Session | LoginChallenge>('/login', 'POST', { ...values, remember_me: values.remember_me === true });
      loginForm.resetFields(['password']);
      if ('otp_required' in response) applyChallenge(response);
      else onLogin(response);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
  }

  async function verify(values: { code: string; trust_device?: boolean }) {
    if (!challenge) return;
    setPending(true); setError(undefined);
    try {
      const response = await mutate<Session>('/login/verify', 'POST', { challenge_id: challenge.challenge_id, code: values.code, trust_device: values.trust_device === true });
      otpForm.resetFields();
      onLogin(response);
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(false); }
  }

  async function resend() {
    if (!challenge) return;
    setPending(true); setError(undefined);
    try {
      const response = await mutate<LoginChallenge>('/login/resend', 'POST', { challenge_id: challenge.challenge_id });
      applyChallenge({ ...challenge, ...response });
      message.success('Đã gửi lại mã xác minh. Mã cũ không còn hiệu lực.');
    } catch (cause) { setError((cause as Error).message); }
    finally { setPending(false); }
  }

  function backToLogin() {
    cancelLoginChallenge(); setChallenge(undefined); setError(undefined); otpForm.resetFields();
  }

  useEffect(() => {
    document.title = 'Đăng nhập · Bàn biên tập';
  }, []);

  return (
    <main className="crm-login">
      <section className="crm-login-cover" aria-label="Bàn biên tập">
        <Brand />
        <div className="crm-folio" aria-hidden="true">
          <div className="crm-sheet crm-sheet-back" />
          <div className="crm-sheet crm-sheet-middle" />
          <div className="crm-sheet crm-sheet-front"><span /><span /><span /><i /></div>
        </div>
        <div className="crm-login-caption">
          <h2>Quản lý dịch vụ<br />viết bài AI.</h2>
          <p>Theo dõi yêu cầu viết, hạn mức khách hàng và chi phí AI.</p>
        </div>
      </section>
      <section className="crm-login-panel" aria-labelledby="login-heading">
        <div className="crm-login-form">
          <h1 id="login-heading">{challenge ? 'Xác minh thiết bị' : 'Đăng nhập'}</h1>
          <p>{challenge ? `Nhập mã 8 chữ số đã gửi tới ${challenge.email_hint}.` : 'Nhập tài khoản quản trị để vào Bàn biên tập.'}</p>
          {(error ?? sessionError) && <Alert className="resource-error" type="error" showIcon title={error ?? sessionError} />}
          {challenge ? <Form form={otpForm} layout="vertical" requiredMark={false} size="large" initialValues={{ trust_device: false }} onFinish={verify} preserve={false}>
            <Form.Item name="code" label="Mã OTP" rules={[{ required: true, message: 'Nhập mã OTP.' }, { pattern: /^\d{8}$/, message: 'Mã OTP gồm 8 chữ số.' }]}>
              <Input inputMode="numeric" autoComplete="one-time-code" maxLength={8} autoFocus disabled={pending} />
            </Form.Item>
            <p className="crm-login-help" role="status">{now >= expiresAt ? 'Mã đã hết hạn. Hãy gửi lại mã hoặc đăng nhập lại.' : `Mã có hiệu lực trong ${Math.ceil((expiresAt - now) / 60000)} phút.`}</p>
            <Form.Item name="trust_device" valuePropName="checked" extra="Chỉ chọn trên thiết bị cá nhân. Bạn vẫn cần mật khẩu khi đăng nhập lại.">
              <Checkbox>Không hỏi lại OTP trên thiết bị này trong 30 ngày</Checkbox>
            </Form.Item>
            <Button block type="primary" htmlType="submit" loading={pending} disabled={now >= expiresAt}>Xác minh và đăng nhập</Button>
            <div className="crm-login-secondary">
              <Button type="link" onClick={() => void resend()} disabled={pending || now < resendAt}>{now < resendAt ? `Gửi lại mã sau ${Math.ceil((resendAt - now) / 1000)}s` : 'Gửi lại mã OTP'}</Button>
              <Button type="text" onClick={backToLogin} disabled={pending}>Đổi tài khoản</Button>
            </div>
          </Form> : <Form form={loginForm} layout="vertical" requiredMark={false} size="large" initialValues={{ remember_me: false }} onFinish={submit}>
            <Form.Item name="username" label="Tên đăng nhập" rules={[{ required: true, message: 'Nhập tên đăng nhập.' }]}>
              <Input prefix={<UserOutlined />} autoComplete="username" autoFocus={window.matchMedia('(min-width: 801px)').matches} />
            </Form.Item>
            <Form.Item name="password" label="Mật khẩu" rules={[{ required: true, message: 'Nhập mật khẩu.' }]}>
              <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
            </Form.Item>
            <Form.Item name="remember_me" valuePropName="checked" extra="Giữ đăng nhập tối đa 30 ngày trên trình duyệt này. Không chọn trên máy dùng chung.">
              <Checkbox>Ghi nhớ đăng nhập</Checkbox>
            </Form.Item>
            <Button block type="primary" htmlType="submit" loading={pending} icon={<ArrowRightOutlined />} iconPlacement="end">Đăng nhập</Button>
          </Form>}
        </div>
      </section>
    </main>
  );
}

function getLocation() {
  const [key, search] = window.location.hash.slice(1).split('?');
  return { key: navigation.some((item) => item.key === key) ? key : 'overview', query: new URLSearchParams(search) };
}

function savedWorkspace(session: Session) {
  if (session.role !== 'root') return 'root';
  try { return window.sessionStorage.getItem(`crm-workspace:${session.username}`) || 'root'; }
  catch { return 'root'; }
}

function Workspace({ session, onSession, onSignOut }: { session: Session; onSession: (session: Session) => void; onSignOut: () => void }) {
  const isRoot = session.role === 'root';
  const [selectedWorkspace, selectWorkspace] = useState(() => savedWorkspace(session));
  const partners = useResource<{ data: PartnerAccount[] }>(isRoot ? '/partners' : null);
  function changeWorkspace(id: string) {
    setWorkspace(id === 'root' ? undefined : id);
    selectWorkspace(id);
    try { window.sessionStorage.setItem(`crm-workspace:${session.username}`, id); } catch { /* In-memory selection still works. */ }
    window.location.hash = '#overview';
  }
  const accountName = session.display_name?.trim() || session.username;
  const nameParts = accountName.split(/\s+/);
  const avatarText = (nameParts.length > 1 ? `${Array.from(nameParts[0])[0] ?? ''}${Array.from(nameParts.at(-1)!)[0] ?? ''}` : Array.from(accountName).slice(0, 2).join('')).toUpperCase();
  const [location, setLocation] = useState(getLocation);
  const [mobileMenu, setMobileMenu] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordPending, setPasswordPending] = useState(false);
  const [passwordForm] = Form.useForm();
  const { message } = App.useApp();

  useEffect(() => {
    function update() {
      setLocation(getLocation());
      setMobileMenu(false);
    }
    window.addEventListener('hashchange', update);
    const desktop = window.matchMedia('(min-width: 801px)');
    const closeMobileMenu = () => {
      if (desktop.matches) setMobileMenu(false);
    };
    desktop.addEventListener('change', closeMobileMenu);
    return () => {
      window.removeEventListener('hashchange', update);
      desktop.removeEventListener('change', closeMobileMenu);
    };
  }, []);

  async function logout() {
    try {
      await mutate('/logout', 'POST');
      onSignOut();
    } catch (error) {
      message.error((error as Error).message);
    }
  }

  async function changePassword(values: { current_password: string; new_password: string }) {
    setPasswordPending(true);
    try {
      onSession(await mutate<Session>('/password', 'POST', values));
      setPasswordOpen(false);
      passwordForm.resetFields();
      message.success('Đã đổi mật khẩu.');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setPasswordPending(false);
    }
  }

  const active = navigation.find((item) => item.key === location.key) ?? navigation[0];
  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = `${active.label} · Bàn biên tập`;
  }, [active]);

  const menu = (
    <div className="crm-menu">
      <nav aria-label="Điều hướng CRM">
        {navigationGroups.map((group) => (
          <div key={group.label} className="crm-nav-group">
            <div className="crm-nav-label">{group.label}</div>
            {group.items.filter(item => item.key !== 'partners' || isRoot).map(({ key, label, icon: Icon }) => (
              <a key={key} href={`#${key}`} className="crm-nav-link" aria-current={location.key === key ? 'page' : undefined} onClick={() => setMobileMenu(false)}>
                <Icon aria-hidden="true" /><span>{label}</span>
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div className="crm-account">
        <Dropdown trigger={['click']} placement="topLeft" menu={{
          items: [
            { key: 'account', icon: <UserOutlined />, label: 'Thông tin tài khoản' },
            { key: 'password', icon: <LockOutlined />, label: 'Đổi mật khẩu' },
            { key: 'logout', icon: <LogoutOutlined />, label: 'Đăng xuất' },
          ],
          onClick: ({ key }) => {
            setMobileMenu(false);
            if (key === 'account') window.location.hash = 'account';
            else if (key === 'password') setPasswordOpen(true);
            else void logout();
          },
        }}>
          <button type="button" className="crm-account-button" aria-label={`Tài khoản ${accountName}`} aria-haspopup="menu">
            <span className="crm-avatar" aria-hidden="true">{avatarText}</span>
            <span className="crm-identity"><strong>{accountName}</strong><span>{session.role === 'provider' ? 'Quản trị đối tác' : isRoot ? 'Root' : 'Quản trị viên'}</span></span>
            <DownOutlined className="crm-account-caret" aria-hidden="true" />
          </button>
        </Dropdown>
      </div>
    </div>
  );
  const brandLink = <a href="#overview" className="crm-brand-link" aria-label="Bàn biên tập, tổng quan" onClick={() => setMobileMenu(false)}><Brand /></a>;

  return (
    <div className="crm-workspace">
      <button className="crm-skip" onClick={() => document.getElementById('crm-main')?.focus()}>Đến nội dung chính</button>
      <aside className="crm-sidebar">{brandLink}{menu}</aside>
      <Drawer open={mobileMenu} onClose={() => setMobileMenu(false)} placement="left" size={272} title={brandLink} closable={{ placement: 'end' }} destroyOnHidden className="crm-mobile-drawer">
        {menu}
      </Drawer>
      <div className="crm-canvas">
        <header className="crm-topbar">
          <div className="crm-crumb">
            <Button className="crm-menu-toggle" aria-label="Mở điều hướng" type="text" icon={<MenuOutlined />} aria-expanded={mobileMenu} onClick={() => setMobileMenu(true)} />
            <BookOutlined className="crm-crumb-icon" aria-hidden="true" />
            <span className="crm-crumb-group">{active.group}</span>
            <RightOutlined className="crm-crumb-chevron" aria-hidden="true" />
            <strong>{active.label}</strong>
          </div>
          <div className="crm-topbar-context">
            {isRoot && <Select className="crm-workspace-select" aria-label="Nhóm quản lý" value={selectedWorkspace}
              loading={partners.loading} onChange={changeWorkspace} showSearch optionFilterProp="label"
              options={[{ value: 'root', label: 'Nhóm root' }, ...(partners.data?.data ?? []).map(partner => ({ value: partner.id, label: partner.name + (partner.enabled ? '' : ' (đã khóa)') }))]} />}
            {session.partner && <span className="crm-workspace-name">{session.partner.name}</span>}
            <Today />
          </div>
        </header>
        <main id="crm-main" tabIndex={-1} className="crm-page" key={`${selectedWorkspace}:${location.key}?${location.query}`}>
          {partners.error && <Alert type="error" title={partners.error.message} action={<Button onClick={partners.reload}>Thử lại</Button>} />}
          <Suspense fallback={<div role="status" aria-label="Đang tải"><Skeleton active paragraph={{ rows: 4 }} /></div>}>
            {location.key === 'overview' && <Dashboard query={location.query} />}
            {location.key === 'customers' && <Customers query={location.query} />}
            {location.key === 'websites' && <Websites query={location.query} />}
            {location.key === 'jobs' && <Jobs query={location.query} />}
            {location.key === 'keywords' && <Keywords query={location.query} />}
            {location.key === 'deliveries' && <Deliveries query={location.query} />}
            {location.key === 'providers' && <Providers />}
            {location.key === 'prices' && <Pricing />}
            {location.key === 'settings' && <Settings query={location.query} />}
            {location.key === 'partners' && (isRoot ? <Partners onOpen={changeWorkspace} onChanged={partners.reload} /> : <Alert type="error" title="Chỉ root được quản lý tài khoản đối tác." />)}
            {location.key === 'account' && <Account onProfile={(profile) => onSession({ ...session, username: profile.username, display_name: profile.display_name, email: profile.email, email_verified: profile.email_verified })} onPasswordChange={() => setPasswordOpen(true)} />}
          </Suspense>
        </main>
      </div>
      <Modal title="Đổi mật khẩu" open={passwordOpen} onCancel={() => setPasswordOpen(false)} onOk={() => passwordForm.submit()} okText="Lưu mật khẩu" confirmLoading={passwordPending} destroyOnHidden>
        <Form form={passwordForm} layout="vertical" onFinish={changePassword} preserve={false}>
          <Form.Item name="current_password" label="Mật khẩu hiện tại" rules={[{ required: true, message: 'Nhập mật khẩu hiện tại.' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item name="new_password" label="Mật khẩu mới" rules={[{ required: true, min: 12, message: 'Nhập tối thiểu 12 ký tự.' }]}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

function Root() {
  const [session, setSession] = useState<Session | null>();
  const [sessionError, setSessionError] = useState<string>();
  function applySession(next: Session | null) {
    setCsrfToken(next?.csrf_token ?? '');
    const workspace = next ? savedWorkspace(next) : 'root';
    setWorkspace(workspace === 'root' ? undefined : workspace);
    if (!next) setBrowserSession(null);
    setSession(next);
  }

  useEffect(() => {
    const abort = new AbortController();
    request<Session>('/session', { signal: abort.signal }).then(applySession).catch((error) => {
      if (abort.signal.aborted) return;
      if (error.status !== 401) setSessionError(error.message);
      applySession(null);
    });
    function expired() {
      applySession(null);
      setSessionError('Phiên đăng nhập đã hết hạn.');
    }
    window.addEventListener('crm-session-expired', expired);
    return () => {
      abort.abort();
      window.removeEventListener('crm-session-expired', expired);
    };
  }, []);

  if (session === undefined) return <main className="crm-session-loading"><Spin size="large" /></main>;
  if (!session) return <Login sessionError={sessionError} onLogin={(next) => {
    setSessionError(undefined);
    applySession(next);
  }} />;
  return <Workspace session={session} onSession={applySession} onSignOut={() => applySession(null)} />;
}

function ReauthenticationDialog() {
  const { token } = antdTheme.useToken();
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<{ current_password: string }>();
  const pending = useRef<((password: string | null) => void) | undefined>(undefined);
  function finish(password: string | null) {
    const resolve = pending.current;
    pending.current = undefined;
    form.resetFields();
    setOpen(false);
    resolve?.(password);
  }
  useEffect(() => {
    setReauthenticationHandler(() => new Promise(resolve => {
      pending.current?.(null);
      pending.current = resolve;
      form.resetFields();
      setOpen(true);
    }));
    const cancel = () => finish(null);
    window.addEventListener('crm-session-expired', cancel);
    return () => {
      setReauthenticationHandler(undefined);
      pending.current?.(null);
      pending.current = undefined;
      window.removeEventListener('crm-session-expired', cancel);
    };
  }, [form]);
  // Confirm dialogs use the popup base + 1000; security prompts must appear above them.
  return <Modal title="Xác nhận bảo mật" open={open} zIndex={token.zIndexPopupBase + 1100} onCancel={() => finish(null)}
    onOk={() => form.submit()} okText="Xác nhận thao tác" cancelText="Hủy" destroyOnHidden>
    <p>Nhập lại mật khẩu để lưu thay đổi cài đặt. Xác nhận chỉ có hiệu lực cho lần lưu này.</p>
    <Form form={form} layout="vertical" preserve={false} onFinish={values => finish(values.current_password)}>
      <Form.Item name="current_password" label="Mật khẩu hiện tại" rules={[{ required: true, message: 'Nhập mật khẩu hiện tại.' }]}>
        <Input.Password autoComplete="current-password" autoFocus />
      </Form.Item>
    </Form>
  </Modal>;
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function subscribeToMotionPreference(notify: () => void) {
  reducedMotion.addEventListener('change', notify);
  return () => reducedMotion.removeEventListener('change', notify);
}

function CrmApp() {
  const reduce = useSyncExternalStore(subscribeToMotionPreference, () => reducedMotion.matches);
  const theme = reduce ? { ...crmTheme, token: { ...crmTheme.token, motion: false } } : crmTheme;
  return <ConfigProvider locale={viVN} theme={theme}><App><Root /><ReauthenticationDialog /></App></ConfigProvider>;
}

createRoot(document.getElementById('root')!).render(<CrmApp />);
