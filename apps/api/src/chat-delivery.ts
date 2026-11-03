// Delivery side of the "chat" channel, kept apart from the controllers in chat.ts so notify.ts can use it
// without importing the HTTP guards (which import notify.ts back).
import { chatApps, type AdminAccounts, type Message, type SendResult } from './chat-apps';
import { pool } from './db';
import { logEvent } from './log';
import { decryptSecret } from './secrets';
import { getSettings, type ChatSettings } from './settings-store';
import { settings as hostSettings } from './maintenance';

export const ctx = 'settings:chat';
const dec = (v: string | null) => (v ? decryptSecret(v, ctx) : '');

export async function adminAccounts(s?: ChatSettings): Promise<AdminAccounts> {
  s ??= await getSettings('chat');
  return { telegramToken: dec(s.telegram.tokenEnc), whatsappToken: dec(s.whatsapp.tokenEnc), whatsappPhoneId: s.whatsapp.phoneNumberId,
    whatsappTemplate: s.whatsapp.template, whatsappLanguage: s.whatsapp.language, pushoverToken: dec(s.pushover.tokenEnc) };
}
// Apps users can connect now: switched on by the admin, with the admin account they need.
export function usableApps(s: ChatSettings) {
  const ready = { telegram: !!s.telegram.tokenEnc && !!s.telegram.username, whatsapp: !!s.whatsapp.tokenEnc && !!s.whatsapp.phoneNumberId && !!s.whatsapp.template, pushover: !!s.pushover.tokenEnc };
  return s.apps.filter((a) => chatApps[a] && (!chatApps[a].needs || ready[chatApps[a].needs!]));
}
export async function chatReady() { return usableApps(await getSettings('chat')).length > 0; }

// A panel path (/servers/…) as a full URL on the address set in setup; null when none is set.
// The panel's address for links in mail, chat and push: the domain the host agent serves (it follows a domain
// change made in the panel), else the address given in the setup wizard.
export async function panelBase() {
  const s = hostSettings();
  if (s.site && !s.site.startsWith(':')) return `${s.tlsMode === 'none' ? 'http' : 'https'}://${s.site}`;
  const { rows: [r] } = await pool.query("SELECT value FROM settings WHERE key = 'public_url'");
  return typeof r?.value === 'string' && r.value ? r.value : null;
}
export async function absolute(link: string | null) {
  if (!link || /^https?:\/\//.test(link)) return link;
  const base = await panelBase();
  return base ? new URL(link, base).toString() : null;
}
export async function sendOne(app: string, target: Record<string, string>, m: Message, a: AdminAccounts): Promise<SendResult> {
  try { return await chatApps[app].send(target, m, a); }
  catch (err) { return { ok: false, code: 'CHAT_UNREACHABLE', detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }; }
}

// notify.ts: one notification to every app this user switched on. Throws only when none got it.
export async function deliverChat(userId: string, t: { title: string; body: string }, link: string | null, event: string) {
  const s = await getSettings('chat');
  const usable = usableApps(s);
  const { rows } = await pool.query('SELECT id, app, target_enc FROM chat_connections WHERE user_id = $1 AND enabled', [userId]);
  const conns = rows.filter((r) => usable.includes(r.app));
  if (!conns.length) return;
  const a = await adminAccounts(s);
  const m: Message = { ...t, link: await absolute(link), brand: (await getSettings('branding')).name, event };
  let delivered = 0;
  for (const c of conns) {
    const r = await sendOne(c.app, JSON.parse(decryptSecret(c.target_enc, ctx)), m, a);
    await pool.query('UPDATE chat_connections SET last_sent_at = CASE WHEN $2 THEN now() ELSE last_sent_at END, last_error = $3 WHERE id = $1', [c.id, r.ok, r.ok ? null : r.code]);
    if (r.ok) delivered++;
    else logEvent('error', 'chat_failed', { app: c.app, code: r.code });
  }
  if (!delivered) throw new Error('no messaging app accepted the notification');
}

