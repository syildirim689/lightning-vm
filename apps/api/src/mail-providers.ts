// E-mail providers sent to through their HTTP APIs (SMTP stays in settings-store.ts with nodemailer). Each one:
// the account fields the admin fills in (labels are translated by the panel from the field key), and send() for
// one plain-text message, checked the way the provider documents it. None of these were called with real
// accounts during development; the settings page has a test button that sends a real message.
import { createHash, createHmac } from 'node:crypto';

export type MailMessage = { from: { name: string; address: string }; to: string; subject: string; text: string };
export type MailResult = { ok: boolean; code?: 'MAIL_AUTH_FAILED' | 'MAIL_REJECTED' | 'MAIL_CONNECTION_FAILED'; detail?: string; ref?: string };
export type MailField = { key: string; secret?: boolean; optional?: boolean; options?: string[] };
export type MailProvider = { name: string; website: string; docs: string; fields: MailField[]; send: (c: Record<string, string>, m: MailMessage) => Promise<MailResult> };

async function call(url: string, init: RequestInit) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    return { status: res.status, text: (await res.text()).trim().slice(0, 2000) };
  } catch (e) { return { status: 0, text: String((e as Error).message ?? e) }; }
}
const jsonPost = (url: string, body: unknown, headers: Record<string, string>) =>
  call(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) });
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const parse = (t: string) => { try { return JSON.parse(t); } catch { return null; } };
const fromLine = (f: MailMessage['from']) => (f.name ? `${f.name.replace(/[<>"]/g, '')} <${f.address}>` : f.address);
// 2xx: accepted; 401/403: credentials; status 0: no connection; anything else: the provider refused it.
function judge(r: { status: number; text: string }, ref?: (b: Record<string, unknown>) => unknown): MailResult {
  if (r.status >= 200 && r.status < 300) { const b = parse(r.text); return { ok: true, ref: b && ref ? String(ref(b) ?? '').slice(0, 120) : undefined }; }
  if (r.status === 0) return { ok: false, code: 'MAIL_CONNECTION_FAILED', detail: r.text };
  return { ok: false, code: r.status === 401 || r.status === 403 ? 'MAIL_AUTH_FAILED' : 'MAIL_REJECTED', detail: `HTTP ${r.status}: ${r.text.slice(0, 300)}` };
}
const apiKey = { key: 'apiKey', secret: true };

