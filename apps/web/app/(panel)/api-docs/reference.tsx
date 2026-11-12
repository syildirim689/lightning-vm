"use client";
// The API reference: a guide (sign-in with a token, answers and errors, idempotency, limits, long operations,
// webhooks, safe use) and every route of the panel, built from the API itself (GET /docs/reference), so it is
// always the running version's. Search, filters, example code in three languages, and the same as a PDF.
import { Button, Tabs, toast } from '@heroui/react';
import { useLocale, useTranslations } from 'next-intl';
import { parseAsString, useQueryState } from 'nuqs';
import { useEffect, useMemo, useState } from 'react';
import { I } from '../../../components/icon';
import { ButtonLink, Empty, Mono, Notice, PageHeader, Stat, StatusChip, SwitchInput } from '../../../components/ui';
import { apiFetch, useErrorText } from '../../../lib/api';
import { anchor, curl, exampleBody, guide, javascript, python, type Endpoint, type Field, type Lang, type Reference as Ref } from '../../../lib/api-reference';
import { useApiQuery } from '../../../lib/query';
import type { PublicConfig } from '../../../lib/session';

const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const methodTone: Record<string, string> = { GET: 'bg-success/15 text-success', POST: 'bg-accent-soft text-accent', PUT: 'bg-warning/15 text-warning',
  PATCH: 'bg-warning/15 text-warning', DELETE: 'bg-danger/10 text-danger', ALL: 'bg-default text-muted' };
const fold = (s: string) => s.toLocaleLowerCase('tr').normalize('NFD').replace(/[̀-ͯ]/g, '');

export function MethodBadge({ method }: { method: string }) {
  return <span className={`inline-flex w-16 shrink-0 justify-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold ${methodTone[method] ?? methodTone.ALL}`}>{method}</span>;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const t = useTranslations('ApiDocs');
  return <Button size="sm" variant="secondary" aria-label={label} onPress={() => { void navigator.clipboard?.writeText(text); toast.success(t('copied')); }}>
    <I name="copy" size={14}/>{t('copy')}</Button>;
}

function CodeBlock({ code, label }: { code: string; label: string }) {
  return <div className="relative min-w-0">
    <pre className="max-h-96 overflow-auto rounded-lg bg-default p-3 pr-24 font-mono text-xs leading-relaxed">{code}</pre>
    <div className="absolute right-2 top-2"><CopyButton text={code} label={label}/></div>
  </div>;
}

