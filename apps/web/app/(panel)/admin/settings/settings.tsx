"use client";
// Panel settings: general, branding, e-mail (SMTP), bot protection (captcha), SMS, payment methods and notification policy.
// Secrets are write-only: the API says whether one is stored, never what it is. Every integration has a test.
import { Button, Card, Chip, Tabs, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useState } from 'react';
import { useCaptcha } from '../../../../components/captcha';
import { I } from '../../../../components/icon';
import { GuideButton } from '../../../../components/setup-guide';
import { CheckboxInput, FormActions, FormSection, Notice, NumberInput, PageHeader, SelectInput, StatusChip, SwitchInput, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useMe } from '../../../../lib/me';
import { can } from '../../../../lib/permissions';
import { useApiQuery } from '../../../../lib/query';
import NotificationPolicy from './notification-policy';
import Payments from './payments';
import ReverseDns from './rdns';
import Domain from './domain';
import Security from './security';
import AnnouncementSettings from './announcement';
import ServerSettings from './servers';
import ChatSettings from './chat';
import DirectorySettings from './directory';
import SsoSettings from './sso';
import SignInMethods from './sign-in-methods';
import Incidents from './incidents';
import SupportDepartments from './support-departments';
import GeneralSettings from './general';
import BillingSettings from './billing';

const tabs = ['general', 'branding', 'domain', 'security', 'signin', 'directory', 'servers', 'mail', 'captcha', 'sms', 'chat', 'payments', 'billing', 'rdns', 'notifications', 'announcement', 'status', 'support'] as const;

export default function Settings() {
  const t = useTranslations('Settings');
  const [tab, setTab] = useQueryState('tab', parseAsString.withDefault('general'));
  const me = useMe();
  const readOnly = !can(me?.permissions, 'settings.manage');
  const icon = { general: <I name="settings-2" size={16}/>, branding: <I name="palette" size={16}/>, domain: <I name="globe-lock" size={16}/>, security: <I name="shield-check" size={16}/>, signin: <I name="log-in" size={16}/>, directory: <I name="network" size={16}/>, servers: <I name="server-cog" size={16}/>, mail: <I name="mail" size={16}/>, captcha: <I name="bot" size={16}/>,
    sms: <I name="message-square" size={16}/>, chat: <I name="messages-square" size={16}/>, payments: <I name="credit-card" size={16}/>, billing: <I name="receipt" size={16}/>, rdns: <I name="globe" size={16}/>, notifications: <I name="bell" size={16}/>, announcement: <I name="megaphone" size={16}/>, status: <I name="activity" size={16}/>, support: <I name="life-buoy" size={16}/> };
  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}/>
    {readOnly && <div className="mb-4"><Notice tone="default">{t('readOnly')}</Notice></div>}
    <Tabs selectedKey={tabs.includes(tab as 'general') ? tab : 'general'} onSelectionChange={(k) => setTab(String(k))}>
      <Tabs.ListContainer className="overflow-x-auto">
        <Tabs.List aria-label={t('title')}>{tabs.map((k) => <Tabs.Tab key={k} id={k} className="gap-2 whitespace-nowrap">{icon[k]}{t(`tabs.${k}`)}<Tabs.Indicator/></Tabs.Tab>)}</Tabs.List>
      </Tabs.ListContainer>
      <Tabs.Panel id="general" className="pt-5"><GeneralSettings onOpen={(k) => setTab(k)}/></Tabs.Panel>
      <Tabs.Panel id="branding" className="pt-5"><Branding readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="domain" className="pt-5"><Domain readOnly={readOnly || !can(me?.permissions, 'system.update')}/></Tabs.Panel>
      <Tabs.Panel id="servers" className="pt-5"><ServerSettings readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="security" className="pt-5"><Security readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="signin" className="pt-5"><SignInMethods readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="directory" className="flex flex-col gap-5 pt-5"><DirectorySettings readOnly={readOnly}/><SsoSettings readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="mail" className="pt-5"><Mail readOnly={readOnly} myEmail={me?.email ?? ''}/></Tabs.Panel>
      <Tabs.Panel id="captcha" className="pt-5"><Captcha readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="sms" className="pt-5"><Sms readOnly={readOnly} myPhone={me?.phoneNumber ?? ''}/></Tabs.Panel>
      <Tabs.Panel id="chat" className="pt-5"><ChatSettings readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="payments" className="pt-5"><Payments readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="billing" className="pt-5"><BillingSettings readOnly={!can(me?.permissions, 'billing.manage')}/></Tabs.Panel>
      <Tabs.Panel id="rdns" className="pt-5"><ReverseDns readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="notifications" className="pt-5"><NotificationPolicy readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="announcement" className="pt-5"><AnnouncementSettings readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="status" className="pt-5"><Incidents readOnly={readOnly}/></Tabs.Panel>
      <Tabs.Panel id="support" className="pt-5"><SupportDepartments readOnly={readOnly}/></Tabs.Panel>
    </Tabs>
  </>;
}

