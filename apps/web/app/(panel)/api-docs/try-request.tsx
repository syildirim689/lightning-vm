"use client";
// "Run this request": sends one documented route to this panel's own API from the reference page, with the session
// the person is signed in with. The request is built by lib/api-reference.ts from the route and what was typed, shown
// before it is sent, and anything that is not a GET is sent only after a confirmation that repeats it. The API sees
// an ordinary request of that session: permissions, limits and the audit log apply as everywhere else. Nothing typed
// or answered is stored or logged, and what looks like a secret in an answer is not shown.
import { Button } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { I } from '../../../components/icon';
import { ConfirmButton, Notice, StatusChip, TextInput } from '../../../components/ui';
import { buildRequest, exampleBody, notRunnable, pathParams, previewRequest, queryFields, shownBody, shownBodyLimit, takesBody, type Endpoint, type Lang } from '../../../lib/api-reference';

type Answer = { status: number; statusText: string; ms: number; headers: [string, string][]; body: ReturnType<typeof shownBody>; type: string; bytes: number; truncated: boolean } | { failed: 'network' | 'timeout' };
// The headers of an answer worth reading here: its type, the request's id, and the limits a token would be told.
const shownHeaders = ['content-type', 'x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after', 'location'];
const timeoutMs = 30_000;
const newKey = () => `try-${typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

// At most `limit` bytes of the body are read; the rest of a long answer (a download, a stream) is let go.
async function readCapped(res: Response, limit: number) {
  if (!res.body) return { text: '', bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0, truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > limit) { truncated = true; await reader.cancel().catch(() => undefined); break; }
    chunks.push(value);
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return { text: new TextDecoder().decode(all), bytes, truncated };
}

export function TryRequest({ e, lang }: { e: Endpoint; lang: Lang }) {
  const t = useTranslations('ApiDocs.try');
  const reason = notRunnable(e);
  const [open, setOpen] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<Record<string, string>>({});
  const example = exampleBody(e);
  const [body, setBody] = useState(() => (takesBody(e) && example !== undefined ? JSON.stringify(example, null, 2) : ''));
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  // The key that makes a repeated change safe: a new one for every request sent.
  useEffect(() => { if (open && e.idempotencyKey && !key) setKey(newKey()); }, [open, e.idempotencyKey, key]);

  const title = <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">{t('title')}</h4>;
  if (reason) return <div className="flex min-w-0 flex-col gap-1.5" data-testid="try-request">{title}<p className="text-sm text-muted">{t(`not.${reason}`)}</p></div>;
  if (!open) return <div className="flex min-w-0 flex-col items-start gap-1.5" data-testid="try-request">{title}
    <p className="text-sm text-muted">{t('intro')}</p>
    <Button size="sm" variant="secondary" onPress={() => setOpen(true)}><I name="play" size={14}/>{t('open')}</Button></div>;

  const built = buildRequest(e, { params, query, body, idempotencyKey: key });
  const preview = built.request ? previewRequest(built.request, t('cookieNote')) : null;
  async function send() {
    if (!built.request || busy) return;
    const r = built.request;
    const control = new AbortController();
    abort.current = control;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; control.abort(); }, timeoutMs);
    setBusy(true); setAnswer(null);
    const started = performance.now();
    try {
      // Same origin only, with the browser's own session cookie; a redirect is shown, not followed.
      const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body, credentials: 'same-origin', redirect: 'manual', cache: 'no-store', signal: control.signal });
      const type = res.headers.get('content-type') ?? '';
      const read = await readCapped(res, shownBodyLimit);
      setAnswer({ status: res.status, statusText: res.statusText, ms: Math.round(performance.now() - started), type, bytes: read.bytes, truncated: read.truncated,
        headers: shownHeaders.flatMap((h) => { const v = res.headers.get(h); return v ? [[h, v] as [string, string]] : []; }), body: shownBody(type, read.text, read.truncated) });
    } catch { setAnswer({ failed: timedOut ? 'timeout' : 'network' }); }
    finally { clearTimeout(timer); setBusy(false); if (e.idempotencyKey) setKey(newKey()); }
  }
  const tone = (s: number) => (s === 0 ? 'default' : s < 300 ? 'success' : s < 400 ? 'default' : s < 500 ? 'warning' : 'danger');
  const field = (name: string, required: boolean, value: string, set: (v: string) => void, help?: string) => <TextInput key={name} label={name} value={value} onChange={set} isRequired={required} spellCheck={false}
    autoComplete="off" maxLength={300} help={help}/>;
  return <div className="flex min-w-0 flex-col gap-3" data-testid="try-request">
    {title}
    <Notice tone={e.method === 'GET' ? 'default' : 'warning'}>{e.method === 'GET' ? t('realRead') : t('realChange')}</Notice>
    {(pathParams(e).length > 0 || queryFields(e).length > 0) && <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      {pathParams(e).map((p) => field(p, true, params[p] ?? '', (v) => setParams({ ...params, [p]: v }), e.params?.find((x) => x.name === p)?.text[lang]))}
      {queryFields(e).map((q) => field(q.name, !!q.required, query[q.name] ?? '', (v) => setQuery({ ...query, [q.name]: v }), q.text[lang]))}
    </div>}
    {takesBody(e) && <label className="flex min-w-0 flex-col gap-1 text-sm"><span className="font-medium">{t('body')}</span>
      <textarea value={body} onChange={(ev) => setBody(ev.target.value)} spellCheck={false} autoComplete="off" rows={Math.min(14, Math.max(3, body.split('\n').length))}
        className="w-full min-w-0 rounded-lg border border-border bg-transparent p-2 font-mono text-xs outline-none focus:border-accent"/></label>}
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs font-medium text-muted">{t('preview')}</p>
      {preview ? <pre data-testid="try-preview" className="max-h-72 min-w-0 overflow-auto whitespace-pre-wrap rounded-lg bg-default p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{preview}</pre>
        : <ul role="alert" data-testid="try-problems" className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm text-warning">
          {built.problems!.map((p) => <li key={`${p.field}-${p.code}`} className="flex items-start gap-2"><I name="circle-alert" size={14} className="mt-0.5 shrink-0"/>{t(`problem.${p.code}`, { field: p.field })}</li>)}</ul>}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      {e.method === 'GET'
        ? <Button size="sm" isDisabled={!built.request} isPending={busy} onPress={() => void send()}><I name="play" size={14}/>{t('send')}</Button>
        : <ConfirmButton size="sm" variant={e.method === 'DELETE' ? 'danger' : 'primary'} icon={<I name="play" size={14}/>} label={t('send')} isDisabled={!built.request || busy}
            title={t('confirmTitle', { method: e.method })} confirmLabel={t('confirmSend', { method: e.method })} cancelLabel={t('cancel')} onConfirm={send}
            body={<span className="flex flex-col gap-2"><span>{t('confirmBody')}</span>
              <span className="block max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-default p-2 font-mono text-xs text-foreground [overflow-wrap:anywhere]">{preview}</span></span>}/>}
      <Button size="sm" variant="ghost" onPress={() => { abort.current?.abort(); setOpen(false); setAnswer(null); }}>{t('close')}</Button>
    </div>
    <div aria-live="polite" className="min-w-0">
      {answer && ('failed' in answer
        ? <Notice tone="danger">{t(`failed.${answer.failed}`, { seconds: timeoutMs / 1000 })}</Notice>
        : <div data-testid="try-response" className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3">
          <p className="flex flex-wrap items-center gap-2 text-sm"><span className="font-semibold">{t('answer')}</span>
            <StatusChip tone={tone(answer.status)}>{answer.status === 0 ? t('redirected') : `${answer.status} ${answer.statusText}`.trim()}</StatusChip>
            <span className="text-xs text-muted">{t('took', { ms: answer.ms })}</span></p>
          {answer.headers.length > 0 && <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 font-mono text-xs">
            {answer.headers.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd className="[overflow-wrap:anywhere]">{v}</dd></div>)}</dl>}
          {answer.body.kind === 'empty' ? <p className="text-sm text-muted">{t('noBody')}</p>
            : answer.body.kind === 'other' ? <p className="text-sm text-muted">{t(answer.truncated ? 'tooLarge' : 'notShown', { type: answer.type || '–', kb: Math.round(shownBodyLimit / 1000) })}</p>
            : <pre className="max-h-96 min-w-0 overflow-auto whitespace-pre-wrap rounded-lg bg-default p-3 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{answer.body.text}</pre>}
          {answer.body.hidden > 0 && <p className="flex items-start gap-1.5 text-xs text-muted"><I name="eye-off" size={13} className="mt-0.5 shrink-0"/>{t('hidden', { n: answer.body.hidden })}</p>}
        </div>)}
    </div>
  </div>;
}
