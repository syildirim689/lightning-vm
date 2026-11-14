"use client";
// Shared building blocks on top of HeroUI v3, used by every page so forms, headers and confirmations
// look and behave the same everywhere.
import { Alert, AlertDialog, Button, Card, Checkbox, CheckboxGroup, Chip, Description, FieldError, Input, Label, ListBox, NumberField, Select,
  Switch, Table, TextArea, TextField, buttonVariants, toast } from '@heroui/react';
import NextLink from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readDraft, writeDraft } from '../lib/drafts';
import { type Format, inputProps, isValid, normalize, splitList } from '../lib/formats';
import { I } from './icon';

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode }) {
  return <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
    <div className="min-w-0">
      {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{eyebrow}</p>}
      <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
      {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
    </div>
    {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
  </header>;
}

type Variant = 'primary' | 'secondary' | 'tertiary' | 'outline' | 'ghost' | 'danger';
export function ButtonLink({ href, variant = 'primary', size = 'md', className = '', children }: { href: string; variant?: Variant; size?: 'sm' | 'md' | 'lg'; className?: string; children: React.ReactNode }) {
  return <NextLink href={href} className={`${buttonVariants({ variant, size })} ${className}`}>{children}</NextLink>;
}

export function Section({ title, description, actions, children, className = '' }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  // Titled sections are listed by SectionNav on long pages.
  return <Card className={`scroll-mt-28 ${className}`} data-section={typeof title === 'string' ? title : undefined}>
    {(title || actions) && <Card.Header className="flex flex-row flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {title && <Card.Title className="text-base font-semibold">{title}</Card.Title>}
        {description && <Card.Description className="text-sm text-muted">{description}</Card.Description>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </Card.Header>}
    <Card.Content>{children}</Card.Content>
  </Card>;
}

export function Stat({ label, value, hint, icon, tone = 'default', pressed, onPress }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode; tone?: 'default' | 'success' | 'warning' | 'danger' | 'accent';
  pressed?: boolean; onPress?: () => void }) {
  const toneClass = { default: 'text-foreground', success: 'text-success', warning: 'text-warning', danger: 'text-danger', accent: 'text-accent' }[tone];
  const iconClass = { default: 'bg-default text-muted', success: 'bg-success/10 text-success', warning: 'bg-warning/15 text-warning', danger: 'bg-danger/10 text-danger', accent: 'bg-accent-soft text-accent' }[tone];
  // onPress: the tile is a filter toggle (pressed = active).
  const press = onPress && { role: 'button', tabIndex: 0, 'aria-pressed': !!pressed, onClick: onPress,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress(); } } };
  return <Card {...press} className={`rise transition-shadow duration-200 hover:shadow-lg ${onPress ? 'cursor-pointer outline-offset-2' : ''} ${pressed ? 'ring-2 ring-accent' : ''}`}>
    <Card.Content className="flex flex-row items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
        <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
        {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      </div>
      {icon && <span aria-hidden className={`shrink-0 rounded-lg p-2 ${iconClass}`}>{icon}</span>}
    </Card.Content>
  </Card>;
}

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-10 text-center">
    {icon && <span aria-hidden className="text-muted">{icon}</span>}
    <p className="font-medium">{title}</p>
    {children && <div className="max-w-md text-sm text-muted">{children}</div>}
  </div>;
}

export type Tone = 'default' | 'accent' | 'success' | 'warning' | 'danger';
export function StatusChip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <Chip size="sm" variant="soft" color={tone}>{children}</Chip>;
}

// Browsers and password managers never fill or remember a field unless it is part of signing in (autofill).
// Password-type fields are shown as masked text where the browser can mask text, so password managers do not
// treat them as passwords at all; elsewhere they stay password fields with autocomplete off.
export const noAutofill = { autoComplete: 'off', 'data-1p-ignore': 'true', 'data-lpignore': 'true', 'data-bwignore': 'true', 'data-form-type': 'other' } as const;
const masksText = () => typeof CSS !== 'undefined' && CSS.supports('-webkit-text-security', 'disc');

