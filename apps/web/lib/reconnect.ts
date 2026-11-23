// When the panel's server stops answering (or the browser goes offline): every list stops asking (React Query's
// online state is set to offline, so polling pauses instead of piling up failed requests), and one small request to
// /api/health tries again after 2, 4, 8, 16 and then every 30 seconds, or at once with "Try now". The first answer
// resumes everything without a reload (components/connection-banner.tsx).
// Pure (node --test lib/*.test.ts).

export const FIRST_RETRY_MS = 2_000;
export const MAX_RETRY_MS = 30_000;

// The wait before the attempt after `failures` failed ones (0: the first retry).
export function retryDelay(failures: number): number {
  const n = Math.max(0, Math.floor(failures));
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(n, 10));
}

// Whole seconds left until the next attempt, for "Trying again in 8 s"; never below 1 while one is due.
export const secondsLeft = (dueAt: number, now: number) => Math.max(1, Math.ceil((dueAt - now) / 1000));

// What a health answer means: the API answered (any JSON status) or a gateway said it is not there (502–504, or no
// answer at all). A 503 from the API itself (database down) still means the panel cannot work: not back yet.
export function isBack(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}
