"use client";
// The page side of lib/undo.ts: hide the item, show "Removed · Undo" for a few seconds, then send the removal.
// The Undo button is in the message (a toast region the keyboard reaches with F6, as every message of the panel),
// the message stays while it is hovered or focused, and a screen reader hears both the removal and the undo.
import { toast } from '@heroui/react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { useErrorText } from '../lib/api';
import { Holder, UNDO_CAP_MS, UNDO_MS, type Commit } from '../lib/undo';

// One holder for the whole tab: a removal waiting on one page is still sent after moving to another.
const holder = new Holder();
let listening = false;
const listen = () => {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  // Closing or reloading the tab sends what is waiting (keepalive requests outlive the page).
  window.addEventListener('pagehide', () => { void Promise.allSettled(holder.releaseAll()); });
};

export function useUndoableRemove() {
  const t = useTranslations('Undo');
  const { error } = useErrorText();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  useEffect(listen, []);
  const show = (id: string) => setHidden((h) => { const n = new Set(h); n.delete(id); return n; });
  const remove = useCallback((o: { id: string; text: string; commit: Commit; done?: () => void }) => {
    if (!holder.hold(o.id, o.commit)) return;
    setHidden((h) => new Set(h).add(o.id));
    let key = '';
    const send = () => {
      clearTimeout(cap);
      holder.release(o.id)?.then(() => o.done?.(), (e) => { show(o.id); toast.danger(t('failed', { reason: error(e) })); });
    };
    const cap = setTimeout(() => { toast.close(key); send(); }, UNDO_CAP_MS);
    key = toast(o.text, { timeout: UNDO_MS, onClose: send, actionProps: { children: t('undo'), size: 'sm', variant: 'secondary', onPress: () => {
      clearTimeout(cap);
      if (holder.undo(o.id)) { show(o.id); toast.close(key); toast.info(t('undone')); }
    } } });
  }, [t, error]);
  return { hidden, remove };
}
