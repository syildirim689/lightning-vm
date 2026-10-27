// UBL-TR 1.2 invoice XML (GİB e-Fatura / e-Arşiv) from a paid invoice, without I/O; ubl.test.mjs checks it. Element order
// follows the XSD sequence; rules are from GİB's schematron (docs/research-einvoice.md §1.1): a 16-character number, our
// ETTN, KDV (0015) per rate with an exemption reason at 0%, line totals rounded per line, a person's first and family name
// when the party is a TCKN, and the XSLT that shows it. The integrator signs it; e-Arşiv internet-sale details go in its own fields.
import { invoiceXslt } from './ubl-xslt';

export type UblParty = { name: string; taxId: string; taxOffice?: string; address?: string; district?: string; city?: string; postalCode?: string; country?: string;
  email?: string; phone?: string; website?: string; mersis?: string; tradeRegistry?: string };
export type UblLine = { description: string; quantity: string; unit: string; unitPrice: string; taxRate: string; net: string; tax: string };
export type UblInvoice = {
  uuid: string; number: string; issueDate: string; issueTime: string; profile: 'TEMELFATURA' | 'TICARIFATURA' | 'EARSIVFATURA';
  type: 'SATIS' | 'IADE' | 'ISTISNA'; currency: string; exchangeRate?: string; notes: string[];
  supplier: UblParty; customer: UblParty; lines: UblLine[]; subtotal: string; taxTotal: string; total: string;
  exemption?: { code: string; reason: string } | null; returnOf?: { number: string; date: string } | null;
  // How and when it was paid (e-Arşiv internet sales need the date; the note names the payment intermediary), and for e-Arşiv
  // how it is delivered (always electronically here).
  paymentMeans?: { code: '48' | '42' | 'ZZZ'; date?: string; note?: string }; sendingType?: 'ELEKTRONIK' | 'KAGIT';
  // e-Arşiv internet sale: delivered by the seller itself (a service, no carrier), on the issue date.
  selfDelivered?: boolean;
};

const esc = (s = '') => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const el = (name: string, value: string | undefined, attrs = '') => (value === undefined || value === '' ? '' : `<${name}${attrs}>${esc(value)}</${name}>`);
const amount = (name: string, v: string, cur: string) => `<${name} currencyID="${esc(cur)}">${Number(v).toFixed(2)}</${name}>`;
const countryName = (code = 'TR') => (code === 'TR' ? 'Türkiye' : code);

// A person's name split for UBL: the last word is the family name.
export function splitName(full: string) {
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? { first: parts.slice(0, -1).join(' '), family: parts.at(-1)! } : { first: parts[0] ?? '', family: parts[0] ?? '' };
}

function party(p: UblParty, wrap = 'cac:Party') {
  const tckn = p.taxId.length === 11;
  const ids = [el('cbc:ID', p.taxId, ` schemeID="${tckn ? 'TCKN' : 'VKN'}"`), p.mersis && el('cbc:ID', p.mersis, ' schemeID="MERSISNO"'),
    p.tradeRegistry && el('cbc:ID', p.tradeRegistry, ' schemeID="TICARETSICILNO"')].filter(Boolean).map((x) => `<cac:PartyIdentification>${x}</cac:PartyIdentification>`).join('');
  const n = splitName(p.name);
  return `<${wrap}>${el('cbc:WebsiteURI', p.website)}${ids}`
    + `${tckn ? '' : `<cac:PartyName>${el('cbc:Name', p.name)}</cac:PartyName>`}`
    + `<cac:PostalAddress>${el('cbc:StreetName', p.address || '-')}${el('cbc:CitySubdivisionName', p.district || '-')}${el('cbc:CityName', p.city || '-')}${el('cbc:PostalZone', p.postalCode)}`
    + `<cac:Country>${el('cbc:Name', countryName(p.country))}</cac:Country></cac:PostalAddress>`
    + `${p.taxOffice ? `<cac:PartyTaxScheme><cac:TaxScheme>${el('cbc:Name', p.taxOffice)}</cac:TaxScheme></cac:PartyTaxScheme>` : ''}`
    + `${p.phone || p.email ? `<cac:Contact>${el('cbc:Telephone', p.phone)}${el('cbc:ElectronicMail', p.email)}</cac:Contact>` : ''}`
    + `${tckn ? `<cac:Person>${el('cbc:FirstName', n.first)}${el('cbc:FamilyName', n.family)}</cac:Person>` : ''}</${wrap}>`;
}

