"use client";
import { useTranslations } from 'next-intl';

export type ApiError = { code: string; fields?: Record<string, string> };

// Browser calls go through Caddy at /api. The CSRF header is required by the API on every state change.
export async function apiFetch<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    signal: init.signal,
    headers: { 'x-lightning-csrf': '1', ...(init.body !== undefined && { 'content-type': 'application/json' }) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch((e) => { throw init.signal?.aborted ? e : ({ code: 'NETWORK' } satisfies ApiError); });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw { code: body?.code ?? 'UNKNOWN', fields: body?.fields } satisfies ApiError;
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

// Translates API error and field codes; unknown codes fall back to a generic translated text.
export function useErrorText() {
  const te = useTranslations('errors');
  const tf = useTranslations('fieldErrors');
  return {
    error: (e: unknown) => { const code = (e as ApiError)?.code ?? 'UNKNOWN'; return te.has(code as 'UNKNOWN') ? te(code as 'UNKNOWN') : te('UNKNOWN'); },
    field: (code?: string) => code === undefined ? undefined : tf.has(code as 'INVALID_VALUE') ? tf(code as 'INVALID_VALUE') : tf('INVALID_VALUE'),
  };
}
