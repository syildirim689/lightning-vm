// Panel settings an admin changes at runtime (no HTTP here; the controllers are in settings.ts): branding, outgoing mail (SMTP) and bot protection (captcha).
// Stored in the settings table; passwords and secret keys are encrypted with the master key and never
// returned. Values are cached for a few seconds so every sign-in does not read the database.
import { createHash } from 'node:crypto';
import { createTransport } from 'nodemailer';
import { config } from './config';
import { pool } from './db';
import { apiError } from './errors';
import { logEvent } from './log';
import { decryptSecret, encryptSecret } from './secrets';
import { mailProviders, readProviderFields } from './mail-providers';

// passwordPrefix: starts the strong root password generated when a customer picks a weak one (passwords.ts).
export type Branding = { name: string; accent: string | null; logo: string | null; favicon: string | null; passwordPrefix: string };
// Transactional mail only; notifications choose their channels in notify.ts.
export type MailUse = { passwordReset: boolean; twoFactor: boolean };
// provider: 'smtp' (host, port, account below) or one of mail-providers.ts sent through its HTTP API, with its
// plain fields in api and its secrets encrypted together in apiSecretEnc.
export type MailSettings = { enabled: boolean; provider: string; host: string; port: number; security: 'none' | 'starttls' | 'tls'; username: string; passwordEnc: string | null;
  api: Record<string, string>; apiSecretEnc: string | null; fromName: string; fromAddress: string; use: MailUse };
export type CaptchaProvider = 'none' | 'turnstile' | 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha';
export type CaptchaUse = { signIn: boolean; signUp: boolean; passwordReset: boolean };
export type SmsUse = { twoFactor: boolean; phoneVerification: boolean };
// credentialsEnc: the provider's account fields (sms.ts), encrypted as one JSON document.
export type SmsSettings = { provider: string; sender: string; credentialsEnc: string | null; commercial: boolean; use: SmsUse };
// chat: the messaging apps (Telegram, WhatsApp, Slack, ...) each user connects in chat.ts.
// Directory sign-in (ldap.ts). userFilter has {email}; groupRoles maps a group DN to roles.
export type LdapSettings = { enabled: boolean; url: string; startTls: boolean; caPem: string; bindDn: string; bindPasswordEnc: string | null; baseDn: string; userFilter: string;
  emailAttribute: string; nameAttribute: string; groupAttribute: string; groupRoles: { group: string; roles: string[] }[]; defaultRole: string; autoCreate: boolean };
// Single sign-on with OpenID Connect (sso.ts): issuer for discovery, the client, groups claim -> roles.
export type OidcSettings = { enabled: boolean; name: string; issuer: string; clientId: string; clientSecretEnc: string | null; scopes: string; groupsClaim: string;
  groupRoles: { group: string; roles: string[] }[]; defaultRole: string; autoCreate: boolean };
// Sign-in methods (sign-in-methods.ts): social providers, magic link, user names, One Tap and two checks.
export type SocialId = 'google' | 'microsoft' | 'github' | 'gitlab' | 'discord' | 'facebook' | 'linkedin';
export type SocialProvider = { enabled: boolean; clientId: string; clientSecretEnc: string | null; tenantId?: string; hostedDomain?: string };
export type SignInSettings = { magicLink: boolean; username: boolean; oneTap: boolean; socialSignUp: boolean; pwnedPasswords: boolean; blockDisposable: boolean;
  providers: Partial<Record<SocialId, SocialProvider>> };
export type Channel = 'inApp' | 'push' | 'email' | 'sms' | 'chat';
// Messaging apps users may connect (chat-apps.ts) and the admin accounts some of them need; secrets encrypted.
export type ChatSettings = { apps: string[]; telegram: { tokenEnc: string | null; username: string };
  whatsapp: { tokenEnc: string | null; phoneNumberId: string; template: string; language: string }; pushover: { tokenEnc: string | null } };
