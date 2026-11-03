"use client";
import { useEffect } from 'react';

// Names the tab after what the page shows ("web-1 · Lightning VM") on pages whose subject is only known in the
// browser. The brand is the last part of the title the layout set; the unread count (notification bell) stays in front.
export function useDocTitle(text: string | undefined) {
  useEffect(() => {
    if (!text) return;
    const count = document.title.match(/^\(\d+\+?\) /)?.[0] ?? '';
    const brand = document.title.replace(/^\(\d+\+?\) /, '').split(' · ').pop();
    document.title = `${count}${text} · ${brand}`;
  }, [text]);
}
