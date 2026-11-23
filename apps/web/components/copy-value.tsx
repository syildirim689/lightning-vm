"use client";
import { Button } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useCopy } from '../lib/clipboard';
import { I } from './icon';

// A small copy button beside a value people paste elsewhere (an invoice or ticket number): "copied" only when it was.
export function CopyValue({ text, what, className = '' }: { text: string; what: string; className?: string }) {
  const t = useTranslations('CopyValue');
  const copy = useCopy();
  return <Button size="sm" variant="ghost" isIconOnly aria-label={t('copy', { what })} className={`min-h-9 min-w-9 print:hidden ${className}`}
    onPress={() => void copy(text, t('copied', { what }))}><I name="copy" size={15}/></Button>;
}
