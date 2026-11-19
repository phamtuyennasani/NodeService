import type { AriaAttributes } from 'react';
import { DatePicker, Grid, Input } from 'antd';
import dayjs from 'dayjs';

interface DateTimeFieldProps extends AriaAttributes {
  id?: string;
  value?: dayjs.Dayjs | null;
  onChange?: (value: dayjs.Dayjs | null) => void;
  seconds?: boolean;
}

export function DateTimeField({ value, onChange, seconds, ...attributes }: DateTimeFieldProps) {
  const screens = Grid.useBreakpoint();
  if (screens.sm) {
    return <DatePicker {...attributes} showTime value={value} onChange={onChange}
      format={seconds ? 'DD/MM/YYYY HH:mm:ss' : 'DD/MM/YYYY HH:mm'} />;
  }
  return <Input {...attributes} type="datetime-local" step={seconds ? 1 : 60}
    value={value?.format(seconds ? 'YYYY-MM-DDTHH:mm:ss' : 'YYYY-MM-DDTHH:mm') ?? ''}
    onChange={event => onChange?.(event.target.value ? dayjs(event.target.value) : null)} />;
}
