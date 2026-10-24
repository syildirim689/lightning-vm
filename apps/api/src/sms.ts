// Outgoing SMS through one provider the admin picks (Settings → SMS). Each provider declares the account
// fields it needs and how to send one message; credentials are stored encrypted as one JSON document.
// Used for two-factor codes, phone verification and the notifications a user routes to SMS.
import { logEvent } from './log';
import { decryptSecret, encryptSecret } from './secrets';
import { getSettings, type SmsSettings, type SmsUse } from './settings-store';
import { phoneForms, providers, type SmsResult } from './sms-providers';

export { phoneForms, providers };

export async function smsReady() {
  const s = await getSettings('sms');
  return s.provider !== 'none' && !!providers[s.provider] && !!s.credentialsEnc;
}
export async function smsUse(kind: keyof SmsUse) {
  return (await smsReady()) && (await getSettings('sms')).use[kind];
}

export const encryptCredentials = (c: Record<string, string>) => encryptSecret(JSON.stringify(c), 'settings:sms');
export const decryptCredentials = (s: SmsSettings): Record<string, string> => (s.credentialsEnc ? JSON.parse(decryptSecret(s.credentialsEnc, 'settings:sms')) : {});

export async function sendWith(s: SmsSettings, credentials: Record<string, string>, to: string, text: string): Promise<SmsResult> {
  const p = providers[s.provider];
  if (!p) return { ok: false, code: 'SMS_PROVIDER_UNKNOWN' };
  try {
    return await p.send({ credentials, sender: s.sender, commercial: s.commercial }, phoneForms(to), text);
  } catch (err) {
    return { ok: false, code: 'SMS_PROVIDER_UNREACHABLE', detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown' };
  }
}

export async function sendSms(to: string, text: string) {
  const s = await getSettings('sms');
  if (!(await smsReady())) throw new Error('SMS is not configured');
  const r = await sendWith(s, decryptCredentials(s), to, text);
  if (!r.ok) {
    logEvent('error', 'sms_failed', { provider: s.provider, code: r.code });
    throw new Error(`SMS failed: ${r.code}`);
  }
  logEvent('info', 'sms_sent', { provider: s.provider });
}
