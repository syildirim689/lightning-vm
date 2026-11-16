// One run at a time across every worker copy: a Redis key with a lifetime, holding a token only this run knows.
// The release deletes the key only while it still holds that token: a run that outlived the lifetime (another copy
// has started since) must not remove the other copy's lock. Nothing here throws: these runs start from timers, where
// a Redis error reply would otherwise be an unhandled rejection and end the process.
import { randomUUID } from 'node:crypto';

const release = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";

// wait: try for up to a minute (a requested run waits for one already running); otherwise a held lock just skips.
// Returns whether `run` was started. `run` handles its own errors; one that still throws is logged.
export async function withLock(redis, key, seconds, run, { wait = false, log = () => {}, pauseMs = 1000 } = {}) {
  const token = randomUUID();
  try {
    for (let i = 0; !(await redis.set(key, token, 'EX', seconds, 'NX')); i++) { if (!wait || i >= 60) return false; await new Promise((r) => setTimeout(r, pauseMs)); }
  } catch (e) { log('error', 'lock_failed', { lock: key, error: String(e?.message ?? e).slice(0, 200) }); return false; }
  try { await run(); } catch (e) { log('error', 'locked_run_failed', { lock: key, error: String(e?.message ?? e).slice(0, 200) }); }
  // A release that fails leaves the key to its lifetime.
  await redis.eval(release, 1, key, token).catch((e) => log('error', 'unlock_failed', { lock: key, error: String(e?.message ?? e).slice(0, 200) }));
  return true;
}
