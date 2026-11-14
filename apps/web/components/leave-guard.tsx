"use client";
// A link inside the app would throw away text that was typed and not saved: ask first. "Stay" takes the person back
// to the first changed field; "Leave" drops the changes and goes. Closing or reloading the tab is asked by the browser
// itself (lib/edits.ts); the palette, shortcuts and menus ask through mayLeave. The browser's Back and Forward buttons
// ask too: the step is undone at once (the page stays), and "Leave" takes it again. Links that open a new tab, downloads and modified clicks (new tab/window) are left alone.
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { firstEdited, forgetEdits, hasPendingEdits } from '../lib/edits';
import { ConfirmDialog } from './ui';

// Not a path: the person pressed Back or Forward.
const back = '\u0000history';

export default function LeaveGuard() {
  const t = useTranslations('LeaveGuard');
  const router = useRouter();
  const [to, setTo] = useState<string | null>(null);
  useEffect(() => {
    // The page being edited, as the router left it in history (its state lets the router show it again).
    let here: { href: string; state: unknown } | null = null;
    const typed = () => { here = { href: window.location.href, state: window.history.state }; };
    // Runs before the router's own listener (capture on window), so the router never sees a step that is asked about.
    const pop = (e: PopStateEvent) => {
      if (!here || !hasPendingEdits()) return;
      const was = new URL(here.href);
      if (was.pathname === window.location.pathname && was.search === window.location.search) return;
      e.stopImmediatePropagation();
      window.history.pushState(here.state, '', here.href);
      setTo(back);
    };
    document.addEventListener('input', typed, true);
    window.addEventListener('popstate', pop, true);
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
    return () => { document.removeEventListener('click', click, true); window.removeEventListener('lvm:leave', asked);
      document.removeEventListener('input', typed, true); window.removeEventListener('popstate', pop, true); };
  }, []);
  const stay = () => {
    setTo(null);
    const el = firstEdited();
    if (el) setTimeout(() => { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 50);
  };
  return <ConfirmDialog isOpen={to !== null} onClose={stay} status="warning" title={t('title')} body={t('body')}
    confirmLabel={t('leave')} cancelLabel={t('stay')}
    onConfirm={() => { const next = to!; forgetEdits(); setTo(null); if (next === back) window.history.back(); else router.push(next); }}/>;
}
