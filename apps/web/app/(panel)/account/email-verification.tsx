"use client";
// The account's own e-mail address verification (API: account/email-verification). Shown only while the address is
// unverified and the panel can mail a code; with mail off the section is not there at all. A code typed here, or the
// link in the mail (which opens this page with ?verify=…), counts only in this signed-in session.
import { Button, InputOTP, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../../components/icon';
import { Notice, Section } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { useMe } from '../../../lib/me';
import { useApiQuery } from '../../../lib/query';

export type EmailVerificationState = { email: string; verified: boolean; available: boolean; pending: boolean; resendInSeconds: number; codeMinutes: number; requiredToOrder: boolean };
const key = ['email-verification'];
export const useEmailVerification = () => useApiQuery<EmailVerificationState>(key, '/account/email-verification').data;

export function EmailVerification() {
  const t = useTranslations('Account.emailVerification');
  const { error } = useErrorText();
  const client = useQueryClient();
  const me = useMe();
  const s = useEmailVerification();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'verify' | null>(null);
  const [wait, setWait] = useState(0);
  const [linkCode, setLinkCode] = useQueryState('verify', parseAsString);
  const tried = useRef(false);
  // The wait until another mail may be asked for, counted down here between answers from the API.
  useEffect(() => { if (s) setWait(s.resendInSeconds); }, [s]);
  useEffect(() => { if (wait <= 0) return; const id = setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(id); }, [wait]);

  async function confirm(value: string) {
    setBusy('verify');
    try {
      await apiFetch('/account/email-verification/confirm', { method: 'POST', body: { code: value } });
      toast.success(t('verified'));
      await Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: ['me'] })]);
    } catch (e) { toast.danger(error(e)); setCode(''); void client.invalidateQueries({ queryKey: key }); }
    finally { setBusy(null); }
  }
  async function send() {
    setBusy('send');
    try {
      client.setQueryData(key, await apiFetch<EmailVerificationState>('/account/email-verification/send', { method: 'POST' }));
      setCode(''); toast.success(t('sent', { email: s?.email ?? '' }));
    } catch (e) { toast.danger(error(e)); void client.invalidateQueries({ queryKey: key }); }
    finally { setBusy(null); }
  }
  // The link in the mail: its code is tried once, then taken out of the address bar.
  const acting = !!me?.impersonatedBy;
  useEffect(() => {
    if (!linkCode || !s || !me || tried.current) return;
    tried.current = true;
    void setLinkCode(null);
    if (/^\d{6}$/.test(linkCode) && s.available && !s.verified && !acting) void confirm(linkCode);
  }, [linkCode, s, me]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!s || !s.available || s.verified) return null;
  return <Section title={t('title')} description={t('intro', { email: s.email })}>
    <div id="email-verification" className="flex max-w-2xl scroll-mt-24 flex-col gap-4">
      <Notice tone="warning" title={t('unverified')}>{s.requiredToOrder ? t('neededToOrder') : t('why')}</Notice>
      {acting ? <p className="text-sm text-muted">{t('notWhileActing')}</p> : <>
        {s.pending && <div className="flex flex-col items-start gap-3">
          <p className="text-sm [overflow-wrap:anywhere]">{t('codeSent', { email: s.email, minutes: s.codeMinutes })}</p>
          <InputOTP maxLength={6} value={code} onChange={setCode} onComplete={(v) => void confirm(v)} aria-label={t('code')} isDisabled={busy === 'verify'}>
            <InputOTP.Group>{[0, 1, 2, 3, 4, 5].map((i) => <InputOTP.Slot key={i} index={i}/>)}</InputOTP.Group>
          </InputOTP>
          <Button isPending={busy === 'verify'} isDisabled={code.length !== 6} onPress={() => confirm(code)}><I name="check" size={16}/>{t('verify')}</Button>
        </div>}
        <div><Button variant={s.pending ? 'ghost' : 'secondary'} isPending={busy === 'send'} isDisabled={wait > 0} onPress={send}>
          <I name="send" size={16}/>{wait > 0 ? t('resendIn', { seconds: wait }) : s.pending ? t('resend') : t('send')}</Button></div>
      </>}
    </div>
  </Section>;
}
