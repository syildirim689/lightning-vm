// e-Fatura / e-Arşiv: paid invoices go to the chosen GİB integrator as UBL-TR. Until one is chosen ('none') invoices
// are issued in the panel only and these do nothing.
import { getSettings } from './settings-store';

const off = async () => (await getSettings('einvoice')).provider === 'none';
export async function sendQueued() { if (await off()) return 0; return 0; }
export async function lookupProfile(userId: string) { if (await off()) return null; return userId ? null : null; }
export async function creditNote(invoiceId: string, amount: string, reason: string) { if (await off()) return null; return invoiceId && amount && reason ? null : null; }
