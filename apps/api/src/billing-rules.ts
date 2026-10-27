// Billing rules without I/O (billing.ts uses them; billing-rules.test.mjs checks them): money in kuruş/cents, KDV,
// the invoice number format, Turkish identity and tax number checks, subscription periods and the collection steps.

// "12.50" → 1250. Amounts never go through floating point arithmetic.
export function toCents(v: string | number): number {
  const s = typeof v === 'number' ? v.toFixed(2) : v.trim();
  const m = /^(-)?(\d{1,10})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`not an amount: ${v}`);
  return (m[1] ? -1 : 1) * (Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0')));
}
export const fromCents = (c: number) => `${c < 0 ? '-' : ''}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, '0')}`;

// One invoice line: net, tax and gross in cents, rounded half up per line (as GİB's UBL-TR totals expect).
// inclusive: the price already contains the tax (it is taken out of it).
export function lineAmounts(unitCents: number, quantity: number, rate: number, inclusive = false) {
  const amount = Math.round(unitCents * quantity);
  if (inclusive) {
    const net = Math.round((amount * 100) / (100 + rate));
    return { net, tax: amount - net, gross: amount };
  }
  const tax = Math.round((amount * rate) / 100);
  return { net: amount, tax, gross: amount + tax };
}
export function totals(lines: { net: number; tax: number; gross: number }[]) {
  return lines.reduce((t, l) => ({ net: t.net + l.net, tax: t.tax + l.tax, gross: t.gross + l.gross }), { net: 0, tax: 0, gross: 0 });
}

// GİB invoice number: 3 characters, the year, 9 digits (16 in all).
export const validPrefix = (p: string) => /^[A-Z0-9]{3}$/.test(p);
export const invoiceNumber = (prefix: string, year: number, seq: number) => `${prefix}${year}${String(seq).padStart(9, '0')}`;

// T.C. kimlik numarası: 11 digits, not starting with 0, two check digits.
export function validTckn(v: string) {
  if (!/^[1-9]\d{10}$/.test(v)) return false;
  const d = [...v].map(Number);
  const odd = d[0] + d[2] + d[4] + d[6] + d[8], even = d[1] + d[3] + d[5] + d[7];
  return ((odd * 7 - even) % 10 + 10) % 10 === d[9] && d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}
// Vergi kimlik numarası: 10 digits with the Revenue Administration's check digit.
export function validVkn(v: string) {
  if (!/^\d{10}$/.test(v)) return false;
  const d = [...v].map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const t = (d[i] + 9 - i) % 10;
    let r = (t * 2 ** (9 - i)) % 9;
    if (t !== 0 && r === 0) r = 9;
    sum += r;
  }
  return (10 - (sum % 10)) % 10 === d[9];
}

export type ProfileInput = { kind?: unknown; name?: unknown; taxId?: unknown; taxOffice?: unknown; country?: unknown; city?: unknown; district?: unknown;
  address?: unknown; postalCode?: unknown; email?: unknown; phone?: unknown };
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
// The customer's invoice details. Turkish customers need a valid TCKN (person) or VKN (company, with tax office) and an address.
export function cleanProfile(b: ProfileInput) {
  const fields: Record<string, string> = {};
  const kind = b.kind === 'company' ? 'company' : b.kind === 'individual' ? 'individual' : (fields.kind = 'INVALID_VALUE', 'individual');
  const country = str(b.country, 2).toUpperCase() || 'TR';
  if (!/^[A-Z]{2}$/.test(country)) fields.country = 'INVALID_VALUE';
  const p = { kind, name: str(b.name, 200), taxId: str(b.taxId, 20).replace(/\s/g, ''), taxOffice: str(b.taxOffice, 100), country, city: str(b.city, 100),
    district: str(b.district, 100), address: str(b.address, 500), postalCode: str(b.postalCode, 20), email: str(b.email, 254), phone: str(b.phone, 30) };
  if (p.name.length < 2) fields.name = 'REQUIRED';
  if (country === 'TR') {
    if (kind === 'individual' && !validTckn(p.taxId)) fields.taxId = 'INVALID_TCKN';
    if (kind === 'company' && !validVkn(p.taxId)) fields.taxId = 'INVALID_VKN';
    if (kind === 'company' && !p.taxOffice) fields.taxOffice = 'REQUIRED';
    if (!p.city) fields.city = 'REQUIRED';
    if (!p.district) fields.district = 'REQUIRED';
  } else if (p.taxId.length < 5) fields.taxId = 'REQUIRED';
  if (!p.address) fields.address = 'REQUIRED';
  if (p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) fields.email = 'INVALID_EMAIL';
  return Object.keys(fields).length ? { fields } : { profile: p };
}

// The tax on a customer's lines: the general KDV rate, or 0 with exemption 301 for a foreign buyer when the admin
// treats services used abroad as exempt (KDV Kanunu 11/1-a, services exported).
export function taxFor(country: string, s: { taxRate: number; exportExempt: boolean }) {
  return country !== 'TR' && s.exportExempt ? { rate: 0, exemption: '301' } : { rate: s.taxRate, exemption: null };
}

// Dates are calendar days (YYYY-MM-DD). A period ends on the same day N months later, or the month's last day.
export function addMonths(day: string, months: number) {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
export const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export type Dunning = { invoiceDaysBefore: number; reminderDays: number[]; suspendAfterDays: number; terminateAfterDays: number };
// What an unpaid renewal needs today, by days past its due date: a reminder before it is due, the overdue notice
// on the day after, suspension after N days, termination after M more days (0 = never).
export function collectionStep(daysPastDue: number, s: Dunning, state: { reminded: boolean; overdueNotified: boolean; suspended: boolean; suspendedDays: number }) {
  if (state.suspended) return s.terminateAfterDays > 0 && state.suspendedDays >= s.terminateAfterDays ? 'terminate' : null;
  if (daysPastDue >= s.suspendAfterDays && daysPastDue > 0) return 'suspend';
  if (daysPastDue > 0 && !state.overdueNotified) return 'overdue';
  if (daysPastDue <= 0 && s.reminderDays.includes(-daysPastDue) && !state.reminded) return 'remind';
  return null;
}
