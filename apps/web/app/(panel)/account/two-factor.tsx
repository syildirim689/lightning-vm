"use client";
// Two-factor authentication (authenticator app or codes by e-mail/SMS, plus backup codes) and the verified phone number used for
// SMS codes and SMS notifications. All of it runs through better-auth's client.
import { Button, InputOTP, Modal, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';
import { I } from '../../../components/icon';
import { Notice, StatusChip, TextInput } from '../../../components/ui';
import { useErrorText } from '../../../lib/api';
import { useCopy } from '../../../lib/clipboard';
import { authClient } from '../../../lib/auth-client';
import { useMe } from '../../../lib/me';
import { useApiQuery } from '../../../lib/query';
import type { PublicConfig } from '../../../lib/session';
import { hostLabel, totpLabel } from '../../../lib/proposals';

type ClientError = { code?: string; status?: number } | null;
const codeOf = (e: ClientError) => ({ code: e?.code ?? (e?.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN') });

function BackupCodes({ codes }: { codes: string[] }) {
  const t = useTranslations('Account');
  const tp = useTranslations('Proposals');
  // The file says whose codes they are: "acme-cloud-backup-codes.txt" (the panel's name, in the panel's language).
  const brand = useApiQuery<PublicConfig>(['public-config'], '/public/config').data?.branding.name ?? '';
  const file = `${[hostLabel(brand, 40), tp('codesFile')].filter(Boolean).join('-')}.txt`;
  const text = codes.join('\n');
  const copy = useCopy();
  return <div className="flex flex-col gap-3">
    <Notice tone="warning" title={t('twoFactor.backupTitle')}>{t('twoFactor.backupHelp')}</Notice>
    <ul className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-default/40 p-3 font-mono text-sm sm:grid-cols-5">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onPress={() => void copy(text, t('twoFactor.copied'))}><I name="copy" size={15}/>{t('twoFactor.copy')}</Button>
      <Button size="sm" variant="secondary" onPress={() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = file; a.click(); }}>
        <I name="download" size={15}/>{t('twoFactor.download')}</Button>
    </div>
  </div>;
}

const methodIcon = (m: 'app' | 'code', channel: string) => m === 'app' ? 'smartphone' : channel === 'sms' ? 'message-square-text' : 'mail';

export function TwoFactor() {
  const t = useTranslations('Account');
  const tp = useTranslations('Proposals');
  const { error } = useErrorText();
  const client = useQueryClient();
  const me = useMe();
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'mail' | 'codes' | 'disable' | 'regenerate'>('idle');
  const cfg = useApiQuery<PublicConfig>(['public-config'], '/public/config').data;
  // Codes go by SMS to a verified phone when SMS codes are on, otherwise by e-mail (better-auth.ts sendOTP).
  const channel = cfg?.otpChannels.sms && me?.phoneNumberVerified ? 'sms' : cfg?.otpChannels.email ? 'email' : null;
  const [via, setVia] = useState<'app' | 'code'>('app');
  const [password, setPassword] = useState('');
  const [uri, setUri] = useState('');
  const [qr, setQr] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (uri) void QRCode.toDataURL(uri, { margin: 1, width: 220 }).then(setQr); }, [uri]);
  const enabled = !!me?.twoFactorEnabled;
  const secret = uri ? new URL(uri).searchParams.get('secret') ?? '' : '';
  // What the authenticator app will list: the issuer and the account the panel put in the URI.
  const [issuer, account] = uri ? totpLabel(uri) : ['', ''];
  const close = () => { setStep('idle'); setPassword(''); setCode(''); };
  const refresh = () => client.invalidateQueries({ queryKey: ['me'] });

  async function start() {
    setBusy(true);
    const r = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (r.error) { toast.danger(error(codeOf(r.error))); return; }
    const d = r.data as { totpURI: string; backupCodes: string[] };
    setCodes(d.backupCodes); setPassword('');
    if (via === 'app') { setUri(d.totpURI); setStep('scan'); return; }
    setStep('mail'); await send();
  }
  async function send() {
    setBusy(true);
    const r = await authClient.twoFactor.sendOtp();
    setBusy(false);
    if (r.error) toast.danger(error(codeOf(r.error))); else toast.success(t('twoFactor.codeSent'));
  }
  async function verifyCode() {
    setBusy(true);
    const r = await authClient.twoFactor.verifyOtp({ code });
    setBusy(false);
    if (r.error) { toast.danger(error(codeOf(r.error))); setCode(''); return; }
    // The sign-in form then opens on "send a code" instead of the authenticator app.
    try { localStorage.setItem('lvm-2fa-method', 'otp'); } catch { /* storage off */ }
    setStep('codes'); await refresh();
  }
  async function verify() {
    setBusy(true);
    const r = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (r.error) { toast.danger(error(codeOf(r.error))); setCode(''); return; }
    setStep('codes'); await refresh();
  }
  async function disable() {
    setBusy(true);
    const r = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (r.error) { toast.danger(error(codeOf(r.error))); return; }
    close(); toast.success(t('twoFactor.disabled')); await refresh();
  }
  async function regenerate() {
    setBusy(true);
    const r = await authClient.twoFactor.generateBackupCodes({ password });
    setBusy(false);
    if (r.error) { toast.danger(error(codeOf(r.error))); return; }
    setCodes(r.data.backupCodes); setPassword(''); setStep('codes');
  }

  return <div id="two-factor" className="flex scroll-mt-24 flex-col gap-4 rounded-xl transition-shadow">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-semibold">{t('twoFactor.title')}</h3>
      <StatusChip tone={enabled ? 'success' : 'warning'}>{enabled ? t('twoFactor.on') : t('twoFactor.off')}</StatusChip>
    </div>
    <p className="text-sm text-muted">{t('twoFactor.intro')}</p>
    <div className="flex flex-wrap gap-2">
      {!enabled ? <Button variant="secondary" onPress={() => setStep('password')}><I name="shield-check" size={16}/>{t('twoFactor.enable')}</Button> : <>
        <Button variant="secondary" onPress={() => setStep('regenerate')}><I name="refresh-cw" size={16}/>{t('twoFactor.newCodes')}</Button>
        <Button variant="danger-soft" onPress={() => setStep('disable')}>{t('twoFactor.disable')}</Button>
      </>}
    </div>

    <Modal.Backdrop isOpen={step !== 'idle'} onOpenChange={(o) => { if (!o) close(); }}>
      <Modal.Container size="md" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading>{step === 'disable' ? t('twoFactor.disable') : step === 'regenerate' ? t('twoFactor.newCodes') : t('twoFactor.enable')}</Modal.Heading></Modal.Header>
          <Modal.Body>
            <AnimatePresence mode="wait">
              <motion.div key={step} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.18 }} className="flex flex-col gap-4">
                {(step === 'password' || step === 'disable' || step === 'regenerate') && <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void (step === 'password' ? start() : step === 'disable' ? disable() : regenerate()); }}>
                  {step === 'password' && channel && <div role="radiogroup" aria-label={t('twoFactor.method')} className="grid gap-2 sm:grid-cols-2">
                    {(['app', 'code'] as const).map((m) => <button key={m} type="button" role="radio" aria-checked={via === m} onClick={() => setVia(m)}
                      className={`flex items-start gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent ${via === m ? 'border-accent bg-accent-soft' : 'border-border hover:bg-default'}`}>
                      <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${via === m ? 'bg-accent text-accent-foreground' : 'bg-default text-muted'}`}><I name={methodIcon(m, channel)} size={18}/></span>
                      <span className="flex flex-col gap-0.5"><span className="text-sm font-semibold">{t(m === 'app' ? 'twoFactor.viaApp' : channel === 'sms' ? 'twoFactor.viaSms' : 'twoFactor.viaEmail')}</span>
                        <span className="text-xs text-muted">{t(m === 'app' ? 'twoFactor.viaAppHelp' : channel === 'sms' ? 'twoFactor.viaSmsHelp' : 'twoFactor.viaEmailHelp')}</span></span>
                    </button>)}
                  </div>}
                  <p className="text-sm text-muted">{t('twoFactor.confirmPassword')}</p>
                  <TextInput label={t('security.currentPassword')} type="password" value={password} onChange={setPassword} autoComplete="current-password"/>
                  <Button type="submit" variant={step === 'disable' ? 'danger' : 'primary'} isPending={busy} isDisabled={!password}>{t('twoFactor.continue')}</Button>
                </form>}
                {step === 'scan' && <>
                  <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm text-muted"><li>{t('twoFactor.scan1')}</li><li>{t('twoFactor.scan2')}</li></ol>
                  <div className="flex flex-col items-center gap-3">
                    {/* eslint-disable-next-line @next/next/no-img-element -- generated locally from the otpauth URI */}
                    {qr && <img src={qr} alt={t('twoFactor.qrAlt')} className="size-48 rounded-lg bg-white p-2"/>}
                    <p className="text-center text-xs text-muted">{t('twoFactor.manual')} <code className="break-all font-mono">{secret}</code></p>
                    {issuer && <p className="text-center text-xs text-muted [overflow-wrap:anywhere]" data-testid="totp-label">{tp('appShows', { issuer, account })}</p>}
                    <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={() => void verify()} aria-label={t('twoFactor.code')}>
                      <InputOTP.Group>{[0, 1, 2, 3, 4, 5].map((i) => <InputOTP.Slot key={i} index={i}/>)}</InputOTP.Group>
                    </InputOTP>
                  </div>
                  <Button isPending={busy} isDisabled={code.length !== 6} onPress={verify}>{t('twoFactor.verify')}</Button>
                </>}
                {step === 'mail' && <>
                  <p className="text-sm text-muted">{t(channel === 'sms' ? 'twoFactor.mailSentSms' : 'twoFactor.mailSent', { email: me?.email ?? '' })}</p>
                  <div className="flex justify-center">
                    <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={() => void verifyCode()} aria-label={t('twoFactor.code')}>
                      <InputOTP.Group>{[0, 1, 2, 3, 4, 5].map((i) => <InputOTP.Slot key={i} index={i}/>)}</InputOTP.Group>
                    </InputOTP>
                  </div>
                  <div className="flex flex-wrap justify-between gap-2">
                    <Button variant="ghost" isDisabled={busy} onPress={send}><I name="rotate-ccw" size={15}/>{t('twoFactor.resend')}</Button>
                    <Button isPending={busy} isDisabled={code.length !== 6} onPress={verifyCode}>{t('twoFactor.verify')}</Button>
                  </div>
                </>}
                {step === 'codes' && <>
                  <BackupCodes codes={codes}/>
                  <Button onPress={() => { close(); toast.success(t('twoFactor.enabled')); }}>{t('twoFactor.done')}</Button>
                </>}
              </motion.div>
            </AnimatePresence>
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </div>;
}

// E.164: + country code + number. Turkish numbers typed as 05xx… or 5xx… are completed with +90.
const normalize = (v: string) => { const d = v.replace(/[^\d+]/g, ''); if (d.startsWith('+')) return d; if (d.startsWith('0')) return `+90${d.slice(1)}`; if (/^5\d{9}$/.test(d)) return `+90${d}`; return `+${d}`; };

export function PhoneNumber() {
  const t = useTranslations('Account');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const me = useMe();
  const cfg = useApiQuery<PublicConfig>(['public-config'], '/public/config').data;
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [phoneError, setPhoneError] = useState<string>();
  const available = !!cfg?.phoneVerification;

  async function send() {
    const n = normalize(phone);
    if (!/^\+[1-9]\d{7,14}$/.test(n)) { setPhoneError(field('INVALID_PHONE')); return; }
    setBusy(true);
    const r = await authClient.phoneNumber.sendOtp({ phoneNumber: n });
    setBusy(false);
    if (r.error) { toast.danger(error(codeOf(r.error))); return; }
    setSent(n); setCode('');
  }
  async function verify() {
    setBusy(true);
    const r = await authClient.phoneNumber.verify({ phoneNumber: sent, code, updatePhoneNumber: true });
    setBusy(false);
    if (r.error) { toast.danger(error(codeOf(r.error))); setCode(''); return; }
    setSent(''); setPhone(''); toast.success(t('phone.verified')); client.invalidateQueries({ queryKey: ['me'] });
  }

  return <div id="phone" className="flex scroll-mt-24 flex-col gap-4 rounded-xl transition-shadow">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="font-semibold">{t('phone.title')}</h3>
      {me?.phoneNumber && <StatusChip tone={me.phoneNumberVerified ? 'success' : 'warning'}>{me.phoneNumber}</StatusChip>}
    </div>
    <p className="text-sm text-muted">{t('phone.intro')}</p>
    {!available ? <Notice tone="default">{t('phone.unavailable')}</Notice> : !sent
      ? <form className="flex flex-wrap items-start gap-2" onSubmit={(e) => { e.preventDefault(); void send(); }} noValidate>
          <TextInput className="min-w-52 flex-1" label={me?.phoneNumber ? t('phone.change') : t('phone.number')} type="tel" value={phone} onChange={(v) => { setPhone(v); setPhoneError(undefined); }}
            placeholder="+90 5xx xxx xx xx" autoComplete="tel" error={phoneError} help={t('phone.help')}/>
          <Button type="submit" className="mt-6" variant="secondary" isPending={busy}><I name="send" size={16}/>{t('phone.sendCode')}</Button>
        </form>
      : <div className="flex flex-col items-start gap-3">
          <p className="text-sm">{t('phone.codeSent', { phone: sent })}</p>
          <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={() => void verify()} aria-label={t('phone.code')}>
            <InputOTP.Group>{[0, 1, 2, 3, 4, 5].map((i) => <InputOTP.Slot key={i} index={i}/>)}</InputOTP.Group>
          </InputOTP>
          <div className="flex gap-2"><Button isPending={busy} isDisabled={code.length !== 6} onPress={verify}>{t('phone.verify')}</Button><Button variant="ghost" onPress={() => setSent('')}>{t('phone.cancel')}</Button></div>
        </div>}
  </div>;
}
