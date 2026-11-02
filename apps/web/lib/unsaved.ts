"use client";
import { useEffect, useRef } from 'react';

// While a form has unsaved changes: the browser asks before closing or reloading the tab, and Ctrl/⌘+S runs save
// (instead of the browser's "save page").
// shortcut: in-app link clicks are not intercepted (the App Router has no hook for it); add one if users lose edits that way.
export function useUnsaved(dirty: boolean, save?: () => void) {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    if (!dirty) return;
    const leave = (e: BeforeUnloadEvent) => e.preventDefault();
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's' && latest.current) { e.preventDefault(); latest.current(); }
    };
    window.addEventListener('beforeunload', leave);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('beforeunload', leave); window.removeEventListener('keydown', key); };
  }, [dirty]);
}
