// SMS providers. Each one: the account fields the admin fills in (labels are translated by the panel from
// the field key), and send() for one message to one number, checked the way the provider documents it.
// confidence: 'docs' = built from the provider's official API documentation; 'partial' = official docs
// that leave the response format open; 'community' = no public docs, built from third-party integrations.
// None of these were called with real accounts during development; the settings page has a test button.
import { createHmac, randomUUID } from 'node:crypto';

export type SmsResult = { ok: boolean; code?: string; ref?: string; detail?: string };
export type Phone = { e164: string; international: string; national: string; zeroNational: string };
export type Field = { key: string; secret?: boolean; optional?: boolean; options?: string[] };
export type SendInput = { credentials: Record<string, string>; sender: string; commercial: boolean };
export type Provider = { name: string; website: string; docs: string; confidence: 'docs' | 'partial' | 'community'; fields: Field[]; senderRequired: boolean;
  iys: boolean; send: (i: SendInput, to: Phone, text: string) => Promise<SmsResult> };

// E.164 in (+905321234567); each provider gets the form it documents.
export function phoneForms(e164: string): Phone {
  const digits = e164.replace(/\D/g, '');
  const national = digits.startsWith('90') ? digits.slice(2) : digits; // 5321234567
  return { e164: `+${digits}`, international: digits, national, zeroNational: `0${national}` };
}

