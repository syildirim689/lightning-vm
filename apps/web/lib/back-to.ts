// Where to go after signing in: the panel page the person was sent away from (?next=/servers/…), so a link opened
// while signed out, or a session that ran out, ends up where it was meant to. Only a path inside this panel counts:
// never another site (//evil.example, /\\evil.example), the API, or the sign-in pages themselves.
export function backTo(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2000 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw, 'http://panel.invalid'); } catch { return null; }
  if (url.origin !== 'http://panel.invalid' || url.pathname === '/') return null;
  if (/^\/(api|_next|login|register|setup|reset-password|forgot-password|verify)(\/|$)/.test(url.pathname)) return null;
  return url.pathname + url.search + url.hash;
}

// "/login?reason=expired&next=…" for the page now on screen.
export function loginFrom(path: string, reason?: string) {
  const q = new URLSearchParams();
  if (reason) q.set('reason', reason);
  const next = backTo(path);
  if (next) q.set('next', next);
  const s = q.toString();
  return s ? `/login?${s}` : '/login';
}
