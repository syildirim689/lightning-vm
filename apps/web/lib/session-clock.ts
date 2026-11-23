// The warning before a browser session ends (GET /auth/me `session`, apps/api/src/session-rules.ts): five minutes
// before, a bar says when and why; "Stay signed in" (POST /auth/stay) is offered only where staying is possible.
// Nothing is extended without that click. Pure (node --test lib/*.test.ts); components/session-clock.tsx shows it.

export const WARN_MS = 5 * 60_000;
export type SessionEnds = { endsAt: string; msLeft: number; kind: 'fixed' | 'renewable'; why: 'impersonation' | 'directory' | 'role' | 'cookie' | 'idle' };

// The end on this browser's clock: the API's "milliseconds left" counted from when the answer arrived, so a clock
// that is off by minutes does not move the warning.
export const localEnd = (s: Pick<SessionEnds, 'msLeft'>, receivedAt: number) => receivedAt + Math.max(0, s.msLeft);

// Whether the bar shows now: within the last five minutes, not yet over, and not put away for this same end. Each
// answer of /auth/me counts the end again from its own arrival, so "the same end" allows a minute and a half of drift.
export const SAME_END_MS = 90_000;
export function warnNow(end: number, now: number, dismissedEnd: number | null): boolean {
  return now >= end - WARN_MS && now < end && (dismissedEnd === null || Math.abs(dismissedEnd - end) > SAME_END_MS);
}

// How long until the bar should appear (for one timer instead of a ticking clock); 0 when it is due already.
export const untilWarning = (end: number, now: number) => Math.max(0, end - WARN_MS - now);

// "4:05" left.
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
