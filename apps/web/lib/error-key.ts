// Which sentence explains a failed request (lib/api.ts useErrorText). A code with its own sentence says it; a code
// without one (a newer API than this panel's texts) is named, so support can look it up; an answer without any code
// (a proxy's or gateway's page) gives its HTTP status; only nothing at all is "unknown". Every sentence says what to
// do next. Pure (node --test lib/*.test.ts); scripts/check-messages.mjs checks that every code the API, the adapters
// and the worker can send has a sentence in both languages.
export type ErrorKey = { key: string; values?: Record<string, string | number> };

export function errorKey(e: unknown, known: (code: string) => boolean): ErrorKey {
  const { code = 'UNKNOWN', status } = (e as { code?: string; status?: number } | null) ?? {};
  if (code !== 'UNKNOWN' && known(code)) return { key: code };
  if (code !== 'UNKNOWN') return { key: 'UNTRANSLATED', values: { code: String(code).slice(0, 60) } };
  if (typeof status === 'number') return { key: status >= 500 ? 'SERVER_STATUS' : 'CLIENT_STATUS', values: { status } };
  return { key: 'UNKNOWN' };
}
export const FALLBACK_KEYS = ['UNKNOWN', 'UNTRANSLATED', 'SERVER_STATUS', 'CLIENT_STATUS', 'NETWORK'] as const;
