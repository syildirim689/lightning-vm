"use client";
// Settings → Sign-in methods: social providers (each with its client, the redirect URI to register and a guide),
// Google One Tap, sign-in links by e-mail, user names, and two checks on new passwords and addresses.
import { Button, Card, Chip, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'motion/react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../../components/icon';
import ProviderMark, { providerNames } from '../../../../components/provider-mark';
import { GuideButton } from '../../../../components/setup-guide';
import { FormActions, FormSection, Notice, SwitchInput, TextInput } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

const ids = ['google', 'microsoft', 'github', 'gitlab', 'discord', 'facebook', 'linkedin'] as const;
type Id = (typeof ids)[number];
type Provider = { enabled: boolean; clientId: string; clientSecretSet: boolean; tenantId?: string; hostedDomain?: string };
type Doc = { magicLink: boolean; username: boolean; oneTap: boolean; socialSignUp: boolean; pwnedPasswords: boolean; blockDisposable: boolean; providers: Record<Id, Provider> };

export default function SignInMethods({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings.signIn');
  const ts = useTranslations('Settings');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const reduce = useReducedMotion();
  const q = useApiQuery<Doc>(['settings', 'sign-in'], '/admin/settings/sign-in');
  const mail = useApiQuery<{ enabled: boolean }>(['settings', 'mail'], '/admin/settings/mail').data;
  const [v, setV] = useState<Doc | null>(null);
  const [secrets, setSecrets] = useState<Partial<Record<Id, string>>>({});
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState('');
  useEffect(() => { setOrigin(window.location.origin); }, []);
  useEffect(() => { if (q.data && !v) setV(q.data); }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return <p role="status" className="text-sm text-muted">…</p>;
  const set = <K extends keyof Doc>(k: K) => (x: Doc[K]) => { setV({ ...v, [k]: x }); setFields((f) => ({ ...f, [k]: '' })); };
  const setP = (id: Id, patch: Partial<Provider>) => { setV({ ...v, providers: { ...v.providers, [id]: { ...v.providers[id], ...patch } } }); setFields((f) => ({ ...f, [`providers.${id}.clientId`]: '' })); };
  const err = (k: string) => field(fields[k]);

  async function save() {
    setBusy(true); setFields({});
    const providers = Object.fromEntries(ids.map((id) => [id, { ...v!.providers[id], clientSecret: secrets[id] ?? '' }]));
    try {
      const r = await apiFetch<Doc>('/admin/settings/sign-in', { method: 'PUT', body: { ...v, providers } });
      client.setQueryData(['settings', 'sign-in'], r); setV(r); setSecrets({}); toast.success(ts('saved'));
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }
  const on = ids.filter((id) => v.providers[id]?.enabled);

  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('title')} description={t('intro')} icon={<I name="log-in" size={16}/>}>
      <div className="flex flex-wrap gap-2">
        <Chip size="sm" variant="soft" color="success"><I name="key-round" size={12}/> {t('always.password')}</Chip>
        <Chip size="sm" variant="soft" color="success"><I name="fingerprint" size={12}/> {t('always.passkey')}</Chip>
        {on.map((id) => <Chip key={id} size="sm" variant="soft" color="accent"><ProviderMark id={id} size={12}/> {providerNames[id]}</Chip>)}
        {v.magicLink && <Chip size="sm" variant="soft" color="accent"><I name="mail" size={12}/> {t('magicLink')}</Chip>}
        {v.username && <Chip size="sm" variant="soft" color="accent"><I name="at-sign" size={12}/> {t('username')}</Chip>}
      </div>
      <Notice tone="default">{t('guards')}</Notice>
    </FormSection>

    <FormSection title={t('social')} description={t('socialHelp')} icon={<I name="users" size={16}/>} aside={<GuideButton id="social"/>}>
      <SwitchInput label={t('socialSignUp')} isSelected={v.socialSignUp} onChange={set('socialSignUp')} isDisabled={readOnly}/>
      <p className="-mt-2 text-xs text-muted">{t('socialSignUpHelp')}</p>
      <div className="grid gap-3 xl:grid-cols-2">
        {ids.map((id, i) => {
          const p = v.providers[id] ?? { enabled: false, clientId: '', clientSecretSet: false };
          return <motion.div key={id} initial={reduce ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}
            className={`flex flex-col gap-3 rounded-2xl border p-4 transition-colors ${p.enabled ? 'border-accent/40 bg-accent/5' : 'border-border'}`}>
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-xl border border-border bg-surface"><ProviderMark id={id} size={18}/></span>
              <span className="flex-1 font-semibold">{providerNames[id]}</span>
              <SwitchInput label={<span className="sr-only">{t('enable', { name: providerNames[id] })}</span>} isSelected={p.enabled} onChange={(x) => setP(id, { enabled: x })} isDisabled={readOnly}/>
            </div>
            {p.enabled && <>
              <div className="grid gap-3 sm:grid-cols-2">
                <TextInput label={t('clientId')} value={p.clientId} onChange={(x) => setP(id, { clientId: x })} error={err(`providers.${id}.clientId`)} isDisabled={readOnly} spellCheck={false}/>
                <TextInput revealable label={t('clientSecret')} type="password" value={secrets[id] ?? ''} onChange={(x) => setSecrets({ ...secrets, [id]: x })} placeholder={p.clientSecretSet ? ts('secretKept') : ''} isDisabled={readOnly}/>
                {id === 'microsoft' && <TextInput label={t('tenantId')} value={p.tenantId ?? ''} onChange={(x) => setP(id, { tenantId: x })} placeholder="common" help={t('tenantHelp')} error={err('providers.microsoft.tenantId')} isDisabled={readOnly} spellCheck={false}/>}
                {id === 'google' && <TextInput label={t('hostedDomain')} value={p.hostedDomain ?? ''} onChange={(x) => setP(id, { hostedDomain: x })} placeholder="example.com" help={t('hostedDomainHelp')} error={err('providers.google.hostedDomain')} isDisabled={readOnly} spellCheck={false}/>}
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium">{t('redirect')}</span>
                <span className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-lg bg-default px-3 py-2 font-mono text-xs">{origin}/api/auth/callback/{id}</code>
                  <Button isIconOnly size="sm" variant="ghost" aria-label={t('copy')} onPress={() => { void navigator.clipboard?.writeText(`${origin}/api/auth/callback/${id}`); toast.success(t('copied')); }}><I name="copy" size={14}/></Button>
                </span>
              </div>
            </>}
          </motion.div>;
        })}
      </div>
      <SwitchInput label={t('oneTap')} isSelected={v.oneTap} onChange={set('oneTap')} isDisabled={readOnly || !v.providers.google?.enabled}/>
      <p className="-mt-2 text-xs text-muted">{err('oneTap') || t('oneTapHelp', { origin })}</p>
    </FormSection>

    <FormSection title={t('passwordless')} description={t('passwordlessHelp')} icon={<I name="mail" size={16}/>}>
      <SwitchInput label={t('magicLink')} isSelected={v.magicLink} onChange={set('magicLink')} isDisabled={readOnly}/>
      {v.magicLink && mail && !mail.enabled && <Notice tone="warning">{t('needsMail')}</Notice>}
      <p className="-mt-2 text-xs text-muted">{t('magicLinkHelp')}</p>
      <SwitchInput label={t('username')} isSelected={v.username} onChange={set('username')} isDisabled={readOnly}/>
      <p className="-mt-2 text-xs text-muted">{t('usernameHelp')}</p>
    </FormSection>

    <FormSection title={t('checks')} description={t('checksHelp')} icon={<I name="shield-check" size={16}/>}>
      <SwitchInput label={t('pwned')} isSelected={v.pwnedPasswords} onChange={set('pwnedPasswords')} isDisabled={readOnly}/>
      <p className="-mt-2 text-xs text-muted">{t('pwnedHelp')}</p>
      <SwitchInput label={t('disposable')} isSelected={v.blockDisposable} onChange={set('blockDisposable')} isDisabled={readOnly}/>
      <p className="-mt-2 text-xs text-muted">{t('disposableHelp')}</p>
    </FormSection>
    {!readOnly && <FormActions><Button isPending={busy} onPress={save}><I name="check" size={16}/>{ts('save')}</Button></FormActions>}
  </Card.Content></Card>;
}
