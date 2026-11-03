"use client";
// A sticky row of chips for a long page: one per titled Section inside `root` (found as they load), the one being
// read is marked, a tap scrolls there. Hidden when the page has only a few sections.
import { useEffect, useRef, useState } from 'react';
import { I } from './icon';

type Item = { id: string; title: string };
const slug = (s: string) => `section-${s.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`;
const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

// lead: what the page is about (a server's name and state), shown at the start of the bar once the page header scrolled away.
export function SectionNav({ label, top, root, lead }: { label: string; top: string; root: React.RefObject<HTMLElement | null>; lead?: React.ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const [active, setActive] = useState<string>();
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const scan = () => {
      const found = [...el.querySelectorAll<HTMLElement>('[data-section]')].map((s) => { s.id ||= slug(s.dataset.section!); return { id: s.id, title: s.dataset.section! }; });
      setItems((prev) => prev.length === found.length && prev.every((p, i) => p.id === found[i].id && p.title === found[i].title) ? prev : found);
    };
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [root]);

  // The first section crossing the band under the header and this bar is the one being read.
  useEffect(() => {
    const seen = new Set<string>();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) e.isIntersecting ? seen.add(e.target.id) : seen.delete(e.target.id);
      const first = items.find((i) => seen.has(i.id));
      if (first) setActive(first.id);
    }, { rootMargin: '-120px 0px -55% 0px' });
    for (const i of items) { const n = document.getElementById(i.id); if (n) io.observe(n); }
    return () => io.disconnect();
  }, [items]);

  // Keep the marked chip in view inside the row (it scrolls sideways on phones).
  useEffect(() => {
    const ul = list.current;
    const chip = active && ul?.querySelector<HTMLElement>(`[data-id="${CSS.escape(active)}"]`);
    if (ul && chip) ul.scrollTo({ left: chip.offsetLeft - ul.clientWidth / 2 + chip.clientWidth / 2, behavior: smooth() });
  }, [active]);

  if (items.length < 4) return null;
  const go = (id: string) => { document.getElementById(id)?.scrollIntoView({ behavior: smooth(), block: 'start' }); setActive(id); };
  const scrolled = active && active !== items[0].id;
  return <nav aria-label={label} className="sticky top-14 z-20 -mx-4 flex items-center gap-2 border-b border-separator bg-background/85 px-4 py-2 backdrop-blur md:-mx-8 md:px-8 2xl:-mx-10 2xl:px-10">
    {lead && <div aria-hidden={!scrolled} className={`flex shrink-0 items-center overflow-hidden transition-[max-width,opacity] duration-300 ${scrolled ? 'max-w-[45%] opacity-100 sm:max-w-xs' : 'max-w-0 opacity-0'}`}>{lead}</div>}
    <I name="list" size={16} className={`hidden shrink-0 text-muted ${lead && scrolled ? '' : 'sm:block'}`}/>
    <ul ref={list} className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto [scrollbar-width:none]">
      {items.map((i) => <li key={i.id} className="shrink-0">
        <a href={`#${i.id}`} data-id={i.id} aria-current={active === i.id ? 'location' : undefined} onClick={(e) => { e.preventDefault(); go(i.id); }}
          className={`inline-flex min-h-8 items-center whitespace-nowrap rounded-full px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${active === i.id ? 'bg-accent text-accent-foreground' : 'bg-default text-muted hover:text-foreground'}`}>{i.title}</a>
      </li>)}
    </ul>
    <button type="button" aria-label={top} title={top} onClick={() => { window.scrollTo({ top: 0, behavior: smooth() }); setActive(items[0].id); }}
      className={`grid size-8 shrink-0 place-items-center rounded-full bg-default text-muted transition-opacity hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent ${scrolled ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      tabIndex={scrolled ? 0 : -1} aria-hidden={!scrolled}><I name="arrow-up" size={16}/></button>
  </nav>;
}
