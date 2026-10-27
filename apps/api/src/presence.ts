// Who is here now and when they were last seen. "Online": a panel tab holds the live line (GET /live) open,
// refreshed every ping; "last seen": any signed-in request, written at most once a minute per session (so busy
// pages cost nothing). Kept in Redis (live state) and on auth_sessions / users (history).
import { pool, redis } from './db';
import { deviceOf } from './device';
import { sha256 } from './security';

const TTL = 70; // seconds: a little over two pings (25 s), so a closed tab drops out within about a minute

// Called on every signed-in request; cheap after the first call of the minute.
export async function touch(sessionId: string, userId: string, ip: string | null) {
  if ((await redis.set(`seen:${sessionId}`, '1', 'EX', 60, 'NX').catch(() => null)) !== 'OK') return;
  await pool.query('UPDATE auth_sessions SET last_active_at = now(), last_ip = coalesce($2::inet, last_ip) WHERE id = $1', [sessionId, ip]).catch(() => undefined);
  await pool.query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]).catch(() => undefined);
}

// A tab's live line is open: mark its session and person online while it stays open.
export function holdOnline(userId: string, sessionId: string) {
  const mark = () => redis.multi().set(`online:s:${sessionId}`, userId, 'EX', TTL).set(`online:u:${userId}`, '1', 'EX', TTL).exec().catch(() => undefined);
  void mark();
  return mark;
}

export async function onlineUsers(ids: string[]) {
  if (!ids.length) return new Set<string>();
  const v = await redis.mget(...ids.map((id) => `online:u:${id}`)).catch(() => ids.map(() => null));
  return new Set(ids.filter((_, i) => v[i]));
}

// A person's sessions with what can be shown (never the token): device, addresses, when it started, was last
// active and ends, whether a tab has it open now, and whether it is the caller's own.
export async function sessionsOf(userId: string, currentId?: string) {
  const { rows } = await pool.query(`SELECT id, ip_address AS ip, last_ip AS "lastIp", user_agent AS agent, created_at AS "createdAt",
      coalesce(last_active_at, updated_at, created_at) AS "lastActiveAt", expires_at AS "expiresAt", impersonated_by AS "impersonatedBy"
    FROM auth_sessions WHERE user_id = $1 AND expires_at > now() ORDER BY coalesce(last_active_at, updated_at, created_at) DESC`, [userId]);
  const live = rows.length ? await redis.mget(...rows.map((r) => `online:s:${r.id}`)).catch(() => rows.map(() => null)) : [];
  return rows.map((r, i) => ({ id: r.id as string, device: deviceOf(r.agent), mobile: /mobile|android|iphone|ipad/i.test(r.agent ?? ''), agent: (r.agent ?? '').slice(0, 300),
    ip: r.ip, lastIp: r.lastIp, createdAt: r.createdAt, lastActiveAt: r.lastActiveAt, expiresAt: r.expiresAt, impersonated: !!r.impersonatedBy, online: !!live[i], current: r.id === currentId }));
}

// Ends one session: its row goes (better-auth reads sessions from the database, so it is gone at once) and the
// browser consoles opened with it close. Returns whether it existed.
export async function endSession(userId: string, sessionId: string) {
  const { rows: [s] } = await pool.query('DELETE FROM auth_sessions WHERE id = $1 AND user_id = $2 RETURNING token', [sessionId, userId]);
  if (!s) return false;
  await redis.publish('console:revoke', JSON.stringify({ authHash: sha256(s.token).toString('hex') })).catch(() => undefined);
  await redis.del(`online:s:${sessionId}`).catch(() => undefined);
  return true;
}

// Online, recently active (a request in the last 15 minutes) or offline, with the last time seen.
export const statusOf = (online: boolean, lastSeen: Date | string | null) =>
  online ? 'online' : lastSeen && Date.now() - new Date(lastSeen).getTime() < 15 * 60_000 ? 'recent' : 'offline';
