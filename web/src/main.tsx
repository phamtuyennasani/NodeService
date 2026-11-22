import { lazy, Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Alert, App, Button, ConfigProvider, Drawer, Dropdown, Form, Input, Modal, Skeleton, Spin,
} from 'antd';
import viVN from 'antd/locale/vi_VN';
import dayjs from 'dayjs';
import 'dayjs/locale/vi';
import {
  AppstoreOutlined, ArrowRightOutlined, BookOutlined, CalendarOutlined, ClusterOutlined,
  DollarOutlined, DownOutlined, FileTextOutlined, GlobalOutlined, LockOutlined, LogoutOutlined,
  MenuOutlined, RightOutlined, SendOutlined, SettingOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import '@fontsource/inter/vietnamese-400.css';
import '@fontsource/inter/vietnamese-500.css';
import '@fontsource/inter/vietnamese-600.css';
import '@fontsource/inter/vietnamese-700.css';
import { mutate, request, setCsrfToken } from './api';
import type { Session } from './types';
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

const navigationGroups = [
  { label: 'Vận hành', items: [
    { key: 'overview', label: 'Tổng quan', icon: AppstoreOutlined },
    { key: 'jobs', label: 'Yêu cầu viết', icon: FileTextOutlined },
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
    { key: 'settings', label: 'Cài đặt', icon: SettingOutlined },
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

  async function submit(values: { username: string; password: string }) {
    setError(undefined);
    setPending(true);
    try {
      onLogin(await mutate<Session>('/login', 'POST', values));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setPending(false);
    }
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
          <h1 id="login-heading">Đăng nhập</h1>
          <p>Nhập tài khoản quản trị để vào Bàn biên tập.</p>
          {(error ?? sessionError) && <Alert className="resource-error" type="error" showIcon title={error ?? sessionError} />}
          <Form layout="vertical" requiredMark={false} size="large" onFinish={submit}>
            <Form.Item name="username" label="Tên đăng nhập" rules={[{ required: true, message: 'Nhập tên đăng nhập.' }]}>
              <Input prefix={<UserOutlined />} autoComplete="username" autoFocus={window.matchMedia('(min-width: 801px)').matches} />
            </Form.Item>
            <Form.Item name="password" label="Mật khẩu" rules={[{ required: true, message: 'Nhập mật khẩu.' }]}>
              <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
            </Form.Item>
            <Button block type="primary" htmlType="submit" loading={pending} icon={<ArrowRightOutlined />} iconPlacement="end">Đăng nhập</Button>
          </Form>
        </div>
      </section>
    </main>
  );
}

function getLocation() {
  const [key, search] = window.location.hash.slice(1).split('?');
  return { key: navigation.some((item) => item.key === key) ? key : 'overview', query: new URLSearchParams(search) };
}

function Workspace({ session, onSession, onSignOut }: { session: Session; onSession: (session: Session) => void; onSignOut: () => void }) {
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
            {group.items.map(({ key, label, icon: Icon }) => (
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
            { key: 'password', icon: <LockOutlined />, label: 'Đổi mật khẩu' },
            { key: 'logout', icon: <LogoutOutlined />, label: 'Đăng xuất' },
          ],
          onClick: ({ key }) => {
            setMobileMenu(false);
            if (key === 'password') setPasswordOpen(true);
            else void logout();
          },
        }}>
          <button type="button" className="crm-account-button" aria-label={`Tài khoản ${session.username}`} aria-haspopup="menu">
            <span className="crm-avatar" aria-hidden="true">{Array.from(session.username).slice(0, 2).join('').toUpperCase()}</span>
            <span className="crm-identity"><strong>{session.username}</strong><span>Quản trị viên</span></span>
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
          <Today />
        </header>
        <main id="crm-main" tabIndex={-1} className="crm-page" key={`${location.key}?${location.query}`}>
          <Suspense fallback={<div role="status" aria-label="Đang tải"><Skeleton active paragraph={{ rows: 4 }} /></div>}>
            {location.key === 'overview' && <Dashboard query={location.query} />}
            {location.key === 'customers' && <Customers query={location.query} />}
            {location.key === 'websites' && <Websites query={location.query} />}
            {location.key === 'jobs' && <Jobs query={location.query} />}
            {location.key === 'deliveries' && <Deliveries query={location.query} />}
            {location.key === 'providers' && <Providers />}
            {location.key === 'prices' && <Pricing />}
            {location.key === 'settings' && <Settings />}
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

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function subscribeToMotionPreference(notify: () => void) {
  reducedMotion.addEventListener('change', notify);
  return () => reducedMotion.removeEventListener('change', notify);
}

function CrmApp() {
  const reduce = useSyncExternalStore(subscribeToMotionPreference, () => reducedMotion.matches);
  const theme = reduce ? { ...crmTheme, token: { ...crmTheme.token, motion: false } } : crmTheme;
  return <ConfigProvider locale={viVN} theme={theme}><App><Root /></App></ConfigProvider>;
}

createRoot(document.getElementById('root')!).render(<CrmApp />);
