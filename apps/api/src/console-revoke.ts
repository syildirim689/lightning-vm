// Closing consoles, apart from the console routes (console.ts): the session code (better-auth.ts, presence.ts, which
// auth.ts loads) revokes them too and cannot import the controllers.
import { redis } from './db';

// How long a console ticket lives before the gateway must have redeemed it.
export const sessionSeconds = 60;

// Live consoles of a signed-out or disabled user are closed by the gateway (it hears the message). A ticket that was
// issued before and is not redeemed yet is no live console: for those a marker with this moment stays in Redis a
// little longer than a ticket lives, and the gateway refuses a ticket of that account, session (or any, for "all")
// that was asked for before it (issuedAt in console.ts). Every revocation goes through here, so each leaves its
// marker; the marker also survives a gateway restart.
export async function revokeConsoles(revocation: { authHash?: string; userId?: string; sessionKey?: string; all?: boolean }) {
  const who = revocation.all ? 'all' : revocation.userId ? `user:${revocation.userId}` : revocation.authHash ? `auth:${revocation.authHash}` : null;
  if (who) await redis.set(`console:revoked:${who}`, String(Date.now()), 'EX', sessionSeconds + 30).catch(() => undefined);
  await redis.publish('console:revoke', JSON.stringify(revocation)).catch(() => undefined);
}
