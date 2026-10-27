import test from 'node:test';
import assert from 'node:assert/strict';

const { buildUbl, inWords, splitName } = await import('../dist/ubl.js');

const supplier = { name: 'Lightning Bilişim A.Ş.', taxId: '1234567890', taxOffice: 'Kadıköy', address: 'Moda Cd. 1', district: 'Kadıköy', city: 'İstanbul', country: 'TR', website: 'https://panel.example.com' };
const base = { uuid: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', number: 'LVM2026000000001', issueDate: '2026-10-27', issueTime: '14:05:00', profile: 'EARSIVFATURA', type: 'SATIS',
  currency: 'TRY', notes: ['Bu satış internet üzerinden yapılmıştır.'], supplier, customer: { name: 'Ayşe Nur Yılmaz', taxId: '10000000146', city: 'İstanbul', district: 'Kadıköy', address: 'Moda <2>' },
  lines: [{ description: 'Sunucu web-1 (2026-10-27 – 2026-11-27)', quantity: '1', unit: 'MON', unitPrice: '100.0000', taxRate: '20', net: '100.00', tax: '20.00' },
    { description: 'Ek IPv4', quantity: '2', unit: 'C62', unitPrice: '12.5000', taxRate: '20', net: '25.00', tax: '5.00' }],
  subtotal: '125.00', taxTotal: '25.00', total: '150.00' };

test('a UBL-TR 1.2 e-Arşiv invoice: header, parties, KDV 0015 per rate, totals and lines in order', () => {
  const x = buildUbl(base);
  assert.match(x, /^<\?xml version="1.0" encoding="UTF-8"\?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"/);
  const order = ['cbc:UBLVersionID>2.1', 'cbc:CustomizationID>TR1.2', 'cbc:ProfileID>EARSIVFATURA', 'cbc:ID>LVM2026000000001', 'cbc:CopyIndicator>false', `cbc:UUID>${base.uuid}`,
    'cbc:IssueDate>2026-10-27', 'cbc:InvoiceTypeCode>SATIS', 'cbc:Note>', 'cbc:DocumentCurrencyCode>TRY', 'cbc:LineCountNumeric>2', 'cac:Signature>',
    'cac:AccountingSupplierParty>', 'cac:AccountingCustomerParty>', 'cac:TaxTotal>', 'cac:LegalMonetaryTotal>', 'cac:InvoiceLine>'];
  let at = -1;
  for (const o of order) { const i = x.indexOf(o, at + 1); assert.ok(i > at, `${o} after the previous element`); at = i; }
  assert.match(x, /<cbc:ID schemeID="VKN">1234567890<\/cbc:ID>/);
  assert.match(x, /<cbc:ID schemeID="TCKN">10000000146<\/cbc:ID>/);
  assert.match(x, /<cac:Person><cbc:FirstName>Ayşe Nur<\/cbc:FirstName><cbc:FamilyName>Yılmaz<\/cbc:FamilyName><\/cac:Person>/, 'a TCKN party is a person');
  assert.match(x, /Moda &lt;2&gt;/, 'escaped');
  assert.match(x, /<cac:TaxTotal><cbc:TaxAmount currencyID="TRY">25.00<\/cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="TRY">125.00<\/cbc:TaxableAmount><cbc:TaxAmount currencyID="TRY">25.00<\/cbc:TaxAmount><cbc:Percent>20<\/cbc:Percent>/);
  assert.match(x, /<cbc:TaxTypeCode>0015<\/cbc:TaxTypeCode>/);
  assert.match(x, /<cbc:PayableAmount currencyID="TRY">150.00<\/cbc:PayableAmount>/);
  assert.match(x, /<cbc:InvoicedQuantity unitCode="C62">2<\/cbc:InvoicedQuantity>/);
  assert.equal((x.match(/<cac:InvoiceLine>/g) ?? []).length, 2);
  assert.ok(!x.includes('BillingReference'));
  const e = buildUbl({ ...base, sendingType: 'ELEKTRONIK', paymentMeans: { code: '48', date: '2026-10-27', note: 'iyzico' } });
  assert.ok(e.includes('<cbc:DocumentTypeCode>SendingType</cbc:DocumentTypeCode><cbc:DocumentType>ELEKTRONIK</cbc:DocumentType>'));
  assert.ok(e.includes('<cac:PaymentMeans><cbc:PaymentMeansCode>48</cbc:PaymentMeansCode><cbc:PaymentDueDate>2026-10-27</cbc:PaymentDueDate><cbc:InstructionNote>iyzico</cbc:InstructionNote></cac:PaymentMeans>'));
  const d = buildUbl({ ...base, selfDelivered: true });
  assert.ok(d.includes('<cac:Delivery><cbc:ActualDeliveryDate>2026-10-27</cbc:ActualDeliveryDate><cac:CarrierParty>') && d.includes('<cac:Despatch><cbc:ActualDespatchDate>2026-10-27</cbc:ActualDespatchDate></cac:Despatch></cac:Delivery>'), 'a service delivered by the seller itself');
  assert.ok(e.indexOf('SendingType') < e.indexOf('<cac:Signature>'));
});

test('zero rate carries its exemption; a return invoice refers to the original; foreign currency has its rate', () => {
  const x = buildUbl({ ...base, type: 'ISTISNA', currency: 'EUR', exchangeRate: '36.1234', exemption: { code: '302', reason: '11/1-a Hizmet İhracatı' },
    lines: [{ ...base.lines[0], taxRate: '0', tax: '0.00' }], subtotal: '100.00', taxTotal: '0.00', total: '100.00' });
  assert.match(x, /<cbc:TaxExemptionReasonCode>302<\/cbc:TaxExemptionReasonCode><cbc:TaxExemptionReason>11\/1-a Hizmet İhracatı<\/cbc:TaxExemptionReason>/);
  assert.match(x, /<cbc:CalculationRate>36.1234<\/cbc:CalculationRate>/);
  const r = buildUbl({ ...base, type: 'IADE', returnOf: { number: 'LVM2026000000001', date: '2026-10-20' } });
  assert.match(r, /<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>LVM2026000000001<\/cbc:ID><cbc:IssueDate>2026-10-20<\/cbc:IssueDate>/);
});

test('names split for a person; the amount in Turkish words', () => {
  assert.deepEqual(splitName('Ayşe Nur Yılmaz'), { first: 'Ayşe Nur', family: 'Yılmaz' });
  assert.equal(inWords('1250.50'), 'Yalnız binikiyüzelli TL elli Kr');
  assert.equal(inWords('2000000'), 'Yalnız ikimilyon TL');
  assert.equal(inWords('101.05', 'EUR'), 'Yalnız yüzbir Avro beş Sent');
});
