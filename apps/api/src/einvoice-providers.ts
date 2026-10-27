// e-Fatura / e-Arşiv integrators (GİB özel entegratörleri): each one checks whether a tax number is an e-Fatura user,
// sends our UBL-TR (ubl.ts) as e-Fatura or e-Arşiv, reads its status, cancels an e-Arşiv invoice and fetches the PDF.
// Sources: docs/research-einvoice.md. 'verified' lists what was sent successfully to the integrator's own test system
// during development (İzibiz and Uyumsoft e-Arşiv, with their published test users); everything else follows their
// published WSDL/OpenAPI and needs one test with a real account before it is relied on.
import { randomUUID } from 'node:crypto';
import { zipOne } from './zip';

export type Kind = 'efatura' | 'earsiv';
export type Creds = Record<string, string> & { endpoint: string };
export type Doc = { ubl: string; kind: Kind; uuid: string; number: string; alias: string | null; total: string; currency: string; issueDate: string; email: string;
  buyer: { taxId: string; name: string }; sender: { taxId: string; alias: string }; internet: { website: string; method: string; intermediary: string; date: string } };
export type Status = 'sent' | 'accepted' | 'rejected' | 'failed';
export type Field = { key: string; label: [tr: string, en: string]; secret?: boolean; optional?: boolean };
export type Integrator = {
  name: string; website: string; docs: string; verified: Kind[]; fields: Field[]; hosts: { test: string; live: string };
  lookup(taxId: string, c: Creds): Promise<{ registered: boolean; alias: string | null }>;
  send(d: Doc, c: Creds): Promise<{ ref: string; number?: string }>;
  status(uuid: string, kind: Kind, c: Creds): Promise<{ status: Status; detail?: string }>;
  cancel(uuid: string, d: { number: string; total: string; date: string }, c: Creds): Promise<void>;
  pdf?(uuid: string, kind: Kind, c: Creds): Promise<Buffer | null>;
};

export class EinvoiceError extends Error {
  constructor(message: string, readonly permanent = false) { super(message.slice(0, 500)); }
}
const timeout = 30_000;
const esc = (s = '') => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
export const tag = (xml: string, name: string) => new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'i').exec(xml)?.[1]?.trim() ?? '';
const tags = (xml: string, name: string) => [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'gi'))].map((m) => m[1].trim());
const attr = (xml: string, el: string, name: string) => new RegExp(`<(?:[\\w-]+:)?${el}\\b[^>]*\\s${name}="([^"]*)"`, 'i').exec(xml)?.[1] ?? '';
const text = (xml: string) => xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const ublBody = (ubl: string) => ubl.replace(/^<\?xml[^>]*\?>/, '');

async function post(url: string, body: string, headers: Record<string, string>) {
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeout) }).catch((e) => { throw new EinvoiceError(`network: ${e?.message ?? e}`); });
  const t = await res.text();
  if (res.status >= 500 && !t.includes('Fault')) throw new EinvoiceError(`HTTP ${res.status}`);
  return t;
}
const soap = (url: string, action: string, body: string, header = '', ns = '') => post(url,
  `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"${ns}><soapenv:Header>${header}</soapenv:Header><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`,
  { 'content-type': 'text/xml; charset=utf-8', SOAPAction: `"${action}"` });
const fault = (x: string) => tag(x, 'faultstring') || tag(x, 'ERROR_SHORT_DES') || tag(x, 'Message');
const wsse = (u: string, p: string) => '<o:Security soapenv:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">'
  + `<o:UsernameToken><o:Username>${esc(u)}</o:Username><o:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${esc(p)}</o:Password></o:UsernameToken></o:Security>`;
// GİB's "internet sale" payment method words.
const odemeSekli = (m: string) => ({ card: 'KREDIKARTI/BANKAKARTI', saved_card: 'KREDIKARTI/BANKAKARTI', bank_transfer: 'EFT/HAVALE' } as Record<string, string>)[m] ?? 'DIGER';

