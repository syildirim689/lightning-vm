"use client";
// While a customer writes a new ticket: what may answer it before it is sent (POST /support/suggestions). Only their
// own earlier tickets with support's answers and the incidents of the public status page come back; the text is sent
// for the comparison and is not stored. Asked a moment after typing stops; with nothing to show nothing is drawn.
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { I } from '../../../components/icon';
import { apiFetch } from '../../../lib/api';

type Found = {
  incidents: { id: string; title: string; impact: string; status: string; open: boolean }[];
  answers: { id: string; number: number; subject: string; status: string; shared: string[]; answer: string }[];
};

export function TicketSuggestions({ subject, body }: { subject: string; body: string }) {
  const t = useTranslations('SupportHelp');
  const [found, setFound] = useState<Found | null>(null);
  useEffect(() => {
    if (subject.trim().length + body.trim().length < 8) { setFound(null); return; }
    let stale = false;
    const timer = setTimeout(() => {
      apiFetch<Found>('/support/suggestions', { method: 'POST', body: { subject, body } }).then((r) => { if (!stale) setFound(r); }, () => { if (!stale) setFound(null); });
    }, 700);
    return () => { stale = true; clearTimeout(timer); };
  }, [subject, body]);
  if (!found || (!found.incidents.length && !found.answers.length)) return null;
  return <section aria-label={t('before')} className="flex flex-col gap-2 rounded-xl border border-accent/40 bg-accent/5 px-3 py-3">
    <p className="flex items-center gap-2 text-sm font-semibold"><I name="lightbulb" size={16} className="text-accent"/>{t('before')}</p>
    {found.incidents.map((i) => <NextLink key={i.id} href="/status" target="_blank" className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-accent">
      {i.open ? <I name="triangle-alert" size={15} className="mt-0.5 shrink-0 text-warning"/> : <I name="circle-check" size={15} className="mt-0.5 shrink-0 text-success"/>}
      <span className="min-w-0 [overflow-wrap:anywhere]"><span className="font-medium">{i.open ? t('incidentOpen') : t('incidentResolved')}</span> {i.title}</span>
    </NextLink>)}
    {found.answers.map((a) => <div key={a.id} className="flex flex-col gap-1 rounded-lg px-2 py-1.5">
      <NextLink href={`/support/${a.id}`} target="_blank" className="text-sm font-medium [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-accent">{t('yourTicket', { number: a.number, subject: a.subject })}</NextLink>
      <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted [overflow-wrap:anywhere]">{a.answer}</p>
      <p className="text-xs text-muted">{t('shares', { words: a.shared.join(', ') })}</p>
    </div>)}
    <p className="text-xs text-muted">{t('privacy')}</p>
  </section>;
}