function taxCategory(rate: number, exemption: UblInvoice['exemption']) {
  return `<cac:TaxCategory>${rate === 0 && exemption ? `${el('cbc:TaxExemptionReasonCode', exemption.code)}${el('cbc:TaxExemptionReason', exemption.reason)}` : ''}`
    + `<cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>`;
}

export function buildUbl(i: UblInvoice) {
  const cur = i.currency;
  // One subtotal per KDV rate, from the line amounts (already rounded per line).
  const byRate = new Map<number, { net: number; tax: number }>();
  for (const l of i.lines) {
    const r = Number(l.taxRate);
    const x = byRate.get(r) ?? { net: 0, tax: 0 };
    byRate.set(r, { net: x.net + Math.round(Number(l.net) * 100), tax: x.tax + Math.round(Number(l.tax) * 100) });
  }
  const subtotals = [...byRate.entries()].map(([rate, x]) => `<cac:TaxSubtotal>${amount('cbc:TaxableAmount', (x.net / 100).toFixed(2), cur)}${amount('cbc:TaxAmount', (x.tax / 100).toFixed(2), cur)}`
    + `<cbc:Percent>${rate}</cbc:Percent>${taxCategory(rate, i.exemption)}</cac:TaxSubtotal>`).join('');
  const lines = i.lines.map((l, n) => `<cac:InvoiceLine><cbc:ID>${n + 1}</cbc:ID><cbc:InvoicedQuantity unitCode="${esc(l.unit)}">${Number(l.quantity)}</cbc:InvoicedQuantity>`
    + `${amount('cbc:LineExtensionAmount', l.net, cur)}<cac:TaxTotal>${amount('cbc:TaxAmount', l.tax, cur)}<cac:TaxSubtotal>${amount('cbc:TaxableAmount', l.net, cur)}${amount('cbc:TaxAmount', l.tax, cur)}`
    + `<cbc:Percent>${Number(l.taxRate)}</cbc:Percent>${taxCategory(Number(l.taxRate), i.exemption)}</cac:TaxSubtotal></cac:TaxTotal>`
    + `<cac:Item>${el('cbc:Name', l.description)}</cac:Item><cac:Price><cbc:PriceAmount currencyID="${esc(cur)}">${Number(l.unitPrice).toFixed(4).replace(/0{1,2}$/, '')}</cbc:PriceAmount></cac:Price></cac:InvoiceLine>`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>'
    + '<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"'
    + ' xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">'
    + '<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>'
    + '<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>TR1.2</cbc:CustomizationID>'
    + `${el('cbc:ProfileID', i.profile)}${el('cbc:ID', i.number)}<cbc:CopyIndicator>false</cbc:CopyIndicator>${el('cbc:UUID', i.uuid)}`
    + `${el('cbc:IssueDate', i.issueDate)}${el('cbc:IssueTime', i.issueTime)}${el('cbc:InvoiceTypeCode', i.type)}`
    + i.notes.map((n) => el('cbc:Note', n)).join('')
    + `${el('cbc:DocumentCurrencyCode', cur)}<cbc:LineCountNumeric>${i.lines.length}</cbc:LineCountNumeric>`
    + (i.returnOf ? `<cac:BillingReference><cac:InvoiceDocumentReference>${el('cbc:ID', i.returnOf.number)}${el('cbc:IssueDate', i.returnOf.date)}</cac:InvoiceDocumentReference></cac:BillingReference>` : '')
    + `<cac:AdditionalDocumentReference>${el('cbc:ID', i.uuid)}${el('cbc:IssueDate', i.issueDate)}<cbc:DocumentType>XSLT</cbc:DocumentType><cac:Attachment>`
    + `<cbc:EmbeddedDocumentBinaryObject characterSetCode="UTF-8" encodingCode="Base64" filename="${esc(i.number)}.xslt" mimeCode="application/xml">${Buffer.from(invoiceXslt).toString('base64')}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment></cac:AdditionalDocumentReference>`
    + (i.sendingType ? `<cac:AdditionalDocumentReference>${el('cbc:ID', i.uuid.replace(/^.{8}/, '00000000'))}${el('cbc:IssueDate', i.issueDate)}<cbc:DocumentTypeCode>SendingType</cbc:DocumentTypeCode>${el('cbc:DocumentType', i.sendingType)}</cac:AdditionalDocumentReference>` : '')
    + `<cac:Signature><cbc:ID schemeID="VKN_TCKN">${esc(i.supplier.taxId)}</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID schemeID="${i.supplier.taxId.length === 11 ? 'TCKN' : 'VKN'}">${esc(i.supplier.taxId)}</cbc:ID></cac:PartyIdentification>`
    + `<cac:PostalAddress>${el('cbc:CitySubdivisionName', i.supplier.district || '-')}${el('cbc:CityName', i.supplier.city || '-')}<cac:Country>${el('cbc:Name', countryName(i.supplier.country))}</cac:Country></cac:PostalAddress></cac:SignatoryParty>`
    + '<cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#Signature</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>'
    + `<cac:AccountingSupplierParty>${party(i.supplier)}</cac:AccountingSupplierParty><cac:AccountingCustomerParty>${party(i.customer)}</cac:AccountingCustomerParty>`
    + (i.selfDelivered ? `<cac:Delivery>${el('cbc:ActualDeliveryDate', i.issueDate)}${party(i.supplier, 'cac:CarrierParty')}<cac:Despatch>${el('cbc:ActualDespatchDate', i.issueDate)}</cac:Despatch></cac:Delivery>` : '')
    + (i.paymentMeans ? `<cac:PaymentMeans>${el('cbc:PaymentMeansCode', i.paymentMeans.code)}${el('cbc:PaymentDueDate', i.paymentMeans.date)}${el('cbc:InstructionNote', i.paymentMeans.note)}</cac:PaymentMeans>` : '')
    + (cur !== 'TRY' && i.exchangeRate ? `<cac:PricingExchangeRate><cbc:SourceCurrencyCode>${esc(cur)}</cbc:SourceCurrencyCode><cbc:TargetCurrencyCode>TRY</cbc:TargetCurrencyCode><cbc:CalculationRate>${esc(i.exchangeRate)}</cbc:CalculationRate></cac:PricingExchangeRate>` : '')
    + `<cac:TaxTotal>${amount('cbc:TaxAmount', i.taxTotal, cur)}${subtotals}</cac:TaxTotal>`
    + `<cac:LegalMonetaryTotal>${amount('cbc:LineExtensionAmount', i.subtotal, cur)}${amount('cbc:TaxExclusiveAmount', i.subtotal, cur)}${amount('cbc:TaxInclusiveAmount', i.total, cur)}`
    + `${amount('cbc:AllowanceTotalAmount', '0', cur)}${amount('cbc:PayableAmount', i.total, cur)}</cac:LegalMonetaryTotal>`
    + lines + '</Invoice>';
}

// The amount in Turkish words, a customary note on Turkish invoices ("Yalnız ... TL ... Kr").
export function inWords(v: string, currency = 'TRY') {
  const ones = ['', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
  const tens = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];
  const three = (n: number) => `${n >= 100 ? `${n >= 200 ? ones[Math.floor(n / 100)] : ''}yüz` : ''}${tens[Math.floor((n % 100) / 10)]}${ones[n % 10]}`;
  const words = (n: number) => {
    if (n === 0) return 'sıfır';
    const groups = ['', 'bin', 'milyon', 'milyar'];
    let out = ''; let i = 0;
    while (n > 0) { const g = n % 1000; if (g) out = `${g === 1 && i === 1 ? '' : three(g)}${groups[i]}${out}`; n = Math.floor(n / 1000); i++; }
    return out;
  };
  const [lira, kurus] = Number(v).toFixed(2).split('.').map(Number);
  const unit = ({ TRY: ['TL', 'Kr'], EUR: ['Avro', 'Sent'], USD: ['Dolar', 'Sent'] } as Record<string, string[]>)[currency] ?? [currency, ''];
  return `Yalnız ${words(lira)} ${unit[0]}${kurus ? ` ${words(kurus)} ${unit[1]}` : ''}`;
}