// ---- İzibiz (SOAP, session) ----
const izibiz: Integrator = {
  name: 'İzibiz', website: 'https://www.izibiz.com.tr', docs: 'https://dev.izibiz.com.tr', verified: ['earsiv'],
  fields: [{ key: 'username', label: ['Kullanıcı adı', 'User name'] }, { key: 'password', label: ['Parola', 'Password'], secret: true }],
  hosts: { test: 'https://efaturatest.izibiz.com.tr', live: 'https://efaturaws.izibiz.com.tr' },
  async lookup(taxId, c) {
    const s = await izibizSession(c);
    const x = await soap(`${c.endpoint}/AuthenticationWS`, '', `<w:CheckUserRequest>${s}<USER><IDENTIFIER>${esc(taxId)}</IDENTIFIER></USER><DOCUMENT_TYPE>INVOICE</DOCUMENT_TYPE></w:CheckUserRequest>`, '', ' xmlns:w="http://schemas.i2i.com/ei/wsdl"');
    const aliases = tags(x, 'ALIAS').filter((a) => /pk@/i.test(a));
    return { registered: aliases.length > 0, alias: aliases[0] ?? null };
  },
  async send(d, c) {
    const s = await izibizSession(c);
    const content = b64(zipOne(`${d.uuid}.xml`, d.ubl));
    if (d.kind === 'earsiv') {
      const x = await soap(`${c.endpoint}/EIArchiveWS/EFaturaArchive`, '', `<w:ArchiveInvoiceExtendedRequest>${s}<ArchiveInvoiceExtendedContent><INVOICE_PROPERTIES><EARSIV_FLAG>Y</EARSIV_FLAG>`
        + `<EARSIV_PROPERTIES><EARSIV_TYPE>INTERNET</EARSIV_TYPE><EARSIV_EMAIL_FLAG>${d.email ? 'Y' : 'N'}</EARSIV_EMAIL_FLAG>${d.email ? `<EARSIV_EMAIL>${esc(d.email)}</EARSIV_EMAIL>` : ''}<SUB_STATUS>NEW</SUB_STATUS></EARSIV_PROPERTIES>`
        + `<INVOICE_CONTENT>${content}</INVOICE_CONTENT></INVOICE_PROPERTIES></ArchiveInvoiceExtendedContent></w:ArchiveInvoiceExtendedRequest>`, '', ' xmlns:w="http://schemas.i2i.com/ei/wsdl/archive"');
      if (tag(x, 'ERROR_CODE')) throw new EinvoiceError(fault(x), true);
      return { ref: d.uuid, number: tag(x, 'INVOICE_ID') || d.number };
    }
    const x = await soap(`${c.endpoint}/EInvoiceWS`, '', `<w:SendInvoiceRequest>${s}<SENDER vkn="${esc(d.sender.taxId)}" alias="${esc(d.sender.alias)}"/><RECEIVER vkn="${esc(d.buyer.taxId)}" alias="${esc(d.alias ?? '')}"/>`
      + `<INVOICE><CONTENT>${content}</CONTENT></INVOICE></w:SendInvoiceRequest>`, '', ' xmlns:w="http://schemas.i2i.com/ei/wsdl"');
    if (tag(x, 'ERROR_CODE')) throw new EinvoiceError(fault(x), true);
    return { ref: d.uuid };
  },
  async status(uuid, kind, c) {
    const s = await izibizSession(c);
    const x = kind === 'earsiv'
      ? await soap(`${c.endpoint}/EIArchiveWS/EFaturaArchive`, '', `<w:GetEArchiveInvoiceStatusRequest>${s}<UUID>${uuid}</UUID></w:GetEArchiveInvoiceStatusRequest>`, '', ' xmlns:w="http://schemas.i2i.com/ei/wsdl/archive"')
      : await soap(`${c.endpoint}/EInvoiceWS`, '', `<w:GetInvoiceStatusRequest>${s}<INVOICE UUID="${uuid}"/></w:GetInvoiceStatusRequest>`, '', ' xmlns:w="http://schemas.i2i.com/ei/wsdl"');
    const st = `${tag(x, 'STATUS')} ${tag(x, 'STATUS_DESC')} ${tag(x, 'GIB_STATUS_CODE')}`.toUpperCase();
    return { status: /HATA|ERROR|FAIL|RED/.test(st) ? 'failed' : /BASARI|SUCCEED|RAPORLANDI|KABUL|1300/.test(st) ? 'accepted' : 'sent', detail: text(st) };
  },
  async cancel(uuid, d, c) {
    const s = await izibizSession(c);
    const x = await soap(`${c.endpoint}/EIArchiveWS/EFaturaArchive`, '', `<w:CancelEArchiveInvoiceRequest>${s}<CancelEArsivInvoiceContent><FATURA_UUID>${uuid}</FATURA_UUID>`
      + `<FATURA_ID>${esc(d.number)}</FATURA_ID><IPTAL_TARIHI>${d.date}</IPTAL_TARIHI><TOPLAM_TUTAR>${d.total}</TOPLAM_TUTAR></CancelEArsivInvoiceContent></w:CancelEArchiveInvoiceRequest>`, '', ' xmlns:w="http://schemas.i2i.com/ei/wsdl/archive"');
    if (tag(x, 'ERROR_CODE')) throw new EinvoiceError(fault(x), true);
  },
  async pdf(uuid, kind, c) {
    const s = await izibizSession(c);
    const x = kind === 'earsiv'
      ? await soap(`${c.endpoint}/EIArchiveWS/EFaturaArchive`, '', `<w:ArchiveInvoiceReadRequest>${s}<INVOICEID>${uuid}</INVOICEID><PORTAL_DIRECTION>OUT</PORTAL_DIRECTION><PROFILE>PDF</PROFILE></w:ArchiveInvoiceReadRequest>`, '', ' xmlns:w="http://schemas.i2i.com/ei/wsdl/archive"')
      : await soap(`${c.endpoint}/EInvoiceWS`, '', `<w:GetInvoiceWithTypeRequest>${s}<INVOICE_SEARCH_KEY><UUID>${uuid}</UUID><TYPE>PDF</TYPE><DIRECTION>OUT</DIRECTION></INVOICE_SEARCH_KEY><HEADER_ONLY>N</HEADER_ONLY></w:GetInvoiceWithTypeRequest>`, '', ' xmlns:w="http://schemas.i2i.com/ei/wsdl"');
    const content = tag(x, 'INVOICE') ? tag(tag(x, 'INVOICE'), 'CONTENT') : tag(x, 'CONTENT');
    return content ? Buffer.from(content, 'base64') : null;
  },
};
async function izibizSession(c: Creds) {
  const x = await soap(`${c.endpoint}/AuthenticationWS`, '', `<w:LoginRequest><REQUEST_HEADER><SESSION_ID>-1</SESSION_ID><APPLICATION_NAME>LightningVM</APPLICATION_NAME></REQUEST_HEADER>`
    + `<USER_NAME>${esc(c.username)}</USER_NAME><PASSWORD>${esc(c.password)}</PASSWORD></w:LoginRequest>`, '', ' xmlns:w="http://schemas.i2i.com/ei/wsdl"');
  const sid = tag(x, 'SESSION_ID');
  if (!sid) throw new EinvoiceError(`login: ${fault(x) || text(x)}`, true);
  return `<REQUEST_HEADER><SESSION_ID>${sid}</SESSION_ID><APPLICATION_NAME>LightningVM</APPLICATION_NAME></REQUEST_HEADER>`;
}

