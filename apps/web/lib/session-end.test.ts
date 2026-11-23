import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { claimLocal, closeNotifications, contentKeys, forgetEvent, forgetLocal, ownerKey, preferenceKeys, separateKeys, sessionEnded } from './session-end.ts';

// A Storage as the browser's: keys in insertion order, removal while counting shifts the rest.
function fakeStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, String(v)); },
    removeItem: (k: string) => { data.delete(k); },
  };
}
type Fake = ReturnType<typeof fakeStore>;
const put = (name: string, value: unknown) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });

// Everything the panel writes, by where it lives. The values only have to be there.
const localContent = ['lvm-recent', 'lvm-dashboard-seen', 'lvm:support-new-draft', 'lvm:support-draft:7f3c', 'lvm:support-draft:91aa', 'lvm:draft:dispute:inv_1',
  'lvm:draft:bulk-message:subject', 'lvm:draft:bulk-message:body', 'lvm:draft:incident:new:title', 'lvm:draft:incident:new:body', 'lvm:draft:incident:42'];
const sessionContent = ['lvm-order', 'lvm:tasks-cleared', 'lvm:host-task', 'lvm:table:/servers:Servers', 'lvm:table:/admin/users/u_9:Sessions'];
const localKept = ['lvm-a11y', 'theme', 'lvm-nav-open', 'lvm-server-view', 'lvm.terminalFont', 'lvm.snippetOs', 'lvm-first-steps-hidden', 'lvm-announcement-closed', 'lvm-2fa-method',
  'lvm-setup-hidden', 'better-auth.message', 'somebody-else'];
// Saved views an earlier version left here (separateKeys): gone when a session ends, kept when the panel opens for an
// account (their owner's next visit to the list moves them to the account).
const localViews = ['lvm:views:u_1:servers', 'lvm:views:u_2:admin-payments'];
const sessionKept = ['nuqs-something', 'lvm-a11y'];

let local: Fake, session: Fake, events: string[], unsubscribed: number, closed: number;
const fill = (owner?: string) => {
  local = fakeStore(Object.fromEntries([...localContent, ...localKept, ...localViews].map((k) => [k, 'x'])));
  session = fakeStore(Object.fromEntries([...sessionContent, ...sessionKept].map((k) => [k, 'x'])));
  if (owner) { local.setItem(ownerKey, owner); session.setItem(ownerKey, owner); }
  put('localStorage', local); put('sessionStorage', session);
};
beforeEach(() => {
  fill(); events = []; unsubscribed = 0; closed = 0;
  put('window', { dispatchEvent: (e: Event) => { events.push(e.type); return true; } });
  put('navigator', { serviceWorker: { getRegistration: async () => ({
    pushManager: { getSubscription: async () => ({ unsubscribe: async () => { unsubscribed++; return true; } }) },
    getNotifications: async () => [{ close: () => { closed++; } }, { close: () => { closed++; } }],
  }) } });
});
const settle = () => new Promise((r) => setTimeout(r, 0));
const keysOf = (s: Fake) => [...s.data.keys()].sort();

test('the end of a session removes every content key from both storages and nothing else', () => {
  forgetLocal();
  assert.deepEqual(keysOf(local), [...localKept].sort());
  assert.deepEqual(keysOf(session), [...sessionKept].sort());
  assert.deepEqual(events, [forgetEvent]);
});

test('the lists the removal goes by are the ones this test fills', () => {
  const covered = (keys: { exact: readonly string[]; prefix: readonly string[] }, k: string) => keys.exact.includes(k) || keys.prefix.some((p) => k.startsWith(p));
  for (const k of localContent) assert.ok(covered(contentKeys.local, k), k);
  for (const k of sessionContent) assert.ok(covered(contentKeys.session, k), k);
  for (const k of contentKeys.local.exact) assert.ok(localContent.includes(k), k);
  for (const k of contentKeys.session.exact) assert.ok(sessionContent.includes(k), k);
  for (const p of contentKeys.local.prefix) assert.ok(localContent.some((k) => k.startsWith(p)), p);
  for (const p of contentKeys.session.prefix) assert.ok(sessionContent.some((k) => k.startsWith(p)), p);
  for (const k of [...localKept, ...localViews, ...sessionKept, ...preferenceKeys]) { assert.ok(!covered(contentKeys.local, k), k); assert.ok(!covered(contentKeys.session, k), k); }
  for (const k of localViews) assert.ok(separateKeys.some((p) => k.startsWith(p)), k);
  for (const p of separateKeys) assert.ok(localViews.some((k) => k.startsWith(p)), p);
});

