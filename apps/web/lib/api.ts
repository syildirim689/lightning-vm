"use client";
import { useTranslations } from 'next-intl';

export type ApiError = { code: string; fields?: Record<string, string> };

// Whether the panel's server answers: a failed connection or a gateway error page (502/503/504 without the API's
// JSON) says no, any API answer says yes. The connection banner listens.
const reach = (up: boolean) => window.dispatchEvent(new CustomEvent('lvm:api', { detail: up }));

// Browser calls go through Caddy at /api. The CSRF header is required by the API on every state change.
export async function apiFetch<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    signal: init.signal,
    headers: { 'x-lightning-csrf': '1', ...(init.body !== undefined && { 'content-type': 'application/json' }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch((e) => { if (!init.signal?.aborted) reach(false); throw init.signal?.aborted ? e : ({ code: 'NETWORK' } satisfies ApiError); });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    reach(!(body === null && res.status >= 502 && res.status <= 504));
    // Keep structured context (certificate, conflicts) for the UI; only the code is required.
    throw { ...body, code: body?.code ?? 'UNKNOWN' } satisfies ApiError;
  }
  reach(true);
  return res.status === 204 ? (undefined as T) : res.json();
}

// Translates API error and field codes; unknown codes fall back to a generic translated text.
export function useErrorText() {
  const te = useTranslations('errors');
  const tf = useTranslations('fieldErrors');
  return {
    error: (e: unknown) => { const code = (e as ApiError)?.code ?? 'UNKNOWN'; return te.has(code as 'UNKNOWN') ? te(code as 'UNKNOWN') : te('UNKNOWN'); },
    field: (code?: string) => !code ? undefined : tf.has(code as 'INVALID_VALUE') ? tf(code as 'INVALID_VALUE') : tf('INVALID_VALUE'),
  };
}