// ---- Uyumsoft (SOAP, WS-Security) ----
const uyumAction = (op: string) => `http://tempuri.org/IIntegration/${op}`;
const uyum = (c: Creds, op: string, body: string) => soap(`${c.endpoint}/Services/Integration`, uyumAction(op), body, wsse(c.username, c.password));
const uyumsoft: Integrator = {
  name: 'Uyumsoft', website: 'https://www.uyumsoft.com', docs: 'https://efatura-test.uyumsoft.com.tr/Services/Integration?wsdl', verified: ['earsiv'],
  fields: [{ key: 'username', label: ['Kullanıcı adı', 'User name'] }, { key: 'password', label: ['Parola', 'Password'], secret: true }],
  hosts: { test: 'https://efatura-test.uyumsoft.com.tr', live: 'https://efatura.uyumsoft.com.tr' },
  async lookup(taxId, c) {
    const x = await uyum(c, 'GetUserAliasses', `<GetUserAliasses xmlns="http://tempuri.org/"><vknTckn>${esc(taxId)}</vknTckn></GetUserAliasses>`);
    if (attr(x, 'GetUserAliassesResult', 'IsSucceded') === 'false') throw new EinvoiceError(attr(x, 'GetUserAliassesResult', 'Message') || text(x));
    const aliases = [...x.matchAll(/Alias="([^"]*pk@[^"]*)"/gi)].map((m) => m[1]).concat(tags(x, 'Alias').filter((a) => /pk@/i.test(a)));
    return { registered: aliases.length > 0, alias: aliases[0] ?? null };
  },
  async send(d, c) {
    // Uyumsoft takes the UBL as a typed object: our document's root becomes InvoiceInfo's <Invoice>.
    const inner = ublBody(d.ubl).replace(/^<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/, '<Invoice');
    const x = await uyum(c, 'SendInvoice', `<SendInvoice xmlns="http://tempuri.org/"><invoices><InvoiceInfo LocalDocumentId="${d.uuid}">${inner}`
      + `<TargetCustomer VknTckn="${esc(d.buyer.taxId)}" Alias="${esc(d.alias ?? '')}" Title="${esc(d.buyer.name)}"/>`
      + (d.kind === 'earsiv' ? `<EArchiveInvoiceInfo DeliveryType="Electronic"/>` : '')
      + `<Scenario>${d.kind === 'earsiv' ? 'eArchive' : 'eInvoice'}</Scenario>${d.email ? `<Notification><Mailing EnableNotification="true" To="${esc(d.email)}" Attachment="Pdf"/></Notification>` : ''}</InvoiceInfo></invoices></SendInvoice>`);
    if (attr(x, 'SendInvoiceResult', 'IsSucceded') !== 'true') throw new EinvoiceError(attr(x, 'SendInvoiceResult', 'Message') || fault(x) || text(x), true);
    return { ref: attr(x, 'Value', 'Id') || d.uuid, number: attr(x, 'Value', 'Number') || d.number };
  },
  async status(uuid, _kind, c) {
    const x = await uyum(c, 'QueryOutboxInvoiceStatus', `<QueryOutboxInvoiceStatus xmlns="http://tempuri.org/"><invoiceIds><string>${uuid}</string></invoiceIds></QueryOutboxInvoiceStatus>`);
    const st = `${attr(x, 'Value', 'Status')} ${attr(x, 'Value', 'Message')} ${tag(x, 'Status')}`;
    return { status: /Error|Declined|Rejected|Canceled/i.test(st) ? 'failed' : /Approved|Succeed|Delivered|Archived|Reported/i.test(st) ? 'accepted' : 'sent', detail: text(st) };
  },
  async cancel(uuid, d, c) {
    const x = await uyum(c, 'CancelEArchiveInvoice', `<CancelEArchiveInvoice xmlns="http://tempuri.org/"><request InvoiceId="${uuid}" CancelDate="${d.date}T00:00:00"/></CancelEArchiveInvoice>`);
    if (attr(x, 'CancelEArchiveInvoiceResult', 'IsSucceded') !== 'true') throw new EinvoiceError(attr(x, 'CancelEArchiveInvoiceResult', 'Message') || text(x), true);
  },
  async pdf(uuid, _kind, c) {
    const x = await uyum(c, 'GetOutboxInvoicePdf', `<GetOutboxInvoicePdf xmlns="http://tempuri.org/"><invoiceId>${uuid}</invoiceId></GetOutboxInvoicePdf>`);
    const data = tag(x, 'Data');
    return data ? Buffer.from(data, 'base64') : null;
  },
};

