"use client";
// Settings → Messaging: which apps users may connect for notifications, and the accounts Telegram, WhatsApp
// and Pushover need (set up once here). Secrets are never shown again; an empty field keeps the saved one.
import { Button, Card, toast } from '@heroui/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { AppBadge } from '../../../../components/chat-app-badge';
import { I } from '../../../../components/icon';
import { GuideButton } from '../../../../components/setup-guide';
import { FormActions, FormSection, Notice, TextInput, Loading } from '../../../../components/ui';
import { apiFetch, useErrorText, type ApiError } from '../../../../lib/api';
import { useApiQuery } from '../../../../lib/query';

type Doc = { apps: string[]; usable: string[]; catalog: { id: string; name: string; website: string; docs: string; needs: string | null }[];
  telegram: { username: string; tokenSet: boolean }; whatsapp: { phoneNumberId: string; template: string; language: string; tokenSet: boolean }; pushover: { tokenSet: boolean } };

export default function ChatSettings({ readOnly }: { readOnly: boolean }) {
  const t = useTranslations('Settings');
  const { error, field } = useErrorText();
  const client = useQueryClient();
  const q = useApiQuery<Doc>(['settings', 'chat'], '/admin/settings/chat');
  const [apps, setApps] = useState<string[]>([]);
  const [tg, setTg] = useState('');
  const [wa, setWa] = useState({ token: '', phoneNumberId: '', template: '', language: 'tr' });
  const [po, setPo] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setApps(q.data.apps);
    setWa({ token: '', phoneNumberId: q.data.whatsapp.phoneNumberId, template: q.data.whatsapp.template, language: q.data.whatsapp.language });
  }, [q.data]);
  if (!q.data) return <Loading of={['settings', 'chat']}/>;
  const d = q.data;
  const on = (id: string) => apps.includes(id);
  const err = (k: string) => field(fields[k]);

  async function save() {
    setBusy(true); setFields({});
    try {
      const r = await apiFetch<Doc>('/admin/settings/chat', { method: 'PUT', body: { apps, telegram: { token: tg }, whatsapp: wa, pushover: { token: po } } });
      client.setQueryData(['settings', 'chat'], r); setTg(''); setPo(''); toast.success(t('saved'));
    } catch (e) { setFields((e as ApiError).fields ?? {}); toast.danger(error(e)); } finally { setBusy(false); }
  }

  return <Card><Card.Content className="flex flex-col">
    <FormSection title={t('chat.apps')} description={t('chat.appsHelp')} icon={<I name="messages-square" size={16}/>}>
      <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {d.catalog.map((a) => <li key={a.id}>
          <button type="button" role="checkbox" aria-checked={on(a.id)} disabled={readOnly} onClick={() => setApps(on(a.id) ? apps.filter((y) => y !== a.id) : [...apps, a.id])}
            className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60 ${on(a.id) ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50'}`}>
            <AppBadge app={a.id} size={30}/>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{a.name}</span>
              {on(a.id) && <span className={`text-xs ${d.usable.includes(a.id) ? 'text-success' : 'text-warning'}`}>{d.usable.includes(a.id) ? t('chat.ready') : t('chat.needsSetup')}</span>}
            </span>
            <span className={`grid size-5 shrink-0 place-items-center rounded-full border ${on(a.id) ? 'border-accent bg-accent text-accent-foreground' : 'border-border'}`}>
              {on(a.id) && <I name="check" size={13}/>}
            </span>
          </button>
        </li>)}
      </ul>
      <p className="text-xs text-muted">{t('chat.appsNote')}</p>
    </FormSection>

    {on('telegram') && <FormSection title="Telegram" description={t('chat.telegramHelp')} icon={<AppBadge app="telegram" size={20}/>} aside={<GuideButton id="telegram"/>}>
      {d.telegram.username && <Notice tone="success" title={t('chat.telegramBot', { bot: `@${d.telegram.username}` })}/>}
      <TextInput revealable label={t('chat.telegramToken')} type="password" value={tg} onChange={setTg} isDisabled={readOnly} error={err('telegram.token')} autoComplete="off" spellCheck={false}
        placeholder={d.telegram.tokenSet ? t('secretKept') : '123456789:AA…'} help={t('chat.telegramTokenHelp')}/>
    </FormSection>}

    {on('whatsapp') && <FormSection title="WhatsApp (Cloud API)" description={t('chat.whatsappHelp')} icon={<AppBadge app="whatsapp" size={20}/>} aside={<GuideButton id="whatsapp"/>}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput revealable label={t('chat.whatsappToken')} type="password" value={wa.token} onChange={(x) => setWa({ ...wa, token: x })} isDisabled={readOnly} error={err('whatsapp.token')}
          autoComplete="off" spellCheck={false} placeholder={d.whatsapp.tokenSet ? t('secretKept') : 'EAAG…'} help={t('chat.whatsappTokenHelp')}/>
        <TextInput maxLength={40} label={t('chat.whatsappPhoneId')} value={wa.phoneNumberId} onChange={(x) => setWa({ ...wa, phoneNumberId: x })} isDisabled={readOnly} error={err('whatsapp.phoneNumberId')} spellCheck={false}/>
        <TextInput maxLength={512} label={t('chat.whatsappTemplate')} value={wa.template} onChange={(x) => setWa({ ...wa, template: x })} isDisabled={readOnly} error={err('whatsapp.template')} spellCheck={false}
          placeholder="panel_bildirimi" help={t('chat.whatsappTemplateHelp')}/>
        <TextInput label={t('chat.whatsappLanguage')} value={wa.language} onChange={(x) => setWa({ ...wa, language: x })} isDisabled={readOnly} error={err('whatsapp.language')} maxLength={10} placeholder="tr"/>
      </div>
    </FormSection>}

    {on('pushover') && <FormSection title="Pushover" description={t('chat.pushoverHelp')} icon={<AppBadge app="pushover" size={20}/>} aside={<GuideButton id="pushover"/>}>
      <TextInput revealable label={t('chat.pushoverToken')} type="password" value={po} onChange={setPo} isDisabled={readOnly} error={err('pushover.token')} autoComplete="off" spellCheck={false}
        placeholder={d.pushover.tokenSet ? t('secretKept') : ''}/>
    </FormSection>}

    {!readOnly && <FormActions status={<span className="text-xs text-muted">{t('chat.testNote')}</span>}>
      <Button isPending={busy} onPress={save}><I name="check" size={16}/>{t('save')}</Button>
    </FormActions>}
  </Card.Content></Card>;
}