// Shared: load a settings document, edit a copy, save with field errors.
function useSettingsForm<T extends object>(path: string, key: string) {
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<T>(['settings', key], path);
  const [v, setV] = useState<T | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data && !v) setV(q.data); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof T>(k: K) => (x: T[K]) => { setV((s) => s && { ...s, [k]: x }); setFields((f) => ({ ...f, [k as string]: '' })); };
  async function save(body: unknown, ok: string) {
    setBusy(true); setFields({});
    try {
      const r = await apiFetch<T>(path, { method: 'PUT', body });
      client.setQueryData(['settings', key], r); setV(r); toast.success(ok);
      client.invalidateQueries({ queryKey: ['public-config'] });
      return true;
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); return false; } finally { setBusy(false); }
  }
  return { v, setV, set, fields, err: (k: string) => field(fields[k]), busy, save, saved: q.data };
}

// ---------- Branding ----------
type BrandingDoc = { name: string; accent: string | null; logo: string | null; favicon: string | null; passwordPrefix: string };
const swatches = ['#f5a524', '#e5484d', '#30a46c', '#0090ff', '#6e56cf', '#e93d82', '#12a594', '#1f2937'];
// WCAG contrast of the colour against white and against the dark background.
function contrast(hex: string, bg: [number, number, number]) {
  const lum = (rgb: number[]) => { const [r, g, b] = rgb.map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const a = lum([1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function readImage(file: File, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|x-icon|vnd\.microsoft\.icon)$/.test(file.type)) return reject(new Error('type'));
    if (file.size > max) return reject(new Error('size'));
    const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => reject(new Error('read')); r.readAsDataURL(file);
  });
}

