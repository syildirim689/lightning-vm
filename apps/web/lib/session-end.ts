"use client";
// What this browser keeps for the person signed in, and when it goes. Nothing of the panel's client is imported here
// (api.ts calls this file, and its test, session-end.test.ts, runs it under node as it is): only saved-views.ts,
// which is free of the browser too.
import { forgetLocalViews } from './saved-views.ts';
//
// Every key the panel writes is in one of the lists below; the test fails for a key that is in none.
// - contentKeys name the person's data (half-written messages, the servers, tickets and invoices they opened, the
//   order they were composing, the staff dashboard's "since your last visit"). They go when the session ends,
//   however it ends, and when the panel finds that the browser's content belongs to somebody else (claimLocal).
// - preferenceKeys describe how this browser shows the panel (theme, text size, which menu is open). They name
//   nobody's data and stay.
// - separateKeys are being moved to the account by their own code (lib/saved-views.ts, when their owner opens the
//   list): they stay through claimLocal so that they can still be moved, and go when a session ends (forgetLocal).
//   A sign-out sends the signing-out account's own to the account first (lib/auth-client.ts, while there still is a
//   session to send them with); any other end of a session has none, and removes them unsent.
type Keys = { exact: readonly string[]; prefix: readonly string[] };
export const contentKeys: { local: Keys; session: Keys } = {
  local: {
    // lvm-recent: lib/recent.ts. lvm-dashboard-seen: components/digest.tsx. The new-ticket draft: app/(panel)/support/list.tsx.
    exact: ['lvm-recent', 'lvm-dashboard-seen', 'lvm:support-new-draft'],
    // lvm:draft: is lib/drafts.ts (dispute, incident and bulk messages); the reply drafts are app/(panel)/support/ui.tsx.
    prefix: ['lvm:draft:', 'lvm:support-draft:'],
  },
  session: {
    // The order being composed (lib/order-store.ts), the tasks put aside (components/task-manager.tsx), a restart or
    // update of the panel's server that this tab is following (components/host-task.tsx).
    exact: ['lvm-order', 'lvm:tasks-cleared', 'lvm:host-task'],
    // Sort and page of a table, per address: the address may carry the id of a server, ticket or person (components/ui.tsx).
    prefix: ['lvm:table:'],
  },
};
export const preferenceKeys: readonly string[] = [
  'lvm-a11y', 'theme', 'lvm-nav-open', 'lvm-server-view', 'lvm.terminalFont', 'lvm.snippetOs', 'lvm-first-steps-hidden', 'lvm-announcement-closed',
  // Read by the sign-in form before there is a session: which second step was used last.
  'lvm-2fa-method',
  // The live walls' look, tour and keeping the screen on (components/wall/hooks.ts): how this screen shows a wall.
  'lvm-wall-look', 'lvm-wall-tour', 'lvm-wall-awake',
  // Cookies the panel's own pages set: language and time zone.
  'NEXT_LOCALE', 'lvm-tz',
];
export const separateKeys: readonly string[] = ['lvm:views:'];

// Whose content the lists above hold: "user|staff member signed in as them". Kept in both storages (a tab brings its
// own sessionStorage back when it is restored) and removed with the content.
export const ownerKey = 'lvm-owner';
// Tells what holds a copy in memory (the order draft's store) that the content is gone.
export const forgetEvent = 'lvm:forget';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const storeOf = (name: 'localStorage' | 'sessionStorage'): Store | null => {
  try { return (globalThis as unknown as Record<string, Store | undefined>)[name] ?? null; } catch { return null; }
};

function wipe(store: Store | null, keys: Keys) {
  try {
    if (!store) return;
    const gone: string[] = [];
    for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k !== null && (keys.exact.includes(k) || keys.prefix.some((p) => k.startsWith(p)))) gone.push(k); }
    for (const k of gone) store.removeItem(k);
  } catch { /* storage blocked */ }
}
const announce = () => { try { if (typeof window !== 'undefined') window.dispatchEvent(new Event(forgetEvent)); } catch { /* no window */ } };

// Removes every content key from this tab's two storages, and the saved views an earlier version left in this
// browser. The next account on a shared computer finds none of it.
export function forgetLocal() {
  const local = storeOf('localStorage'), session = storeOf('sessionStorage');
  wipe(local, contentKeys.local); wipe(session, contentKeys.session);
  forgetLocalViews(local);
  for (const s of [local, session]) try { s?.removeItem(ownerKey); } catch { /* storage blocked */ }
  announce();
}

// Notifications of the account that are still on screen (they name its servers, tickets and invoices) are closed.
export async function closeNotifications() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    for (const n of (await reg?.getNotifications?.()) ?? []) n.close();
  } catch { /* no service worker here, or the browser refused */ }
}
// The browser's side of Web Push: its subscription ends, so nothing more arrives for the account that had it.
async function dropPush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/');
    await (await reg?.pushManager?.getSubscription())?.unsubscribe();
  } catch { /* no service worker here, or the browser refused */ }
  await closeNotifications();
}

// A session that ended without a sign-out (ran out, ended from elsewhere, the account blocked). The browser must also
// stop showing that account's notifications. The API cannot be told to drop the push subscription any more (there is
// no session), so the browser's side goes: the push service then answers "gone" and the API removes its row on the
// next send.
export async function sessionEnded() {
  forgetLocal();
  await dropPush();
}

// The person at the keyboard: the staff member while they are signed in as somebody, else the account itself.
const person = (owner: string) => { const [user, staff] = owner.split('|'); return staff || user; };

// Called when the panel opens for an account, before anything reads the storage (the shell, while it renders).
// Content that was written for another account, or for nobody the browser knows of, is removed first: a session
// that ended with the browser closed, another account signing in over one that never signed out, a restored tab,
// and both ends of "sign in as" (a staff member's drafts do not follow them into a customer's panel, nor the other
// way). Answers whether anything was removed. Browser notifications follow the person: they end when somebody else
// is at the keyboard, and stay for a staff member who enters or leaves "sign in as".
export function claimLocal(userId: string, impersonatedBy: string | null = null): boolean {
  const owner = `${userId}|${impersonatedBy ?? ''}`;
  let changed = false, before: string | null = null;
  for (const [name, keys] of [['localStorage', contentKeys.local], ['sessionStorage', contentKeys.session]] as const) {
    const s = storeOf(name);
    let had: string | null = null;
    try { had = s?.getItem(ownerKey) ?? null; } catch { /* storage blocked */ }
    if (had === owner) continue;
    if (name === 'localStorage') before = had;
    wipe(s, keys); changed = true;
    try { s?.setItem(ownerKey, owner); } catch { /* storage blocked: checked again on the next page */ }
  }
  if (changed) announce();
  if (before !== null && person(before) !== person(owner)) void dropPush();
  return changed;
}
