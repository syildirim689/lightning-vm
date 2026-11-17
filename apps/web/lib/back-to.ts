// Where to go after signing in: the panel page the person was sent away from (?next=/servers/…), so a link opened
// while signed out, or a session that ran out, ends up where it was meant to. Only a path inside this panel counts:
// never another site (//evil.example, /\\evil.example), the API, or the sign-in pages themselves.
const base = 'http://panel.invalid';
export function backTo(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 2000 || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw, base); } catch { return null; }
  if (url.origin !== base || url.pathname === '/') return null;
  // The block list reads the path the way the server will: decoded, whatever its case (/LOGIN, /%61pi).
  let path: string;
  try { path = decodeURIComponent(url.pathname).toLowerCase(); } catch { return null; }
  if (/^\/+(api|_next|login|register|setup|reset-password|forgot-password|verify)(\/|$)/.test(path)) return null;
  // What is returned is the parser's normalised form, so that is what gets checked: dot segments are gone by now,
  // and /.//evil.example or /%2e%2e//evil.example has become //evil.example, another site to a browser.
  const out = url.pathname + url.search + url.hash;
  if (out.startsWith('//') || out.includes('\\')) return null;
  try { if (new URL(out, base).origin !== base) return null; } catch { return null; }
  return out;
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