function Branding({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings');
  const f = useSettingsForm<BrandingDoc>('/admin/settings/branding', 'branding');
  if (!f.v) return <p role="status" className="text-sm text-muted">…</p>;
  const v = f.v;
  const hex = v.accent ?? '#f5a524';
  const light = contrast(hex, [255, 255, 255]), dark = contrast(hex, [24, 28, 38]);
  const pick = (k: 'logo' | 'favicon') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file) return;
    try { f.set(k)(await readImage(file, 256 * 1024)); } catch (x) { toast.danger(t(`branding.image_${(x as Error).message}` as 'branding.image_type')); }
  };
  const image = (k: 'logo' | 'favicon') => <div className="flex flex-wrap items-center gap-4">
    <span className="grid size-16 place-items-center overflow-hidden rounded-xl border border-dashed border-border bg-default/40">
      {/* eslint-disable-next-line @next/next/no-img-element -- local preview of the chosen file */}
      {v[k] ? <img src={v[k]!} alt="" className="size-full object-contain p-1"/> : <I name="image" size={22} className="text-muted"/>}
    </span>
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <label className={`inline-flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:border-accent ${readOnly ? 'pointer-events-none opacity-50' : ''}`}>
          <I name="upload" size={15}/>{t('branding.upload')}<input type="file" accept="image/png,image/jpeg,image/webp,image/x-icon" className="sr-only" onChange={pick(k)} disabled={readOnly}/>
        </label>
        {v[k] && !readOnly && <Button size="sm" variant="ghost" onPress={() => f.set(k)(null)}>{t('branding.removeImage')}</Button>}
      </div>
      <p className="text-xs text-muted">{t(`branding.${k}Help`)}</p>
      {f.err(k) && <p className="text-xs text-danger">{f.err(k)}</p>}
    </div>
  </div>;

  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('branding.identity')} description={t('branding.identityHelp')} icon={<I name="tag" size={16}/>}>
      <TextInput label={t('branding.name')} value={v.name} onChange={f.set('name')} error={f.err('name')} maxLength={40} isDisabled={readOnly} help={t('branding.nameHelp')}/>
      <TextInput label={t('branding.passwordPrefix')} value={v.passwordPrefix ?? ''} onChange={f.set('passwordPrefix')} error={f.err('passwordPrefix')} maxLength={20} isDisabled={readOnly}
        placeholder={v.name.replace(/[^A-Za-z0-9]/g, '')} help={t('branding.passwordPrefixHelp', { example: `${(v.passwordPrefix || v.name).replace(/[^A-Za-z0-9]/g, '') || 'Server'}-K7qp-3xTm-9wZc-Rt4e` })}/>
    </FormSection>
    <FormSection title={t('branding.color')} description={t('branding.colorHelp')} icon={<I name="palette" size={16}/>}>
      <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label={t('branding.color')}>
        {swatches.map((s) => <button key={s} type="button" role="radio" aria-checked={hex === s} aria-label={s} disabled={readOnly} onClick={() => f.set('accent')(s)}
          className={`size-9 rounded-full border-2 transition-transform hover:scale-110 ${hex === s ? 'border-foreground' : 'border-transparent'}`} style={{ background: s }}/>)}
        <label className="relative size-9 cursor-pointer overflow-hidden rounded-full border border-border" aria-label={t('branding.custom')}>
          <input type="color" value={hex} onChange={(e) => f.set('accent')(e.target.value)} disabled={readOnly} className="absolute inset-0 size-[150%] -translate-x-1/4 -translate-y-1/4 cursor-pointer"/>
        </label>
        <TextInput className="w-32" label={t('branding.hex')} value={v.accent ?? ''} onChange={(x) => f.set('accent')(x || null)} error={f.err('accent')} spellCheck={false} isDisabled={readOnly}/>
        {v.accent && !readOnly && <Button size="sm" variant="ghost" onPress={() => f.set('accent')(null)}>{t('branding.default')}</Button>}
      </div>
      {v.accent && (light < 3 || dark < 3) && <Notice tone="warning">{t('branding.lowContrast', { light: light.toFixed(1), dark: dark.toFixed(1) })}</Notice>}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-4" aria-label={t('branding.preview')}>
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">{t('branding.preview')}</span>
        <span className="rounded-lg px-3 py-1.5 text-sm font-medium" style={{ background: hex, color: contrast(hex, [0, 0, 0]) > 7 ? '#111' : '#fff' }}>{t('branding.sampleButton')}</span>
        <span className="text-sm font-medium" style={{ color: hex }}>{t('branding.sampleLink')}</span>
        <span className="flex items-center gap-2 text-sm font-semibold">
          {/* eslint-disable-next-line @next/next/no-img-element -- local preview */}
          {v.logo ? <img src={v.logo} alt="" className="size-7 rounded-md object-contain"/> : <span className="grid size-7 place-items-center rounded-md" style={{ background: hex }}><I name="zap" size={15}/></span>}{v.name}
        </span>
      </div>
    </FormSection>
    <FormSection title={t('branding.logo')} description={t('branding.logoSection')} icon={<I name="image" size={16}/>}>{image('logo')}</FormSection>
    <FormSection title={t('branding.favicon')} description={t('branding.faviconSection')} icon={<I name="app-window" size={16}/>}>{image('favicon')}</FormSection>
    {!readOnly && <FormActions><Button isPending={f.busy} onPress={() => f.save(v, t('saved'))}><I name="check" size={16}/>{t('save')}</Button></FormActions>}
  </Card.Content></Card>;
}

// ---------- Mail ----------
type MailField = { key: string; secret?: boolean; optional?: boolean; options?: string[] };
type MailDoc = { enabled: boolean; provider: string; host: string; port: number; security: 'none' | 'starttls' | 'tls'; username: string; fromName: string; fromAddress: string;
  api: Record<string, string>; secretsSet: string[]; providers: { id: string; name: string; website: string; docs: string; fields: MailField[] }[];
  use: { passwordReset: boolean; twoFactor: boolean }; passwordSet: boolean; envFallback: boolean; password?: string };
const mailPresets: Record<string, Pick<MailDoc, 'host' | 'port' | 'security'>> = {
  gmail: { host: 'smtp.gmail.com', port: 587, security: 'starttls' }, outlook: { host: 'smtp.office365.com', port: 587, security: 'starttls' },
  yandex: { host: 'smtp.yandex.com', port: 465, security: 'tls' }, zoho: { host: 'smtp.zoho.eu', port: 587, security: 'starttls' },
  sendgrid: { host: 'smtp.sendgrid.net', port: 587, security: 'starttls' }, mailgun: { host: 'smtp.eu.mailgun.org', port: 587, security: 'starttls' },
  ses: { host: 'email-smtp.eu-central-1.amazonaws.com', port: 587, security: 'starttls' }, brevo: { host: 'smtp-relay.brevo.com', port: 587, security: 'starttls' },
};

