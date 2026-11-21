"use client";
// Staff only: the closed tickets most like this one (GET /admin/support/tickets/:id/similar), each with the answer that
// closed it, the words the two tickets share (why it is shown) and a button that copies the answer. Nothing is sent
// or written by itself: what to tell the customer stays the agent's decision.
import NextLink from 'next/link';
import { Button } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { I } from '../../../../../components/icon';
import { Ago } from '../../../../../components/ui';
import { useCopy } from '../../../../../lib/clipboard';
import { useApiQuery } from '../../../../../lib/query';

type Similar = { id: string; number: number; subject: string; closedAt: string | null; rating: number | null; score: number; shared: string[]; answer: string };

export function SimilarTickets({ id }: { id: string }) {
  const t = useTranslations('SupportHelp');
  const copy = useCopy();
  const d = useApiQuery<{ compared: number; similar: Similar[] }>(['admin', 'support', 'similar', id], `/admin/support/tickets/${id}/similar`).data;
  if (!d) return null;
  return <section aria-labelledby="similar-tickets" className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-4">
    <div>
      <h2 id="similar-tickets" className="flex items-center gap-2 text-sm font-semibold"><I name="lightbulb" size={16} className="text-accent"/>{t('similarTitle')}</h2>
      <p className="text-xs text-muted">{t('similarHelp', { n: d.compared })}</p>
    </div>
    {d.similar.length === 0 ? <p className="text-sm text-muted">{t('similarNone')}</p>
      : <ul className="flex flex-col divide-y divide-separator">
        {d.similar.map((s) => <li key={s.id} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <NextLink href={`/admin/support/${s.id}`} className="text-sm font-medium [overflow-wrap:anywhere] hover:underline focus-visible:outline-2 focus-visible:outline-accent">#{s.number} · {s.subject}</NextLink>
            {s.closedAt && <span className="text-xs text-muted">{t('closed')} <Ago at={s.closedAt}/></span>}
            {s.rating !== null && <span className="text-xs text-muted">{t('rated', { rating: s.rating })}</span>}
          </div>
          <p className="text-xs text-muted">{t('shares', { words: s.shared.join(', ') })}</p>
          <p className="line-clamp-4 whitespace-pre-wrap rounded-lg bg-default/60 px-3 py-2 text-sm [overflow-wrap:anywhere]">{s.answer}</p>
          <Button size="sm" variant="ghost" className="self-start" onPress={() => void copy(s.answer, t('copied'))} aria-label={t('copyLabel', { number: s.number })}><I name="copy" size={14}/>{t('copy')}</Button>
        </li>)}
      </ul>}
  </section>;
}
