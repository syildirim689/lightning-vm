// When a browser session ends, and whether the person can do anything about it (GET /auth/me `session`, POST
// /auth/stay; the panel warns five minutes before). Pure (unit tests: test/session-rules.test.mjs).
//
// - Fixed ends cannot be moved by being active: a "sign in as" session (one hour), a directory or single sign-on
//   account (SESSION_TTL_HOURS after sign-in, ldap.ts) and a role's session length (role-limits.ts). The warning says
//   which, and offers no "stay signed in".
// - Renewable ends: the session cookie of a "remember me" sign-in is written once, at sign-in, for SESSION_TTL_HOURS
//   (the requests that keep the stored session alive do not rewrite it), so it runs out that long after sign-in or
//   after the last "Stay signed in", whichever is later; and the stored session itself ends SESSION_TTL_HOURS after it
//   was last used. "Stay signed in" renews both, only on the person's click.

export type SessionEndWhy = 'impersonation' | 'directory' | 'role' | 'cookie' | 'idle';
export type SessionEnd = { at: number; kind: 'fixed' | 'renewable'; why: SessionEndWhy };

export const IMPERSONATION_HOURS = 1;
const hour = 3_600_000;

export function sessionEnd(s: {
  createdAt: number; expiresAt: number; ttlHours: number;
  impersonated: boolean; directory: boolean; roleHours?: number | null;
  remembered: boolean; stayedAt?: number | null;
}): SessionEnd {
  const ends: SessionEnd[] = [];
  if (s.impersonated) ends.push({ at: s.createdAt + IMPERSONATION_HOURS * hour, kind: 'fixed', why: 'impersonation' });
  else if (s.directory) ends.push({ at: s.createdAt + s.ttlHours * hour, kind: 'fixed', why: 'directory' });
  if (s.roleHours && s.roleHours > 0) ends.push({ at: s.createdAt + s.roleHours * hour, kind: 'fixed', why: 'role' });
  if (s.remembered) ends.push({ at: Math.max(s.createdAt, s.stayedAt ?? 0) + s.ttlHours * hour, kind: 'renewable', why: 'cookie' });
  ends.push({ at: s.expiresAt, kind: 'renewable', why: 'idle' });
  // The earliest wins. Ends within a minute of it count as the same moment (the stored expiry and the row's creation
  // time are written a few milliseconds apart): then a fixed end is the one to tell (staying would not help), and the
  // cookie before the stored session (in the order listed above).
  const first = Math.min(...ends.map((e) => e.at));
  const near = ends.filter((e) => e.at - first < SAME_MOMENT_MS);
  return { ...(near.find((e) => e.kind === 'fixed') ?? near[0]), at: first };
}
export const SAME_MOMENT_MS = 60_000;