function Mail({ readOnly, myEmail }: { readOnly: boolean; myEmail: string }) {
  const t = useTranslations('Settings');
  const { error } = useErrorText();
  const f = useSettingsForm<MailDoc>('/admin/settings/mail', 'mail');
  const [to, setTo] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string; detail?: string }>();
  const [testing, setTesting] = useState(false);
  useEffect(() => { if (myEmail && !to) setTo(myEmail); }, [myEmail]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f.v) return <p role="status" className="text-sm text-muted">…</p>;
  const v = f.v;
  const body = { ...v, password: v.password ?? '' };
  const api = v.providers.find((p) => p.id === v.provider);
  const ready = !!v.fromAddress && (api ? api.fields.every((x) => x.optional || v.api[x.key] || (x.secret && v.secretsSet.includes(x.key))) : !!v.host);
  async function runTest() {
    setTesting(true); setTest(undefined);
    try { await apiFetch('/admin/settings/mail/test', { method: 'POST', body: { ...body, to } }); setTest({ ok: true, text: t('mail.testOk', { to }) }); }
    catch (e) { setTest({ ok: false, text: error(e), detail: (e as { detail?: string }).detail }); } finally { setTesting(false); }
  }
  const dis = readOnly || !v.enabled;
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('mail.provider')} description={t('mail.providerHelp')} icon={<I name="mail" size={16}/>} aside={<GuideButton id="mail"/>}>
      <SwitchInput label={t('mail.enabled')} isSelected={v.enabled} onChange={f.set('enabled')} isDisabled={readOnly}/>
      {v.envFallback && <Notice tone="default">{t('mail.envFallback')}</Notice>}
      <div role="radiogroup" aria-label={t('mail.provider')} className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7">
        {[{ id: 'smtp', name: 'SMTP' }, ...v.providers].map((p) => <button key={p.id} type="button" role="radio" aria-checked={v.provider === p.id} disabled={readOnly}
          onClick={() => f.setV({ ...v, provider: p.id, api: p.id === v.provider ? v.api : {} })}
          className={`flex min-h-12 items-center justify-center rounded-xl border px-3 text-center text-sm font-medium transition-colors ${v.provider === p.id ? 'border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border hover:border-accent'}`}>{p.name}</button>)}
      </div>
    </FormSection>
    {api ? <FormSection title={api.name} description={t('mail.apiHelp')} icon={<I name="plug" size={16}/>}>
      <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm"><a href={api.website} target="_blank" rel="noreferrer" className="text-accent underline">{t('mail.website')}</a>
        <a href={api.docs} target="_blank" rel="noreferrer" className="text-accent underline">{t('mail.docs')}</a></p>
      <div className="grid gap-4 sm:grid-cols-2">
        {api.fields.map((x) => x.options
          ? <SelectInput key={x.key} label={t(`mail.fields.${x.key}` as 'mail.fields.apiKey')} value={v.api[x.key] ?? ''} onChange={(val) => f.setV({ ...v, api: { ...v.api, [x.key]: val } })} isDisabled={dis}
              error={f.err(`api.${x.key}`)} options={[...(x.optional ? [{ id: '', label: t('mail.default') }] : []), ...x.options.map((o) => ({ id: o, label: o }))]}/>
          : <TextInput key={x.key} label={t(`mail.fields.${x.key}` as 'mail.fields.apiKey')} type={x.secret ? 'password' : 'text'} value={v.api[x.key] ?? ''} isDisabled={dis} spellCheck={false}
              autoComplete={x.secret ? 'new-password' : 'off'} onChange={(val) => f.setV({ ...v, api: { ...v.api, [x.key]: val } })} error={f.err(`api.${x.key}`)}
              placeholder={x.secret && v.secretsSet.includes(x.key) ? t('secretKept') : ''} help={x.secret && v.secretsSet.includes(x.key) ? t('secretHelp') : x.optional ? t('mail.optional') : undefined}/>)}
      </div>
    </FormSection> : <>
    <FormSection title={t('mail.server')} description={t('mail.serverHelp')} icon={<I name="server" size={16}/>}>
      <SelectInput label={t('mail.preset')} value="" onChange={(k) => { if (mailPresets[k]) f.setV({ ...v, ...mailPresets[k] }); }} isDisabled={dis} help={t('mail.presetHelp')}
        options={Object.keys(mailPresets).map((k) => ({ id: k, label: t(`mail.presets.${k}` as 'mail.presets.gmail') }))}/>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_8rem_12rem]">
        <TextInput label={t('mail.host')} value={v.host} onChange={f.set('host')} error={f.err('host')} isDisabled={dis} spellCheck={false} placeholder="smtp.example.com"/>
        <NumberInput label={t('mail.port')} value={v.port} onChange={(x) => f.set('port')(x ?? 587)} minValue={1} maxValue={65535} isDisabled={dis}/>
        <SelectInput label={t('mail.security')} value={v.security} isDisabled={dis} onChange={(x) => f.setV({ ...v, security: x as MailDoc['security'], port: x === 'tls' ? 465 : x === 'starttls' ? 587 : 25 })}
          options={(['starttls', 'tls', 'none'] as const).map((s) => ({ id: s, label: t(`mail.sec.${s}`) }))}/>
      </div>
      {v.security === 'none' && v.enabled && <Notice tone="warning">{t('mail.insecure')}</Notice>}
    </FormSection>
    <FormSection title={t('mail.auth')} description={t('mail.authHelp')} icon={<I name="key-round" size={16}/>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput label={t('mail.username')} value={v.username} onChange={f.set('username')} isDisabled={dis} autoComplete="off" spellCheck={false}/>
        <TextInput label={t('mail.password')} type="password" value={v.password ?? ''} onChange={(x) => f.setV({ ...v, password: x })} isDisabled={dis} autoComplete="new-password"
          placeholder={v.passwordSet ? t('secretKept') : ''} help={v.passwordSet ? t('secretHelp') : undefined}/>
      </div>
    </FormSection></>}
    <FormSection title={t('mail.sender')} description={t('mail.senderHelp')} icon={<I name="send" size={16}/>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput label={t('mail.fromName')} value={v.fromName} onChange={f.set('fromName')} isDisabled={dis}/>
        <TextInput label={t('mail.fromAddress')} type="email" value={v.fromAddress} onChange={f.set('fromAddress')} error={f.err('fromAddress')} isDisabled={dis}/>
      </div>
    </FormSection>
    <FormSection title={t('mail.use')} description={t('mail.useHelp')} icon={<I name="list-checks" size={16}/>}>
      <CheckboxInput label={t('mail.usePasswordReset')} help={t('mail.usePasswordResetHelp')} isSelected={v.use.passwordReset} onChange={(x) => f.set('use')({ ...v.use, passwordReset: x })} isDisabled={readOnly}/>
      <CheckboxInput label={t('mail.useTwoFactor')} help={t('mail.useTwoFactorHelp')} isSelected={v.use.twoFactor} onChange={(x) => f.set('use')({ ...v.use, twoFactor: x })} isDisabled={readOnly}/>
      <p className="text-xs text-muted">{t('mail.notificationsNote')}</p>
    </FormSection>
    {!readOnly && <FormSection title={t('mail.test')} description={t('mail.testHelp')} icon={<I name="flask-conical" size={16}/>}>
      <div className="flex flex-wrap items-start gap-2">
        <TextInput className="min-w-60 flex-1" label={t('mail.testTo')} type="email" value={to} onChange={setTo}/>
        <Button className="mt-6" variant="secondary" isPending={testing} isDisabled={!ready || !to} onPress={runTest}><I name="send" size={16}/>{t('mail.sendTest')}</Button>
      </div>
      {test && <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}><Notice tone={test.ok ? 'success' : 'danger'} title={test.text}>{test.detail && <code className="break-all text-xs">{test.detail}</code>}</Notice></motion.div>}
    </FormSection>}
    {!readOnly && <FormActions status={f.saved?.enabled ? <StatusChip tone="success">{t('active')}</StatusChip> : <StatusChip tone="default">{t('inactive')}</StatusChip>}>
      <Button isPending={f.busy} onPress={async () => { if (await f.save(body, t('saved'))) f.setV({ ...v, password: '', api: Object.fromEntries(Object.entries(v.api).filter(([k]) => !api?.fields.find((x) => x.key === k)?.secret)), secretsSet: [...new Set([...v.secretsSet, ...Object.keys(v.api).filter((k) => api?.fields.find((x) => x.key === k)?.secret && v.api[k])])] }); }}><I name="check" size={16}/>{t('save')}</Button>
    </FormActions>}
  </Card.Content></Card>;
}