// Sign-in policy: who must use two-factor, and whether a one-time e-mail code can replace the password.
// Servers: what customers may do on their own servers (staff always may), and hardware options for new VMs.
export type ServerSettings = { customer: { power: boolean; console: boolean; iso: boolean; rootPassword: boolean; delete: boolean; snapshots: boolean };
  hardware: { cpuHotAdd: boolean; memoryHotAdd: boolean; nestedHv: boolean } };
// Energy report: electricity price, datacenter overhead (PUE) and grid carbon intensity.
export type EnergySettings = { pricePerKwh: string; currency: string; pue: number; co2GramsPerKwh: number };
// Abuse monitoring (worker/abuse.mjs keeps the same defaults).
export type AbuseSettings = { portScan: boolean; scanMinutes: number; cpu: boolean; cpuThreshold: number; cpuHours: number; notifyCustomer: boolean; ports: { port: number; label: string }[] };
// A notice on every signed-in page (announcement.ts); a new id per saved version.
export type Announcement = { id: string; active: boolean; tone: 'info' | 'warning' | 'danger' | 'success'; textTr: string; textEn: string; link: string; startsAt: string | null; endsAt: string | null };
export type SecuritySettings = { require2fa: 'none' | 'staff' | 'all'; emailCodeSignIn: boolean };
export type NotificationPolicy = { enabled: boolean; allowed: Channel[]; defaults: Channel[]; userCanChange: boolean };
export type CaptchaSettings = { provider: CaptchaProvider; siteKey: string; secretEnc: string | null; minScore: number; use: CaptchaUse };
// Reverse DNS (rdns.ts): PowerDNS's HTTP API holds the in-addr.arpa / ip6.arpa zones of the routed blocks.
// template: the default PTR of a new server's addresses ({ip}, {ip-dashed}, {name}); empty = none.
// Billing (billing.ts): off until turned on. Seller details print on every invoice and go into the e-invoice.
export type Company = { name: string; taxId: string; taxOffice: string; address: string; district: string; city: string; country: string; postalCode: string;
  phone: string; email: string; website: string; mersis: string; tradeRegistry: string };
export type BillingSettings = { enabled: boolean; requirePayment: boolean; orderExpiryHours: number; taxRate: number; pricesIncludeTax: boolean; exportExempt: boolean;
  invoicePrefix: string; invoiceDaysBefore: number; reminderDays: number[]; suspendAfterDays: number; terminateAfterDays: number;
  autoCharge: boolean; chargeRetries: number; balance: boolean; topupMin: number; topupMax: number; sandbox: boolean;
  bankTransfer: { enabled: boolean; bank: string; holder: string; iban: string }; company: Company };
// e-Fatura / e-Arşiv through an integrator (einvoice.ts); 'none' issues invoices in the panel only.
// values: the integrator's plain fields (and an endpoint override); its secrets are encrypted together in credentialsEnc.
export type EinvoiceSettings = { provider: string; mode: 'test' | 'live'; values: Record<string, string>; credentialsEnc: string | null; efaturaSeries: string; earsivSeries: string;
  profile: 'TEMELFATURA' | 'TICARIFATURA'; senderAlias: string; check: { ok: boolean; message: string; at: string } | null };
export type RdnsSettings = { provider: 'none' | 'powerdns'; apiUrl: string; apiKeyEnc: string | null; serverId: string; template: string; ttl: number;
  customerEdit: boolean; forwardCheck: boolean };