// Text field with a visible label, help text, and a translated server-side error under it.
// `format` gives a typed value its keyboard, an example, tidying when the field is left (MAC spellings, spaces,
// upper case) and a message as soon as it is wrong; `list` accepts several values separated by commas or lines.
export function TextInput({ label, value, onChange, error, help, type = 'text', name, isRequired, autoComplete, autofill, placeholder, multiline, isDisabled, maxLength, className, spellCheck, format, list, datePresets, unit, transient, revealable, draft }: {
  label: string; value: string; onChange: (v: string) => void; error?: string; help?: React.ReactNode; type?: string; name?: string; isRequired?: boolean;
  autoComplete?: string; autofill?: boolean; placeholder?: string; multiline?: boolean; isDisabled?: boolean; maxLength?: number; className?: string; spellCheck?: boolean;
  format?: Format; list?: boolean; datePresets?: boolean; unit?: string;
  transient?: boolean; // a filter or a typed confirmation: leaving it is not losing work
  revealable?: boolean; // a secret with a Show button
  draft?: string; // kept in this browser under this key until it is sent (the parent empties the value then)
}) {
  const tf = useTranslations('Formats');
  const fd = useFormatter();
  // Masked text from the first paint: a password field that exists even for a moment is filled by the browser
  // (and the field before it taken for a user name). Only a browser that cannot mask text gets a password field.
  const [masked, setMasked] = useState(!autofill && type === 'password');
  const [left, setLeft] = useState(false);
  const [revealed, setRevealed] = useState(false);
  // A draft comes back when the field is shown empty again; every change is kept, and an empty value forgets it.
  const [restored, setRestored] = useState(false);
  // A long text in a form with a send button: Ctrl/⌘+Enter sends it (components/shortcuts.tsx), said while typing.
  const [sendable, setSendable] = useState(false);
  const loaded = useRef(false);
  useEffect(() => { if (!draft) return; const kept = readDraft(draft); if (kept && !value) { onChange(kept); setRestored(true); } }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!draft) return; if (!loaded.current) { loaded.current = true; return; } writeDraft(draft, value); if (!value) setRestored(false); }, [draft, value]);
  useEffect(() => { setMasked(!autofill && type === 'password' && masksText()); }, [autofill, type]);
  const hidden = masked && !revealed;
  const fill = autofill ? { autoComplete, 'data-autofill': 'true' } : noAutofill;
  const fmt = format ? inputProps[format] : undefined;
  const items = format ? (list ? splitList(value) : value.trim() ? [value.trim()] : []) : [];
  const bad = format ? items.find((x) => !isValid(format, normalize(format, x))) : undefined;
  // Wrong values are named once the field has been left (or at once when fixing one), never while first typing.
  const own = bad !== undefined && (left || !!error) ? tf(list ? 'invalidItem' : 'invalid', { kind: tf(`kind.${format}` as 'kind.ip'), value: bad, example: fmt!.example }) : undefined;
  const shown = error ?? own;
  const tidy = () => {
    setLeft(true);
    if (!format) return;
    const next = list ? splitList(value).map((x) => normalize(format, x)).join(multiline ? '\n' : ', ') : normalize(format, value);
    if (next !== value) onChange(next);
  };
  const extra = fmt ? { inputMode: fmt.inputMode, autoCapitalize: 'none', autoCorrect: 'off', spellCheck: false } : {};
  const ph = placeholder ?? (fmt ? tf('example', { example: fmt.example }) : undefined);
  // Dates and times read back in full ("Thursday, 20 November 2026 · in 7 days"), so a typo in the day shows at once.
  const when = readableDate(type, value, fd, tf);
  const presets = datePresets && type === 'date' && !isDisabled ? datePresetValues() : null;
  // Room left, shown as the limit nears (long texts from half way), so text is never cut off unseen; the API takes no more.
  const count = !!maxLength && !isDisabled && !hidden && type !== 'password' && value.length >= maxLength * (multiline ? 0.5 : 0.8);
  const full = !!maxLength && value.length >= maxLength;
  return <TextField className={`min-w-0 ${className ?? ''}`} name={autofill ? name : undefined} type={masked || revealed ? 'text' : type} value={value} onChange={onChange} isInvalid={!!shown} isRequired={isRequired} isDisabled={isDisabled} validationBehavior="aria"
    onFocus={(e) => setSendable(!!multiline && !!(e.target as Element as HTMLTextAreaElement).form?.querySelector('button[type="submit"]'))}
    onBlur={() => { setSendable(false); tidy(); }} data-transient={transient || !!draft || undefined}>
    <Label>{label}{unit && <span className="sr-only"> ({unit})</span>}</Label>
    {multiline ? <TextArea rows={4} placeholder={ph} maxLength={maxLength} spellCheck={spellCheck} {...fill} {...extra} className={fmt?.mono ? 'font-mono text-sm' : undefined}/>
      : unit ? <div className="relative"><Input placeholder={ph} maxLength={maxLength} spellCheck={false} {...fill} {...extra} className={`w-full min-w-0 pr-14 tabular-nums ${fmt?.mono ? 'font-mono' : ''}`}/>
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted">{unit}</span></div>
      : revealable && type === 'password' ? <div className="relative"><Input placeholder={ph} maxLength={maxLength} spellCheck={false} {...fill} {...extra} className="w-full min-w-0 pr-20 font-mono" style={hidden ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : undefined}/>
        <button type="button" onClick={() => setRevealed((v) => !v)} aria-pressed={revealed} disabled={isDisabled} aria-label={tf(revealed ? 'hide' : 'show')}
          className="absolute inset-y-0 right-1 my-auto grid h-8 min-w-8 place-items-center rounded-lg px-2 text-xs font-medium text-muted hover:bg-default hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50">
          <span aria-hidden className="flex items-center gap-1"><I name={revealed ? 'eye-off' : 'eye'} size={16}/><span className="hidden sm:inline">{tf(revealed ? 'hide' : 'show')}</span></span></button></div>
      : <Input placeholder={ph} maxLength={maxLength} spellCheck={masked ? false : spellCheck} {...fill} {...extra} className={fmt?.mono ? 'min-w-0 font-mono' : 'min-w-0'} style={masked ? { WebkitTextSecurity: 'disc' } as React.CSSProperties : undefined}/>}
    {shown ? <FieldError>{shown}</FieldError> : when || help ? <Description>{when && <span className="block font-medium text-foreground/80">{when}</span>}{help}</Description> : null}
    {count && <p className={`mt-0.5 text-right text-xs tabular-nums ${full ? 'font-medium text-warning' : 'text-muted'}`} aria-live={full ? 'polite' : 'off'}>
      {full ? tf('atLimit', { max: maxLength! }) : tf('count', { n: value.length, max: maxLength! })}</p>}
    {sendable && value.trim() && <p className="mt-0.5 text-xs text-muted">{tf('sendHint', { keys: sendKeys() })}</p>}
    {draft && value.trim() && !isDisabled && <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
      <span className="inline-flex items-center gap-1"><I name="save" size={12}/>{tf(restored ? 'draftRestored' : 'draftKept')}</span>
      <button type="button" onClick={() => { onChange(''); setRestored(false); }} className="rounded px-1 font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent">{tf('draftDiscard')}</button></p>}
    {presets && <div role="group" aria-label={tf('quick')} className="mt-1 flex flex-wrap gap-1.5">{presets.map(([k, d]) =>
      <button key={k} type="button" aria-pressed={value === d} onClick={() => onChange(d)}
        className={`min-h-8 rounded-full border px-2.5 text-xs transition-colors ${value === d ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>{tf(`preset.${k}` as 'preset.today')}</button>)}</div>}
  </TextField>;
}

const sendKeys = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '\u2318 Enter' : 'Ctrl+Enter';

// "YYYY-MM-DD" for a local date.
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function datePresetValues(): [string, string][] {
  const now = new Date(), add = (n: number) => { const d = new Date(now); d.setDate(d.getDate() + n); return ymd(d); };
  return [['today', ymd(now)], ['week', add(7)], ['month', add(30)], ['monthEnd', ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0))], ['year', add(365)]];
}
function readableDate(type: string, value: string, f: ReturnType<typeof useFormatter>, t: ReturnType<typeof useTranslations<'Formats'>>): string | null {
  if (!value) return null;
  if (type !== 'date' && type !== 'datetime-local') return null;
  const d = type === 'date' ? new Date(`${value}T00:00:00`) : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const full = type === 'date' ? f.dateTime(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : f.dateTime(d, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - today.getTime()) / 86_400_000);
  const rel = days === 0 ? t('today') : type === 'date' ? f.relativeTime(new Date(`${value}T12:00:00`), { now: new Date(new Date().setHours(12, 0, 0, 0)), unit: 'day' }) : f.relativeTime(d);
  return `${full} · ${rel}`;
}

export function NumberInput({ label, value, onChange, error, help, minValue, maxValue, step, className, formatOptions, isDisabled }: {
  label: string; value: number | undefined; onChange: (v: number | undefined) => void; error?: string; help?: React.ReactNode; minValue?: number; maxValue?: number; step?: number; className?: string;
  formatOptions?: Intl.NumberFormatOptions; isDisabled?: boolean;
}) {
  return <NumberField className={className} isDisabled={isDisabled} value={value ?? NaN} onChange={(v) => onChange(Number.isNaN(v) ? undefined : v)} minValue={minValue} maxValue={maxValue} step={step}
    isInvalid={!!error} validationBehavior="aria" formatOptions={formatOptions ?? { useGrouping: false, maximumFractionDigits: 2 }}>
    <Label>{label}</Label>
    <NumberField.Group>
      <NumberField.DecrementButton/>
      <NumberField.Input/>
      <NumberField.IncrementButton/>
    </NumberField.Group>
    {error ? <FieldError>{error}</FieldError> : help ? <Description>{help}</Description> : null}
  </NumberField>;
}

export type Option = { id: string; label: string; description?: string; isDisabled?: boolean };
export function SelectInput({ label, value, onChange, options, error, help, placeholder, className, isDisabled }: {
  label: string; value: string; onChange: (v: string) => void; options: Option[]; error?: string; help?: React.ReactNode; placeholder?: string; className?: string; isDisabled?: boolean;
}) {
  // '' is a real choice when an option has that id (e.g. "All"); otherwise it means nothing selected.
  return <Select className={className} value={options.some((o) => o.id === value) ? value : null} onChange={(k) => onChange(k == null ? '' : String(k))} placeholder={placeholder ?? '–'}
    isInvalid={!!error} isDisabled={isDisabled} disabledKeys={options.filter((o) => o.isDisabled).map((o) => o.id)}>
    <Label>{label}</Label>
    <Select.Trigger><Select.Value/><Select.Indicator/></Select.Trigger>
    {error ? <FieldError>{error}</FieldError> : help ? <Description>{help}</Description> : null}
    <Select.Popover>
      <ListBox>
        {options.map((o) => <ListBox.Item key={o.id} id={o.id} textValue={o.label}>
          <div className="flex flex-col"><span>{o.label}</span>{o.description && <span className="text-xs text-muted">{o.description}</span>}</div>
          <ListBox.ItemIndicator/>
        </ListBox.Item>)}
      </ListBox>
    </Select.Popover>
  </Select>;
}

// Currencies by code and name in the person's language; a stored code not in the list stays selectable.
export function CurrencyInput({ label, value, onChange, error, codes = ['TRY', 'EUR', 'USD', 'GBP'] }: { label: string; value: string; onChange: (v: string) => void; error?: string; codes?: string[] }) {
  const locale = useLocale();
  const names = useMemo(() => { try { return new Intl.DisplayNames([locale], { type: 'currency' }); } catch { return null; } }, [locale]);
  const all = value && !codes.includes(value) ? [...codes, value] : codes;
  return <SelectInput label={label} value={value} onChange={onChange} error={error} options={all.map((c) => ({ id: c, label: `${c} · ${names?.of(c) ?? c}` }))}/>;
}

export function CheckboxInput({ label, isSelected, onChange, help, isDisabled }: { label: React.ReactNode; isSelected: boolean; onChange: (v: boolean) => void; help?: React.ReactNode; isDisabled?: boolean }) {
  return <Checkbox isSelected={isSelected} onChange={onChange} isDisabled={isDisabled}>
    <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{label}</Checkbox.Content>
    {help && <Description>{help}</Description>}
  </Checkbox>;
}

export function CheckboxList({ label, value, onChange, options, error, help }: { label: string; value: string[]; onChange: (v: string[]) => void; options: Option[]; error?: string; help?: React.ReactNode }) {
  return <CheckboxGroup value={value} onChange={onChange} isInvalid={!!error}>
    <Label>{label}</Label>
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {options.map((o) => <Checkbox key={o.id} value={o.id} isDisabled={o.isDisabled}>
        <Checkbox.Content><Checkbox.Control><Checkbox.Indicator/></Checkbox.Control>{o.label}</Checkbox.Content>
      </Checkbox>)}
    </div>
    {error ? <FieldError>{error}</FieldError> : help ? <Description>{help}</Description> : null}
  </CheckboxGroup>;
}

export function SwitchInput({ label, isSelected, onChange, isDisabled }: { label: React.ReactNode; isSelected: boolean; onChange: (v: boolean) => void; isDisabled?: boolean }) {
  return <Switch isSelected={isSelected} onChange={onChange} isDisabled={isDisabled}>
    <Switch.Content><Switch.Control><Switch.Thumb/></Switch.Control>{label}</Switch.Content>
  </Switch>;
}

// A destructive action behind an explicit confirmation dialog.
export function ConfirmButton({ label, title, body, confirmLabel, cancelLabel, onConfirm, variant = 'danger', size = 'md', isDisabled, icon }: {
  label: React.ReactNode; title: string; body: React.ReactNode; confirmLabel: string; cancelLabel: string; onConfirm: () => void | Promise<void>;
  variant?: Variant | 'danger-soft'; size?: 'sm' | 'md'; isDisabled?: boolean; icon?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  return <AlertDialog>
    <Button variant={variant} size={size} isDisabled={isDisabled}>{icon}{label}</Button>
    <AlertDialog.Backdrop>
      <AlertDialog.Container>
        <AlertDialog.Dialog className="sm:max-w-[440px]">
          {({ close }) => <>
            <AlertDialog.Header><AlertDialog.Icon status="danger"/><AlertDialog.Heading>{title}</AlertDialog.Heading></AlertDialog.Header>
            <AlertDialog.Body><div className="text-sm text-muted">{body}</div></AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">{cancelLabel}</Button>
              <Button variant="danger" isPending={busy} onPress={async () => { setBusy(true); try { await onConfirm(); close(); } finally { setBusy(false); } }}>{confirmLabel}</Button>
            </AlertDialog.Footer>
          </>}
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  </AlertDialog>;
}

// The same confirmation opened from elsewhere (a menu item): the caller holds whether it is open.
export function ConfirmDialog({ isOpen, onClose, title, body, confirmLabel, cancelLabel, onConfirm, status = 'danger' }: {
  isOpen: boolean; onClose: () => void; title: string; body: React.ReactNode; confirmLabel: string; cancelLabel: string; onConfirm: () => void | Promise<void>;
  status?: 'danger' | 'warning';
}) {
  const [busy, setBusy] = useState(false);
  return <AlertDialog.Backdrop isOpen={isOpen} onOpenChange={(o) => { if (!o) onClose(); }}>
    <AlertDialog.Container>
      <AlertDialog.Dialog className="sm:max-w-[440px]">
        <AlertDialog.Header><AlertDialog.Icon status={status}/><AlertDialog.Heading>{title}</AlertDialog.Heading></AlertDialog.Header>
        <AlertDialog.Body><div className="text-sm text-muted">{body}</div></AlertDialog.Body>
        <AlertDialog.Footer>
          <Button variant="tertiary" onPress={onClose}>{cancelLabel}</Button>
          <Button variant={status === 'danger' ? 'danger' : 'primary'} isPending={busy}
            onPress={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>{confirmLabel}</Button>
        </AlertDialog.Footer>
      </AlertDialog.Dialog>
    </AlertDialog.Container>
  </AlertDialog.Backdrop>;
}

// Monospace value (IPs, fingerprints, ids).
export function Mono({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-default px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>;
}

// One table look everywhere: rows are arrays of cells in column order; the first column is the row header.
// Columns named in `sortBy` can be sorted by clicking their header (or the select on phones); long lists are split
// into pages of `pageSize` rows. The page goes back to the first one when the rows or the order change.
export type Column = { id: string; label: React.ReactNode; className?: string };
type SortValue = string | number | null | undefined;
export function DataTable<T>({ label, columns, rows, rowKey, cells, empty, minWidth = 640, sortBy, pageSize = 50 }: {
  label: string; columns: Column[]; rows: T[]; rowKey: (row: T) => string; cells: (row: T) => React.ReactNode[]; empty?: React.ReactNode; minWidth?: number;
  sortBy?: Record<string, (row: T) => SortValue>; pageSize?: number;
}) {
  const t = useTranslations('Table');
  const locale = useLocale();
  const [sort, setSort] = useState<{ column: string; direction: 'ascending' | 'descending' } | null>(null);
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => {
    const get = sort && sortBy?.[sort.column];
    if (!sort || !get) return rows;
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
    const sign = sort.direction === 'ascending' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a), y = get(b);
      // Empty values always go last, whichever way the column is sorted.
      if (x == null || x === '') return y == null || y === '' ? 0 : 1;
      if (y == null || y === '') return -1;
      return sign * (typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y)));
    });
  }, [rows, sort, sortBy, locale]);
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(() => { setPage(0); }, [rows.length, sort]);
  const current = Math.min(page, pages - 1);
  const shown = pages > 1 ? sorted.slice(current * pageSize, (current + 1) * pageSize) : sorted;
  const sortable = columns.filter((c) => sortBy?.[c.id]);
  const lastIsAction = columns.at(-1)?.id === 'act';

  // Phones get one card per row (label: value); wider screens the table.
  const cards = <div className="flex flex-col gap-2 sm:hidden">
    {sortable.length > 0 && rows.length > 1 && <label className="flex items-center justify-end gap-2 text-xs text-muted">
      {t('sortBy')}
      <select className="rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-foreground" value={sort ? `${sort.column}:${sort.direction}` : ''}
        onChange={(e) => { const [column, direction] = e.target.value.split(':'); setSort(column ? { column, direction: direction as 'ascending' | 'descending' } : null); }}>
        <option value="">{t('defaultOrder')}</option>
        {sortable.flatMap((c) => (['ascending', 'descending'] as const).map((d) => <option key={`${c.id}:${d}`} value={`${c.id}:${d}`}>
          {typeof c.label === 'string' ? c.label : c.id} {d === 'ascending' ? '↑' : '↓'}</option>))}
      </select>
    </label>}
    <ul className="flex flex-col gap-2" aria-label={label}>
      {rows.length === 0 && <li className="rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted">{empty ?? '–'}</li>}
      {shown.map((r) => { const c = cells(r); return <li key={rowKey(r)} className="rounded-xl border border-border bg-surface p-3">
        <div className="mb-2 flex items-start justify-between gap-2 font-medium">{c[0]}{lastIsAction && <span className="shrink-0">{c.at(-1)}</span>}</div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
          {c.slice(1, lastIsAction ? -1 : undefined).map((cell, i) => <div key={columns[i + 1]?.id ?? i} className="contents">
            <dt className="text-xs text-muted">{columns[i + 1]?.label}</dt><dd className="min-w-0 break-words">{cell}</dd>
          </div>)}
        </dl>
      </li>; })}
    </ul>
  </div>;
  const pager = pages > 1 && <nav className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm" aria-label={t('pages', { label })}>
    <span className="text-muted" aria-live="polite">{t('range', { from: current * pageSize + 1, to: Math.min((current + 1) * pageSize, sorted.length), total: sorted.length })}</span>
    <div className="flex items-center gap-1">
      <Button size="sm" variant="tertiary" isDisabled={current === 0} onPress={() => setPage(current - 1)}>{t('previous')}</Button>
      <span className="px-2 tabular-nums text-muted">{t('page', { page: current + 1, pages })}</span>
      <Button size="sm" variant="tertiary" isDisabled={current >= pages - 1} onPress={() => setPage(current + 1)}>{t('next')}</Button>
    </div>
  </nav>;
  return <>{cards}<Table className="hidden sm:block">
    <Table.ScrollContainer>
      <Table.Content aria-label={label} style={{ minWidth }} sortDescriptor={sort ?? undefined}
        onSortChange={(d) => setSort({ column: String(d.column), direction: d.direction })}>
        <Table.Header>
          {columns.map((c, i) => sortBy?.[c.id]
            ? <Table.Column key={c.id} id={c.id} isRowHeader={i === 0} className={c.className} allowsSorting>
                {({ sortDirection }) => <Table.SortableColumnHeader sortDirection={sortDirection}>{c.label}</Table.SortableColumnHeader>}
              </Table.Column>
            : <Table.Column key={c.id} id={c.id} isRowHeader={i === 0} className={c.className}>{c.label}</Table.Column>)}
        </Table.Header>
        <Table.Body renderEmptyState={() => <div className="py-6 text-center text-sm text-muted">{empty ?? '–'}</div>}>
          {shown.map((r) => <Table.Row key={rowKey(r)} id={rowKey(r)}>
            {cells(r).map((cell, i) => <Table.Cell key={columns[i]?.id ?? i}>{cell}</Table.Cell>)}
          </Table.Row>)}
        </Table.Body>
      </Table.Content>
    </Table.ScrollContainer>
  </Table>{pager}</>;
}

export function Notice({ tone = 'default', title, children }: { tone?: Tone; title?: React.ReactNode; children?: React.ReactNode }) {
  return <Alert status={tone}>
    <Alert.Indicator/>
    <Alert.Content>
      {title && <Alert.Title>{title}</Alert.Title>}
      {children && <Alert.Description>{children}</Alert.Description>}
    </Alert.Content>
  </Alert>;
}

// A form block with its explanation beside it (stacked on phones): what the fields are for, then the fields.
export function FormSection({ title, description, icon, children, aside }: { title: React.ReactNode; description?: React.ReactNode; icon?: React.ReactNode; children: React.ReactNode; aside?: React.ReactNode }) {
  return <section className="grid gap-x-8 gap-y-4 border-b border-separator py-6 first:pt-0 last:border-0 last:pb-0 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
    <div className="flex flex-col gap-1">
      <h3 className="flex items-center gap-2 font-semibold">{icon && <span aria-hidden className="text-accent">{icon}</span>}{title}</h3>
      {description && <p className="text-sm text-muted">{description}</p>}
      {aside}
    </div>
    <div className="flex min-w-0 flex-col gap-4">{children}</div>
  </section>;
}

// Related fields inside a dialog: a small heading and a responsive grid.
export function FieldGroup({ title, description, children, cols = 2 }: { title: string; description?: string; children: React.ReactNode; cols?: 1 | 2 | 3 }) {
  const grid = { 1: '', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3' }[cols];
  return <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4">
    <legend className="px-1 text-sm font-semibold">{title}</legend>
    {description && <p className="-mt-1 text-xs text-muted">{description}</p>}
    <div className={`grid gap-4 ${grid}`}>{children}</div>
  </fieldset>;
}

// Save bar under a form: the status of the last action on the left, buttons on the right.
export function FormActions({ children, status }: { children: React.ReactNode; status?: React.ReactNode }) {
  return <div className="flex flex-wrap items-center justify-end gap-2 border-t border-separator pt-4">
    {status && <div className="mr-auto min-w-0 text-sm" role="status">{status}</div>}
    {children}
  </div>;
}

// A success toast that, when `from` is given, offers to go back to it (for settings saved as soon as they change).
export function undoToast(text: string, from: string | undefined, undoLabel: string, undo: (from: string) => void) {
  toast.success(text, from === undefined ? undefined : { actionProps: { children: undoLabel, size: 'sm', variant: 'secondary', onPress: () => undo(from) } });
}
