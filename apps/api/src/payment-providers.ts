// Payment providers usable in Turkey: payment institutions (aggregators), bank virtual POS platforms and
// wallets. Each entry declares the account fields the merchant panel gives, the live and test hosts, and a
// credential check that moves no money (a BIN/installment query, a token request, or a status query for a
// made-up order: "order not found" proves the credentials). Sources and confidence: docs/research-payments.md.
// None of these were called with real merchant accounts during development; results are classified
// conservatively and the provider's own message is always shown.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

export type Mode = 'live' | 'test';
export type Field = { key: string; label: [tr: string, en: string]; secret?: boolean; optional?: boolean;
  // Used only inside the 3D Secure form hash: no API can confirm it, only a real 3D test payment.
  unverifiable?: boolean; options?: string[] };
export type CheckStatus = 'ok' | 'rejected' | 'inconclusive' | 'network' | 'unverifiable';
export type CheckResult = { status: CheckStatus; message?: string; httpStatus?: number; unverified?: string[] };
export type Kind = 'gateway' | 'bank' | 'wallet';
// Notes the panel explains (translated there).
export type Note = 'NO_SANDBOX_HOST' | 'TEST_HOST_UNCERTAIN' | 'FIXED_IP' | 'TOKEN_ROTATES' | 'WALLET_ONLY' | 'NO_SERVER_CHECK' | 'THREE_D_KEY' | 'IP_WHITELIST' | 'SAME_HOST_FOR_TEST';
export type Provider = {
  name: string; kind: Kind; platform: string; website: string; docs: string; confidence: 'docs' | 'partial' | 'community';
  fields: Field[]; hosts: Record<Mode, string>; threeD: string[]; notes: Note[];
  testCredentials?: Record<string, string>; testCards?: string[];
  check?: (c: Record<string, string>, base: string, mode: Mode) => Promise<CheckResult>;
};

