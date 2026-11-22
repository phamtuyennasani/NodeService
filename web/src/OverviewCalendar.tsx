import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, DatePicker, Skeleton, Space } from 'antd';
import { ArrowLeftOutlined, CalendarOutlined, LeftOutlined, ReloadOutlined, RightOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useResource, withQuery } from './api';
import { number, PageHeading, ResourceError } from './shared';
import './overview-calendar.css';

type Counts = { scheduled: number; written: number; delivered: number };
export type CalendarReport = {
  timezone: 'Asia/Ho_Chi_Minh';
  month: string;
  date: string | null;
  totals: Counts;
  days: (Counts & { date: string })[];
  hours: (Counts & { hour: number })[];
};
type CalendarProps = {
  initialDate: string;
  customerId?: string;
  websiteId?: string;
  scopeLabel?: string;
  revision?: number;
  onClose: () => void;
};

const todayInVietnam = () => dayjs(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date()));
const weekdays = ['Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy', 'Chủ nhật'];
const measures = [
  { key: 'scheduled', label: 'Lên lịch', short: 'L' },
  { key: 'written', label: 'Đã viết', short: 'V' },
  { key: 'delivered', label: 'Đã giao', short: 'G' },
] as const;

export function OverviewCalendar({ initialDate, customerId, websiteId, scopeLabel, revision = 0, onClose }: CalendarProps) {
  const [month, setMonth] = useState(() => (dayjs(initialDate).isValid() ? dayjs(initialDate) : todayInVietnam()).startOf('month'));
  const [selectedDate, setSelectedDate] = useState<string>();
  const path = withQuery('/dashboard/calendar', {
    month: month.format('YYYY-MM'), date: selectedDate, customer_id: customerId, website_id: websiteId,
  });
  const report = useResource<CalendarReport>(path);
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (report.loading || document.hidden || revision <= lastRevision.current) return;
    const timer = window.setTimeout(() => {
      lastRevision.current = revision;
      report.reload();
    }, 100);
    return () => window.clearTimeout(timer);
  }, [revision, report.loading]);

  const days = useMemo(() => new Map(report.data?.days.map(point => [point.date, point]) ?? []), [report.data]);
  const hours = useMemo(() => new Map(report.data?.hours.map(point => [point.hour, point]) ?? []), [report.data]);
  const today = todayInVietnam().format('YYYY-MM-DD');
  const leadingDays = (month.day() + 6) % 7;
  const weeks = Math.ceil((leadingDays + month.daysInMonth()) / 7);
  const dateValue = selectedDate ? dayjs(selectedDate) : month;
  const selectedCounts = selectedDate ? days.get(selectedDate) : undefined;

  function showMonth(value: dayjs.Dayjs) {
    setMonth(value.startOf('month'));
    setSelectedDate(undefined);
  }
  function showDay(value: dayjs.Dayjs) {
    setMonth(value.startOf('month'));
    setSelectedDate(value.format('YYYY-MM-DD'));
  }

  return <div className="overview-calendar">
    <PageHeading title="Lịch bài viết" description="Theo dõi lịch viết, bài đã hoàn tất và bài đã giao theo ngày, theo giờ." action={
      <Space wrap className="calendar-page-actions">
        <Button icon={<ArrowLeftOutlined />} onClick={onClose}>Về tổng quan</Button>
        <Button icon={<ReloadOutlined />} loading={report.loading} onClick={report.reload}>Làm mới</Button>
      </Space>
    } />
    <section className="panel calendar-panel" aria-label="Lịch hoạt động bài viết" aria-busy={report.loading}>
      <div className="calendar-toolbar">
        <div className="calendar-period-control">
          <Button icon={<LeftOutlined />} aria-label={selectedDate ? 'Ngày trước' : 'Tháng trước'} onClick={() => selectedDate ? showDay(dateValue.subtract(1, 'day')) : showMonth(month.subtract(1, 'month'))} />
          {selectedDate ? <DatePicker aria-label="Chọn ngày" allowClear={false} value={dateValue} format="DD/MM/YYYY" onChange={value => { if (value) showDay(value); }} />
            : <DatePicker aria-label="Chọn tháng" picker="month" allowClear={false} value={month} format="MM/YYYY" onChange={value => { if (value) showMonth(value); }} />}
          <Button icon={<RightOutlined />} aria-label={selectedDate ? 'Ngày sau' : 'Tháng sau'} onClick={() => selectedDate ? showDay(dateValue.add(1, 'day')) : showMonth(month.add(1, 'month'))} />
        </div>
        <Space wrap className="calendar-view-actions">
          {selectedDate && <Button icon={<CalendarOutlined />} onClick={() => setSelectedDate(undefined)}>Xem theo tháng</Button>}
          <Button type="text" onClick={() => showMonth(todayInVietnam())}>Tháng hiện tại</Button>
        </Space>
      </div>
      <div className="calendar-context"><span>{scopeLabel || 'Tất cả khách hàng và website'}</span><span>Giờ Việt Nam · UTC+7</span></div>
      <ResourceError error={report.error} onRetry={report.reload} />
      {!report.data && report.loading && <div className="calendar-loading" role="status" aria-label="Đang tải lịch bài viết"><Skeleton active paragraph={{ rows: 8 }} /></div>}
      {report.data && <>
        <div className="calendar-month-heading"><h2>Tháng {month.format('MM/YYYY')}</h2><span>Tổng số bài trong tháng</span></div>
        <dl className="calendar-totals">{measures.map(({ key, label }) => <div key={key} className={`calendar-total calendar-${key}`}>
          <dt><i aria-hidden="true" />{label}</dt><dd>{number.format(report.data!.totals[key])}</dd>
        </div>)}</dl>
        {selectedDate ? <section className="calendar-hour-view" aria-labelledby="calendar-day-heading">
          <div className="calendar-day-heading"><h3 id="calendar-day-heading">Ngày {dateValue.format('DD/MM/YYYY')}</h3><p>{selectedCounts ? `${number.format(selectedCounts.scheduled)} lên lịch · ${number.format(selectedCounts.written)} đã viết · ${number.format(selectedCounts.delivered)} đã giao` : 'Chưa có dữ liệu cho ngày này'}</p></div>
          <table className="calendar-hours" aria-label="Số bài viết theo giờ">
            <caption>Ngày {dateValue.format('DD/MM/YYYY')} · Giờ Việt Nam (UTC+7)</caption>
            <thead><tr><th scope="col">Giờ</th>{measures.map(({ key, label }) => <th key={key} scope="col" className={`calendar-${key}`}>{label}</th>)}</tr></thead>
            <tbody>{Array.from({ length: 24 }, (_, hour) => {
              const point = hours.get(hour);
              const active = point && measures.some(({ key }) => point[key] > 0);
              return <tr key={hour} data-hour={hour} className={active ? 'calendar-hour-active' : ''}>
                <th scope="row">{String(hour).padStart(2, '0')}:00<span>–{String(hour).padStart(2, '0')}:59</span></th>
                {measures.map(({ key }) => <td key={key} className={`calendar-${key}${point?.[key] ? ' calendar-count-active' : ''}`}>{point ? number.format(point[key]) : '—'}</td>)}
              </tr>;
            })}</tbody>
          </table>
        </section> : <>
          <p className="calendar-hint">Chọn một ngày để xem số bài theo từng giờ.</p>
          <table className="calendar-month" aria-label="Lịch bài viết theo tháng">
            <thead><tr>{weekdays.map((day, index) => <th key={day} scope="col"><abbr title={day}>{index === 6 ? 'CN' : `T${index + 2}`}</abbr></th>)}</tr></thead>
            <tbody>{Array.from({ length: weeks }, (_, week) => <tr key={week}>{Array.from({ length: 7 }, (_, weekday) => {
              const dateNumber = week * 7 + weekday - leadingDays + 1;
              if (dateNumber < 1 || dateNumber > month.daysInMonth()) return <td className="calendar-outside" key={weekday} aria-hidden="true" />;
              const date = month.date(dateNumber);
              const dateKey = date.format('YYYY-MM-DD');
              const point = days.get(dateKey);
              return <td key={weekday} className={weekday > 4 ? 'calendar-weekend' : undefined}>
                <button type="button" className={`calendar-day${dateKey === today ? ' calendar-today' : ''}`} data-date={dateKey}
                  aria-current={dateKey === today ? 'date' : undefined} disabled={!point}
                  aria-label={`Xem theo giờ ngày ${date.format('DD/MM/YYYY')}: ${point?.scheduled ?? '—'} lên lịch, ${point?.written ?? '—'} đã viết, ${point?.delivered ?? '—'} đã giao`}
                  onClick={() => showDay(date)}>
                  <time dateTime={dateKey}>{dateNumber}</time>
                  <span className="calendar-day-counts">{measures.map(({ key, label, short }) => <span key={key} className={`calendar-day-count calendar-${key}${point?.[key] ? ' calendar-count-active' : ''}`}>
                    <span className="calendar-count-label">{label}</span><span className="calendar-count-short" aria-hidden="true">{short}</span><b>{point ? number.format(point[key]) : '—'}</b>
                  </span>)}</span>
                </button>
              </td>;
            })}</tr>)}</tbody>
          </table>
        </>}
      </>}
      <div className="calendar-explanation">
        <p><span className="calendar-scheduled">L · Lên lịch</span> theo giờ hẹn, không gồm yêu cầu đã hủy.</p>
        <p><span className="calendar-written">V · Đã viết</span> theo giờ hoàn tất bài viết.</p>
        <p><span className="calendar-delivered">G · Đã giao</span> mỗi bài tính một lần trong ngày, theo giờ giao thành công đầu tiên.</p>
      </div>
    </section>
  </div>;
}