const defaults = {
  einvoice: { provider: 'none', mode: 'test', values: {}, credentialsEnc: null, efaturaSeries: 'LVF', earsivSeries: 'LVA', profile: 'TEMELFATURA', senderAlias: '', check: null } as EinvoiceSettings,
  billing: { enabled: false, requirePayment: true, orderExpiryHours: 24, taxRate: 20, pricesIncludeTax: false, exportExempt: false, invoicePrefix: 'LVM',
    invoiceDaysBefore: 7, reminderDays: [3, 1], suspendAfterDays: 3, terminateAfterDays: 0, autoCharge: true, chargeRetries: 3, balance: true, topupMin: 50, topupMax: 50000, sandbox: false,
    bankTransfer: { enabled: false, bank: '', holder: '', iban: '' },
    company: { name: '', taxId: '', taxOffice: '', address: '', district: '', city: '', country: 'TR', postalCode: '', phone: '', email: '', website: '', mersis: '', tradeRegistry: '' } } as BillingSettings,
  branding: { name: 'Lightning VM', accent: null, logo: null, favicon: null, passwordPrefix: '' } as Branding,
  mail: { enabled: false, provider: 'smtp', host: '', port: 587, security: 'starttls', username: '', passwordEnc: null, api: {}, apiSecretEnc: null, fromName: '', fromAddress: '',
    use: { passwordReset: true, twoFactor: true } } as MailSettings,
  captcha: { provider: 'none', siteKey: '', secretEnc: null, minScore: 0.5, use: { signIn: true, signUp: true, passwordReset: true } } as CaptchaSettings,
  sms: { provider: 'none', sender: '', credentialsEnc: null, commercial: false, use: { twoFactor: true, phoneVerification: true } } as SmsSettings,
  // Per notification event (notify.ts): the admin's policy. Missing events use the catalog defaults.
  notifications: {} as Record<string, NotificationPolicy>,
  security: { require2fa: 'none', emailCodeSignIn: false } as SecuritySettings,
  announcement: { id: '', active: false, tone: 'info', textTr: '', textEn: '', link: '', startsAt: null, endsAt: null } as Announcement,
  energy: { pricePerKwh: '0', currency: 'TRY', pue: 1.5, co2GramsPerKwh: 420 } as EnergySettings,
  abuse: { portScan: true, scanMinutes: 30, cpu: true, cpuThreshold: 90, cpuHours: 6, notifyCustomer: false,
    ports: [{ port: 23, label: 'Telnet' }, { port: 445, label: 'SMB' }, { port: 1433, label: 'MS SQL' }, { port: 2375, label: 'Docker API' }, { port: 3306, label: 'MySQL' },
      { port: 5432, label: 'PostgreSQL' }, { port: 6379, label: 'Redis' }, { port: 9200, label: 'Elasticsearch' }, { port: 11211, label: 'Memcached' }, { port: 27017, label: 'MongoDB' }] } as AbuseSettings,
  servers: { customer: { power: true, console: true, iso: true, rootPassword: true, delete: true, snapshots: true }, hardware: { cpuHotAdd: false, memoryHotAdd: false, nestedHv: false } } as ServerSettings,
  rdns: { provider: 'none', apiUrl: '', apiKeyEnc: null, serverId: 'localhost', template: '', ttl: 3600, customerEdit: true, forwardCheck: true } as RdnsSettings,
  chat: { apps: ['slack', 'discord', 'teams', 'googlechat', 'mattermost', 'rocketchat', 'matrix', 'ntfy', 'gotify', 'webhook'], telegram: { tokenEnc: null, username: '' },
    whatsapp: { tokenEnc: null, phoneNumberId: '', template: '', language: 'tr' }, pushover: { tokenEnc: null } } as ChatSettings,
  directory: { ldap: { enabled: false, url: '', startTls: false, caPem: '', bindDn: '', bindPasswordEnc: null, baseDn: '', userFilter: '(&(objectClass=person)(mail={email}))',
    emailAttribute: 'mail', nameAttribute: 'displayName', groupAttribute: 'memberOf', groupRoles: [], defaultRole: 'user', autoCreate: true } as LdapSettings,
    oidc: { enabled: false, name: 'SSO', issuer: '', clientId: '', clientSecretEnc: null, scopes: 'openid email profile', groupsClaim: 'groups', groupRoles: [], defaultRole: 'user', autoCreate: true } as OidcSettings },
  signIn: { magicLink: false, username: false, oneTap: false, socialSignUp: false, pwnedPasswords: false, blockDisposable: false, providers: {} } as SignInSettings,
  // The public status page (/status): on unless the admin turns it off.
  statusPage: { enabled: true } as { enabled: boolean },
  // Web Push (VAPID) keys, generated on first use.
  vapid: { publicKey: '', privateKeyEnc: null } as { publicKey: string; privateKeyEnc: string | null },
};
export type Key = keyof typeof defaults;

