"use client";
import { Button, Dropdown, Label, Tooltip } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { useEffect, useState, useTransition } from 'react';
import { setLocale } from '../i18n/actions';
import { I } from './icon';

export function ThemeToggle() {
  const t = useTranslations('Nav');
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const dark = mounted && resolvedTheme === 'dark';
  return <Tooltip delay={400}>
    <Button isIconOnly variant="ghost" size="sm" aria-label={dark ? t('lightTheme') : t('darkTheme')} onPress={() => setTheme(dark ? 'light' : 'dark')}>
      {dark ? <I name="sun" size={18}/> : <I name="moon" size={18}/>}
    </Button>
    <Tooltip.Content>{dark ? t('lightTheme') : t('darkTheme')}</Tooltip.Content>
  </Tooltip>;
}

export function LanguageMenu() {
  const t = useTranslations('Nav');
  const locale = useLocale();
  const router = useRouter();
  const [, start] = useTransition();
  const choose = (l: string) => start(async () => { const f = new FormData(); f.set('locale', l); await setLocale(f); router.refresh(); });
  return <Dropdown>
    <Button variant="ghost" size="sm" aria-label={`${t('language')}: ${locale}`}><span className="font-mono text-xs uppercase">{locale}</span></Button>
    <Dropdown.Popover placement="bottom end">
      <Dropdown.Menu aria-label={t('language')} onAction={(k) => choose(String(k))}>
        <Dropdown.Item id="tr" textValue="Türkçe"><Label lang="tr">Türkçe</Label></Dropdown.Item>
        <Dropdown.Item id="en" textValue="English"><Label lang="en">English</Label></Dropdown.Item>
      </Dropdown.Menu>
    </Dropdown.Popover>
  </Dropdown>;
}
