"use client";
// Full-screen loading layer (blurred page behind, the brand mark inside a spinning ring) for the first load and
// for moves between pages. The first-load copy is rendered by the server (LoaderLayer in the root layout) and
// fades out once the page is interactive; on navigation the same layer appears after a short delay (so a fast
// change never flashes) and goes when the new page's URL is in place.
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

const startEvent = 'lvm:navigation-start';
const showAfterMs = 120;
const giveUpMs = 15_000;

// The layer itself; also used by the server for the first paint.
export function LoaderLayer({ label, id, hidden }: { label: string; id?: string; hidden?: boolean }) {
  return <div id={id} role="status" aria-live="polite" aria-busy={!hidden} className={`page-loader${hidden ? ' page-loader-hidden' : ''}`}>
    <div className="page-loader-mark">
      <span className="page-loader-ring" aria-hidden/>
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>
      </svg>
    </div>
    <span className="page-loader-label">{label}</span>
  </div>;
}

// Called before a programmatic navigation (router.push from the panel) so the layer can appear.
export function announceNavigation(href: string) {
  try {
    const next = new URL(href, location.href);
    if (next.origin === location.origin && next.pathname + next.search !== location.pathname + location.search) window.dispatchEvent(new Event(startEvent));
  } catch { /* not a URL */ }
}

function Watcher({ label }: { label: string }) {
  const path = usePathname();
  const search = useSearchParams()?.toString();
  const [shown, setShown] = useState(false);
  const timers = useRef<number[]>([]);
  const clear = () => { timers.current.forEach((t) => window.clearTimeout(t)); timers.current = []; };

  // First load: the server's copy fades out. It stays in the DOM: React owns it, and removing it by hand breaks the next navigation.
  useEffect(() => {
    const boot = document.getElementById('boot-loader');
    boot?.classList.add('page-loader-hidden');
    boot?.setAttribute('aria-busy', 'false');
  }, []);

  useEffect(() => {
    const start = () => {
      clear();
      timers.current.push(window.setTimeout(() => setShown(true), showAfterMs), window.setTimeout(() => setShown(false), giveUpMs));
    };
    // Plain clicks on links to another page of this site (new tabs, downloads and anchors on the same page are not navigations here).
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      announceNavigation(a.href);
    };
    window.addEventListener(startEvent, start);
    document.addEventListener('click', onClick, true);
    return () => { window.removeEventListener(startEvent, start); document.removeEventListener('click', onClick, true); clear(); };
  }, []);

  // The new page's URL is in place: done.
  useEffect(() => { clear(); setShown(false); }, [path, search]);

  return <LoaderLayer label={label} hidden={!shown}/>;
}

export default function PageLoader({ label }: { label: string }) {
  return <Suspense fallback={null}><Watcher label={label}/></Suspense>;
}