const cache = new Map<Key, { at: number; value: unknown }>();
export async function getSettings<K extends Key>(key: K): Promise<(typeof defaults)[K]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10_000) return hit.value as (typeof defaults)[K];
  const { rows: [r] } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  // One level deep, so a setting added later (servers.customer.snapshots) gets its default under an older saved object.
  const d = defaults[key] as Record<string, unknown>;
  const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  const value = Object.fromEntries(Object.entries({ ...d, ...(r?.value ?? {}) }).map(([k, v]) => [k, plain(d[k]) && plain(v) ? { ...d[k], ...v } : v])) as (typeof defaults)[K];
  cache.set(key, { at: Date.now(), value });
  return value;
}
export async function saveSettings(key: Key, value: object) {
  await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`, [key, value]);
  cache.delete(key);
}

// ---- Mail ----
// Installs from before the settings page keep working with SMTP_URL / MAIL_FROM until an admin saves SMTP here.
export async function transportFor(m: MailSettings, password?: string) {
  if (!m.enabled) {
    if (config.SMTP_URL && config.MAIL_FROM) return { transport: createTransport(config.SMTP_URL), from: config.MAIL_FROM };
    return null;
  }
  const pass = password ?? (m.passwordEnc ? decryptSecret(m.passwordEnc, 'settings:mail') : '');
  const transport = createTransport({ host: m.host, port: m.port, secure: m.security === 'tls', requireTLS: m.security === 'starttls', ignoreTLS: m.security === 'none',
    auth: m.username ? { user: m.username, pass } : undefined, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 20_000 });
  return { transport, from: m.fromName ? { name: m.fromName, address: m.fromAddress } : m.fromAddress };
}

export async function mailReady() {
  const m = await getSettings('mail');
  if (!m.enabled) return !!(config.SMTP_URL && config.MAIL_FROM);
  return !!m.fromAddress && (m.provider === 'smtp' || !mailProviders[m.provider] ? !!m.host : !!m.apiSecretEnc);
}
export const mailSecrets = (m: MailSettings): Record<string, string> => (m.apiSecretEnc ? JSON.parse(decryptSecret(m.apiSecretEnc, 'settings:mail-api')) : {});

// One message through the chosen API provider (SMTP goes through transportFor). Throws with the provider's code.
export async function sendViaProvider(m: MailSettings, secrets: Record<string, string>, to: string, subject: string, text: string) {
  const r = await mailProviders[m.provider].send({ ...m.api, ...secrets }, { from: { name: m.fromName, address: m.fromAddress }, to, subject, text });
  if (!r.ok) throw Object.assign(new Error(r.detail ?? r.code ?? 'mail failed'), { mailCode: r.code });
  return r;
}
export async function mailUse(kind: keyof MailUse) {
  const m = await getSettings('mail');
  return (await mailReady()) && (m.enabled ? m.use[kind] : kind === 'passwordReset');
}

export async function sendMail(to: string, subject: string, text: string) {
  const m = await getSettings('mail');
  if (m.enabled && m.provider !== 'smtp' && mailProviders[m.provider]) {
    try { await sendViaProvider(m, mailSecrets(m), to, subject, text); logEvent('info', 'mail_sent', { subject, provider: m.provider }); }
    catch (err) { logEvent('error', 'mail_failed', { provider: m.provider, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' }); throw err; }
    return;
  }
  const t = await transportFor(m);
  if (!t) throw new Error('mail is not configured');
  try {
    await t.transport.sendMail({ from: t.from, to, subject, text });
    logEvent('info', 'mail_sent', { subject });
  } catch (err) {
    logEvent('error', 'mail_failed', { error: err instanceof Error ? err.message : 'unknown' });
    throw err;
  }
}

// Nodemailer's error codes, mapped to codes the panel explains.
export function mailErrorCode(err: unknown) {
  const mailCode = (err as { mailCode?: string })?.mailCode;
  if (mailCode) return mailCode;
  const code = (err as { code?: string; responseCode?: number })?.code;
  if (code === 'EAUTH') return 'MAIL_AUTH_FAILED';
  if (code === 'ETLS' || /certificate|SSL|TLS/i.test(String((err as Error)?.message))) return 'MAIL_TLS_FAILED';
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return 'MAIL_REJECTED';
  if (code === 'EDNS') return 'MAIL_HOST_NOT_FOUND';
  return 'MAIL_CONNECTION_FAILED';
}

// ---- Captcha ----
const verifyUrls: Record<Exclude<CaptchaProvider, 'none'>, string> = {
  turnstile: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  'recaptcha-v2': 'https://www.google.com/recaptcha/api/siteverify',
  'recaptcha-v3': 'https://www.google.com/recaptcha/api/siteverify',
  hcaptcha: 'https://api.hcaptcha.com/siteverify',
};
type Verdict = { ok: boolean; score?: number; hostname?: string; errors: string[] };

export async function verifyCaptcha(provider: CaptchaProvider, secret: string, token: string, ip: string | null, minScore: number): Promise<Verdict> {
  if (provider === 'none') return { ok: true, errors: [] };
  const form = new URLSearchParams({ secret, response: token, ...(ip && { remoteip: ip }) });
  const res = await fetch(verifyUrls[provider], { method: 'POST', body: form, signal: AbortSignal.timeout(10_000) })
    .catch(() => { throw apiError(503, 'CAPTCHA_UNAVAILABLE', 'Captcha provider unreachable'); });
  const out = await res.json().catch(() => ({})) as { success?: boolean; score?: number; hostname?: string; 'error-codes'?: string[] };
  const ok = out.success === true && (provider !== 'recaptcha-v3' || (out.score ?? 0) >= minScore);
  return { ok, score: out.score, hostname: out.hostname, errors: out['error-codes'] ?? [] };
}

// What sign-in and the other auth forms need; env keys from older installs count as Turnstile on every form.
export async function activeCaptcha() {
  const c = await getSettings('captcha');
  if (c.provider !== 'none' && c.siteKey && c.secretEnc) return { ...c, secret: () => decryptSecret(c.secretEnc!, 'settings:captcha') };
  if (config.TURNSTILE_SITE_KEY && config.TURNSTILE_SECRET_KEY) {
    return { ...defaults.captcha, provider: 'turnstile' as const, siteKey: config.TURNSTILE_SITE_KEY, secret: () => config.TURNSTILE_SECRET_KEY! };
  }
  return null;
}

// ---- Validation ----
type Input = Record<string, unknown>;
export const imagePattern = /^data:image\/(png|jpeg|webp|x-icon|vnd\.microsoft\.icon);base64,([A-Za-z0-9+/=]+)$/;
// Raster images only (no SVG: it can carry script). The bytes must match the declared type.
function readImage(v: unknown, field: string, fields: Record<string, string>): string | null {
  if (v === null || v === undefined || v === '') return null;
  const m = typeof v === 'string' ? imagePattern.exec(v) : null;
  if (!m) { fields[field] = 'INVALID_IMAGE'; return null; }
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > 256 * 1024) { fields[field] = 'IMAGE_TOO_LARGE'; return null; }
  const magic = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46], 'x-icon': [0, 0, 1, 0], 'vnd.microsoft.icon': [0, 0, 1, 0] }[m[1]]!;
  if (!magic.every((b, i) => bytes[i] === b)) { fields[field] = 'INVALID_IMAGE'; return null; }
  return v as string;
}

export function readBranding(body: Input): Branding {
  const fields: Record<string, string> = {};
  const name = typeof body.name === 'string' && body.name.trim() && body.name.trim().length <= 40 ? body.name.trim() : (fields.name = 'INVALID_VALUE', '');
  const accent = body.accent === null || body.accent === '' || body.accent === undefined ? null
    : typeof body.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.accent) ? body.accent.toLowerCase() : (fields.accent = 'INVALID_COLOR', null);
  const logo = readImage(body.logo, 'logo', fields);
  const favicon = readImage(body.favicon, 'favicon', fields);
  const passwordPrefix = typeof body.passwordPrefix === 'string' ? body.passwordPrefix.trim() : '';
  if (!/^[A-Za-z0-9]{0,20}$/.test(passwordPrefix)) fields.passwordPrefix = 'INVALID_PASSWORD_PREFIX';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return { name, accent, logo, favicon, passwordPrefix };
}

const bool = (v: unknown) => v === true;
const hostPattern = /^[A-Za-z0-9.-]{1,253}$/;
export const emailPattern = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

// Returns the settings to store, and the plain password when a new one was typed (for a test before saving).
export function readMail(body: Input, saved: MailSettings): { value: MailSettings; password?: string; secrets: Record<string, string> } {
  const fields: Record<string, string> = {};
  const enabled = bool(body.enabled);
  const provider = typeof body.provider === 'string' && (body.provider === 'smtp' || mailProviders[body.provider]) ? body.provider : (body.provider === undefined ? 'smtp' : (fields.provider = 'INVALID_VALUE', 'smtp'));
  const smtp = provider === 'smtp';
  const host = typeof body.host === 'string' ? body.host.trim() : '';
  if (enabled && smtp && !hostPattern.test(host)) fields.host = 'INVALID_HOST';
  // API providers: plain fields stored as they are, secrets encrypted together (empty secret fields keep the saved ones).
  const savedSecrets = saved.provider === provider ? mailSecrets(saved) : {};
  const api = smtp ? { plain: {}, secrets: {}, fields: {} } : readProviderFields(provider, (body.api ?? {}) as Input, savedSecrets);
  if (enabled) Object.assign(fields, Object.fromEntries(Object.entries(api.fields).map(([k, v]) => [`api.${k}`, v])));
  // Port and security matter only for SMTP; an API provider keeps the saved ones.
  const port = smtp ? Number(body.port) : saved.port;
  if (smtp && (!Number.isInteger(port) || port < 1 || port > 65535)) fields.port = 'OUT_OF_RANGE';
  const security = !smtp ? saved.security : ['none', 'starttls', 'tls'].includes(body.security as string) ? body.security as MailSettings['security'] : (fields.security = 'INVALID_VALUE', 'starttls');
  const username = typeof body.username === 'string' ? body.username.trim().slice(0, 200) : '';
  const fromAddress = typeof body.fromAddress === 'string' ? body.fromAddress.trim() : '';
  if (enabled && !emailPattern.test(fromAddress)) fields.fromAddress = 'INVALID_EMAIL';
  const fromName = typeof body.fromName === 'string' ? body.fromName.trim().slice(0, 80) : '';
  const password = typeof body.password === 'string' && body.password !== '' ? body.password : undefined;
  if (password && password.length > 500) fields.password = 'INVALID_VALUE';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  const use = (body.use ?? {}) as Input;
  // An empty password field keeps the stored one; clearing the username drops it.
  const passwordEnc = !username ? null : password ? encryptSecret(password, 'settings:mail') : saved.passwordEnc;
  const apiSecretEnc = smtp ? saved.apiSecretEnc : Object.keys(api.secrets).length ? encryptSecret(JSON.stringify(api.secrets), 'settings:mail-api') : null;
  return { value: { enabled, provider, host, port, security, username, passwordEnc, api: smtp ? saved.api : api.plain, apiSecretEnc, fromName, fromAddress,
    use: { passwordReset: bool(use.passwordReset), twoFactor: bool(use.twoFactor) } }, password, secrets: api.secrets };
}

export function readCaptcha(body: Input, saved: CaptchaSettings): { value: CaptchaSettings; secret?: string } {
  const fields: Record<string, string> = {};
  const provider = ['none', 'turnstile', 'recaptcha-v2', 'recaptcha-v3', 'hcaptcha'].includes(body.provider as string) ? body.provider as CaptchaProvider : (fields.provider = 'INVALID_VALUE', 'none');
  const siteKey = typeof body.siteKey === 'string' ? body.siteKey.trim() : '';
  if (provider !== 'none' && !/^[\w.-]{8,200}$/.test(siteKey)) fields.siteKey = 'INVALID_VALUE';
  const secret = typeof body.secret === 'string' && body.secret.trim() ? body.secret.trim() : undefined;
  if (secret && !/^[\w.-]{8,300}$/.test(secret)) fields.secret = 'INVALID_VALUE';
  if (provider !== 'none' && !secret && !saved.secretEnc) fields.secret = 'REQUIRED';
  const minScore = body.minScore === undefined ? 0.5 : Number(body.minScore);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 1) fields.minScore = 'OUT_OF_RANGE';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  const use = (body.use ?? {}) as Input;
  // A new provider needs its own secret; the old one is never reused across providers.
  const secretEnc = provider === 'none' ? null : secret ? encryptSecret(secret, 'settings:captcha') : provider === saved.provider ? saved.secretEnc : null;
  if (provider !== 'none' && !secretEnc) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', { secret: 'REQUIRED' });
  return { value: { provider, siteKey, secretEnc, minScore, use: { signIn: bool(use.signIn), signUp: bool(use.signUp), passwordReset: bool(use.passwordReset) } }, secret };
}

const brandingVersion = (b: Branding) => createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0, 12);

// Public: what every page (sign-in included) needs to look like the operator's panel and run its forms.
export async function publicConfig() {
  const { smsUse } = await import('./sms');
  const [b, captcha, reset, phone, smsCodes, mailCodes] = await Promise.all([getSettings('branding'), activeCaptcha(), mailUse('passwordReset'), smsUse('phoneVerification'), smsUse('twoFactor'), mailUse('twoFactor')]);
  return {
    branding: { name: b.name, accent: b.accent, logo: !!b.logo, favicon: !!b.favicon, version: brandingVersion(b) },
    passwordReset: reset,
    // Phone numbers can be verified (SMS), and where two-factor codes can be sent besides an authenticator app.
    phoneVerification: phone,
    otpChannels: { sms: smsCodes, email: mailCodes },
    // Sign-in with a one-time code sent by e-mail (the admin turns it on; needs working mail).
    emailCodeSignIn: mailCodes && (await getSettings('security')).emailCodeSignIn,
    // Other sign-in methods: social buttons, the e-mail link, user names, and One Tap's public client id.
    signIn: await getSettings('signIn').then(async (s) => {
      const { enabledSocial } = await import('./social-providers');
      const social = enabledSocial(s);
      return { social, magicLink: s.magicLink && (await mailReady()), username: s.username, oneTap: s.oneTap && social.includes('google') ? { clientId: s.providers.google!.clientId } : null };
    }),
    // Single sign-on: the button's label when it is on (sso.ts).
    sso: await getSettings('directory').then((d) => (d.oidc.enabled ? { name: d.oidc.name } : null)),
    captcha: captcha ? { provider: captcha.provider, siteKey: captcha.siteKey, use: captcha.use } : null,
    // Older web builds read this field.
    turnstileSiteKey: captcha?.provider === 'turnstile' ? captcha.siteKey : null,
  };
}

