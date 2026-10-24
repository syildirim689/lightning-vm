"use client";
// Shared building blocks on top of HeroUI v3, used by every page so forms, headers and confirmations
// look and behave the same everywhere.
import { Alert, AlertDialog, Button, Card, Checkbox, CheckboxGroup, Chip, Description, FieldError, Input, Label, ListBox, NumberField, Select,
  Switch, Table, TextArea, TextField, buttonVariants } from '@heroui/react';
import NextLink from 'next/link';
import { useState } from 'react';

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
  return <Card className={className}>
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

export function Stat({ label, value, hint, icon, tone = 'default' }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon?: React.ReactNode; tone?: 'default' | 'success' | 'warning' | 'danger' | 'accent' }) {
  const toneClass = { default: 'text-foreground', success: 'text-success', warning: 'text-warning', danger: 'text-danger', accent: 'text-accent' }[tone];
  return <Card>
    <Card.Content className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wider text-muted">{label}</p>
        <p className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
        {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
      </div>
      {icon && <span aria-hidden className="rounded-lg bg-default p-2 text-muted">{icon}</span>}
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

// Text field with a visible label, help text, and a translated server-side error under it.
export function TextInput({ label, value, onChange, error, help, type = 'text', name, isRequired, autoComplete, placeholder, multiline, isDisabled, maxLength, className, spellCheck }: {
  label: string; value: string; onChange: (v: string) => void; error?: string; help?: React.ReactNode; type?: string; name?: string; isRequired?: boolean;
  autoComplete?: string; placeholder?: string; multiline?: boolean; isDisabled?: boolean; maxLength?: number; className?: string; spellCheck?: boolean;
}) {
  return <TextField className={className} name={name} type={type} value={value} onChange={onChange} isInvalid={!!error} isRequired={isRequired} isDisabled={isDisabled} validationBehavior="aria">
    <Label>{label}</Label>
    {multiline ? <TextArea rows={4} placeholder={placeholder} spellCheck={spellCheck}/> : <Input placeholder={placeholder} autoComplete={autoComplete} maxLength={maxLength} spellCheck={spellCheck}/>}
    {error ? <FieldError>{error}</FieldError> : help ? <Description>{help}</Description> : null}
  </TextField>;
}

export function NumberInput({ label, value, onChange, error, help, minValue, maxValue, step, className, formatOptions }: {
  label: string; value: number | undefined; onChange: (v: number | undefined) => void; error?: string; help?: React.ReactNode; minValue?: number; maxValue?: number; step?: number; className?: string;
  formatOptions?: Intl.NumberFormatOptions;
}) {
  return <NumberField className={className} value={value ?? NaN} onChange={(v) => onChange(Number.isNaN(v) ? undefined : v)} minValue={minValue} maxValue={maxValue} step={step}
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
  return <Select className={className} value={value || null} onChange={(k) => onChange(k == null ? '' : String(k))} placeholder={placeholder ?? '–'}
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

// Monospace value (IPs, fingerprints, ids).
export function Mono({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-default px-1.5 py-0.5 font-mono text-[0.85em]">{children}</code>;
}

// One table look everywhere: rows are arrays of cells in column order; the first column is the row header.
export type Column = { id: string; label: React.ReactNode; className?: string };
export function DataTable<T>({ label, columns, rows, rowKey, cells, empty, minWidth = 640 }: {
  label: string; columns: Column[]; rows: T[]; rowKey: (row: T) => string; cells: (row: T) => React.ReactNode[]; empty?: React.ReactNode; minWidth?: number;
}) {
  return <Table>
    <Table.ScrollContainer>
      <Table.Content aria-label={label} style={{ minWidth }}>
        <Table.Header>
          {columns.map((c, i) => <Table.Column key={c.id} id={c.id} isRowHeader={i === 0} className={c.className}>{c.label}</Table.Column>)}
        </Table.Header>
        <Table.Body renderEmptyState={() => <div className="py-6 text-center text-sm text-muted">{empty ?? '–'}</div>}>
          {rows.map((r) => <Table.Row key={rowKey(r)} id={rowKey(r)}>
            {cells(r).map((cell, i) => <Table.Cell key={columns[i]?.id ?? i}>{cell}</Table.Cell>)}
          </Table.Row>)}
        </Table.Body>
      </Table.Content>
    </Table.ScrollContainer>
  </Table>;
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