test('a session that ended without a sign-out also ends browser notifications and closes the ones on screen', async () => {
  local.setItem(ownerKey, 'u_1|'); session.setItem(ownerKey, 'u_1|');
  await sessionEnded();
  assert.deepEqual(keysOf(local), [...localKept].sort());
  assert.deepEqual(keysOf(session), [...sessionKept].sort());
  assert.equal(unsubscribed, 1);
  assert.equal(closed, 2);
});

test('closing notifications alone leaves the subscription', async () => {
  await closeNotifications();
  assert.deepEqual([closed, unsubscribed], [2, 0]);
});

test('the same account opening the panel again keeps its content', async () => {
  fill('u_1|');
  assert.equal(claimLocal('u_1', null), false);
  for (const k of [...localContent, ...localViews]) assert.equal(local.getItem(k), 'x', k);
  for (const k of sessionContent) assert.equal(session.getItem(k), 'x', k);
  await settle();
  assert.deepEqual([events.length, unsubscribed], [0, 0]);
});

test('another account in the same browser finds none of the earlier content, and not its notifications', async () => {
  fill('u_1|');
  assert.equal(claimLocal('u_2', null), true);
  assert.deepEqual(keysOf(local), [...localKept, ...localViews, ownerKey].sort());
  assert.deepEqual(keysOf(session), [...sessionKept, ownerKey].sort());
  assert.equal(local.getItem(ownerKey), 'u_2|');
  assert.equal(session.getItem(ownerKey), 'u_2|');
  assert.deepEqual(events, [forgetEvent]);
  await settle();
  assert.equal(unsubscribed, 1);
});

test('content nobody is recorded for (a session that ended with the browser closed, an older version) is removed', async () => {
  assert.equal(claimLocal('u_1', null), true);
  assert.deepEqual(keysOf(local), [...localKept, ...localViews, ownerKey].sort());
  assert.deepEqual(keysOf(session), [...sessionKept, ownerKey].sort());
  await settle();
  // Whose the subscription is cannot be known: it is left to the session's own end.
  assert.equal(unsubscribed, 0);
});

test('"sign in as": the staff member\'s content does not follow into the customer\'s panel, nor back; their notifications stay', async () => {
  fill('staff_1|');
  assert.equal(claimLocal('cust_1', 'staff_1'), true);
  assert.deepEqual(keysOf(local), [...localKept, ...localViews, ownerKey].sort());
  assert.deepEqual(keysOf(session), [...sessionKept, ownerKey].sort());
  // What is typed while signed in as the customer…
  local.setItem('lvm:draft:dispute:inv_9', 'typed as the customer'); session.setItem('lvm-order', '{}'); local.setItem('lvm-recent', '[]');
  // …is gone when the staff member is back in their own account.
  assert.equal(claimLocal('staff_1', null), true);
  assert.deepEqual(keysOf(local), [...localKept, ...localViews, ownerKey].sort());
  assert.deepEqual(keysOf(session), [...sessionKept, ownerKey].sort());
  await settle();
  assert.equal(unsubscribed, 0);
  // Another staff member taking over the browser is another person.
  assert.equal(claimLocal('cust_1', 'staff_2'), true);
  await settle();
  assert.equal(unsubscribed, 1);
});

test('a restored tab brings back its own sessionStorage: only that is removed', () => {
  fill('u_2|');
  session.setItem(ownerKey, 'u_1|');
  assert.equal(claimLocal('u_2', null), true);
  for (const k of localContent) assert.equal(local.getItem(k), 'x', k);
  assert.deepEqual(keysOf(session), [...sessionKept, ownerKey].sort());
});

