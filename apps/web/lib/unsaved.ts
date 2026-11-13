"use client";
import { useEffect, useRef } from 'react';
import { formDirty } from './edits';

// While a form has unsaved changes: the browser asks before closing or reloading the tab, links in the app ask
// before leaving (components/leave-guard.tsx), and Ctrl/⌘+S runs save (instead of the browser's "save page").
export function useUnsaved(dirty: boolean, save?: () => void) {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    if (!dirty) return;
    formDirty(true);
    const leave = (e: BeforeUnloadEvent) => e.preventDefault();
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's' && latest.current) { e.preventDefault(); latest.current(); }
    };
    window.addEventListener('beforeunload', leave);
    window.addEventListener('keydown', key);
    return () => { formDirty(false); window.removeEventListener('beforeunload', leave); window.removeEventListener('keydown', key); };
  }, [dirty]);
}
