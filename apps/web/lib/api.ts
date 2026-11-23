"use client";
import { useTranslations } from 'next-intl';
import { loginFrom } from './back-to';
import { errorKey } from './error-key';
import { editsSaved, hasPendingEdits } from './edits';
import { sessionEnded } from './session-end';

export type ApiError = { code: string; fields?: Record<string, string>; status?: number };

// Whether the panel's server answers: a failed connection or a gateway error page (502/503/504 without the API's
// JSON) says no, any API answer says yes. The connection banner listens.
const reach = (up: boolean) => window.dispatchEvent(new CustomEvent('lvm:api', { detail: up }));

// After a rejected save, move to the first field marked invalid (in the open dialog first), so a long form does not
// leave the person hunting for the message. Waits for the errors to render; does nothing if focus is already on one.
export function focusFirstInvalid() {
  let tries = 0;
  const look = () => {
    const scope = document.querySelector('[role=dialog],[role=alertdialog]') ?? document;
    const bad = scope.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"] input, [data-invalid="true"] textarea, [data-invalid="true"] button');
    if (!bad) { if (++tries < 10) setTimeout(look, 60); return; }
    if (document.activeElement?.closest('[data-invalid="true"]') || document.activeElement?.getAttribute('aria-invalid') === 'true') return;
    bad.focus({ preventScroll: true });
    bad.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  setTimeout(look, 60);
}

// Set while the signed-in panel is on screen (LiveEvents): only there does a refused read mean "the session ended".
// Public pages (sign-in, status) never set it, so a 401 on one of their reads cannot send anybody in circles.
let sessionExpected = false;
export const expectSession = (on: boolean) => { sessionExpected = on; };

// Browser calls go through Caddy at /api. The CSRF header is required by the API on every state change.
export async function apiFetch<T = unknown>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; headers?: Record<string, string>; keepalive?: boolean } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? 'GET',
    signal: init.signal,
    // A removal sent while the page unloads (components/undo.tsx) must outlive it.
    keepalive: init.keepalive,
    headers: { 'x-lightning-csrf': '1', ...(init.body !== undefined && { 'content-type': 'application/json' }), ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }).catch((e) => { if (!init.signal?.aborted) reach(false); throw init.signal?.aborted ? e : ({ code: 'NETWORK' } satisfies ApiError); });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    reach(!(body === null && res.status >= 502 && res.status <= 504));
    // The session ran out during a save: the same path as a live-update sign-out (keeps unsaved typing on screen).
    // A read that is refused inside the panel says the same (a role's session limit, the end of "sign in as"): the
    // lists on screen would otherwise stay as they were, quietly out of date.
    if (body?.code === 'UNAUTHENTICATED' && ((init.method ?? 'GET') !== 'GET' || sessionExpected) && !/^\/(auth|setup)\//.test(path) && !/^\/(login|setup|register)/.test(window.location.pathname)) {
      if (hasPendingEdits()) window.dispatchEvent(new Event('lvm:expired')); else { void sessionEnded(); window.location.replace(loginFrom(window.location.pathname + window.location.search, 'expired')); }
    }
    // A form the server sent back with field errors: once they are shown, the first wrong field takes the focus.
    if (body?.fields && Object.keys(body.fields).length && (init.method ?? 'GET') !== 'GET') focusFirstInvalid();
    // Keep structured context (certificate, conflicts) for the UI; only the code is required.
    // The HTTP status goes along: an answer without the API's code (a proxy's error page) is then still explained.
    throw { ...body, code: body?.code ?? 'UNKNOWN', status: res.status } satisfies ApiError;
  }
  reach(true);
  if ((init.method ?? 'GET') !== 'GET') editsSaved();
  return res.status === 204 ? (undefined as T) : res.json();
}

// Translates API error and field codes; unknown codes fall back to a generic translated text.
// code: for codes written by the host's installer and agent, where an unknown one is better shown as it is.
export function useErrorText() {
  const te = useTranslations('errors');
  const tf = useTranslations('fieldErrors');
  return {
    code: (code: string) => (te.has(code as 'UNKNOWN') ? te(code as 'UNKNOWN') : code),
    // A code with its own sentence says it. Otherwise the cause in plain words and the next step, never a bare
    // "unknown error": a code without a sentence (a newer API) is named so support can look it up, and an answer
    // without any code (a proxy or gateway page) gives its HTTP status.
    error: (e: unknown) => { const k = errorKey(e, (c) => te.has(c as 'UNKNOWN')); return te(k.key as 'UNTRANSLATED', k.values as { code: string }); },
    field: (code?: string) => !code ? undefined : tf.has(code as 'INVALID_VALUE') ? tf(code as 'INVALID_VALUE') : tf('INVALID_VALUE'),
  };
}
