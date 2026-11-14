"use client";
import { Button } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';
import { I } from '../../components/icon';
import { ButtonLink } from '../../components/ui';

// A page that failed while drawing keeps the panel around it (menu, header) and offers a way on, instead of a blank
// screen: try the page again, or go to the start page.
export default function PanelError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations('ErrorPage');
  useEffect(() => { console.error(error); }, [error]);
  return <div role="alert" className="mx-auto flex max-w-lg flex-col items-center gap-3 py-16 text-center">
    <span aria-hidden className="grid size-14 place-items-center rounded-2xl bg-danger/10 text-danger"><I name="triangle-alert" size={28}/></span>
    <h1 className="text-xl font-semibold">{t('title')}</h1>
    <p className="text-sm text-muted">{t('body')}</p>
    {error.digest && <p className="font-mono text-xs text-muted">{t('code', { code: error.digest })}</p>}
    <div className="mt-2 flex flex-wrap justify-center gap-2">
      <Button onPress={reset}><I name="refresh-cw" size={16}/>{t('retry')}</Button>
      <ButtonLink href="/" variant="secondary"><I name="house" size={16}/>{t('home')}</ButtonLink>
    </div>
  </div>;
}
