"use client";
// A searchable list of every time zone the browser knows, each with its current UTC offset ("Europe/Istanbul ·
// UTC+03:00"). With autoLabel, the first entry ('' ) means "my browser's zone".
import { ComboBox, Description, Input, Label, ListBox } from '@heroui/react';
import { matches } from '../lib/search';
import { useMemo } from 'react';

function offset(zone: string, at: Date) {
  try {
    const name = new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
    return name === 'GMT' ? 'UTC' : name.replace('GMT', 'UTC');
  } catch { return ''; }
}

export const browserTimeZone = () => (typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC');

export default function TimeZonePicker({ label, value, onChange, help, autoLabel, error, isDisabled }: { label: string; value: string; onChange: (v: string) => void; help?: React.ReactNode;
  autoLabel?: string; error?: string; isDisabled?: boolean }) {
  const zones = useMemo(() => {
    const now = new Date();
    const list = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
    const all = [...new Set(['UTC', ...list])];
    return [...(autoLabel ? [{ id: '', label: `${autoLabel} · ${browserTimeZone()} (${offset(browserTimeZone(), now)})` }] : []),
      ...all.map((z) => ({ id: z, label: `${z.replace(/_/g, ' ')} · ${offset(z, now)}` }))];
  }, [autoLabel]);
  return <ComboBox className="w-full" selectedKey={value} onSelectionChange={(k) => { if (k != null) onChange(String(k)); }} isDisabled={isDisabled} isInvalid={!!error}
    defaultItems={zones} menuTrigger="focus" defaultFilter={matches}>
    <Label>{label}</Label>
    <ComboBox.InputGroup><Input/><ComboBox.Trigger/></ComboBox.InputGroup>
    {error ? <Description className="text-danger">{error}</Description> : help ? <Description>{help}</Description> : null}
    <ComboBox.Popover>
      <ListBox>{(z: { id: string; label: string }) => <ListBox.Item id={z.id} textValue={z.label}>{z.label}<ListBox.ItemIndicator/></ListBox.Item>}</ListBox>
    </ComboBox.Popover>
  </ComboBox>;
}
