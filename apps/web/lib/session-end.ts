"use client";
import { clearDrafts } from './drafts';
import { clearRecent } from './recent';

// What this browser keeps for the person signed in: half-written messages and the servers they opened last. It goes
// when their session ends, however it ends, so the next account on a shared computer finds none of it.
export function forgetLocal() { clearDrafts(); clearRecent(); }

// A session that ended without a sign-out (ran out, ended from elsewhere, the account blocked). The browser must also
// stop showing that account's notifications. The API cannot be told to drop the push subscription any more (there is
// no session), so the browser's side goes: the push service then answers "gone" and the API removes its row on the
// next send. Nothing from ./api is imported here: api.ts calls this.
export async function sessionEnded() {
  forgetLocal();
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    await (await reg?.pushManager?.getSubscription())?.unsubscribe();
  } catch { /* no service worker here, or the browser refused */ }
}
