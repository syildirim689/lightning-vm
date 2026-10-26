// The publishing side of the live line (live.ts), kept apart so modules that announce changes (better-auth.ts,
// rbac.ts, notify.ts) do not import the HTTP controller and its guard.
import { onClose, redis } from './db';
import { logEvent } from './log';

// account: something about this user changed; access: roles or permissions (theirs, or of a role they may hold);
// notification: a new item in the inbox.
export type LiveKind = 'ban' | 'unban' | 'password' | 'sessions' | 'removed' | 'access' | 'account' | 'policy' | 'notification';
export type Live = { userId: string | null; kind: LiveKind }; // userId null: every signed-in tab
const channel = `lvm:live:${Number(process.env.REDIS_DB) || 0}`;

export const publishLive = (userId: string | null, kind: LiveKind) =>
  redis.publish(channel, JSON.stringify({ userId, kind } satisfies Live)).then(() => undefined, () => logEvent('error', 'live_publish_failed', { kind }));

// One Redis subscriber per process, shared by all open streams.
const listeners = new Set<(m: Live) => void>();
let sub: ReturnType<typeof redis.duplicate> | null = null;
export function listen(fn: (m: Live) => void) {
  if (!sub) {
    sub = redis.duplicate();
    sub.subscribe(channel).catch(() => undefined);
    sub.on('message', (_c, raw) => { let m: Live; try { m = JSON.parse(raw); } catch { return; } for (const l of listeners) l(m); });
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}
onClose.push(async () => { sub?.disconnect(); sub = null; listeners.clear(); });

