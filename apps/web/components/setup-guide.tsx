"use client";
// "What is this, how do I set it up?" for anything that needs work outside the panel (PowerDNS, a Telegram bot,
// WhatsApp Cloud API, captcha keys, DNS records...). The text lives in messages/*.json under Guides.<id>, read
// raw so commands with braces stay as written.
import { Button, Modal } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { I } from './icon';

type Section = { title: string; text?: string; steps?: string[]; code?: string; note?: string };
type Guide = { title: string; intro: string; sections: Section[]; links?: { label: string; url: string }[] };

function Code({ text }: { text: string }) {
  const t = useTranslations('Guides');
  const [copied, setCopied] = useState(false);
  return <div className="group relative">
    <pre className="overflow-x-auto rounded-xl bg-default/60 p-3 pr-12 font-mono text-xs leading-relaxed"><code>{text}</code></pre>
    <button type="button" aria-label={t('copy')} onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      className="absolute right-2 top-2 grid size-8 place-items-center rounded-lg text-muted hover:bg-default hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
      <I name={copied ? 'check' : 'copy'} size={14}/>
    </button>
  </div>;
}

export function GuideButton({ id, size = 'sm' }: { id: string; size?: 'sm' | 'md' }) {
  const t = useTranslations('Guides');
  const [open, setOpen] = useState(false);
  const g = (t.raw as (key: string) => unknown)(id) as Guide;
  return <>
    <Button size={size} variant="ghost" onPress={() => setOpen(true)} className="w-fit"><I name="book-open" size={15}/>{t('open')}</Button>
    <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
      <Modal.Container scroll="inside">
        <Modal.Dialog className="w-[44rem] max-w-[calc(100vw-1.5rem)] bg-surface">
          <Modal.CloseTrigger/>
          <Modal.Header><Modal.Heading className="flex items-center gap-2"><I name="book-open" size={18} className="text-accent"/>{g.title}</Modal.Heading></Modal.Header>
          <Modal.Body className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto">
            <p className="text-sm leading-relaxed">{g.intro}</p>
            {g.sections.map((s, i) => <section key={i} className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 font-semibold"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent/15 text-xs text-accent">{i + 1}</span>{s.title}</h3>
              {s.text && <p className="text-sm leading-relaxed text-muted">{s.text}</p>}
              {s.steps && <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed">{s.steps.map((x, j) => <li key={j}>{x}</li>)}</ol>}
              {s.code && <Code text={s.code}/>}
              {s.note && <p className="flex gap-2 rounded-xl bg-warning/10 p-3 text-xs leading-relaxed text-warning"><I name="triangle-alert" size={14} className="mt-0.5 shrink-0"/>{s.note}</p>}
            </section>)}
            {g.links && g.links.length > 0 && <section className="flex flex-col gap-2 border-t border-separator pt-4">
              <h3 className="text-sm font-semibold">{t('sources')}</h3>
              <ul className="flex flex-col gap-1">{g.links.map((l) => <li key={l.url}>
                <a href={l.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-sm text-accent hover:underline">{l.label}<I name="external-link" size={13}/></a></li>)}</ul>
              <p className="text-xs text-muted">{t('disclaimer')}</p>
            </section>}
          </Modal.Body>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  </>;
}
