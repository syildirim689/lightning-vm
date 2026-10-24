"use client";
import { useState } from 'react';
import { apiFetch, useErrorText, type ApiError } from './api';

// Form state + submit with server-side field errors, shared by the catalog forms.
export function useApiForm<T extends Record<string, unknown>>(initial: T) {
  const { error, field } = useErrorText();
  const [values, setValues] = useState(initial);
  const [failure, setFailure] = useState<ApiError & { text: string }>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof T) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setValues((v) => ({ ...v, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));
  async function submit<R>(method: string, path: string, body: unknown = values, headers?: Record<string, string>): Promise<R | undefined> {
    setBusy(true); setFailure(undefined);
    try { return await apiFetch<R>(path, { method, body, headers }); }
    catch (e) { setFailure({ ...(e as ApiError), text: error(e) }); return undefined; }
    finally { setBusy(false); }
  }
  const fieldError = (name: string) => field(failure?.fields?.[name]);
  return { values, setValues, set, submit, failure, busy, fieldError };
}

// Labelled input with help or the translated server error underneath.
export function Field({ id, label, help, error, required, children }: { id: string; label: string; help?: string; error?: string; required?: boolean; children: React.ReactNode }) {
  return <div className="field">
    <label htmlFor={id}>{label}{required !== undefined && <span className="muted"> · {required ? '*' : ''}</span>}</label>
    {children}
    {(error || help) && <small id={`${id}-help`} className={error ? 'error' : 'muted'}>{error ?? help}</small>}
  </div>;
}
