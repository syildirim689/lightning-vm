// E-mail address verification for an account whose address nobody has proven yet (one opened by registration, or
// one staff marked unverified again). A six-digit code is mailed, with a link that carries it to Account → Profile;
// it counts only when it is entered in a signed-in session of that account (email-verification.ts has the routes).
// So the person who holds the account's credentials is shown to read its mailbox: there is no earlier holder to
// clean up after, and nothing is removed (unlike the first proof by a sign-in link or a reset, better-auth.ts
// addressProven, which is how the mailbox's owner gets into an account somebody else opened under their address).
// A link opened without that session only leads to the sign-in page. No HTTP here, and no import of auth.ts:
// better-auth.ts sends the first mail after registration.
import { randomInt, timingSafeEqual } from 'node:crypto';
import { absolute } from './chat-delivery';
import { pool, redis } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { sendAddressCheck } from './mail';
import { rateLimit, sha256 } from './security';
import { getSettings, mailUse } from './settings-store';

export const codeMinutes = 30;
const attemptsPerCode = 5;
const pendingKey = (userId: string) => `emailverify:${userId}`;
const minuteKey = (userId: string) => `emailverify:send:minute:${userId}`;
// The code is bound to the account and to the address it was mailed to: an address staff changed meanwhile is not
// verified by a code sent to the old one.
const hashOf = (userId: string, email: string, code: string) => sha256(`${userId}:${email.trim().toLowerCase()}:${code}`).toString('hex');

// Whether the panel can verify addresses at all: working mail, and the administrator left this use of it on
// (Settings → E-mail). Off: the account page shows nothing and the order rule below asks nothing.
export const verificationAvailable = () => mailUse('verification');

// Deletes the pending code only while it is still the one named (ARGV[1]: its hash, or '' for "no code there"). A
// request that finds no code, uses one up or could not mail one must not remove the code another request has just
// written for the same account (a resend arriving at that moment, a mail that failed after a later one went out).
const dropIf = "local h = redis.call('hget', KEYS[1], 'hash') if (h or '') == ARGV[1] then return redis.call('del', KEYS[1]) end return 0";
const dropCode = (userId: string, hash: string) => redis.eval(dropIf, 1, pendingKey(userId), hash).then(() => undefined, () => undefined);

// One mail with a new code (the earlier one stops working). A few per account: one a minute, five an hour, ten a
// day, counted whether or not the mail could be sent. The first one after registration counts too.
export async function sendVerification(user: { id: string; email: string; locale?: string | null }) {
  if (!(await verificationAvailable())) throw apiError(501, 'MAIL_NOT_CONFIGURED', 'Mail is not configured');
  await rateLimit(minuteKey(user.id), 1, 60);
  await rateLimit(`emailverify:send:hour:${user.id}`, 5, 3600);
  await rateLimit(`emailverify:send:day:${user.id}`, 10, 86_400);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const hash = hashOf(user.id, user.email, code);
  await redis.multi().del(pendingKey(user.id)).hset(pendingKey(user.id), { hash, attempts: 0 }).expire(pendingKey(user.id), codeMinutes * 60).exec();
  // The link opens the account page with the code filled in; without a public address the mail carries the code only.
  const link = await absolute(`/account?tab=profile&verify=${code}`).catch(() => null);
  // A mail that could not be sent leaves no code behind: the page then offers to send one, not to enter one.
  try { await sendAddressCheck(user.email, user.locale ?? undefined, code, link); }
  catch (err) { await dropCode(user.id, hash); throw err; }
}

// After registration: the first mail, without making the registration wait for it or fail with it.
export function sendFirstVerification(user: { id: string; email: string; locale?: string | null }) {
  void (async () => {
    if (!(await verificationAvailable())) return;
    await sendVerification(user);
  })().catch((err) => logEvent('error', 'address_check_mail_failed', { error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }));
}

// A wrong, used, expired or never-sent code all answer the same. Each code takes five tries, an account twenty a day.
export async function confirmVerification(user: { id: string; email: string }, code: unknown): Promise<boolean> {
  const invalid = () => apiError(400, 'VERIFICATION_CODE_INVALID', 'This code is wrong or no longer valid');
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw invalid();
  await rateLimit(`emailverify:confirm:${user.id}`, 20, 86_400);
  // Counted before it is compared, in one step: tries made at the same moment cannot share a count.
  const res = await redis.multi().hget(pendingKey(user.id), 'hash').hincrby(pendingKey(user.id), 'attempts', 1).exec();
  const stored = res?.[0]?.[1] as string | null | undefined, tries = Number(res?.[1]?.[1]);
  if (!stored || tries > attemptsPerCode) { await dropCode(user.id, stored ?? ''); throw invalid(); }
  const given = Buffer.from(hashOf(user.id, user.email, code)), kept = Buffer.from(stored);
  if (given.length !== kept.length || !timingSafeEqual(given, kept)) throw invalid();
  await dropCode(user.id, stored);
  const { rowCount } = await pool.query('UPDATE users SET email_verified = true, updated_at = now() WHERE id = $1 AND lower(email) = lower($2) AND NOT email_verified', [user.id, user.email]);
  return !!rowCount;
}

// A code still waiting when the address is proven another way (or the account's credentials are reset) is dropped.
export const clearVerification = (userId: string) => redis.del(pendingKey(userId)).then(() => undefined, () => undefined);

// What the account page shows. resendInSeconds: how long until another mail may be asked for.
export async function verificationState(userId: string) {
  const [{ rows: [u] }, available, security] = await Promise.all([pool.query('SELECT email, email_verified FROM users WHERE id = $1', [userId]), verificationAvailable(), getSettings('security')]);
  const verified = !!u?.email_verified;
  const [pending, wait] = verified || !available ? [0, -2] : await Promise.all([redis.exists(pendingKey(userId)), redis.ttl(`rl:${minuteKey(userId)}`)]).catch(() => [0, -2]);
  return { email: u?.email ?? '', verified, available, pending: pending === 1, resendInSeconds: Math.max(0, wait), codeMinutes, requiredToOrder: available && security.verifiedEmailToOrder && !verified };
}

// Settings → Sign-in security: accounts with an unverified address do not order. Off by default, and never asked
// while the panel cannot verify (no mail): nobody could then meet it.
export async function orderNeedsVerifiedAddress(userId: string) {
  if (!(await getSettings('security')).verifiedEmailToOrder || !(await verificationAvailable())) return false;
  const { rows: [u] } = await pool.query('SELECT email_verified FROM users WHERE id = $1', [userId]);
  return !!u && !u.email_verified;
}