const timeoutMs = 15_000;
type Reply = { status: number; text: string };
async function send(url: string, init: RequestInit): Promise<Reply> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  return { status: res.status, text: (await res.text()).trim() };
}
const postJson = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  send(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(body) });
const postForm = (url: string, form: Record<string, string>) =>
  send(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
const postXml = (url: string, xml: string, headers: Record<string, string> = {}) =>
  send(url, { method: 'POST', headers: { 'content-type': 'text/xml; charset=UTF-8', ...headers }, body: xml });
const parse = (t: string) => { try { return JSON.parse(t); } catch { return null; } };
const esc = (s = '') => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const tag = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i').exec(xml)?.[1]?.trim() ?? '';
const sha = (alg: string, s: string, enc: 'hex' | 'base64' = 'base64') => createHash(alg).update(s, 'utf8').digest(enc);
const hmac = (alg: string, key: string, s: string, enc: 'hex' | 'base64' = 'base64') => createHmac(alg, key).update(s, 'utf8').digest(enc);
const fakeOrder = () => `credcheck-${randomUUID().slice(0, 18)}`;
const bin = '435508'; // a common Turkish Visa BIN (also the public test card prefix of several banks)

const ok = (message?: string): CheckResult => ({ status: 'ok', message });
const rejected = (message: string, httpStatus?: number): CheckResult => ({ status: 'rejected', message, httpStatus });
// A status query for an order that does not exist: "not found" means the credentials were accepted; an
// authentication complaint means they were not; anything else is shown as-is for the admin to judge.
const authWords = /(invalid|hatal[ıi]|ge[çc]ersiz|yanl[ıi][şs]|incorrect|wrong).{0,40}(user|kullan[ıi]c[ıi]|password|[şs]ifre|parola|credential|kimlik|api|merchant|i[şs]yeri|terminal|client|key|anahtar|hash|imza|signature|mac)|authenti|unauthori|yetkisiz|yetki(niz)? yok|access denied|eri[şs]im (izni|reddedildi)|login|giri[şs] (ba[şs]ar[ıi]s[ıi]z|hatas[ıi])|bad credentials/i;
// "User/merchant/terminal not found" is an account problem, not a missing order.
const accountMissing = /(kullan[ıi]c[ıi]|user|merchant|i[şs]yeri|terminal|client|ma[ğg]aza|api|bayi|dealer).{0,30}(bulunama|not found|yok|does not exist)/i;
const notFoundWords = /(sipari[şs]|order|i[şs]lem|transaction|kay[ıi]t|record).{0,30}(bulunama|yok|not found|exist|found)|(bulunama|not found).{0,20}(sipari[şs]|order|i[şs]lem|kay[ıi]t|record)|no record|no transaction/i;
function judge(text: string, httpStatus: number): CheckResult {
  const message = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (httpStatus === 401) return rejected(message || 'HTTP 401', httpStatus);
  if (httpStatus === 403) return { status: 'network', message: message || 'HTTP 403 (IP not allowed?)', httpStatus };
  if (authWords.test(message) || accountMissing.test(message)) return rejected(message, httpStatus);
  if (notFoundWords.test(message)) return ok(message);
  return { status: 'inconclusive', message: message || `HTTP ${httpStatus}`, httpStatus };
}

// ---------------------------------------------------------------- field shorthands
const f = (key: string, tr: string, en: string, extra: Partial<Field> = {}): Field => ({ key, label: [tr, en], ...extra });
const secret = (key: string, tr: string, en: string, extra: Partial<Field> = {}) => f(key, tr, en, { secret: true, ...extra });
const threeDKey = (key: string, tr: string, en: string) => secret(key, tr, en, { unverifiable: true });

// ---------------------------------------------------------------- aggregators
const iyzico: Provider = {
  name: 'iyzico', kind: 'gateway', platform: 'iyzico', website: 'https://www.iyzico.com', docs: 'https://docs.iyzico.com', confidence: 'docs',
  fields: [f('apiKey', 'API anahtarı', 'API key'), secret('secretKey', 'Güvenlik anahtarı', 'Secret key')],
  hosts: { live: 'https://api.iyzipay.com', test: 'https://sandbox-api.iyzipay.com' }, threeD: ['Checkout Form', '3DS API'], notes: [],
  testCards: ['5890040000000016', '5526080000000006', '4766620000000001'],
  async check(c, base) {
    // IYZWSv2: HMAC-SHA256(secretKey, randomKey + uriPath + body), hex.
    const path = '/payment/bin/check';
    const body = JSON.stringify({ locale: 'tr', conversationId: randomUUID(), binNumber: '55287900' });
    const rnd = `${Date.now()}${randomBytes(4).toString('hex')}`;
    const signature = hmac('sha256', c.secretKey, rnd + path + body, 'hex');
    const auth = Buffer.from(`apiKey:${c.apiKey}&randomKey:${rnd}&signature:${signature}`).toString('base64');
    const r = await send(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-iyzi-rnd': rnd, authorization: `IYZWSv2 ${auth}` }, body });
    const b = parse(r.text);
    if (b?.status === 'success') return ok(b.cardAssociation ? `BIN: ${b.cardAssociation} ${b.bankName ?? ''}`.trim() : undefined);
    return b?.errorMessage ? rejected(`${b.errorCode ?? ''} ${b.errorMessage}`.trim(), r.status) : judge(r.text, r.status);
  },
};

const paytr: Provider = {
  name: 'PayTR', kind: 'gateway', platform: 'PayTR', website: 'https://www.paytr.com', docs: 'https://dev.paytr.com', confidence: 'docs',
  fields: [f('merchant_id', 'Mağaza no', 'Merchant ID'), secret('merchant_key', 'Mağaza parola (merchant_key)', 'Merchant key'), secret('merchant_salt', 'Mağaza gizli anahtar (merchant_salt)', 'Merchant salt')],
  hosts: { live: 'https://www.paytr.com', test: 'https://www.paytr.com' }, threeD: ['iFrame API', 'Direkt API (3D_PAY)'], notes: ['SAME_HOST_FOR_TEST'],
  testCards: ['4355084355084358', '5406675406675403'],
  async check(c, base) {
    const token = hmac('sha256', c.merchant_key, bin + c.merchant_id + c.merchant_salt);
    const r = await postForm(`${base}/odeme/api/bin-detail`, { merchant_id: c.merchant_id, bin_number: bin, paytr_token: token });
    const b = parse(r.text);
    if (b?.status === 'success' || b?.status === 'failed') return ok(b.status === 'success' ? `BIN: ${b.brand ?? ''} ${b.bank ?? ''}`.trim() : undefined);
    return b?.status === 'error' ? rejected(String(b.err_msg ?? 'error'), r.status) : judge(r.text, r.status);
  },
};

const param: Provider = {
  name: 'Param (TurkPos)', kind: 'gateway', platform: 'Param', website: 'https://param.com.tr', docs: 'https://dev.param.com.tr', confidence: 'community',
  fields: [f('CLIENT_CODE', 'Terminal no (CLIENT_CODE)', 'Client code'), f('CLIENT_USERNAME', 'Kullanıcı adı', 'User name'),
    secret('CLIENT_PASSWORD', 'Şifre', 'Password'), secret('GUID', 'Üye işyeri anahtarı (GUID)', 'Merchant key (GUID)')],
  hosts: { live: 'https://posws.param.com.tr/turkpos.ws/service_turkpos_prod.asmx', test: 'https://test-dmz.param.com.tr/turkpos.ws/service_turkpos_test.asmx' },
  threeD: ['3D (TP_WMD_UCD)', '3D_PAY', '3D_HOST'], notes: ['TEST_HOST_UNCERTAIN'],
  testCredentials: { CLIENT_CODE: '10738', CLIENT_USERNAME: 'Test', CLIENT_PASSWORD: 'Test', GUID: '0c13d406-873b-403b-9c09-a5766840d98c' }, testCards: ['5456165456165454'],
  async check(c, base) {
    const xml = `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>`
      + `<TP_Ozel_Oran_SK_Liste xmlns="https://turkpos.com.tr/"><G><CLIENT_CODE>${esc(c.CLIENT_CODE)}</CLIENT_CODE><CLIENT_USERNAME>${esc(c.CLIENT_USERNAME)}</CLIENT_USERNAME>`
      + `<CLIENT_PASSWORD>${esc(c.CLIENT_PASSWORD)}</CLIENT_PASSWORD></G><GUID>${esc(c.GUID)}</GUID></TP_Ozel_Oran_SK_Liste></soap:Body></soap:Envelope>`;
    const r = await postXml(base, xml, { soapaction: 'https://turkpos.com.tr/TP_Ozel_Oran_SK_Liste' });
    const code = tag(r.text, 'Sonuc');
    if (code !== '' && Number(code) > 0) return ok(tag(r.text, 'Sonuc_Str') || undefined);
    return code !== '' ? rejected(tag(r.text, 'Sonuc_Str') || `Sonuc ${code}`, r.status) : judge(r.text, r.status);
  },
};

// Sipay's "CCPayment" platform; Vepara runs on the same one.
function ccpayment(name: string, website: string, docs: string, hosts: Record<Mode, string>, confidence: Provider['confidence']): Provider {
  return {
    name, kind: 'gateway', platform: 'CCPayment (Sipay)', website, docs, confidence,
    fields: [f('merchant_id', 'Üye işyeri ID', 'Merchant ID'), f('app_id', 'Uygulama anahtarı (app_id)', 'App key (app_id)'),
      secret('app_secret', 'Uygulama parolası (app_secret)', 'App secret'), secret('merchant_key', 'Üye işyeri anahtarı (merchant_key)', 'Merchant key')],
    hosts, threeD: ['paySmart3D (3D_PAY)', 'Hosted'], notes: ['IP_WHITELIST'],
    async check(c, base) {
      const t = await postJson(`${base}/api/token`, { app_id: c.app_id, app_secret: c.app_secret, app_lang: 'tr' });
      const b = parse(t.text);
      if (b?.status_code !== 100 || !b?.data?.token) return b?.status_description ? rejected(String(b.status_description), t.status) : judge(t.text, t.status);
      // The token proves app_id/app_secret; getpos with the merchant key proves that one too.
      const p = await postJson(`${base}/api/getpos`, { credit_card: bin, amount: '100.00', currency_code: 'TRY', merchant_key: c.merchant_key }, { authorization: `Bearer ${b.data.token}` });
      const g = parse(p.text);
      if (g?.status_code === 100) return ok();
      return g?.status_description ? rejected(`merchant_key: ${g.status_description}`, p.status) : judge(p.text, p.status);
    },
  };
}

const papara: Provider = {
  name: 'Papara', kind: 'wallet', platform: 'Papara', website: 'https://www.papara.com', docs: 'https://merchant.test.papara.com', confidence: 'community',
  fields: [secret('ApiKey', 'API anahtarı', 'API key')],
  hosts: { live: 'https://merchant-api.papara.com', test: 'https://merchant.test.api.papara.com' }, threeD: ['Papara cüzdan yönlendirmesi'], notes: ['WALLET_ONLY'],
  async check(c, base) {
    const r = await send(`${base}/account`, { method: 'GET', headers: { ApiKey: c.ApiKey, accept: 'application/json' } });
    const b = parse(r.text);
    if (r.status === 200 && b?.succeeded !== false) return ok(b?.data?.legalName ?? b?.data?.brandName);
    return b?.error?.message ? rejected(String(b.error.message), r.status) : judge(r.text, r.status);
  },
};

const moka: Provider = {
  name: 'Moka United', kind: 'gateway', platform: 'Moka', website: 'https://mokaunited.com', docs: 'https://developer.moka.com', confidence: 'community',
  fields: [f('DealerCode', 'Bayi kodu', 'Dealer code'), f('Username', 'Kullanıcı adı', 'User name'), secret('Password', 'Şifre', 'Password')],
  hosts: { live: 'https://service.moka.com', test: 'https://service.refmoka.com' }, threeD: ['DoDirectPaymentThreeD (3D_PAY)'], notes: [],
  async check(c, base) {
    const CheckKey = sha('sha256', `${c.DealerCode}MK${c.Username}PD${c.Password}`, 'hex');
    const r = await postJson(`${base}/PaymentDealer/GetBankCardInformation`, {
      PaymentDealerAuthentication: { DealerCode: c.DealerCode, Username: c.Username, Password: c.Password, CheckKey }, BankCardInformationRequest: { BinNumber: bin } });
    const b = parse(r.text);
    if (b?.ResultCode === 'Success') return ok();
    return b?.ResultCode ? rejected(`${b.ResultCode}${b.ResultMessage ? `: ${b.ResultMessage}` : ''}`, r.status) : judge(r.text, r.status);
  },
};

const craftgate: Provider = {
  name: 'Craftgate', kind: 'gateway', platform: 'Craftgate', website: 'https://craftgate.io', docs: 'https://developer.craftgate.io', confidence: 'community',
  fields: [f('apiKey', 'API anahtarı', 'API key'), secret('secretKey', 'Gizli anahtar', 'Secret key')],
  hosts: { live: 'https://api.craftgate.io', test: 'https://sandbox-api.craftgate.io' }, threeD: ['3DS', 'Ortak Ödeme Formu'], notes: [],
  async check(c, base) {
    const url = `${base}/installment/v1/bins/${bin}`;
    const rnd = randomBytes(8).toString('hex');
    const signature = sha('sha256', decodeURIComponent(url) + c.apiKey + c.secretKey + rnd);
    const r = await send(url, { method: 'GET', headers: { 'x-api-key': c.apiKey, 'x-rnd-key': rnd, 'x-auth-version': '1', 'x-signature': signature, accept: 'application/json' } });
    const b = parse(r.text);
    if (r.status === 200 && !b?.errors) return ok(b?.data?.bankName);
    return b?.errors ? rejected(`${b.errors.errorCode ?? ''} ${b.errors.errorDescription ?? ''}`.trim(), r.status) : judge(r.text, r.status);
  },
};

const paynet: Provider = {
  name: 'Paynet', kind: 'gateway', platform: 'Paynet', website: 'https://paynet.com.tr', docs: 'https://doc.paynet.com.tr', confidence: 'docs',
  fields: [secret('secret_key', 'Gizli anahtar (secret_key)', 'Secret key'), f('publishable_key', 'Açık anahtar (Paynet.js)', 'Publishable key', { optional: true })],
  hosts: { live: 'https://api.paynet.com.tr', test: 'https://pts-api.paynet.com.tr' }, threeD: ['Paynet.js', '3D API'], notes: ['FIXED_IP'],
  async check(c, base) {
    const r = await postJson(`${base}/v1/ratio/Get`, { bin }, { authorization: `Basic ${c.secret_key}` });
    const b = parse(r.text);
    if (b?.code === 0) return ok();
    return b?.message ? rejected(`${b.code ?? ''} ${b.message}`.trim(), r.status) : judge(r.text, r.status);
  },
};

const esnekpos: Provider = {
  name: 'Esnekpos', kind: 'gateway', platform: 'Esnekpos', website: 'https://esnekpos.com', docs: 'https://developer.esnekpos.com', confidence: 'docs',
  fields: [f('MERCHANT', 'Üye işyeri (MERCHANT)', 'Merchant'), secret('MERCHANT_KEY', 'Üye işyeri anahtarı', 'Merchant key')],
  hosts: { live: 'https://posservice.esnekpos.com', test: 'https://posservicetest.esnekpos.com' }, threeD: ['3D', 'Ortak Ödeme Sayfası'], notes: ['TEST_HOST_UNCERTAIN'],
  testCredentials: { MERCHANT: 'TEST1234', MERCHANT_KEY: '4oK26hK8MOXrIV1bzTRVPA==' }, testCards: ['9792100000000001', '6587619825149656'],
  async check(c, base) {
    const r = await postJson(`${base}/api/services/GetDealerBalance`, { MERCHANT: c.MERCHANT, MERCHANT_KEY: c.MERCHANT_KEY, CURRENCY: 'TRY', DEALER_SUB_EXTERNAL_ID: null });
    const b = parse(r.text);
    if (String(b?.RETURN_CODE) === '0') return ok();
    return b?.RETURN_MESSAGE ? rejected(`${b.RETURN_CODE}: ${b.RETURN_MESSAGE}`, r.status) : judge(r.text, r.status);
  },
};

const ymdhis = (d = new Date()) => d.toISOString().replace(/\D/g, '').slice(0, 14);
const tosla: Provider = {
  name: 'Tosla (AKÖde)', kind: 'gateway', platform: 'Tosla', website: 'https://tosla.com', docs: 'https://tosla.com', confidence: 'community',
  fields: [f('clientId', 'Client ID', 'Client ID'), f('apiUser', 'API kullanıcısı', 'API user'), secret('apiPass', 'API şifresi', 'API password')],
  hosts: { live: 'https://entegrasyon.tosla.com/api/Payment', test: 'https://prepentegrasyon.tosla.com/api/Payment' }, threeD: ['3D_PAY', '3D_HOST'], notes: [],
  testCards: ['4546711234567894', '5406675406675403'],
  async check(c, base) {
    const rnd = randomBytes(12).toString('hex').toUpperCase();
    const timeSpan = ymdhis();
    const hash = sha('sha512', c.apiPass + c.clientId + c.apiUser + rnd + timeSpan);
    const r = await postJson(`${base}/inquiry`, { clientId: c.clientId, apiUser: c.apiUser, orderId: fakeOrder(), rnd, timeSpan, hash });
    const b = parse(r.text);
    if (b && Number(b.Code ?? b.code) === 0) return ok(b.Message ?? b.message);
    return judge(b ? `${b.Code ?? b.code ?? ''} ${b.Message ?? b.message ?? ''}` : r.text, r.status);
  },
};

const odeal: Provider = {
  name: 'Ödeal', kind: 'gateway', platform: 'Ödeal', website: 'https://odeal.com', docs: 'https://docs.odeal.com/sanalpos/tr/', confidence: 'community',
  fields: [f('clientId', 'Client ID', 'Client ID'), secret('clientSecret', 'Client secret', 'Client secret')],
  hosts: { live: 'https://auth.odeal.com/api/v1', test: 'https://auth-sandbox.odeal.com/api/v1' }, threeD: ['3D'], notes: ['TOKEN_ROTATES'],
  async check(c, base) {
    const r = await postJson(`${base}/token`, { clientId: c.clientId, clientSecret: c.clientSecret });
    const b = parse(r.text);
    if (b?.accessToken || b?.data?.accessToken) return ok();
    return judge(b?.message ?? r.text, r.status);
  },
};

// No documented read-only call: shown as "cannot be checked here", never as a fake success.
const unchecked = (p: Omit<Provider, 'check'>): Provider => ({ ...p, notes: [...new Set<Note>([...p.notes, 'NO_SERVER_CHECK'])] });
const withoutCheck = ({ check: _check, ...p }: Provider) => p;
const paycell = unchecked({
  name: 'Paycell', kind: 'gateway', platform: 'Paycell', website: 'https://www.paycell.com.tr', docs: 'https://www.paycell.com.tr', confidence: 'community',
  fields: [f('applicationName', 'Uygulama adı', 'Application name'), secret('applicationPwd', 'Uygulama şifresi', 'Application password'),
    secret('secureCode', 'Güvenlik kodu', 'Secure code'), f('merchantCode', 'Üye işyeri kodu', 'Merchant code'), f('eulaId', 'Sözleşme ID (eulaId)', 'EULA ID', { optional: true })],
  hosts: { live: 'https://tpay.turkcell.com.tr/tpay/provision/services/restful', test: 'https://tpay-test.turkcell.com.tr:443/tpay/provision/services/restful' },
  threeD: ['Paycell 3D'], notes: [], testCredentials: { applicationName: 'PAYCELLTEST', applicationPwd: 'PaycellTestPassword', secureCode: 'PAYCELL12345', merchantCode: '9998', eulaId: '17' },
});
const hepsipay = unchecked({
  name: 'Hepsipay', kind: 'gateway', platform: 'Hepsipay', website: 'https://hepsipay.com', docs: 'https://dev.hepsipay.com/docs/', confidence: 'partial',
  fields: [f('MerchantNo', 'Üye işyeri no', 'Merchant no'), f('TerminalNo', 'Terminal no', 'Terminal no'), secret('StoreKey', 'Mağaza anahtarı', 'Store key')],
  hosts: { live: 'https://merchantpfpayment-gateway.hepsipay.com', test: 'https://merchantpfpayment-gateway-qa.hepsipay.com' }, threeD: ['Iframe SDK'], notes: [],
});
const shopier = unchecked({
  name: 'Shopier', kind: 'gateway', platform: 'Shopier', website: 'https://www.shopier.com', docs: 'https://developer.shopier.com', confidence: 'community',
  fields: [f('apiKey', 'API kullanıcı', 'API key'), secret('apiSecret', 'API şifre', 'API secret')],
  hosts: { live: 'https://www.shopier.com', test: 'https://www.shopier.com' }, threeD: ['Hosted form'], notes: ['NO_SANDBOX_HOST'],
});

// ---------------------------------------------------------------- bank platforms
// Payten (Asseco) Nestpay "CC5": the same API at each bank's own host.
const nestpayFields = [f('clientId', 'Mağaza kodu (Client ID)', 'Store number (client ID)'), f('username', 'API kullanıcı adı', 'API user name'),
  secret('password', 'API şifresi', 'API password'), threeDKey('storeKey', '3D üye işyeri anahtarı (storeKey)', '3D store key')];
function nestpay(name: string, live: string, test = 'https://entegrasyon.asseco-see.com.tr', extra: Partial<Provider> = {}): Provider {
  return {
    name, kind: 'bank', platform: 'Payten Nestpay (EST)', website: 'https://www.payten.com.tr', docs: 'https://github.com/mewebstudio/pos', confidence: 'community',
    fields: nestpayFields, hosts: { live, test }, threeD: ['3D', '3D_PAY', '3D_PAY_HOSTING', '3D_HOST'], notes: ['THREE_D_KEY', 'IP_WHITELIST'],
    testCards: ['4355084355084358', '5406675406675403'], ...extra,
    async check(c, base) {
      const xml = `<?xml version="1.0" encoding="ISO-8859-9"?><CC5Request><Name>${esc(c.username)}</Name><Password>${esc(c.password)}</Password><ClientId>${esc(c.clientId)}</ClientId>`
        + `<OrderId>${fakeOrder()}</OrderId><Extra><ORDERSTATUS>QUERY</ORDERSTATUS></Extra></CC5Request>`;
      const r = await postXml(`${base}/fim/api`, xml);
      if (/<Response>\s*Approved/i.test(r.text)) return ok();
      return judge(`${tag(r.text, 'ErrMsg')} ${tag(r.text, 'ProcReturnCode')}`.trim() || r.text, r.status);
    },
  };
}

const akbank: Provider = {
  name: 'Akbank (yeni sanal POS API)', kind: 'bank', platform: 'Akbank JSON API', website: 'https://www.akbank.com', docs: 'https://github.com/mewebstudio/pos', confidence: 'community',
  fields: [f('merchantSafeId', 'Güvenli işyeri no (merchantSafeId)', 'Merchant safe ID'), f('terminalSafeId', 'Güvenli terminal no (terminalSafeId)', 'Terminal safe ID'),
    secret('secretKey', 'Güvenlik anahtarı', 'Secret key'), f('subMerchantId', 'Alt üye işyeri', 'Sub-merchant ID', { optional: true })],
  hosts: { live: 'https://api.akbank.com/api/v1/payment/virtualpos', test: 'https://apipre.akbank.com/api/v1/payment/virtualpos' },
  threeD: ['3D', '3D_PAY', '3D_HOST'], notes: ['IP_WHITELIST'], testCards: ['4355093000315232'],
  async check(c, base) {
    const now = new Date(Date.now() + 3 * 3600_000).toISOString().replace('Z', ''); // Türkiye time, as the bank expects
    const body = JSON.stringify({ version: '1.00', txnCode: '1010', requestDateTime: now, randomNumber: randomBytes(64).toString('hex').toUpperCase(),
      terminal: { merchantSafeId: c.merchantSafeId, terminalSafeId: c.terminalSafeId }, order: { orderId: fakeOrder() } });
    const r = await send(`${base}/transaction/process`, { method: 'POST', headers: { 'content-type': 'application/json', 'auth-hash': hmac('sha512', c.secretKey, body) }, body });
    const b = parse(r.text);
    if (r.status === 200 && (b?.code === 'VPS-0000' || b?.responseCode === 'VPS-0000')) return ok(b.message ?? b.responseMessage);
    return judge(b ? `${b.code ?? b.responseCode ?? ''} ${b.message ?? b.responseMessage ?? ''}` : r.text, r.status);
  },
};

const garanti: Provider = {
  name: 'Garanti BBVA', kind: 'bank', platform: 'Garanti GVP', website: 'https://www.garantibbva.com.tr', docs: 'https://dev.garantibbva.com.tr', confidence: 'community',
  fields: [f('merchantId', 'İşyeri no (Merchant ID)', 'Merchant ID'), f('terminalId', 'Terminal no', 'Terminal ID'), f('provUserId', 'Provizyon kullanıcısı (PROVAUT)', 'Provision user (PROVAUT)'),
    secret('provisionPassword', 'Provizyon şifresi', 'Provision password'), threeDKey('storeKey', '3D güvenlik anahtarı (storeKey)', '3D store key'),
    f('refundUserId', 'İade kullanıcısı (PROVRFN)', 'Refund user (PROVRFN)', { optional: true }), secret('refundPassword', 'İade şifresi', 'Refund password', { optional: true })],
  hosts: { live: 'https://sanalposprov.garanti.com.tr', test: 'https://sanalposprovtest.garantibbva.com.tr' }, threeD: ['3D', '3D_PAY', '3D_OOS_PAY'], notes: ['THREE_D_KEY', 'IP_WHITELIST'],
  testCredentials: { merchantId: '7000679', terminalId: '30691297', provUserId: 'PROVAUT', provisionPassword: '123qweASD/', storeKey: '12345678' }, testCards: ['4282209004348015'],
  async check(c, base, mode) {
    const orderId = fakeOrder().replace(/-/g, '');
    const securityData = sha('sha1', c.provisionPassword + c.terminalId.padStart(9, '0'), 'hex').toUpperCase();
    const amount = '100';
    const hashData = sha('sha512', orderId + c.terminalId + '' + amount + '949' + securityData, 'hex').toUpperCase();
    const xml = `<?xml version="1.0" encoding="UTF-8"?><GVPSRequest><Mode>${mode === 'live' ? 'PROD' : 'TEST'}</Mode><Version>512</Version>`
      + `<Terminal><ProvUserID>${esc(c.provUserId)}</ProvUserID><HashData>${hashData}</HashData><UserID>${esc(c.provUserId)}</UserID><ID>${esc(c.terminalId)}</ID><MerchantID>${esc(c.merchantId)}</MerchantID></Terminal>`
      + `<Customer><IPAddress>127.0.0.1</IPAddress><EmailAddress></EmailAddress></Customer><Order><OrderID>${orderId}</OrderID><GroupID></GroupID></Order>`
      + `<Transaction><Type>orderinq</Type><InstallmentCnt></InstallmentCnt><Amount>${amount}</Amount><CurrencyCode>949</CurrencyCode><CardholderPresentCode>0</CardholderPresentCode><MotoInd>N</MotoInd></Transaction></GVPSRequest>`;
    const r = await postXml(`${base}/VPServlet`, xml);
    if (tag(r.text, 'Code') === '00') return ok(tag(r.text, 'Message'));
    return judge(`${tag(r.text, 'ErrorMsg')} ${tag(r.text, 'SysErrMsg')} ${tag(r.text, 'Message')}`.trim() || r.text, r.status);
  },
};

const posnet: Provider = {
  name: 'Yapı Kredi', kind: 'bank', platform: 'Posnet', website: 'https://www.yapikredi.com.tr', docs: 'https://github.com/mewebstudio/pos', confidence: 'community',
  fields: [f('mid', 'Üye işyeri no (MID)', 'Merchant ID'), f('tid', 'Terminal no (TID)', 'Terminal ID'), f('posnetId', 'Posnet ID', 'Posnet ID'), threeDKey('encKey', '3D anahtarı (ENCKEY)', 'ENCKEY')],
  hosts: { live: 'https://posnet.yapikredi.com.tr', test: 'https://setmpos.ykb.com' }, threeD: ['3D (OOS)'], notes: ['THREE_D_KEY', 'IP_WHITELIST'], testCards: ['4048095010857528'],
  async check(c, base) {
    const xml = `<?xml version="1.0" encoding="ISO-8859-9"?><posnetRequest><mid>${esc(c.mid)}</mid><tid>${esc(c.tid)}</tid><agreement><orderID>${fakeOrder().replace(/-/g, '').slice(0, 24)}</orderID></agreement></posnetRequest>`;
    const r = await postForm(`${base}/PosnetWebService/XML`, { xmldata: xml });
    if (tag(r.text, 'approved') === '1') return ok();
    return judge(`${tag(r.text, 'respCode')} ${tag(r.text, 'respText')}`.trim() || r.text, r.status);
  },
};

const albaraka: Provider = {
  name: 'Albaraka Türk', kind: 'bank', platform: 'PosNet V1 (JSON)', website: 'https://www.albaraka.com.tr', docs: 'https://github.com/mewebstudio/pos', confidence: 'community',
  fields: [f('MerchantNo', 'Üye işyeri no', 'Merchant no'), f('TerminalNo', 'Terminal no', 'Terminal no'), f('PosNetId', 'PosNet / EPOS no', 'PosNet ID'), secret('encKey', 'ENCKEY', 'ENCKEY')],
  hosts: { live: 'https://epos.albarakaturk.com.tr', test: 'https://epostest.albarakaturk.com.tr' }, threeD: ['3D'], notes: ['IP_WHITELIST'],
  async check(c, base) {
    // This MAC includes ENCKEY, so a positive answer also proves the 3D key.
    const MAC = sha('sha256', c.MerchantNo + c.TerminalNo + c.encKey);
    const r = await postJson(`${base}/ALBMerchantService/MerchantJSONAPI.svc/TransactionInquiry`, { ApiType: 'JSON', ApiVersion: 'V100', MerchantNo: c.MerchantNo, TerminalNo: c.TerminalNo,
      MACParams: 'MerchantNo:TerminalNo', OrderId: fakeOrder().replace(/-/g, '').slice(0, 24), MAC });
    const b = parse(r.text);
    const d = b?.ServiceResponseData ?? b;
    if (d?.ResponseCode === '0000' || d?.ResponseCode === '00') return ok(d.ResponseDescription);
    return judge(d ? `${d.ResponseCode ?? ''} ${d.ResponseDescription ?? d.ResponseMessage ?? ''}` : r.text, r.status);
  },
};

function payfor(name: string, mbrId: string, hosts: Record<Mode, string>, extra: Partial<Provider> = {}): Provider {
  return {
    name, kind: 'bank', platform: 'PayFor', website: 'https://www.qnb.com.tr', docs: 'https://github.com/mewebstudio/pos', confidence: 'community',
    fields: [f('MerchantId', 'Üye işyeri no (MerchantId)', 'Merchant ID'), f('UserCode', 'API kullanıcı kodu', 'API user code'), secret('UserPass', 'API şifresi', 'API password'),
      threeDKey('MerchantPass', '3D anahtarı (MerchantPass)', '3D key (MerchantPass)')],
    hosts, threeD: ['3D', '3D_PAY', '3D_HOST'], notes: ['THREE_D_KEY', 'IP_WHITELIST'], testCards: ['4155650100416111'], ...extra,
    async check(c, base) {
      const xml = `<?xml version="1.0" encoding="UTF-8"?><PayforRequest><MerchantId>${esc(c.MerchantId)}</MerchantId><UserCode>${esc(c.UserCode)}</UserCode><UserPass>${esc(c.UserPass)}</UserPass>`
        + `<MbrId>${mbrId}</MbrId><OrgOrderId>${fakeOrder()}</OrgOrderId><SecureType>Inquiry</SecureType><TxnType>OrderInquiry</TxnType><Lang>TR</Lang></PayforRequest>`;
      const r = await postXml(base, xml);
      if (tag(r.text, 'ProcReturnCode') === '00') return ok();
      return judge(`${tag(r.text, 'ProcReturnCode')} ${tag(r.text, 'ErrMsg')}`.trim() || r.text, r.status);
    },
  };
}

const denizbank: Provider = {
  name: 'DenizBank', kind: 'bank', platform: 'InterVPOS', website: 'https://www.denizbank.com', docs: 'https://github.com/mewebstudio/pos', confidence: 'community',
  fields: [f('ShopCode', 'Mağaza kodu (ShopCode)', 'Shop code'), f('UserCode', 'API kullanıcı kodu', 'API user code'), secret('UserPass', 'API şifresi', 'API password'),
    threeDKey('MerchantPass', '3D anahtarı (MerchantPass)', '3D key (MerchantPass)')],
  hosts: { live: 'https://inter-vpos.com.tr', test: 'https://test.inter-vpos.com.tr' }, threeD: ['3D', '3D_PAY', '3D_HOST'], notes: ['THREE_D_KEY', 'IP_WHITELIST'],
  async check(c, base) {
    const r = await postForm(`${base}/mpi/Default.aspx`, { UserCode: c.UserCode, UserPass: c.UserPass, ShopCode: c.ShopCode, orgOrderId: fakeOrder(), TxnType: 'StatusHistory', SecureType: 'NonSecure', Lang: 'TR' });
    // "key=value;;key=value" text
    const kv = Object.fromEntries(r.text.split(';;').map((p) => p.split('=')).filter((p) => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join('=').trim()]));
    if (kv.ProcReturnCode === '00') return ok();
    return judge(`${kv.ProcReturnCode ?? ''} ${kv.ErrorMessage ?? kv.ErrMsg ?? ''}`.trim() || r.text, r.status);
  },
};

function payflex(name: string, search: Record<Mode, string>, extra: Partial<Provider> = {}): Provider {
  return {
    name, kind: 'bank', platform: 'PayFlex (VPOS 7/24)', website: 'https://www.vakifbank.com.tr', docs: 'https://github.com/mewebstudio/pos', confidence: 'community',
    fields: [f('MerchantId', 'Üye işyeri no (HostMerchantId)', 'Merchant ID'), secret('Password', 'API şifresi', 'API password'), f('TerminalNo', 'POS / terminal no', 'Terminal no')],
    hosts: search, threeD: ['3D (MPI)', 'Common Payment (3D_PAY / 3D_HOST)'], notes: ['IP_WHITELIST'], testCards: ['4938410157705591'], ...extra,
    async check(c, base) {
      const xml = `<SearchRequest><MerchantCriteria><HostMerchantId>${esc(c.MerchantId)}</HostMerchantId><MerchantPassword>${esc(c.Password)}</MerchantPassword></MerchantCriteria>`
        + `<TransactionCriteria><TransactionId></TransactionId><OrderId>${fakeOrder()}</OrderId><AuthCode></AuthCode></TransactionCriteria></SearchRequest>`;
      const r = await postForm(base, { prmstr: xml });
      const status = tag(r.text, 'Status');
      if (/^success$/i.test(status)) return ok();
      return judge(`${tag(r.text, 'ResponseCode')} ${tag(r.text, 'ResponseMessage')} ${status}`.trim() || r.text, r.status);
    },
  };
}

const boa = (name: string, website: string, hosts: Record<Mode, string>, extra: Partial<Provider> = {}) => unchecked({
  name, kind: 'bank', platform: 'BOA (Kuveyt Türk TDV2)', website, docs: 'https://github.com/mewebstudio/pos', confidence: 'community',
  fields: [f('MerchantId', 'Mağaza no (MerchantId)', 'Merchant ID'), f('CustomerId', 'Müşteri no (CustomerId)', 'Customer ID'), f('UserName', 'API kullanıcı adı', 'API user name'), secret('Password', 'API şifresi', 'API password')],
  hosts, threeD: ['3D'], notes: ['IP_WHITELIST'], ...extra,
});

export const providers: Record<string, Provider> = {
  iyzico, paytr, param,
  sipay: ccpayment('Sipay', 'https://sipay.com.tr', 'https://apidocs.sipay.com.tr', { live: 'https://app.sipay.com.tr/ccpayment', test: 'https://provisioning.sipay.com.tr/ccpayment' }, 'partial'),
  vepara: ccpayment('Vepara', 'https://vepara.com.tr', 'https://github.com/evrenonur/sanalpos', { live: 'https://app.vepara.com.tr/ccpayment', test: 'https://test.vepara.com.tr/ccpayment' }, 'community'),
  moka, craftgate, paynet, esnekpos, tosla, odeal, paycell, hepsipay, shopier, papara,
  // Nestpay (Payten) banks
  'nestpay-isbank': nestpay('İş Bankası', 'https://sanalpos.isbank.com.tr', 'https://istest.asseco-see.com.tr',
    { testCredentials: { clientId: '700655000200', username: 'ISBANKAPI', password: 'ISBANK07', storeKey: 'TRPS0200' } }),
  'nestpay-akbank': nestpay('Akbank (eski Nestpay)', 'https://www.sanalakpos.com'),
  'nestpay-halkbank': nestpay('Halkbank', 'https://sanalpos.halkbank.com.tr'),
  'nestpay-teb': nestpay('TEB', 'https://sanalpos.teb.com.tr'),
  'nestpay-sekerbank': nestpay('Şekerbank', 'https://sanalpos.sekerbank.com.tr'),
  'nestpay-ziraat': nestpay('Ziraat Bankası (Nestpay)', 'https://sanalpos2.ziraatbank.com.tr', 'https://torus-stage-ziraat.asseco-see.com.tr'),
  'nestpay-qnb': nestpay('QNB (Nestpay terminali)', 'https://www.fbwebpos.com'),
  'nestpay-ing': nestpay('ING', 'https://sanalpos.ingbank.com.tr'),
  'nestpay-turkiyefinans': nestpay('Türkiye Finans', 'https://sanalpos.turkiyefinans.com.tr'),
  'nestpay-anadolubank': nestpay('Anadolubank', 'https://anadolusanalpos.est.com.tr'),
  'nestpay-alternatif': nestpay('Alternatif Bank', 'https://sanalpos.abank.com.tr'),
  'nestpay-cardplus': nestpay('Cardplus', 'https://sanalpos.card-plus.net'),
  akbank, garanti, posnet, albaraka,
  'payfor-qnb': payfor('QNB (PayFor)', '5', { live: 'https://vpos.qnb.com.tr/Gateway/XMLGate.aspx', test: 'https://vpostest.qnb.com.tr/Gateway/XMLGate.aspx' }),
  'payfor-ziraatkatilim': payfor('Ziraat Katılım', '12', { live: 'https://vpos.ziraatkatilim.com.tr/Mpi/XMLGate.aspx', test: 'https://payfortestziraatkatilim.cordisnetwork.com/Mpi/XMLGate.aspx' },
    { website: 'https://www.ziraatkatilim.com.tr' }),
  denizbank,
  'payflex-vakifbank': payflex('VakıfBank', { live: 'https://onlineodeme.vakifbank.com.tr:4443/UIService/Search.aspx', test: 'https://onlineodemetest.vakifbank.com.tr:4443/UIService/Search.aspx' }),
  // Only Ziraat's payment endpoint is known, not its status-query one: not checked here.
  'payflex-ziraat': unchecked(withoutCheck(payflex('Ziraat Bankası (PayFlex)', { live: 'https://sanalpos.ziraatbank.com.tr/v4/v3/Vposreq.aspx', test: 'https://preprod.payflex.com.tr/Ziraatbank/VposWeb/v3/Vposreq.aspx' },
    { website: 'https://www.ziraatbank.com.tr' }))),
  kuveytturk: boa('Kuveyt Türk', 'https://www.kuveytturk.com.tr', { live: 'https://sanalpos.kuveytturk.com.tr/ServiceGateWay/Home', test: 'https://boatest.kuveytturk.com.tr/boa.virtualpos.services/Home' },
    { testCards: ['5188961939192544'] }),
  vakifkatilim: boa('Vakıf Katılım', 'https://www.vakifkatilim.com.tr', { live: 'https://boa.vakifkatilim.com.tr/VirtualPOS.Gateway/Home', test: 'https://boa.vakifkatilim.com.tr/VirtualPOS.Gateway/Home' },
    { notes: ['IP_WHITELIST', 'SAME_HOST_FOR_TEST'] }),
};

// Runs the provider's check; failures to reach it are reported as network problems with the reason.
export async function checkCredentials(id: string, credentials: Record<string, string>, mode: Mode): Promise<CheckResult> {
  const p = providers[id];
  const base = (credentials.endpoint || p.hosts[mode]).replace(/\/+$/, '');
  const unverified = p.fields.filter((x) => x.unverifiable && credentials[x.key]).map((x) => x.key);
  if (!p.check) return { status: 'unverifiable', unverified: p.fields.filter((x) => credentials[x.key]).map((x) => x.key) };
  let r: CheckResult;
  try { r = await p.check(credentials, base, mode); }
  catch (err) {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    r = { status: 'network', message: e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.cause?.message ?? e.message ?? 'unreachable').toString().slice(0, 200) };
  }
  // Never echo a secret back, even if a provider includes it in an error message.
  for (const x of p.fields) if (x.secret && credentials[x.key] && r.message) r.message = r.message.split(credentials[x.key]).join('•••');
  return { ...r, unverified };
}
