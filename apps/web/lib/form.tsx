"use client";
import { useState } from 'react';
import { apiFetch, useErrorText, type ApiError } from './api';

// Form state + submit with server-side field errors, shared by every form.
// set(k) returns a setter for HeroUI fields, which hand over the value itself (not a DOM event).
export function useApiForm<T extends Record<string, unknown>>(initial: T) {
  const { error, field } = useErrorText();
  const [values, setValues] = useState(initial);
  const [failure, setFailure] = useState<ApiError & { text: string }>();
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof T>(k: K) => (v: T[K]) => setValues((prev) => ({ ...prev, [k]: v }));
  async function submit<R>(method: string, path: string, body: unknown = values, headers?: Record<string, string>): Promise<R | undefined> {
    setBusy(true); setFailure(undefined);
    try { return await apiFetch<R>(path, { method, body, headers }); }
    catch (e) { setFailure({ ...(e as ApiError), text: error(e) }); return undefined; }
    finally { setBusy(false); }
  }
  const fieldError = (name: string) => field(failure?.fields?.[name]);
  return { values, setValues, set, submit, failure, busy, fieldError, reset: () => { setValues(initial); setFailure(undefined); } };
}