function Fields({ title, fields, lang }: { title: string; fields: Field[]; lang: Lang }) {
  const t = useTranslations('ApiDocs');
  if (!fields.length) return null;
  return <div className="flex min-w-0 flex-col gap-1.5">
    <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h4>
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[520px] text-sm">
        <thead className="bg-default text-left text-xs text-muted"><tr><th className="px-3 py-2 font-medium">{t('field')}</th><th className="px-3 py-2 font-medium">{t('type')}</th><th className="px-3 py-2 font-medium">{t('meaning')}</th></tr></thead>
        <tbody>{fields.map((f) => <tr key={f.name} className="border-t border-border align-top">
          <td className="px-3 py-2"><span className="flex flex-wrap items-center gap-1.5"><code className="font-mono text-xs [overflow-wrap:anywhere]">{f.name}</code>
            {f.required && <span className="rounded bg-danger/10 px-1 text-[10px] font-semibold uppercase text-danger">{t('required')}</span>}</span></td>
          <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted">{f.type}</td>
          <td className="px-3 py-2">{f.text[lang]}{f.values?.length ? <span className="mt-1 flex flex-wrap gap-1">{f.values.map((v) => <code key={v} className="rounded bg-default px-1 font-mono text-[11px]">{v}</code>)}</span> : null}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

function EndpointBody({ e, lang }: { e: Endpoint; lang: Lang }) {
  const t = useTranslations('ApiDocs');
  const tp = useTranslations('Permissions');
  const body = exampleBody(e);
  return <div className="flex flex-col gap-4 border-t border-border p-4">
    {e.details && <p className="text-sm">{e.details[lang]}</p>}
    <div className="flex flex-wrap gap-1.5 text-xs">
      {e.auth === 'public' ? <StatusChip tone="default">{t('public')}</StatusChip>
        : e.permissions.length ? e.permissions.map((p) => <StatusChip key={p} tone={e.allowed ? 'success' : 'warning'}><span title={p}>{tp(`p.${p.replace('.', '_')}` as 'p.servers_create')}</span></StatusChip>)
        : <StatusChip tone="default">{t('signedIn')}</StatusChip>}
      {e.method !== 'GET' && <StatusChip tone="default">{t('writeToken')}</StatusChip>}
      {e.tokens === false && <StatusChip tone="warning">{t('panelOnly')}</StatusChip>}
      {e.idempotencyKey && <StatusChip tone="accent">Idempotency-Key</StatusChip>}
      <StatusChip tone="default">{t('statusCode', { status: e.status })}</StatusChip>
    </div>
    <Fields title={t('params')} fields={e.params ?? []} lang={lang}/>
    <Fields title={t('query')} fields={e.query ?? []} lang={lang}/>
    <Fields title={t('body')} fields={e.body ?? []} lang={lang}/>
    {body !== undefined && <div className="flex flex-col gap-1.5"><h4 className="text-xs font-semibold uppercase tracking-wider text-muted">{t('example')}</h4>
      <CodeBlock code={JSON.stringify(body, null, 2)} label={t('copyExample')}/></div>}
    <div className="flex min-w-0 flex-col gap-1.5">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">{t('code')}</h4>
      <Tabs aria-label={t('code')}>
        <Tabs.ListContainer><Tabs.List aria-label={t('code')}>
          {['cURL', 'JavaScript', 'Python'].map((k) => <Tabs.Tab key={k} id={k}>{k}<Tabs.Indicator/></Tabs.Tab>)}
        </Tabs.List></Tabs.ListContainer>
        <Tabs.Panel id="cURL" className="pt-2"><CodeBlock code={curl(e)} label={t('copyCode', { lang: 'cURL' })}/></Tabs.Panel>
        <Tabs.Panel id="JavaScript" className="pt-2"><CodeBlock code={javascript(e)} label={t('copyCode', { lang: 'JavaScript' })}/></Tabs.Panel>
        <Tabs.Panel id="Python" className="pt-2"><CodeBlock code={python(e)} label={t('copyCode', { lang: 'Python' })}/></Tabs.Panel>
      </Tabs>
    </div>
    {e.returns && <p className="text-sm"><span className="font-semibold">{t('returns')}: </span>{e.returns[lang]}</p>}
    {!!e.errors?.length && <div className="flex flex-wrap items-center gap-1.5 text-sm"><span className="font-semibold">{t('errors')}:</span>
      {e.errors.map((c) => <code key={c} className="rounded bg-default px-1.5 py-0.5 font-mono text-xs">{c}</code>)}</div>}
  </div>;
}

export default function Reference() {
  const t = useTranslations('ApiDocs');
  const tt = t as unknown as (key: string, values?: Record<string, string | number>) => string;
  const lang = (useLocale() === 'tr' ? 'tr' : 'en') as Lang;
  const { error } = useErrorText();
  const q = useApiQuery<Ref>(['api-reference'], '/docs/reference');
  const brand = useApiQuery<PublicConfig>(['public-config'], '/public/config').data?.branding.name ?? 'Lightning VM';
  const ref = q.data;
  const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
  const [tag, setTag] = useQueryState('tag', parseAsString.withDefault(''));
  const [method, setMethod] = useState<string | null>(null);
  const [mine, setMine] = useState(true);
  const [internal, setInternal] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [pdf, setPdf] = useState(false);

  // A shared link (#post-servers) opens and shows its route.
  useEffect(() => {
    if (!ref || !location.hash) return;
    const id = location.hash.slice(1);
    if (id.startsWith('guide-')) { requestAnimationFrame(() => openGuide(id.slice(6))); return; }
    const e = ref.endpoints.find((x) => anchor(x) === id);
    if (!e) return;
    setOpen((s) => new Set(s).add(e.key)); setMine(false); setInternal(!!e.internal);
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }));
  }, [ref]);

  const base = useMemo(() => ref?.endpoints.filter((e) => (internal || !e.internal) && (!mine || e.allowed)) ?? [], [ref, mine, internal]);
  const needle = fold(search.trim());
  const shown = base.filter((e) => (!method || e.method === method) && (!tag || e.tag === tag)
    && (!needle || fold(`${e.method} ${e.path} ${e.summary[lang]} ${e.details?.[lang] ?? ''} ${e.permissions.join(' ')}`).includes(needle)));
  const groups = (ref?.tags ?? []).map((g) => ({ ...g, items: shown.filter((e) => e.tag === g.key) })).filter((g) => g.items.length);
  const usable = ref?.endpoints.filter((e) => !e.internal && e.allowed).length ?? 0;
  const total = ref?.endpoints.filter((e) => !e.internal).length ?? 0;

  async function openapi() {
    try {
      const spec = await apiFetch<object>(`/docs/openapi.json?lang=${lang}${mine ? '&mine=1' : ''}`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }));
      a.download = `openapi-${lang}.json`; a.click(); URL.revokeObjectURL(a.href);
    } catch (e) { toast.danger(error(e)); }
  }
  async function makePdf() {
    if (!ref) return;
    setPdf(true);
    try { await downloadPdf(ref, base.filter((e) => !method || e.method === method).filter((e) => !tag || e.tag === tag), lang, tt, brand); toast.success(t('pdfReady')); }
    catch { toast.danger(t('pdfFailed')); }
    finally { setPdf(false); }
  }
  const toggle = (key: string, isOpen: boolean) => setOpen((s) => { const n = new Set(s); if (isOpen) n.add(key); else n.delete(key); return n; });

  return <div className="flex flex-col gap-6">
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('intro')}
      actions={<div className="flex flex-wrap gap-2">
        <Button onPress={makePdf} isPending={pdf} isDisabled={!ref}><I name="file-down" size={16}/>{pdf ? t('pdfWorking') : t('pdfButton')}</Button>
        <Button variant="secondary" onPress={openapi} isDisabled={!ref}><I name="braces" size={16}/>{t('openapi')}</Button>
        <ButtonLink href="/account?tab=api" variant="secondary"><I name="key-round" size={16}/>{t('createToken')}</ButtonLink>
      </div>}/>
    {!ref ? <p role="status" className="text-sm text-muted">{q.error ? error(q.error) : t('loading')}</p> : <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label={t('baseUrl')} value={<span className="break-all font-mono text-sm font-medium">{ref.baseUrl}</span>} icon={<I name="link" size={18}/>}
          hint={<button type="button" className="text-accent hover:underline" onClick={() => { void navigator.clipboard?.writeText(ref.baseUrl); toast.success(t('copied')); }}>{t('copy')}</button>}/>
        <Stat label={t('reach')} value={`${usable} / ${total}`} icon={<I name="route" size={18}/>} hint={t('reachHint')}/>
        <Stat label={t('rate')} value={ref.limits.rateLimit ? t('rateValue', { n: ref.limits.rateLimit }) : t('rateOff')} icon={<I name="gauge" size={18}/>} hint={t('rateHint')}/>
        <Stat label={t('version')} value={<span className="font-mono text-base">{ref.version}</span>} icon={<I name="tag" size={18}/>} hint={t('versionHint')}/>
      </div>
      {ref.limits.who === 'off' && <Notice tone="warning" title={t('tokensOff')}/>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label={t('contents')} className="lg:sticky lg:top-4 lg:self-start">
          <div className="flex flex-col gap-4 rounded-xl border border-border p-3 text-sm">
            <div className="flex flex-col gap-1">
              <p className="px-2 text-xs font-semibold uppercase tracking-wider text-muted">{t('guideTitle')}</p>
              {guide.map((g) => <a key={g.id} href={`#guide-${g.id}`} onClick={() => openGuide(g.id)} className="rounded-md px-2 py-1 hover:bg-default">{tt(`guide.${g.id}.title`)}</a>)}
            </div>
            <div className="flex flex-col gap-1">
              <p className="px-2 text-xs font-semibold uppercase tracking-wider text-muted">{t('referenceTitle')}</p>
              <button type="button" aria-pressed={!tag} onClick={() => setTag(null)} className={`flex justify-between rounded-md px-2 py-1 text-left hover:bg-default ${!tag ? 'bg-default font-medium' : ''}`}>
                {t('allGroups')}<span className="tabular-nums text-muted">{base.length}</span></button>
              {ref.tags.map((g) => { const n = base.filter((e) => e.tag === g.key).length; return n ? <button key={g.key} type="button" aria-pressed={tag === g.key}
                onClick={() => setTag(tag === g.key ? null : g.key)} className={`flex justify-between gap-2 rounded-md px-2 py-1 text-left hover:bg-default ${tag === g.key ? 'bg-default font-medium' : ''}`}>
                <span className="min-w-0">{g.name[lang]}</span><span className="tabular-nums text-muted">{n}</span></button> : null; })}
            </div>
          </div>
        </nav>

        <div className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="guide" className="flex flex-col gap-3">
            <h2 id="guide" className="text-lg font-semibold">{t('guideTitle')}</h2>
            {guide.map((g, i) => <details key={g.id} id={`guide-${g.id}`} open={i === 0} className="group scroll-mt-4 rounded-xl border border-border">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-4 font-medium">
                {tt(`guide.${g.id}.title`)}<I name="chevron-down" size={16} className="transition-transform group-open:rotate-180"/></summary>
              <div className="flex flex-col gap-3 border-t border-border p-4 text-sm leading-relaxed">
                {Array.from({ length: g.paras }, (_, n) => <p key={n}>{tt(`guide.${g.id}.p${n + 1}`, { rate: ref.limits.rateLimit, days: ref.limits.maxDays })}</p>)}
                {g.code && <CodeBlock code={g.code(ref.baseUrl)} label={t('copyCode', { lang: tt(`guide.${g.id}.title`) })}/>}
                {g.errors && <div className="overflow-x-auto rounded-lg border border-border"><table className="w-full min-w-[480px] text-sm">
                  <thead className="bg-default text-left text-xs text-muted"><tr><th className="px-3 py-2">HTTP</th><th className="px-3 py-2">{t('codeColumn')}</th><th className="px-3 py-2">{t('meaning')}</th></tr></thead>
                  <tbody>{ref.commonErrors.map((x) => <tr key={x.code} className="border-t border-border"><td className="px-3 py-2 tabular-nums">{x.status}</td>
                    <td className="px-3 py-2"><Mono>{x.code}</Mono></td><td className="px-3 py-2">{x.text[lang]}</td></tr>)}</tbody></table></div>}
              </div>
            </details>)}
          </section>

          <section aria-labelledby="reference" className="flex flex-col gap-4">
            <h2 id="reference" className="text-lg font-semibold">{t('referenceTitle')}</h2>
            <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
              <input type="search" role="searchbox" aria-label={t('search')} placeholder={t('searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value || null)}
                className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-accent"/>
              <div className="flex flex-wrap items-center gap-2">
                <div role="group" aria-label={t('methodFilter')} className="flex flex-wrap gap-1">
                  <Button size="sm" variant={method === null ? 'primary' : 'secondary'} aria-pressed={method === null} onPress={() => setMethod(null)}>{t('allMethods')}</Button>
                  {methods.map((m) => <Button key={m} size="sm" variant={method === m ? 'primary' : 'secondary'} aria-pressed={method === m} onPress={() => setMethod(method === m ? null : m)}>{m}</Button>)}
                </div>
                <div className="flex flex-wrap gap-4 sm:ml-auto">
                  <SwitchInput label={t('onlyMine')} isSelected={mine} onChange={setMine}/>
                  <SwitchInput label={t('showInternal')} isSelected={internal} onChange={setInternal}/>
                </div>
              </div>
              <p role="status" aria-atomic="true" className="text-xs text-muted">{t('shown', { n: shown.length, total: base.length })}</p>
            </div>

            {groups.length === 0 ? <Empty icon={<I name="search-x" size={28}/>} title={t('noMatch')}>
              <Button size="sm" variant="secondary" onPress={() => { void setSearch(null); void setTag(null); setMethod(null); setMine(false); }}>{t('clear')}</Button></Empty>
              : groups.map((g) => <div key={g.key} className="flex flex-col gap-2">
                <div><h3 className="text-base font-semibold">{g.name[lang]}</h3><p className="text-sm text-muted">{g.text[lang]}</p></div>
                {g.items.map((e) => <details key={e.key} id={anchor(e)} open={open.has(e.key)} onToggle={(ev) => toggle(e.key, (ev.target as HTMLDetailsElement).open)}
                  className="scroll-mt-4 rounded-xl border border-border bg-surface">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 p-3">
                    <MethodBadge method={e.method}/>
                    <code className="min-w-0 font-mono text-sm [overflow-wrap:anywhere]">{e.path}</code>
                    <span className="min-w-0 flex-1 text-sm text-muted">{e.summary[lang]}</span>
                    {!e.allowed && <span className="flex items-center gap-1 text-xs text-warning"><I name="lock" size={12}/>{t('notYours')}</span>}
                    {e.internal && <span className="text-xs text-muted">{t('internalBadge')}</span>}
                  </summary>
                  {open.has(e.key) && <>
                    <EndpointBody e={e} lang={lang}/>
                    <div className="flex justify-end border-t border-border p-2">
                      <Button size="sm" variant="ghost" onPress={() => { const url = `${location.origin}${location.pathname}#${anchor(e)}`; void navigator.clipboard?.writeText(url); history.replaceState(null, '', `#${anchor(e)}`); toast.success(t('linkCopied')); }}>
                        <I name="link" size={14}/>{t('copyLink')}</Button>
                    </div>
                  </>}
                </details>)}
              </div>)}
          </section>
        </div>
      </div>
    </>}
  </div>;
}

// A guide chapter reached from the contents or a link opens (a closed <details> would hide what was asked for).
function openGuide(id: string) {
  const d = document.getElementById(`guide-${id}`) as HTMLDetailsElement | null;
  if (!d) return;
  d.open = true;
  d.scrollIntoView({ block: 'start' });
}

// Loaded on demand: pdfmake and its fonts are large.
async function downloadPdf(...args: Parameters<typeof import('../../../lib/api-pdf').downloadReferencePdf>) {
  const { downloadReferencePdf } = await import('../../../lib/api-pdf');
  return downloadReferencePdf(...args);
}