const timeout = () => AbortSignal.timeout(15_000);
async function call(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, signal: timeout() });
  return { status: res.status, text: (await res.text()).trim() };
}
const json = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  call(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const xml = (url: string, body: string, headers: Record<string, string> = {}) =>
  call(url, { method: 'POST', headers: { 'content-type': 'text/xml; charset=UTF-8', ...headers }, body });
const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const esc = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const parse = (t: string) => { try { return JSON.parse(t); } catch { return null; } };
const ok = (ref?: string): SmsResult => ({ ok: true, ref: ref?.slice(0, 80) });
const fail = (code: string, detail?: string): SmsResult => ({ ok: false, code, detail: detail?.slice(0, 200) });
// Provider-specific codes map to a few the panel explains; the provider's own text goes in detail.
const auth = (d: string) => fail('SMS_AUTH_FAILED', d);
const rejected = (d: string) => fail('SMS_REJECTED', d);

// Bearer tokens some providers issue for a day; kept in memory per account.
const tokens = new Map<string, { token: string; until: number }>();
async function cachedToken(key: string, ttlMs: number, get: () => Promise<string | null>) {
  const t = tokens.get(key);
  if (t && t.until > Date.now()) return t.token;
  const fresh = await get();
  if (fresh) tokens.set(key, { token: fresh, until: Date.now() + ttlMs });
  return fresh;
}

const user = { key: 'username' }, pass = { key: 'password', secret: true };

export const providers: Record<string, Provider> = {
  netgsm: {
    name: 'NetGSM', website: 'https://www.netgsm.com.tr', docs: 'https://www.netgsm.com.tr/dokuman/', confidence: 'docs', senderRequired: true, iys: true,
    fields: [user, pass],
    async send(i, to, text) {
      const r = await json('https://api.netgsm.com.tr/sms/rest/v2/send', { msgheader: i.sender, messages: [{ msg: text, no: to.national }], encoding: 'TR', iysfilter: i.commercial ? '11' : '0' },
        { authorization: basic(i.credentials.username, i.credentials.password) });
      const b = parse(r.text);
      if (b?.code === '00') return ok(b.jobid);
      return b?.code === '30' ? auth(r.text) : rejected(r.text);
    },
  },
  verimor: {
    name: 'Verimor', website: 'https://www.verimor.com.tr', docs: 'https://github.com/verimor/SMS-API/blob/master/user_guide.md', confidence: 'docs', senderRequired: false, iys: true,
    fields: [user, pass, { key: 'recipientType', options: ['BIREYSEL', 'TACIR'], optional: true }],
    async send(i, to, text) {
      const r = await json('https://sms.verimor.com.tr/v2/send.json', { username: i.credentials.username, password: i.credentials.password, ...(i.sender && { source_addr: i.sender }),
        datacoding: '1', messages: [{ msg: text, dest: to.international }], ...(i.commercial && { is_commercial: true, iys_recipient_type: i.credentials.recipientType || 'BIREYSEL' }) });
      if (r.status === 200) return ok(r.text);
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  vatansms: {
    name: 'VatanSMS', website: 'https://www.vatansms.net', docs: 'https://docs.vatansms.net/rest-sms-api/1n-sms', confidence: 'partial', senderRequired: true, iys: true,
    fields: [{ key: 'apiId' }, { key: 'apiKey', secret: true }],
    async send(i, to, text) {
      const r = await json('https://api.vatansms.net/api/v1/1toN', { api_id: i.credentials.apiId, api_key: i.credentials.apiKey, sender: i.sender, message_type: 'turkce', message: text,
        message_content_type: i.commercial ? 'ticari' : 'bilgi', phones: [to.national] });
      // The response format is not documented: a 2xx without an error/false status counts as accepted.
      const b = parse(r.text);
      if (r.status < 300 && b && b.status !== false && b.status !== 'error' && !b.error) return ok(String(b.id ?? b.report_id ?? b.data?.id ?? ''));
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  iletimerkezi: {
    name: 'İleti Merkezi', website: 'https://www.iletimerkezi.com', docs: 'https://www.iletimerkezi.com/docs/api/send-sms', confidence: 'docs', senderRequired: true, iys: true,
    fields: [{ key: 'apiKey' }, { key: 'apiHash', secret: true }, { key: 'recipientType', options: ['BIREYSEL', 'TACIR'], optional: true }],
    async send(i, to, text) {
      const r = await json('https://api.iletimerkezi.com/v1/send-sms/json', { request: { authentication: { key: i.credentials.apiKey, hash: i.credentials.apiHash },
        order: { sender: i.sender, sendDateTime: [], iys: i.commercial ? '1' : '0', ...(i.commercial && { iysList: i.credentials.recipientType || 'BIREYSEL' }),
          message: { text, receipents: { number: [to.national] } } } } });
      const b = parse(r.text)?.response;
      if (String(b?.status?.code) === '200') return ok(String(b.order?.id ?? ''));
      return String(b?.status?.code) === '401' ? auth(r.text) : rejected(r.text);
    },
  },
  mutlucell: {
    name: 'Mutlucell', website: 'https://www.mutlucell.com.tr', docs: 'https://www.mutlucell.com.tr/api/', confidence: 'docs', senderRequired: true, iys: true,
    fields: [user, pass, { key: 'brandCode', optional: true }],
    async send(i, to, text) {
      const brand = i.commercial && i.credentials.brandCode ? ` brandCode="${esc(i.credentials.brandCode)}"` : '';
      const r = await xml('https://smsgw.mutlucell.com/smsgw-ws/sndblkex', `<?xml version="1.0" encoding="UTF-8"?><smspack ka="${esc(i.credentials.username)}" pwd="${esc(i.credentials.password)}" org="${esc(i.sender)}" charset="turkish"${brand}><mesaj><metin>${esc(text)}</metin><nums>${to.international}</nums></mesaj></smspack>`);
      if (r.text.startsWith('$')) return ok(r.text.slice(1));
      return r.text === '23' ? auth(r.text) : rejected(r.text);
    },
  },
  jetsms: {
    name: 'JetSMS (Biotekno)', website: 'https://www.jetsms.com.tr', docs: 'https://docs.jetsms.com.tr/', confidence: 'docs', senderRequired: true, iys: true,
    fields: [user, pass, { key: 'brandCode', optional: true }, { key: 'recipientType', options: ['BIREYSEL', 'TACIR'], optional: true }],
    async send(i, to, text) {
      const r = await json('https://smsapi.jetsms.com.tr/api/SendSms', { user: i.credentials.username, password: i.credentials.password, originator: i.sender, messageType: 4,
        smsmessages: [{ messagetext: text, recipient: to.international }], iysfilter: i.commercial ? '1' : '0',
        ...(i.commercial && { brandcode: i.credentials.brandCode, recipienttype: i.credentials.recipientType || 'BIREYSEL' }) });
      const b = parse(r.text);
      if (b?.responseCode === '00' && (b.responseGroupIdArray?.[0]?.status ?? '0') === '0') return ok(b.responseMessage);
      return b?.responseCode === '10' || r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  telsam: {
    name: 'Telsam', website: 'https://telsam.com.tr', docs: 'https://sms.telsam.com.tr/api-docs/', confidence: 'docs', senderRequired: true, iys: true,
    fields: [user, pass],
    async send(i, to, text) {
      const r = await json('https://sms.telsam.com.tr:9588/sms/create', { type: 1, sendingType: 0, title: 'Lightning VM', content: text, number: to.international, encoding: 1,
        sender: i.sender, commercial: i.commercial }, { authorization: basic(i.credentials.username, i.credentials.password) });
      const b = parse(r.text);
      if (b?.data?.pkgID && !b.err) return ok(String(b.data.pkgID));
      return b?.err?.status === 403 || r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  postaguvercini: {
    name: 'Posta Güvercini', website: 'https://www.postaguvercini.com', docs: 'https://www.postaguvercini.com/AnaSayfa/api-dokumanlari.aspx', confidence: 'docs', senderRequired: false, iys: false,
    fields: [user, pass],
    async send(i, to, text) {
      // This API wants ISO-8859-9 percent-encoding (Turkish letters as single bytes).
      const latin5: Record<string, number> = { 'Ğ': 0xd0, 'İ': 0xdd, 'Ş': 0xde, 'ğ': 0xf0, 'ı': 0xfd, 'ş': 0xfe };
      const enc = (s: string) => [...s].map((c) => { const b = latin5[c] ?? c.charCodeAt(0); return /[A-Za-z0-9\-_.~]/.test(c) ? c : b < 256 ? `%${b.toString(16).toUpperCase().padStart(2, '0')}` : '%3F'; }).join('');
      const r = await call(`https://www.postaguvercini.com/api_http/sendsms.asp?user=${enc(i.credentials.username)}&password=${enc(i.credentials.password)}&gsm=${to.national}&text=${enc(text)}`);
      const p = new URLSearchParams(r.text);
      if (p.get('errno') === '0') return ok(p.get('message_id') ?? '');
      return p.get('errno') === '10' ? auth(r.text) : rejected(r.text);
    },
  },
  kobikom: {
    name: 'Kobikom', website: 'https://www.kobikom.com.tr', docs: 'https://developer.kobikom.com.tr/docs/sms/otp-tekli-sms-gonderimi', confidence: 'partial', senderRequired: true, iys: false,
    fields: [{ key: 'apiToken', secret: true }],
    async send(i, to, text) {
      const q = new URLSearchParams({ api_token: i.credentials.apiToken, to: to.international, from: i.sender, message: text });
      const r = await call(`https://sms.kobikom.com.tr/api/message/send?${q}`);
      const b = parse(r.text);
      if (r.status < 300 && b?.data?.[0]?.uuid) return ok(b.data[0].uuid);
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  masgsm: {
    name: 'MasGSM / SenaGSM', website: 'https://www.masgsm.com.tr', docs: 'https://www.masgsm.com.tr/files/api-dokumantasyonu.pdf', confidence: 'partial', senderRequired: true, iys: false,
    fields: [user, { key: 'apiSecret', secret: true }],
    async send(i, to, text) {
      const r = await xml('https://api.senagsm.com.tr/api/smspost/v1', `<sms><username>${esc(i.credentials.username)}</username><password>${esc(i.credentials.apiSecret)}</password><header>${esc(i.sender)}</header><validity>2880</validity><message><gsm><no>${to.international}</no></gsm><msg><![CDATA[${text.replace(/]]>/g, ']] >')}]]></msg></message></sms>`);
      if (r.text.startsWith('00')) return ok(r.text.slice(3));
      return r.text.startsWith('87') ? auth(r.text) : rejected(r.text);
    },
  },
  ttmesaj: {
    name: 'TTMesaj (Türk Telekom)', website: 'https://www.ttmesaj.com', docs: 'https://www.ttmesaj.com/tr/sms-gonderim-metotlari', confidence: 'docs', senderRequired: true, iys: true,
    fields: [user, pass, { key: 'brandCode', optional: true }, { key: 'recipientType', options: ['BIREYSEL', 'TACIR'], optional: true }],
    async send(i, to, text) {
      const c = i.credentials;
      const token = await cachedToken(`ttmesaj:${c.username}`, 23 * 3600_000, async () =>
        parse((await json('https://restapi.ttmesaj.com/api/Login/TokenJson', { userName: c.username, password: c.password })).text)?.access_token ?? null);
      if (!token) return auth('token');
      const r = await json('https://restapi.ttmesaj.com/api/SendSms/SendSingle', { username: c.username, password: c.password, numbers: to.international, message: text, origin: i.sender,
        sd: '0', ed: '', isNotification: !i.commercial, ...(i.commercial && { recipentType: c.recipientType || 'BIREYSEL', brandCode: c.brandCode }) }, { authorization: `Bearer ${token}` });
      const b = parse(r.text);
      if (String(b?.sonuc ?? '').startsWith('*OK*')) return ok(String(b.sonuc).slice(4));
      if (r.status === 401) tokens.delete(`ttmesaj:${c.username}`);
      return String(b?.sonuc) === '1' || r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  organik: {
    name: 'Organik Haberleşme', website: 'https://www.organikhaberlesme.com', docs: 'https://apidocs.organikhaberlesme.com/', confidence: 'docs', senderRequired: true, iys: true,
    // The sender is the numeric header id (GET /sms/headers/get), not the header text.
    fields: [{ key: 'apiKey', secret: true }, { key: 'recipientType', options: ['BIREYSEL', 'TACIR'], optional: true }],
    async send(i, to, text) {
      const r = await json('https://api.organikhaberlesme.com/sms/send', { message: text, recipients: [to.international], header: Number(i.sender), type: 'turkish',
        ...(i.commercial && { commercial: i.credentials.recipientType || 'BIREYSEL' }) }, { 'x-organik-auth': i.credentials.apiKey });
      const b = parse(r.text);
      if (b?.result === true) return ok(JSON.stringify(b.data ?? '').slice(0, 80));
      return r.status === 401 || r.status === 403 ? auth(r.text) : rejected(r.text);
    },
  },
  hermes: {
    name: 'Hermes İletişim (İletişim Makinesi)', website: 'https://www.iletisimmakinesi.com', docs: 'https://api.iletisimmakinesi.com/single-shot-sms-gateway-api/', confidence: 'docs', senderRequired: true, iys: true,
    // The sender is the numeric originator id.
    fields: [user, pass, { key: 'customerCode' }, { key: 'apiKey', secret: true }, { key: 'vendorCode', optional: true }, { key: 'brandCode', optional: true },
      { key: 'recipientType', options: ['birey', 'tacir'], optional: true }],
    async send(i, to, text) {
      const c = i.credentials;
      const token = await cachedToken(`hermes:${c.username}`, 12 * 3600_000, async () => {
        const q = new URLSearchParams({ userName: c.username, userPass: c.password, customerCode: c.customerCode, apiKey: c.apiKey, vendorCode: c.vendorCode ?? '' });
        return (await call(`https://live.iletisimmakinesi.com/api/UserGatewayWS/functions/authenticate?${q}`)).text.match(/<TOKEN_NO>([^<]+)<\/TOKEN_NO>/)?.[1] ?? null;
      });
      if (!token) return auth('authenticate');
      const q = new URLSearchParams({ token, originatorId: i.sender, phoneNumber: to.international, messageText: text, iysTransactionType: i.commercial ? 'reklam' : 'bilgilendirme',
        ...(i.commercial && { iysBrandCode: c.brandCode ?? '', iysRecipientType: c.recipientType || 'birey' }) });
      const r = await call(`https://live.iletisimmakinesi.com/api/SingleShotWS/functions/sendSingleShotSMS?${q}`);
      if (/<CODE>0<\/CODE>/.test(r.text)) return ok(r.text.match(/<ID>([^<]+)<\/ID>/)?.[1]);
      tokens.delete(`hermes:${c.username}`);
      return rejected(r.text);
    },
  },
  codec: {
    name: 'Codec (FastSMS)', website: 'https://www.codec.com.tr', docs: 'https://fastsms-api.codec.com.tr/Soap.asmx?op=SendSms', confidence: 'partial', senderRequired: true, iys: true,
    fields: [user, pass, { key: 'brandCode', optional: true }],
    async send(i, to, text) {
      const body = new URLSearchParams({ userName: i.credentials.username, password: i.credentials.password, sender: i.sender, phone: to.international, messageContent: text,
        msgSpecialId: 'Empty', isOtn: 'true', headerCode: 'Empty', responseType: '3', optionalParameters: '', iysMessageType: i.commercial ? 'TICARI' : 'BILGILENDIRME',
        iysBrandCode: i.credentials.brandCode ?? '', iysRecipientType: i.commercial ? 'BIREYSEL' : '' });
      const r = await call('https://fastsms-api.codec.com.tr/Soap.asmx/SendSms', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
      // Undocumented result string: an HTTP 200 whose payload carries no error word counts as accepted.
      const inner = r.text.replace(/<[^>]+>/g, '').trim();
      if (r.status === 200 && inner && !/hata|error|invalid|yetki|false/i.test(inner)) return ok(inner);
      return /yetki|auth|şifre|password/i.test(inner) ? auth(inner) : rejected(inner || r.text);
    },
  },
  dataport: {
    name: 'Dataport', website: 'https://www.dataport.com.tr', docs: '', confidence: 'community', senderRequired: true, iys: false,
    fields: [user, pass, { key: 'accountNumber' }, { key: 'shortNumber' }, { key: 'operator', options: ['1', '2', '3', '4'] }],
    async send(i, to, text) {
      const c = i.credentials;
      const token = await cachedToken(`dataport:${c.username}`, 3600_000, async () => {
        const r = await call('https://api.dataport.com.tr/restapi/Register', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ UserName: c.username, Password: c.password, Scope: c.accountNumber, grant_type: 'password' }) });
        return parse(r.text)?.access_token ?? null;
      });
      if (!token) return auth('token');
      const r = await json('https://api.dataport.com.tr/restapi/api/Messages/SendSMS', { SessionID: '', Operator: Number(c.operator), GroupID: '', Orginator: i.sender, ShortNumber: c.shortNumber,
        Isunicode: 1, SendDate: '', DeleteDate: '', MessageList: { GSMList: [{ Value: to.national }], ContentList: [{ Value: text }] } }, { authorization: `Bearer ${token}` });
      if (r.status < 300 && !/error|hata/i.test(r.text)) return ok(r.text);
      if (r.status === 401) tokens.delete(`dataport:${c.username}`);
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  mesajpaneli: {
    name: 'SMSVitrini / MesajPaneli', website: 'https://www.smsvitrini.com', docs: '', confidence: 'community', senderRequired: true, iys: false,
    fields: [user, pass],
    async send(i, to, text) {
      const data = Buffer.from(JSON.stringify({ user: { name: i.credentials.username, pass: i.credentials.password }, msgBaslik: i.sender, msgData: [{ tel: to.national, msg: text }], tr: true })).toString('base64');
      const r = await call('https://api.mesajpaneli.com/json_api/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ data }) });
      const b = parse(Buffer.from(r.text, 'base64').toString('utf8'));
      if (b?.status === true) return ok(String(b.ref ?? ''));
      return rejected(b?.error ?? r.text);
    },
  },
  turatel: {
    name: 'Turatel', website: 'https://www.turatel.com', docs: '', confidence: 'community', senderRequired: true, iys: false,
    fields: [user, pass, { key: 'channelCode' }],
    async send(i, to, text) {
      const c = i.credentials;
      const r = await xml('https://processor.smsorigin.com/xml/process.aspx', `<?xml version="1.0" encoding="utf-8"?><MainmsgBody><Command>0</Command><PlatformID>1</PlatformID><ChannelCode>${esc(c.channelCode)}</ChannelCode><UserName>${esc(c.username)}</UserName><PassWord>${esc(c.password)}</PassWord><Mesgbody>${esc(text)}</Mesgbody><Numbers>${to.international}</Numbers><Type>1</Type><Originator>${esc(i.sender)}</Originator></MainmsgBody>`);
      // Error replies are short numeric codes (01 credentials, 02 credit, 05 sender, 20/21 XML); anything longer is a message id.
      if (/^ID:|^\d{5,}/.test(r.text)) return ok(r.text);
      return r.text === '01' ? auth(r.text) : rejected(r.text);
    },
  },
  mobildev: {
    name: 'Mobildev', website: 'https://www.mobildev.com', docs: 'https://docs.mobildev.com/process/mobildev-api/entegrator', confidence: 'community', senderRequired: false, iys: false,
    fields: [{ key: 'apiKey' }, { key: 'apiSecret', secret: true }],
    async send(i, to, text) {
      const path = '/v1/transactional/send';
      const body = JSON.stringify({ to: to.national, message: text });
      const ts = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
      const sig = createHmac('sha256', i.credentials.apiSecret).update(`POST\n${path}\n${ts}\n${nonce}\n${body}`).digest('hex');
      const r = await call(`https://xmlapi.mobildev.com${path}`, { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-api-key': i.credentials.apiKey, 'x-timestamp': ts, 'x-nonce': nonce, 'x-signature': sig } });
      if (r.status < 300 && /^ID:/.test(r.text)) return ok(r.text.slice(3));
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  // ---- International providers (any country; numbers in E.164). The sender is a registered number, an
  // alphanumeric sender ID where the country allows it, or the provider's own service ID.
  twilio: {
    name: 'Twilio', website: 'https://www.twilio.com', docs: 'https://www.twilio.com/docs/messaging/api/message-resource#create-a-message-resource', confidence: 'docs', senderRequired: true, iys: false,
    fields: [{ key: 'accountSid' }, { key: 'authToken', secret: true }],
    async send(i, to, text) {
      // A Messaging Service SID (MG...) as the sender lets Twilio pick the number.
      const from: Record<string, string> = i.sender.startsWith('MG') ? { MessagingServiceSid: i.sender } : { From: i.sender };
      const r = await call(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(i.credentials.accountSid)}/Messages.json`, { method: 'POST',
        headers: { authorization: basic(i.credentials.accountSid, i.credentials.authToken), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to.e164, Body: text, ...from }).toString() });
      const b = parse(r.text);
      if (r.status === 201) return ok(b?.sid);
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  vonage: {
    name: 'Vonage (Nexmo)', website: 'https://www.vonage.com/communications-apis/sms/', docs: 'https://developer.vonage.com/en/api/sms', confidence: 'docs', senderRequired: true, iys: false,
    fields: [{ key: 'apiKey' }, { key: 'apiSecret', secret: true }],
    async send(i, to, text) {
      const r = await call('https://rest.nexmo.com/sms/json', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ api_key: i.credentials.apiKey, api_secret: i.credentials.apiSecret, from: i.sender, to: to.international, text, type: 'unicode' }).toString() });
      const m = parse(r.text)?.messages?.[0];
      if (m?.status === '0') return ok(m['message-id']);
      return m?.status === '4' ? auth(r.text) : rejected(r.text);
    },
  },
  infobip: {
    name: 'Infobip', website: 'https://www.infobip.com', docs: 'https://www.infobip.com/docs/api/channels/sms/sms-messaging/outbound-sms/send-sms-messages', confidence: 'docs', senderRequired: false, iys: false,
    fields: [{ key: 'baseUrl' }, { key: 'apiKey', secret: true }],
    async send(i, to, text) {
      const host = i.credentials.baseUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!/^[a-z0-9-]+\.api\.infobip\.com$/.test(host)) return fail('SMS_INVALID_SETTINGS', 'baseUrl (xxxxx.api.infobip.com)');
      const r = await json(`https://${host}/sms/2/text/advanced`, { messages: [{ destinations: [{ to: to.international }], ...(i.sender && { from: i.sender }), text }] },
        { authorization: `App ${i.credentials.apiKey}` });
      const b = parse(r.text);
      if (r.status === 200) return ok(b?.messages?.[0]?.messageId);
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  plivo: {
    name: 'Plivo', website: 'https://www.plivo.com', docs: 'https://www.plivo.com/docs/messaging/api/message/send-a-message', confidence: 'docs', senderRequired: true, iys: false,
    fields: [{ key: 'authId' }, { key: 'authToken', secret: true }],
    async send(i, to, text) {
      const r = await json(`https://api.plivo.com/v1/Account/${encodeURIComponent(i.credentials.authId)}/Message/`, { src: i.sender, dst: to.international, text },
        { authorization: basic(i.credentials.authId, i.credentials.authToken) });
      const b = parse(r.text);
      if (r.status === 202) return ok(b?.message_uuid?.[0]);
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  sinch: {
    name: 'Sinch', website: 'https://sinch.com', docs: 'https://developers.sinch.com/docs/sms/api-reference/sms/tag/Batches/', confidence: 'docs', senderRequired: true, iys: false,
    fields: [{ key: 'servicePlanId' }, { key: 'apiToken', secret: true }, { key: 'region', options: ['us', 'eu', 'au', 'br', 'ca'] }],
    async send(i, to, text) {
      const region = ['us', 'eu', 'au', 'br', 'ca'].includes(i.credentials.region) ? i.credentials.region : 'us';
      const r = await json(`https://${region}.sms.api.sinch.com/xms/v1/${encodeURIComponent(i.credentials.servicePlanId)}/batches`, { from: i.sender, to: [to.international], body: text },
        { authorization: `Bearer ${i.credentials.apiToken}` });
      const b = parse(r.text);
      if (r.status === 201) return ok(b?.id);
      return r.status === 401 || r.status === 403 ? auth(r.text) : rejected(r.text);
    },
  },
  telnyx: {
    name: 'Telnyx', website: 'https://telnyx.com', docs: 'https://developers.telnyx.com/api/messaging/send-message', confidence: 'docs', senderRequired: true, iys: false,
    fields: [{ key: 'apiKey', secret: true }, { key: 'messagingProfileId', optional: true }],
    async send(i, to, text) {
      const r = await json('https://api.telnyx.com/v2/messages', { from: i.sender, to: to.e164, text, ...(i.credentials.messagingProfileId && { messaging_profile_id: i.credentials.messagingProfileId }) },
        { authorization: `Bearer ${i.credentials.apiKey}` });
      const b = parse(r.text);
      if (r.status === 200) return ok(b?.data?.id);
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  clickatell: {
    name: 'Clickatell', website: 'https://www.clickatell.com', docs: 'https://docs.clickatell.com/channels/sms-channels/sms-api-reference/', confidence: 'docs', senderRequired: false, iys: false,
    fields: [{ key: 'apiKey', secret: true }],
    async send(i, to, text) {
      const r = await json('https://platform.clickatell.com/v1/message', { messages: [{ channel: 'sms', to: to.international, content: text, ...(i.sender && { from: i.sender }) }] },
        { authorization: i.credentials.apiKey });
      const m = parse(r.text)?.messages?.[0];
      if (r.status === 202 && m?.accepted) return ok(m.apiMessageId);
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  messagebird: {
    name: 'MessageBird (Bird)', website: 'https://bird.com', docs: 'https://developers.messagebird.com/api/sms-messaging/#send-outbound-sms', confidence: 'partial', senderRequired: true, iys: false,
    fields: [{ key: 'accessKey', secret: true }],
    async send(i, to, text) {
      const r = await json('https://rest.messagebird.com/messages', { originator: i.sender, recipients: [to.international], body: text }, { authorization: `AccessKey ${i.credentials.accessKey}` });
      const b = parse(r.text);
      if (r.status === 201) return ok(b?.id);
      return r.status === 401 ? auth(r.text) : rejected(r.text);
    },
  },
  // Any HTTP API not listed: URL and body templates with {to}, {text}, {sender} placeholders.
  custom: {
    name: 'Custom HTTP API', website: '', docs: '', confidence: 'docs', senderRequired: false, iys: false,
    fields: [{ key: 'url' }, { key: 'method', options: ['GET', 'POST'] }, { key: 'contentType', options: ['form', 'json'], optional: true },
      { key: 'body', optional: true }, { key: 'headers', optional: true, secret: true }, { key: 'phoneFormat', options: ['e164', 'international', 'national', 'zeroNational'] },
      { key: 'successPattern' }],
    async send(i, to, text) {
      const c = i.credentials;
      const number = to[(c.phoneFormat as keyof Phone) || 'international'];
      const fill = (s: string, enc: (v: string) => string) => s.replace(/\{to\}/g, enc(number)).replace(/\{text\}/g, enc(text)).replace(/\{sender\}/g, enc(i.sender));
      const url = fill(c.url, encodeURIComponent);
      if (!/^https?:\/\//.test(url)) return fail('SMS_INVALID_SETTINGS', 'url');
      const headers: Record<string, string> = c.headers ? JSON.parse(c.headers) : {};
      let body: string | undefined;
      if (c.method === 'POST' && c.body) {
        body = c.contentType === 'json' ? fill(c.body, (v) => JSON.stringify(v).slice(1, -1)) : fill(c.body, encodeURIComponent);
        headers['content-type'] = c.contentType === 'json' ? 'application/json' : 'application/x-www-form-urlencoded';
      }
      // The address is whatever the form names (the test runs unsaved values), so only the verdict leaves here: never
      // the answer's text, and a redirect is not followed (the secret headers would go with it).
      const r = await call(url, { method: c.method === 'POST' ? 'POST' : 'GET', headers, body, redirect: 'manual' });
      return new RegExp(c.successPattern).test(r.text) && r.status < 300 ? ok() : rejected(`HTTP ${Math.floor(r.status / 100)}xx`);
    },
  },
};
