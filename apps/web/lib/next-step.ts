// What to do after an operation failed: one suggested next step from the operation's kind and its error code.
// Plain data in, plain data out; the server page turns the step into a sentence and one button.
//
// The codes are the ones the worker and the platform adapters really set on a failed operation (apps/worker,
// services/*), plus the API's own refusals that can end up there. A code nobody listed falls back to support.
export type NextStep =
  | { step: 'retry' }                    // usually temporary: the same action once more
  | { step: 'billing' }                  // money stands in the way: the invoices and the balance
  | { step: 'quota' }                    // a limit stands in the way: what the quota still allows
  | { step: 'support'; staff: boolean }; // a ticket; `staff` when only the team can sort it out (never retried)

// The panel does not know what happened on the platform, or the server no longer matches what was asked for:
// someone from the team has to look first, and doing it again could make it worse.
const STAFF = new Set(['OUTCOME_UNKNOWN', 'VM_MISMATCH', 'SERVER_CHANGED']);
// Timeouts, something busy, a connection that is down: the same request can succeed a moment later.
const TRANSIENT = new Set(['TIMEOUT', 'SHUTDOWN_TIMEOUT', 'READINESS_TIMEOUT', 'STORAGE_TIMEOUT', 'ETIMEDOUT',
  'ENGINE_BUSY', 'SERVER_BUSY', 'MAINTENANCE_BUSY', 'OPERATION_RATE_LIMITED', 'RATE_LIMITED',
  'VMWARE_SERVICE_UNAVAILABLE', 'DEPENDENCY_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'STORAGE_UNREACHABLE', 'CONNECTION_REFUSED', 'NETWORK']);
const BILLING = new Set(['INSUFFICIENT_BALANCE', 'BALANCE_TOO_LOW', 'UNPAID_INVOICE', 'BILLING_HOLD', 'PAYMENT_FAILED', 'PAYMENT_REQUIRED']);
const QUOTA = new Set(['QUOTA_EXCEEDED', 'LIMIT_REACHED', 'VDC_LIMIT', 'RESELLER_ALLOCATION_EXCEEDED']);
// The only operations offered again with one press: they cost nothing, lose nothing and are asked for with no more
// than the page already knows. Creating, deleting, reinstalling, resizing, restoring (a snapshot or a backup) and
// everything priced are never retried from here.
export const RETRYABLE = ['power_on', 'shutdown', 'reset', 'snapshot_create'] as const;
export type RetryableKind = typeof RETRYABLE[number];
export const retryable = (kind: string): kind is RetryableKind => (RETRYABLE as readonly string[]).includes(kind);

export function nextStep(kind: string, code: string | null | undefined): NextStep {
  const c = code ?? '';
  if (STAFF.has(c)) return { step: 'support', staff: true };
  if (BILLING.has(c)) return { step: 'billing' };
  if (QUOTA.has(c)) return { step: 'quota' };
  if (TRANSIENT.has(c) && retryable(kind)) return { step: 'retry' };
  return { step: 'support', staff: false };
}

export type FailedOperation = { id: string; kind: string; status: string; errorCode: string | null; createdAt: string; finishedAt: string | null };
// The failure worth a notice at the top of the server's page: the newest operation, when it failed, and only while
// it still matters (the server is left in an error state, or it ended within the last day). `operations` is newest first.
export function latestFailure<T extends FailedOperation>(operations: T[], serverState: string, now: number, hours = 24): T | null {
  const last = operations[0];
  if (!last || last.status !== 'failed' || !last.errorCode) return null;
  const at = Date.parse(last.finishedAt ?? last.createdAt);
  return serverState === 'error' || (Number.isFinite(at) && now - at < hours * 3_600_000) ? last : null;
}