// AWS Signature Version 4 for one JSON POST (Amazon SES v2).
export function sigV4(o: { method: string; host: string; path: string; region: string; service: string; body: string; accessKey: string; secretKey: string; now?: Date }) {
  const now = o.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s).digest();
  const headers = `content-type:application/json\nhost:${o.host}\nx-amz-date:${amzDate}\n`;
  const signed = 'content-type;host;x-amz-date';
  const request = [o.method, o.path, '', headers, signed, hash(o.body)].join('\n');
  const scope = `${day}/${o.region}/${o.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(request)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretKey}`, day), o.region), o.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return { 'x-amz-date': amzDate, authorization: `AWS4-HMAC-SHA256 Credential=${o.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}

export const mailProviders: Record<string, MailProvider> = {
  resend: {
    name: 'Resend', website: 'https://resend.com', docs: 'https://resend.com/docs/api-reference/emails/send-email', fields: [apiKey],
    send: async (c, m) => judge(await jsonPost('https://api.resend.com/emails', { from: fromLine(m.from), to: [m.to], subject: m.subject, text: m.text },
      { authorization: `Bearer ${c.apiKey}` }), (b) => b.id),
  },
  sendgrid: {
    name: 'SendGrid (Twilio)', website: 'https://sendgrid.com', docs: 'https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send',
    fields: [apiKey, { key: 'region', options: ['global', 'eu'], optional: true }],
    send: async (c, m) => judge(await jsonPost(`https://api.${c.region === 'eu' ? 'eu.' : ''}sendgrid.com/v3/mail/send`, {
      personalizations: [{ to: [{ email: m.to }] }], from: { email: m.from.address, ...(m.from.name && { name: m.from.name }) }, subject: m.subject, content: [{ type: 'text/plain', value: m.text }],
    }, { authorization: `Bearer ${c.apiKey}` })),
  },
  mailgun: {
    name: 'Mailgun', website: 'https://www.mailgun.com', docs: 'https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/messages',
    fields: [apiKey, { key: 'domain' }, { key: 'region', options: ['us', 'eu'], optional: true }],
    async send(c, m) {
      const form = new URLSearchParams({ from: fromLine(m.from), to: m.to, subject: m.subject, text: m.text });
      return judge(await call(`https://api.${c.region === 'eu' ? 'eu.' : ''}mailgun.net/v3/${encodeURIComponent(c.domain)}/messages`,
        { method: 'POST', headers: { authorization: basic('api', c.apiKey), 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }), (b) => b.id);
    },
  },
  postmark: {
    name: 'Postmark', website: 'https://postmarkapp.com', docs: 'https://postmarkapp.com/developer/api/email-api',
    fields: [{ key: 'serverToken', secret: true }, { key: 'messageStream', optional: true }],
    send: async (c, m) => judge(await jsonPost('https://api.postmarkapp.com/email', { From: fromLine(m.from), To: m.to, Subject: m.subject, TextBody: m.text, MessageStream: c.messageStream || 'outbound' },
      { 'x-postmark-server-token': c.serverToken }), (b) => b.MessageID),
  },
  ses: {
    name: 'Amazon SES', website: 'https://aws.amazon.com/ses/', docs: 'https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html',
    fields: [{ key: 'accessKeyId' }, { key: 'secretAccessKey', secret: true }, { key: 'region' }],
    async send(c, m) {
      if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(c.region ?? '')) return { ok: false, code: 'MAIL_REJECTED', detail: 'region must look like eu-central-1' };
      const host = `email.${c.region}.amazonaws.com`, path = '/v2/email/outbound-emails';
      const body = JSON.stringify({ FromEmailAddress: fromLine(m.from), Destination: { ToAddresses: [m.to] },
        Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' } } } } });
      const sig = sigV4({ method: 'POST', host, path, region: c.region, service: 'ses', body, accessKey: c.accessKeyId, secretKey: c.secretAccessKey });
      return judge(await call(`https://${host}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...sig }, body }), (b) => b.MessageId);
    },
  },
  brevo: {
    name: 'Brevo (Sendinblue)', website: 'https://www.brevo.com', docs: 'https://developers.brevo.com/reference/sendtransacemail', fields: [apiKey],
    send: async (c, m) => judge(await jsonPost('https://api.brevo.com/v3/smtp/email', { sender: { email: m.from.address, ...(m.from.name && { name: m.from.name }) }, to: [{ email: m.to }],
      subject: m.subject, textContent: m.text }, { 'api-key': c.apiKey }), (b) => b.messageId),
  },
  mailjet: {
    name: 'Mailjet', website: 'https://www.mailjet.com', docs: 'https://dev.mailjet.com/email/guides/send-api-v31/',
    fields: [apiKey, { key: 'secretKey', secret: true }],
    async send(c, m) {
      const r = await jsonPost('https://api.mailjet.com/v3.1/send', { Messages: [{ From: { Email: m.from.address, Name: m.from.name || undefined }, To: [{ Email: m.to }], Subject: m.subject, TextPart: m.text }] },
        { authorization: basic(c.apiKey, c.secretKey) });
      const b = parse(r.text);
      // Mailjet answers 200 with a per-message status.
      if (r.status === 200 && b?.Messages?.[0]?.Status !== 'success') return { ok: false, code: 'MAIL_REJECTED', detail: r.text.slice(0, 300) };
      return judge(r, (x) => (x as { Messages?: { To?: { MessageID?: number }[] }[] }).Messages?.[0]?.To?.[0]?.MessageID);
    },
  },
  sparkpost: {
    name: 'SparkPost (Bird)', website: 'https://www.sparkpost.com', docs: 'https://developers.sparkpost.com/api/transmissions/',
    fields: [apiKey, { key: 'region', options: ['us', 'eu'], optional: true }],
    send: async (c, m) => judge(await jsonPost(`https://api.${c.region === 'eu' ? 'eu.' : ''}sparkpost.com/api/v1/transmissions`, {
      content: { from: { email: m.from.address, ...(m.from.name && { name: m.from.name }) }, subject: m.subject, text: m.text }, recipients: [{ address: { email: m.to } }],
    }, { authorization: c.apiKey }), (b) => (b as { results?: { id?: string } }).results?.id),
  },
  mailersend: {
    name: 'MailerSend', website: 'https://www.mailersend.com', docs: 'https://developers.mailersend.com/api/v1/email.html#send-an-email', fields: [apiKey],
    send: async (c, m) => judge(await jsonPost('https://api.mailersend.com/v1/email', { from: { email: m.from.address, ...(m.from.name && { name: m.from.name }) }, to: [{ email: m.to }],
      subject: m.subject, text: m.text }, { authorization: `Bearer ${c.apiKey}` })),
  },
  smtp2go: {
    name: 'SMTP2GO', website: 'https://www.smtp2go.com', docs: 'https://developers.smtp2go.com/docs/send-an-email', fields: [apiKey],
    async send(c, m) {
      const r = await jsonPost('https://api.smtp2go.com/v3/email/send', { sender: fromLine(m.from), to: [m.to], subject: m.subject, text_body: m.text }, { 'x-smtp2go-api-key': c.apiKey });
      const b = parse(r.text);
      if (r.status === 200 && b?.data?.succeeded !== 1) return { ok: false, code: 'MAIL_REJECTED', detail: r.text.slice(0, 300) };
      return judge(r, (x) => (x as { data?: { email_id?: string } }).data?.email_id);
    },
  },
  elasticemail: {
    name: 'Elastic Email', website: 'https://elasticemail.com', docs: 'https://elasticemail.com/developers/api-documentation/rest-api#operation/emailsTransactionalPost', fields: [apiKey],
    send: async (c, m) => judge(await jsonPost('https://api.elasticemail.com/v4/emails/transactional', {
      Recipients: { To: [m.to] }, Content: { From: fromLine(m.from), Subject: m.subject, Body: [{ ContentType: 'PlainText', Content: m.text, Charset: 'utf-8' }] },
    }, { 'x-elasticemail-apikey': c.apiKey }), (b) => b.TransactionID),
  },
  zeptomail: {
    name: 'ZeptoMail (Zoho)', website: 'https://www.zoho.com/zeptomail/', docs: 'https://www.zoho.com/zeptomail/help/api/email-sending.html',
    fields: [{ key: 'sendMailToken', secret: true }, { key: 'region', options: ['com', 'eu', 'in', 'com.au', 'jp', 'ca', 'sa', 'com.cn'], optional: true }],
    send: async (c, m) => judge(await jsonPost(`https://api.zeptomail.${c.region || 'com'}/v1.1/email`, {
      from: { address: m.from.address, ...(m.from.name && { name: m.from.name }) }, to: [{ email_address: { address: m.to } }], subject: m.subject, textbody: m.text,
    }, { authorization: c.sendMailToken.startsWith('Zoho-enczapikey') ? c.sendMailToken : `Zoho-enczapikey ${c.sendMailToken}` }), (b) => b.request_id),
  },
};

// Splits a provider form into stored non-secret fields and secrets (validated against the provider's list).
export function readProviderFields(id: string, given: Record<string, unknown>, savedSecrets: Record<string, string>) {
  const p = mailProviders[id];
  const fields: Record<string, string> = {};
  const plain: Record<string, string> = {}, secrets: Record<string, string> = {};
  for (const f of p.fields) {
    const v = typeof given[f.key] === 'string' ? (given[f.key] as string).trim() : '';
    if (v.length > 2000) { fields[f.key] = 'TOO_LONG'; continue; }
    if (f.options && v && !f.options.includes(v)) { fields[f.key] = 'INVALID_VALUE'; continue; }
    if (f.secret) { if (v) secrets[f.key] = v; else if (savedSecrets[f.key]) secrets[f.key] = savedSecrets[f.key]; else if (!f.optional) fields[f.key] = 'REQUIRED'; }
    else if (v) plain[f.key] = v;
    else if (!f.optional) fields[f.key] = 'REQUIRED';
  }
  return { plain, secrets, fields };
}