// ---------- Captcha ----------
type CaptchaDoc = { provider: 'none' | 'turnstile' | 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha'; siteKey: string; minScore: number; use: { signIn: boolean; signUp: boolean; passwordReset: boolean };
  secretSet: boolean; envFallback: boolean; secret?: string };
const captchaLinks: Record<string, string> = { turnstile: 'https://dash.cloudflare.com/?to=/:account/turnstile', 'recaptcha-v2': 'https://www.google.com/recaptcha/admin/create',
  'recaptcha-v3': 'https://www.google.com/recaptcha/admin/create', hcaptcha: 'https://dashboard.hcaptcha.com/sites' };

function Captcha({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings');
  const { error } = useErrorText();
  const f = useSettingsForm<CaptchaDoc>('/admin/settings/captcha', 'captcha');
  const [result, setResult] = useState<{ ok: boolean; score?: number; hostname?: string; errors: string[] } | { failed: string }>();
  const [testing, setTesting] = useState(false);
  const v = f.v;
  const widget = useCaptcha(v && v.provider !== 'none' && v.siteKey.length >= 8 ? { provider: v.provider, siteKey: v.siteKey } : null, 'settings_test');
  if (!v) return <p role="status" className="text-sm text-muted">…</p>;
  const body = { ...v, secret: v.secret ?? '' };
  async function runTest() {
    setTesting(true); setResult(undefined);
    try {
      const token = await widget.getToken();
      if (!token) { setResult({ failed: t('captcha.solveFirst') }); return; }
      setResult(await apiFetch('/admin/settings/captcha/test', { method: 'POST', body: { ...body, token } }));
    } catch (e) { setResult({ failed: error(e) }); } finally { setTesting(false); widget.reset(); }
  }
  const on = v.provider !== 'none';
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('captcha.provider')} description={t('captcha.providerHelp')} icon={<I name="bot" size={16}/>} aside={<GuideButton id="captcha"/>}>
      {v.envFallback && <Notice tone="default">{t('captcha.envFallback')}</Notice>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label={t('captcha.provider')}>
        {(['none', 'turnstile', 'recaptcha-v2', 'recaptcha-v3', 'hcaptcha'] as const).map((p) => <button key={p} type="button" role="radio" aria-checked={v.provider === p} disabled={readOnly}
          onClick={() => { f.setV({ ...v, provider: p, secret: '' }); setResult(undefined); }}
          className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors ${v.provider === p ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent'}`}>
          <span className="text-sm font-semibold">{t(`captcha.p.${p}`)}</span><span className="text-xs text-muted">{t(`captcha.d.${p}`)}</span>
        </button>)}
      </div>
    </FormSection>
    {on && <FormSection title={t('captcha.keys')} description={t('captcha.keysHelp')} icon={<I name="key-round" size={16}/>}
      aside={<a href={captchaLinks[v.provider]} target="_blank" rel="noreferrer noopener" className="mt-2 inline-flex items-center gap-1 text-sm text-accent hover:underline">{t('captcha.getKeys')}<I name="external-link" size={13}/></a>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput label={t('captcha.siteKey')} value={v.siteKey} onChange={f.set('siteKey')} error={f.err('siteKey')} isDisabled={readOnly} spellCheck={false}/>
        <TextInput label={t('captcha.secret')} type="password" value={v.secret ?? ''} onChange={(x) => f.setV({ ...v, secret: x })} error={f.err('secret')} isDisabled={readOnly}
          placeholder={v.secretSet ? t('secretKept') : ''} help={v.secretSet ? t('secretHelp') : undefined} autoComplete="new-password"/>
      </div>
      {v.provider === 'recaptcha-v3' && <NumberInput label={t('captcha.minScore')} value={v.minScore} onChange={(x) => f.set('minScore')(x ?? 0.5)} minValue={0} maxValue={1} step={0.1}
        formatOptions={{ minimumFractionDigits: 1, maximumFractionDigits: 1 }} help={t('captcha.minScoreHelp')} isDisabled={readOnly}/>}
    </FormSection>}
    {on && <FormSection title={t('captcha.where')} description={t('captcha.whereHelp')} icon={<I name="list-checks" size={16}/>}>
      {(['signIn', 'signUp', 'passwordReset'] as const).map((k) => <CheckboxInput key={k} label={t(`captcha.use.${k}`)} isSelected={v.use[k]} onChange={(x) => f.set('use')({ ...v.use, [k]: x })} isDisabled={readOnly}/>)}
    </FormSection>}
    {on && !readOnly && <FormSection title={t('captcha.test')} description={t('captcha.testHelp')} icon={<I name="flask-conical" size={16}/>}>
      {widget.element ?? (v.provider === 'recaptcha-v3' && <p className="text-sm text-muted">{t('captcha.invisible')}</p>)}
      {widget.failed && <Notice tone="warning">{t('captcha.widgetFailed')}</Notice>}
      <div><Button variant="secondary" isPending={testing} isDisabled={!widget.ready} onPress={runTest}><I name="flask-conical" size={16}/>{t('captcha.runTest')}</Button></div>
      {result && ('failed' in result ? <Notice tone="danger">{result.failed}</Notice>
        : <Notice tone={result.ok ? 'success' : 'danger'} title={result.ok ? t('captcha.testOk') : t('captcha.testFail')}>
            {[result.hostname && `${t('captcha.hostname')}: ${result.hostname}`, result.score !== undefined && `${t('captcha.score')}: ${result.score}`, result.errors.length && result.errors.join(', ')].filter(Boolean).join(' · ')}
          </Notice>)}
    </FormSection>}
    {!readOnly && <FormActions><Button isPending={f.busy} onPress={async () => { if (await f.save(body, t('saved'))) f.setV({ ...v, secret: '' }); }}><I name="check" size={16}/>{t('save')}</Button></FormActions>}
  </Card.Content></Card>;
}

// ---------- SMS ----------
type SmsField = { key: string; secret?: boolean; optional?: boolean; options?: string[] };
type SmsProvider = { id: string; name: string; website: string; docs: string; confidence: 'docs' | 'partial' | 'community'; fields: SmsField[]; senderRequired: boolean; iys: boolean };
type SmsDoc = { provider: string; sender: string; commercial: boolean; use: { twoFactor: boolean; phoneVerification: boolean }; credentials: Record<string, string>;
  secretsSet: Record<string, boolean>; providers: SmsProvider[] };

function Sms({ readOnly, myPhone }: { readOnly: boolean; myPhone: string }) {
  const t = useTranslations('Settings');
  const { error } = useErrorText();
  const f = useSettingsForm<SmsDoc>('/admin/settings/sms', 'sms');
  const [to, setTo] = useState('');
  const [test, setTest] = useState<{ ok: boolean; text: string; detail?: string }>();
  const [testing, setTesting] = useState(false);
  useEffect(() => { if (myPhone && !to) setTo(myPhone); }, [myPhone]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!f.v) return <p role="status" className="text-sm text-muted">…</p>;
  const v = f.v;
  const p = v.providers.find((x) => x.id === v.provider);
  const setCred = (k: string) => (x: string) => f.setV({ ...v, credentials: { ...v.credentials, [k]: x } });
  const body = { provider: v.provider, sender: v.sender, commercial: v.commercial, use: v.use, credentials: v.credentials };
  async function runTest() {
    setTesting(true); setTest(undefined);
    try { await apiFetch('/admin/settings/sms/test', { method: 'POST', body: { ...body, to } }); setTest({ ok: true, text: t('sms.testOk', { to }) }); }
    catch (e) { setTest({ ok: false, text: error(e), detail: (e as { detail?: string }).detail }); } finally { setTesting(false); }
  }
  const label = (k: string) => (t.has(`sms.field.${k}` as 'sms.field.username') ? t(`sms.field.${k}` as 'sms.field.username') : k);
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('sms.provider')} description={t('sms.providerHelp')} icon={<I name="message-square" size={16}/>}>
      <SelectInput label={t('sms.provider')} value={v.provider} isDisabled={readOnly} onChange={(id) => f.setV({ ...v, provider: id, credentials: {}, secretsSet: {} })}
        options={[{ id: 'none', label: t('sms.none') }, ...v.providers.map((x) => ({ id: x.id, label: x.name, description: t(`sms.confidence.${x.confidence}`) }))]}/>
      {p && <div className="flex flex-wrap items-center gap-2 text-sm">
        <Chip size="sm" variant="soft" color={p.confidence === 'docs' ? 'success' : p.confidence === 'partial' ? 'warning' : 'danger'}>{t(`sms.confidence.${p.confidence}`)}</Chip>
        {p.docs && <a href={p.docs} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent hover:underline">{t('sms.docs')}<I name="external-link" size={13}/></a>}
        {p.website && <a href={p.website} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-muted hover:underline">{t('sms.website')}<I name="external-link" size={13}/></a>}
      </div>}
      {p && p.confidence !== 'docs' && <Notice tone="warning">{t(`sms.confidenceHelp.${p.confidence}`)}</Notice>}
    </FormSection>
    {p && <FormSection title={t('sms.account')} description={t('sms.accountHelp')} icon={<I name="key-round" size={16}/>}>
      <div className="grid gap-4 sm:grid-cols-2">
        {p.fields.map((fd) => fd.options
          ? <SelectInput key={fd.key} label={label(fd.key)} value={v.credentials[fd.key] ?? ''} onChange={setCred(fd.key)} isDisabled={readOnly} error={f.err(`credentials.${fd.key}`)}
              options={[...(fd.optional ? [{ id: '', label: '–' }] : []), ...fd.options.map((o) => ({ id: o, label: t.has(`sms.option.${o}` as 'sms.option.BIREYSEL') ? t(`sms.option.${o}` as 'sms.option.BIREYSEL') : o }))]}/>
          : <TextInput key={fd.key} label={`${label(fd.key)}${fd.optional ? ` (${t('optional')})` : ''}`} type={fd.secret ? 'password' : 'text'} value={v.credentials[fd.key] ?? ''} onChange={setCred(fd.key)}
              isDisabled={readOnly} error={f.err(`credentials.${fd.key}`)} spellCheck={false} autoComplete="off" multiline={fd.key === 'body' || fd.key === 'headers'}
              placeholder={fd.secret && v.secretsSet[fd.key] ? t('secretKept') : ''} help={t.has(`sms.fieldHelp.${fd.key}` as 'sms.fieldHelp.url') ? t(`sms.fieldHelp.${fd.key}` as 'sms.fieldHelp.url', { to: '{to}', text: '{text}', sender: '{sender}' }) : undefined}/>)}
      </div>
    </FormSection>}
    {p && <FormSection title={t('sms.sender')} description={t('sms.senderHelp')} icon={<I name="tag" size={16}/>}>
      <TextInput label={t('sms.senderLabel')} value={v.sender} onChange={f.set('sender')} error={f.err('sender')} isDisabled={readOnly} maxLength={20}
        help={['organik', 'hermes'].includes(p.id) ? t('sms.senderNumeric') : t('sms.senderLabelHelp')}/>
      {p.iys && <CheckboxInput label={t('sms.commercial')} help={t('sms.commercialHelp')} isSelected={v.commercial} onChange={f.set('commercial')} isDisabled={readOnly}/>}
    </FormSection>}
    {p && <FormSection title={t('sms.use')} description={t('sms.useHelp')} icon={<I name="list-checks" size={16}/>}>
      <CheckboxInput label={t('sms.useTwoFactor')} help={t('sms.useTwoFactorHelp')} isSelected={v.use.twoFactor} onChange={(x) => f.set('use')({ ...v.use, twoFactor: x })} isDisabled={readOnly}/>
      <CheckboxInput label={t('sms.usePhone')} help={t('sms.usePhoneHelp')} isSelected={v.use.phoneVerification} onChange={(x) => f.set('use')({ ...v.use, phoneVerification: x })} isDisabled={readOnly}/>
      <p className="text-xs text-muted">{t('sms.notificationsNote')}</p>
    </FormSection>}
    {p && !readOnly && <FormSection title={t('sms.test')} description={t('sms.testHelp')} icon={<I name="flask-conical" size={16}/>}>
      <div className="flex flex-wrap items-start gap-2">
        <TextInput className="min-w-60 flex-1" label={t('sms.testTo')} type="tel" value={to} onChange={setTo} placeholder="+905xxxxxxxxx" help={t('sms.testToHelp')}/>
        <Button className="mt-6" variant="secondary" isPending={testing} isDisabled={!/^\+[1-9]\d{7,14}$/.test(to)} onPress={runTest}><I name="send" size={16}/>{t('sms.sendTest')}</Button>
      </div>
      {test && <Notice tone={test.ok ? 'success' : 'danger'} title={test.text}>{test.detail && <code className="break-all text-xs">{test.detail}</code>}</Notice>}
    </FormSection>}
    {!readOnly && <FormActions><Button isPending={f.busy} onPress={() => f.save(body, t('saved'))}><I name="check" size={16}/>{t('save')}</Button></FormActions>}
  </Card.Content></Card>;
}