test('blocked or missing storage is not an error', async () => {
  const blocked = { get length(): number { throw new Error('blocked'); }, key: () => { throw new Error('blocked'); }, getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  put('localStorage', blocked); put('sessionStorage', undefined); put('navigator', {}); put('window', undefined);
  forgetLocal();
  assert.equal(claimLocal('u_1', null), true);
  await sessionEnded();
});

// ---- The source: every key the panel uses is in one of the lists ----
const root = join(import.meta.dirname, '..');
const sources = ['app', 'components', 'lib', 'i18n', 'public'].flatMap((dir) => (readdirSync(join(root, dir), { recursive: true }) as string[])
  .filter((f) => /\.(ts|tsx|js|mjs)$/.test(f) && !/\.test\.ts$/.test(f)).map((f) => join(root, dir, f)));
// Names of window events, not of anything stored.
const eventNames = ['lvm:api', 'lvm:expired', 'lvm:host-task-done', 'lvm:leave', 'lvm:navigation-start', 'lvm:session-back', 'lvm:shortcuts', forgetEvent];

test('every "lvm" name in the source is a content key, a preference, handled separately, or an event', () => {
  const known = new Set([...contentKeys.local.exact, ...contentKeys.local.prefix, ...contentKeys.session.exact, ...contentKeys.session.prefix, ...preferenceKeys, ...separateKeys, ...eventNames, ownerKey]);
  const unknown: string[] = [];
  for (const file of sources) {
    for (const m of readFileSync(file, 'utf8').matchAll(/['"`](lvm[:.-][A-Za-z0-9:.-]*)/g)) if (!known.has(m[1]!)) unknown.push(`${m[1]} (${file.slice(root.length + 1)})`);
  }
  assert.deepEqual(unknown, [], 'a new browser key: add it to contentKeys (it names a person\'s data and goes with the session) or to preferenceKeys in lib/session-end.ts');
});

test('the panel keeps nothing in IndexedDB or Cache Storage, and its service worker answers no requests', () => {
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!/\bindexedDB\b|\bcaches\.(open|match|keys|delete|has)\b|\bcookieStore\b/.test(text), file);
  }
  const worker = readFileSync(join(root, 'public', 'sw.js'), 'utf8');
  assert.deepEqual([...worker.matchAll(/addEventListener\('([a-z]+)'/g)].map((m) => m[1]), ['push', 'notificationclick']);
});

test('storage is written only by the files this list was made from', () => {
  const writers = sources.filter((f) => /\b(localStorage|sessionStorage)\b|document\.cookie\s*=/.test(readFileSync(f, 'utf8'))).map((f) => f.slice(root.length + 1).replaceAll('\\', '/'))
    // Left out: its keys are being moved to the account by its own code.
    .filter((f) => f !== 'lib/saved-views.ts').sort();
  assert.deepEqual(writers, [
    'app/(auth)/credentials-form.tsx', 'app/(panel)/account/two-factor.tsx', 'app/(panel)/admin/dashboard.tsx', 'app/(panel)/admin/terminal/terminal.tsx', 'app/(panel)/order/order.tsx', 'app/(panel)/servers-ui.tsx',
    'app/(panel)/shell.tsx', 'app/(panel)/support/list.tsx', 'app/(panel)/support/ui.tsx', 'components/activity.tsx', 'components/console-snippets.tsx', 'components/digest.tsx',
    'components/first-steps.tsx', 'components/host-task.tsx', 'components/task-manager.tsx', 'components/time-zone-sync.tsx', 'components/ui.tsx', 'components/wall/hooks.ts', 'lib/a11y-prefs.ts', 'lib/a11y.ts',
    'lib/drafts.ts', 'lib/order-store.ts', 'lib/recent.ts', 'lib/session-end.ts',
  ].sort(), 'a file that uses browser storage was added or removed: check its keys against lib/session-end.ts, then update this list');
});
