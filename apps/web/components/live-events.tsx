"use client";
// Listens to the API's live line (GET /api/live, Server-Sent Events) while the panel is open: a banned account,
// a changed password or revoked sessions sign this tab out at once with the reason; role and permission changes
// refresh what the panel shows and allows; a new notification rings the bell immediately. EventSource reconnects
// by itself; if the stream cannot open, "who am I" is asked, and a session that is gone leads to the sign-in page.
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { apiFetch } from '../lib/api';

export function signOutTo(reason: string) {
  window.location.replace(`/login?reason=${encodeURIComponent(reason)}`);
}

export default function LiveEvents() {
  const client = useQueryClient();
  const router = useRouter();
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const open = () => {
      source = new EventSource('/api/live');
      source.addEventListener('signed-out', (e) => { source?.close(); client.clear(); signOutTo(JSON.parse((e as MessageEvent).data).reason); });
      source.addEventListener('changed', (e) => {
        const { kind } = JSON.parse((e as MessageEvent).data) as { kind: string };
        // Roles, permissions or the sign-in policy: everything shown may differ now. Otherwise only the account.
        // The menu and page guards come from the server: they are rendered again too.
        if (kind === 'access' || kind === 'policy') void client.invalidateQueries();
        else void client.invalidateQueries({ queryKey: ['me'] });
        router.refresh();
      });
      source.addEventListener('notification', () => { void client.invalidateQueries({ queryKey: ['notifications'] }); });
      // A refused stream (401) is not retried by the browser: check the session, then try again later.
      source.onerror = () => {
        if (source?.readyState !== EventSource.CLOSED) return;
        apiFetch('/auth/me').then(() => { retry = setTimeout(open, 10_000); }, (err: { code?: string }) => {
          if (err?.code === 'UNAUTHENTICATED') signOutTo('expired'); else retry = setTimeout(open, 10_000);
        });
      };
    };
    open();
    return () => { source?.close(); clearTimeout(retry); };
  }, [client, router]);
  return null;
}
