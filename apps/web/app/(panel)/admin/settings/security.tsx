"use client";
// Sign-in security: who must use two-factor (enforced by the API too) and sign-in with an e-mail code.
import { Button, Card, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import { ButtonLink, FormActions, FormSection, Notice, SwitchInput } from '../../../../components/ui';
import { apiFetch, useErrorText } from '../../../../lib/api';
import { useMe } from '../../../../lib/me';
import { useApiQuery } from '../../../../lib/query';
import type { PublicConfig } from '../../../../lib/session';

type Doc = { require2fa: 'none' | 'staff' | 'all'; emailCodeSignIn: boolean; apiTokens: 'everyone' | 'staff' | 'off' };

export default function Security({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.security');
  const { error } = useErrorText();
  const client = useQueryClient();
  const me = useMe();
  const q = useApiQuery<Doc>(['settings', 'security'], '/admin/settings/security').data;
  const cfg = useApiQuery<PublicConfig>(['public-config'], '/public/config').data;
  const [v, setV] = useState<Doc | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q && !v) setV(q); }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <p role="status" className="text-sm text-muted">…</p>;
  async function save() {
    setBusy(true);
    try { setV(await apiFetch<Doc>('/admin/settings/security', { method: 'PUT', body: v })); toast.success(t('saved')); client.invalidateQueries({ queryKey: ['public-config'] }); }
    catch (e) { toast.danger(error(e)); } finally { setBusy(false); }
  }
  const mailReady = !!cfg?.otpChannels.email;
  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('require')} description={t('requireHelp')} icon={<I name="shield-check" size={16}/>}>
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label={t('require')}>
        {(['none', 'staff', 'all'] as const).map((p) => <button key={p} type="button" role="radio" aria-checked={v.require2fa === p} disabled={readOnly}
          onClick={() => setV({ ...v, require2fa: p })}
          className={`flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors ${v.require2fa === p ? 'border-accent bg-accent-soft' : 'border-border hover:border-accent'}`}>
          <span className="text-sm font-semibold">{t(`levels.${p}`)}</span><span className="text-xs text-muted">{t(`levelHelp.${p}`)}</span>
        </button>)}
      </div>
      {v.require2fa !== 'none' && !me?.twoFactorEnabled && <Notice tone="warning">{t('selfWarning')}</Notice>}
      <p className="text-xs text-muted">{t('methods')}</p>
    </FormSection>
    <FormSection title={t('emailCode')} description={t('emailCodeHelp')} icon={<I name="mail-check" size={16}/>}>
      <SwitchInput label={t('emailCodeOn')} isSelected={v.emailCodeSignIn} onChange={(x) => setV({ ...v, emailCodeSignIn: x })} isDisabled={readOnly}/>
      {v.emailCodeSignIn && !mailReady && <Notice tone="warning">{t('needsMail')}</Notice>}
    </FormSection>
    <FormSection title={t('apiTokens')} description={t('apiTokensMoved')} icon={<I name="key-round" size={16}/>}>
      <div><ButtonLink href="/admin/settings?tab=api" variant="secondary"><I name="code-xml" size={16}/>{t('apiTokensOpen')}</ButtonLink></div>
    </FormSection>
    {!readOnly && <FormActions><Button isPending={busy} onPress={save}><I name="check" size={16}/>{t('save')}</Button></FormActions>}
  </Card.Content></Card>;
}