// ---- Nilvera (REST, Bearer API key) ----
async function nil(c: Creds, method: string, path: string, body?: BodyInit, type?: string) {
  const res = await fetch(`${c.endpoint}${path}`, { method, body, signal: AbortSignal.timeout(timeout),
    headers: { authorization: `Bearer ${c.apiKey}`, accept: 'application/json', ...(type && { 'content-type': type }) } }).catch((e) => { throw new EinvoiceError(`network: ${e?.message ?? e}`); });
  if (res.status === 401 || res.status === 403) throw new EinvoiceError(`Nilvera: HTTP ${res.status} (API key)`, true);
  if (!res.ok) throw new EinvoiceError(`Nilvera: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`, res.status < 500);
  return res;
}
const nilvera: Integrator = {
  name: 'Nilvera', website: 'https://www.nilvera.com', docs: 'https://developer.nilvera.com', verified: [],
  fields: [{ key: 'apiKey', label: ['API anahtarı', 'API key'], secret: true }],
  hosts: { test: 'https://apitest.nilvera.com', live: 'https://api.nilvera.com' },
  async lookup(taxId, c) {
    const list = await (await nil(c, 'GET', `/general/GlobalCompany/Check/TaxNumber/${encodeURIComponent(taxId)}?globalUserType=Invoice`)).json() as { Name?: string }[];
    const pk = (list ?? []).map((x) => x.Name ?? '').filter((n) => /pk@/i.test(n));
    return { registered: (list ?? []).length > 0, alias: pk[0] ?? list?.[0]?.Name ?? null };
  },
  async send(d, c) {
    const form = new FormData();
    form.append('file', new Blob([d.ubl], { type: 'application/xml' }), `${d.uuid}.xml`);
    const path = d.kind === 'earsiv' ? '/earchive/Send/Xml' : `/einvoice/Send/Xml?Alias=${encodeURIComponent(d.alias ?? '')}`;
    const r = await (await nil(c, 'POST', path, form)).json().catch(() => ({})) as { UUID?: string; InvoiceNumber?: string };
    return { ref: r.UUID ?? d.uuid, number: r.InvoiceNumber ?? d.number };
  },
  async status(uuid, kind, c) {
    const r = await (await nil(c, 'GET', kind === 'earsiv' ? `/earchive/Invoices/${uuid}/Status` : `/einvoice/Sale/${uuid}/Status`)).json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const code = String(r.InvoiceStatus?.Code ?? r.StatusCode ?? '').toLowerCase();
    return { status: /error|fail/.test(code) ? 'failed' : /succeed|success|approved/.test(code) ? 'accepted' : 'sent', detail: String(r.InvoiceStatus?.Description ?? r.StatusDetail ?? code) };
  },
  async cancel(uuid, _d, c) { await nil(c, 'PUT', `/earchive/Invoices/${uuid}/Cancel`); },
  async pdf(uuid, kind, c) { return Buffer.from(await (await nil(c, 'GET', kind === 'earsiv' ? `/earchive/Invoices/${uuid}/pdf` : `/einvoice/Sale/${uuid}/pdf`)).arrayBuffer()); },
};

// ---- EDM Bilişim (SOAP, session; same family as İzibiz) ----
const edmHeader = (sid: string) => `<REQUEST_HEADER><SESSION_ID>${sid}</SESSION_ID><CLIENT_TXN_ID>${randomUUID()}</CLIENT_TXN_ID><ACTION_DATE>${new Date().toISOString()}</ACTION_DATE>`
  + '<REASON>e-fatura</REASON><APPLICATION_NAME>LightningVM</APPLICATION_NAME><HOSTNAME>lightning-vm</HOSTNAME><CHANNEL_NAME>API</CHANNEL_NAME><COMPRESSED>N</COMPRESSED></REQUEST_HEADER>';
