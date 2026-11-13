"use client";
// A link inside the app would throw away text that was typed and not saved: ask first. "Stay" takes the person back
// to the first changed field; "Leave" drops the changes and goes. Closing or reloading the tab is asked by the browser
// itself (lib/edits.ts); the palette, shortcuts and menus ask through mayLeave. Links that open a new tab, downloads and modified clicks (new tab/window) are left alone.
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { firstEdited, forgetEdits, hasPendingEdits } from '../lib/edits';
import { ConfirmDialog } from './ui';

export default function LeaveGuard() {
  const t = useTranslations('LeaveGuard');
  const router = useRouter();
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
      if (!hasPendingEdits()) return;
      e.preventDefault(); e.stopPropagation();
      setTo(url.pathname + url.search + url.hash);
    };
    const asked = (e: Event) => setTo((e as CustomEvent<string>).detail);
    document.addEventListener('click', click, true);
    window.addEventListener('lvm:leave', asked);
    return () => { document.removeEventListener('click', click, true); window.removeEventListener('lvm:leave', asked); };
  }, []);
  const stay = () => {
    setTo(null);
    const el = firstEdited();
    if (el) setTimeout(() => { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 50);
  };
  return <ConfirmDialog isOpen={to !== null} onClose={stay} status="warning" title={t('title')} body={t('body')}
    confirmLabel={t('leave')} cancelLabel={t('stay')}
    onConfirm={() => { const next = to!; forgetEdits(); setTo(null); router.push(next); }}/>;
}