const edmCall = (c: Creds, op: string, body: string) => soap(c.endpoint, `${op}Request`, `<${op}Request xmlns="http://tempuri.org/">${body}</${op}Request>`);
async function edmSession(c: Creds) {
  const x = await edmCall(c, 'Login', `${edmHeader('0')}<USER_NAME>${esc(c.username)}</USER_NAME><PASSWORD>${esc(c.password)}</PASSWORD>`);
  const sid = tag(x, 'SESSION_ID');
  if (!sid) throw new EinvoiceError(`login: ${fault(x) || text(x)}`, true);
  return edmHeader(sid);
}
const edm: Integrator = {
  name: 'EDM Bilişim', website: 'https://edmbilisim.com.tr', docs: 'https://docs.edmbilisim.com.tr', verified: [],
  fields: [{ key: 'username', label: ['Kullanıcı adı', 'User name'] }, { key: 'password', label: ['Parola', 'Password'], secret: true }],
  hosts: { test: 'https://test.edmbilisim.com.tr/EFaturaEDM21ea/EFaturaEDM.svc', live: 'https://portal2.edmbilisim.com.tr/EFaturaEDM/EFaturaEDM.svc' },
  async lookup(taxId, c) {
    const x = await edmCall(c, 'CheckUser', `${await edmSession(c)}<USER><IDENTIFIER>${esc(taxId)}</IDENTIFIER></USER>`);
    const aliases = tags(x, 'ALIAS').filter((a) => /pk@/i.test(a));
    return { registered: tags(x, 'IDENTIFIER').length > 0, alias: aliases[0] ?? null };
  },
  async send(d, c) {
    const internet = d.kind === 'earsiv' ? `<EARCHIVE>true</EARCHIVE><INTERNETSALES>true</INTERNETSALES><INTERNETSALESDETAILS><webAdresi>${esc(d.internet.website)}</webAdresi>`
      + `<odemeSekli>${esc(odemeSekli(d.internet.method))}</odemeSekli><odemeAracisiAdi>${esc(d.internet.intermediary)}</odemeAracisiAdi><odemeTarihi>${d.internet.date}</odemeTarihi></INTERNETSALESDETAILS>` : '';
    const x = await edmCall(c, 'SendInvoice', `${await edmSession(c)}<SENDER vkn="${esc(d.sender.taxId)}" alias="${esc(d.sender.alias)}"/><RECEIVER vkn="${esc(d.buyer.taxId)}" alias="${esc(d.alias ?? '')}"/>`
      + `<INVOICE>${internet}<CONTENT>${b64(d.ubl)}</CONTENT></INVOICE>`);
    if (tag(x, 'ERROR_SHORT_DES') || /Fault/.test(x)) throw new EinvoiceError(fault(x) || text(x), true);
    return { ref: d.uuid };
  },
  async status(uuid, _kind, c) {
    const x = await edmCall(c, 'GetInvoiceStatus', `${await edmSession(c)}<INVOICE UUID="${uuid}"/>`);
    const st = `${tag(x, 'STATUS')} ${tag(x, 'GIB_STATUS_CODE')} ${tag(x, 'STATUS_DESCRIPTION')}`;
    return { status: /FAIL|ERROR|HATA/i.test(st) ? 'failed' : /SUCCEED|1300|BASARI/i.test(st) ? 'accepted' : 'sent', detail: text(st) };
  },
  async cancel(uuid, _d, c) {
    const x = await edmCall(c, 'CancelInvoice', `${await edmSession(c)}<INVOICE UUID="${uuid}"/>`);
    if (tag(x, 'ERROR_SHORT_DES')) throw new EinvoiceError(fault(x), true);
  },
  async pdf(uuid, _kind, c) {
    const x = await edmCall(c, 'GetInvoice', `${await edmSession(c)}<INVOICE_SEARCH_KEY><UUID>${uuid}</UUID><DIRECTION>OUT</DIRECTION></INVOICE_SEARCH_KEY><INVOICE_CONTENT_TYPE>PDF</INVOICE_CONTENT_TYPE>`);
    const content = tag(x, 'CONTENT');
    return content ? Buffer.from(content, 'base64') : null;
  },
};

// ---- QNB eFinans (SOAP; e-Fatura connector with a login cookie, e-Arşiv with WS-Security) ----
async function qnbCookie(c: Creds) {
  const res = await fetch(`${c.endpoint}/efatura/ws/userService`, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: '""' },
    body: `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.user.cs.com.tr/"><soapenv:Body><ser:wsLogin><userId>${esc(c.username)}</userId><password>${esc(c.password)}</password><lang>tr</lang></ser:wsLogin></soapenv:Body></soapenv:Envelope>` })
    .catch((e) => { throw new EinvoiceError(`network: ${e?.message ?? e}`); });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new EinvoiceError(`login: ${text(await res.text())}`, true);
  return cookie;
}
const qnbConnector = async (c: Creds, body: string) => {
  const cookie = await qnbCookie(c);
  return post(`${c.endpoint}/efatura/ws/connectorService`, `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.connector.uut.cs.com.tr/"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`,
    { 'content-type': 'text/xml; charset=utf-8', SOAPAction: '""', cookie });
};
const qnbArchive = (c: Creds, body: string) => soap(c.archiveEndpoint || c.endpoint.replace('erpefaturatest1.qnbesolutions.com.tr', 'earsivtest.efinans.com.tr') + '/earsiv/ws/EarsivWebService', '',
  body, wsse(c.username, c.password), ' xmlns:ser="http://service.earsiv.uut.cs.com.tr/"');
const qnb: Integrator = {
  name: 'QNB eFinans', website: 'https://www.qnbesolutions.com.tr', docs: 'https://erpefaturatest1.qnbesolutions.com.tr/efatura/ws/connectorService?wsdl', verified: [],
  fields: [{ key: 'username', label: ['Kullanıcı adı', 'User name'] }, { key: 'password', label: ['Parola', 'Password'], secret: true },
    { key: 'archiveEndpoint', label: ['e-Arşiv servis adresi (QNB’nin verdiği)', 'e-Arşiv service address (from QNB)'], optional: true }],
  hosts: { test: 'https://erpefaturatest1.qnbesolutions.com.tr', live: 'https://connector.qnbesolutions.com.tr' },
  async lookup(taxId, c) {
    const x = await qnbConnector(c, `<ser:getMukellefAktifEtiketList><vergiTcKimlikNo>${esc(taxId)}</vergiTcKimlikNo></ser:getMukellefAktifEtiketList>`);
    const aliases = (tags(x, 'etiket').length ? tags(x, 'etiket') : tags(x, 'return')).filter((a) => /pk@/i.test(a));
    return { registered: aliases.length > 0, alias: aliases[0] ?? null };
  },
  async send(d, c) {
    const zip = zipOne(`${d.uuid}.xml`, d.ubl);
    if (d.kind === 'earsiv') {
      const input = JSON.stringify({ islemId: d.uuid, vkn: d.sender.taxId, sube: 'DFLT', kasa: 'DFLT', numaraVerilsinMi: 0 });
      const x = await qnbArchive(c, `<ser:faturaOlustur><input>${esc(input)}</input><fatura><belgeFormati>UBL</belgeFormati><belgeIcerigi>${b64(d.ubl)}</belgeIcerigi></fatura></ser:faturaOlustur>`);
      if (/Fault|"resultCode":"(?!AE00000)/.test(x)) throw new EinvoiceError(fault(x) || text(x), true);
      return { ref: d.uuid };
    }
    const x = await qnbConnector(c, `<ser:belgeGonderExt><parametreler><vergiTcKimlikNo>${esc(d.sender.taxId)}</vergiTcKimlikNo><belgeTuru>FATURA_UBL</belgeTuru><belgeNo>${esc(d.number)}</belgeNo>`
      + `<veri>${b64(zip)}</veri><belgeHash>${(await import('node:crypto')).createHash('md5').update(zip).digest('hex')}</belgeHash><mimeType>application/xml</mimeType><belgeVersiyon>1.0</belgeVersiyon>`
      + `<alanEtiket>${esc(d.alias ?? '')}</alanEtiket><gonderenEtiket>${esc(d.sender.alias)}</gonderenEtiket></parametreler></ser:belgeGonderExt>`);
    if (/Fault/.test(x)) throw new EinvoiceError(fault(x), true);
    return { ref: tag(x, 'return') || d.uuid };
  },
  async status(uuid, kind, c) {
    const x = kind === 'earsiv'
      ? await qnbArchive(c, `<ser:faturaSorgula><input>${esc(JSON.stringify({ faturaUuid: uuid, vkn: '' }))}</input></ser:faturaSorgula>`)
      : await qnbConnector(c, `<ser:gidenBelgeDurumSorgulaEttn><vergiTcKimlikNo></vergiTcKimlikNo><ettn>${uuid}</ettn></ser:gidenBelgeDurumSorgulaEttn>`);
    const st = `${tag(x, 'durum')} ${tag(x, 'aciklama')} ${tag(x, 'resultText')}`;
    return { status: /HATA|ERROR|RED/i.test(st) ? 'failed' : /BASARI|ONAY|KABUL|3/.test(st) ? 'accepted' : 'sent', detail: text(st) };
  },
  async cancel(uuid, d, c) {
    const x = await qnbArchive(c, `<ser:faturaIptalEt><input>${esc(JSON.stringify({ faturaUuid: uuid, faturaNo: d.number, iptalTarihi: d.date }))}</input></ser:faturaIptalEt>`);
    if (/Fault/.test(x)) throw new EinvoiceError(fault(x), true);
  },
};

// ---- BirFatura (REST "OutEBelgeV2", three keys) ----
async function bir(c: Creds, op: string, body: unknown) {
  const res = await fetch(`${c.endpoint}/api/OutEBelgeV2/${op}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    headers: { 'content-type': 'application/json', 'X-Api-Key': c.apiKey, 'X-Secret-Key': c.secretKey, 'X-Integration-Key': c.integrationKey } })
    .catch((e) => { throw new EinvoiceError(`network: ${e?.message ?? e}`); });
  const r = await res.json().catch(() => ({})) as { Success?: boolean; Message?: string; Result?: unknown };
  if (!res.ok || r.Success === false) throw new EinvoiceError(`BirFatura: ${r.Message ?? `HTTP ${res.status}`}`, res.status < 500);
  return r.Result as any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const birfatura: Integrator = {
  name: 'BirFatura', website: 'https://birfatura.com', docs: 'https://birfatura.com', verified: [],
  fields: [{ key: 'apiKey', label: ['API anahtarı', 'API key'], secret: true }, { key: 'secretKey', label: ['Gizli anahtar', 'Secret key'], secret: true },
    { key: 'integrationKey', label: ['Entegrasyon anahtarı', 'Integration key'], secret: true }],
  hosts: { test: 'https://uygulama.edonustur.com', live: 'https://uygulama.edonustur.com' },
  async lookup(taxId, c) {
    const r = await bir(c, 'GibUserList', { PkGbTypeCode: taxId, PageNumber: 1, PageSize: 10 });
    const list = (Array.isArray(r) ? r : r?.Items ?? []) as { Alias?: string; Etiket?: string }[];
    const pk = list.map((x) => x.Alias ?? x.Etiket ?? '').filter((a) => /pk@/i.test(a));
    return { registered: list.length > 0, alias: pk[0] ?? null };
  },
  async send(d, c) {
    await bir(c, 'SendDocument', { DocumentBytes: b64(zipOne(`${d.uuid}.xml`, d.ubl)), SystemTypeCodes: d.kind === 'earsiv' ? 'EARSIV' : 'EFATURA', IsDocumentNoAuto: false,
      ReceiverTag: d.alias ?? '', DocumentNoPrefix: d.number.slice(0, 3) });
    return { ref: d.uuid };
  },
  async status(uuid, _kind, c) {
    const r = await bir(c, 'GetOutBoxDocumentStatusesWithUUIDs', { Uuids: [uuid] });
    const st = JSON.stringify(r ?? '');
    return { status: /ERROR|FAIL|HATA/i.test(st) ? 'failed' : /SUCCEED|SUCCESS/i.test(st) ? 'accepted' : 'sent', detail: st.slice(0, 300) };
  },
  async cancel(uuid, _d, c) { await bir(c, 'SendDocumentAnswer', { DocumentUUID: uuid, AcceptOrRejectCode: 'IPTAL', AcceptOrRejectReason: 'İade', SystemTypeCodes: 'EARSIV' }); },
  async pdf(uuid, kind, c) {
    const r = await bir(c, 'GetPDFLinkByUUID', { Uuids: [uuid], SystemType: kind === 'earsiv' ? 'EARSIV' : 'EFATURA' });
    const link = (Array.isArray(r) ? r[0] : r)?.pdfLink ?? (Array.isArray(r) ? r[0]?.PdfLink : undefined);
    if (!link || !/^https:\/\//.test(link)) return null;
    return Buffer.from(await (await fetch(link, { signal: AbortSignal.timeout(timeout) })).arrayBuffer());
  },
};

// ---- Paraşüt (accounting; REST JSON:API with OAuth; it issues through its own integrator) ----
const parasutTokens = new Map<string, { token: string; at: number }>();
async function parasut(c: Creds, method: string, path: string, body?: unknown) {
  const key = `${c.endpoint}|${c.clientId}|${c.username}`;
  let t = parasutTokens.get(key);
  if (!t || Date.now() - t.at > 90 * 60_000) {
    const res = await fetch(`${c.endpoint}/oauth/token`, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', client_id: c.clientId, client_secret: c.clientSecret, username: c.username, password: c.password, redirect_uri: 'urn:ietf:wg:oauth:2.0:oob' }) })
      .catch((e) => { throw new EinvoiceError(`network: ${e?.message ?? e}`); });
    const j = await res.json().catch(() => ({})) as { access_token?: string; error_description?: string };
    if (!j.access_token) throw new EinvoiceError(`Paraşüt login: ${j.error_description ?? `HTTP ${res.status}`}`, true);
    t = { token: j.access_token, at: Date.now() }; parasutTokens.set(key, t);
  }
  const res = await fetch(`${c.endpoint}/v4/${c.companyId}${path}`, { method, signal: AbortSignal.timeout(timeout), body: body ? JSON.stringify(body) : undefined,
    headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/vnd.api+json', accept: 'application/vnd.api+json' } });
  const j = await res.json().catch(() => ({})) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!res.ok) throw new EinvoiceError(`Paraşüt: ${j?.errors?.[0]?.detail ?? `HTTP ${res.status}`}`, res.status < 500);
  return j;
}
const parasutIntegrator: Integrator = {
  name: 'Paraşüt', website: 'https://www.parasut.com', docs: 'https://apidocs.parasut.com', verified: [],
  fields: [{ key: 'companyId', label: ['Firma numarası', 'Company id'] }, { key: 'clientId', label: ['Client ID', 'Client ID'] }, { key: 'clientSecret', label: ['Client secret', 'Client secret'], secret: true },
    { key: 'username', label: ['Kullanıcı (e-posta)', 'User (e-mail)'] }, { key: 'password', label: ['Parola', 'Password'], secret: true }],
  hosts: { test: 'https://api.heroku-staging.parasut.com', live: 'https://api.parasut.com' },
  async lookup(taxId, c) {
    const j = await parasut(c, 'GET', `/e_invoice_inboxes?filter[vkn]=${encodeURIComponent(taxId)}`);
    const alias = (j.data ?? []).map((x: { attributes: { e_invoice_address: string } }) => x.attributes.e_invoice_address).find((a: string) => /pk@/i.test(a)) ?? j.data?.[0]?.attributes?.e_invoice_address;
    return { registered: (j.data ?? []).length > 0, alias: alias ?? null };
  },
  // Paraşüt builds the document itself from a sales invoice; ours is mapped into it (the UBL is not sent).
  async send(d, c) {
    const lines = [...d.ubl.matchAll(/<cac:InvoiceLine>([\s\S]*?)<\/cac:InvoiceLine>/g)].map((m) => ({ type: 'sales_invoice_details', attributes: {
      quantity: Number(tag(m[1], 'InvoicedQuantity')), unit_price: Number(tag(m[1], 'PriceAmount')), vat_rate: Number(tag(m[1], 'Percent')), description: tag(m[1], 'Name') } }));
    const contact = await parasut(c, 'GET', `/contacts?filter[tax_number]=${encodeURIComponent(d.buyer.taxId)}`);
    const contactId = contact.data?.[0]?.id ?? (await parasut(c, 'POST', '/contacts', { data: { type: 'contacts', attributes: { name: d.buyer.name, tax_number: d.buyer.taxId,
      contact_type: d.buyer.taxId.length === 11 ? 'person' : 'company', account_type: 'customer', email: d.email || undefined } } })).data.id;
    const inv = await parasut(c, 'POST', '/sales_invoices', { data: { type: 'sales_invoices', attributes: { item_type: 'invoice', issue_date: d.issueDate, currency: d.currency === 'TRY' ? 'TRL' : d.currency,
      description: d.number, invoice_series: d.number.slice(0, 3), invoice_id: Number(d.number.slice(7)) }, relationships: { contact: { data: { type: 'contacts', id: contactId } }, details: { data: lines } } } });
    const doc = d.kind === 'earsiv'
      ? { data: { type: 'e_archives', attributes: { internet_sale: { url: d.internet.website, payment_type: odemeSekli(d.internet.method), payment_platform: d.internet.intermediary, payment_date: d.internet.date } },
          relationships: { sales_invoice: { data: { type: 'sales_invoices', id: inv.data.id } } } } }
      : { data: { type: 'e_invoices', attributes: { scenario: 'basic', to: d.alias }, relationships: { invoice: { data: { type: 'sales_invoices', id: inv.data.id } } } } };
    await parasut(c, 'POST', d.kind === 'earsiv' ? '/e_archives' : '/e_invoices', doc);
    return { ref: String(inv.data.id) };
  },
  async status(ref, _kind, c) {
    const j = await parasut(c, 'GET', `/sales_invoices/${ref}?include=active_e_document`);
    const st = String(j.included?.[0]?.attributes?.status ?? '');
    return { status: /error|fail/i.test(st) ? 'failed' : /done|success|approved|sent/i.test(st) ? 'accepted' : 'sent', detail: st };
  },
  async cancel(ref, _d, c) { await parasut(c, 'DELETE', `/sales_invoices/${ref}/cancel`); },
};

// ---- The panel's own test integrator: no account needed. Tax numbers ending in an even digit are e-Fatura users. ----
const sandbox: Integrator = {
  name: 'Sandbox', website: '', docs: '', verified: ['earsiv', 'efatura'], fields: [], hosts: { test: 'sandbox', live: 'sandbox' },
  async lookup(taxId) { const reg = /^\d{10}$/.test(taxId) && Number(taxId.at(-1)) % 2 === 0; return { registered: reg, alias: reg ? `urn:mail:${taxId}pk@sandbox.test` : null }; },
  async send(d) {
    if (!/^<\?xml[\s\S]*<cbc:UUID>[\s\S]*<\/Invoice>$/.test(d.ubl)) throw new EinvoiceError('not a UBL invoice', true);
    return { ref: d.uuid, number: d.number };
  },
  async status() { return { status: 'accepted' }; },
  async cancel() { /* accepted */ },
};

export const integrators: Record<string, Integrator> = { izibiz, uyumsoft, nilvera, edm, qnb, birfatura, parasut: parasutIntegrator, sandbox };
