// How this panel is named in the person's authenticator app and passkey manager: the installation's own brand
// (Settings → Branding), never a hard-coded product name, and the account by its e-mail address. better-auth builds
// both from fixed options; better-auth.ts puts these in its answers instead (docs/proposals.md).

// The brand as an issuer: one line, no colon (the label's separator between issuer and account), at most 64
// characters; the product's name when nothing is left.
export function issuerName(brand: string | null | undefined): string {
  const name = String(brand ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(name).slice(0, 64).join('').trim() || 'Lightning VM';
}

// An otpauth URI as the Key URI Format describes it: label "Issuer:account" and the same issuer as a parameter, both
// percent-encoded (a space is %20, not "+", which some apps would show as a plus).
export function totpUri(o: { issuer: string; account: string; secret: string; digits?: number | string | null; period?: number | string | null; algorithm?: string | null }): string {
  const enc = encodeURIComponent;
  const extra = [o.algorithm ? `&algorithm=${enc(o.algorithm)}` : '', o.digits ? `&digits=${enc(String(o.digits))}` : '', o.period ? `&period=${enc(String(o.period))}` : ''].join('');
  return `otpauth://totp/${enc(o.issuer)}:${enc(o.account)}?secret=${enc(o.secret)}&issuer=${enc(o.issuer)}${extra}`;
}

// The same secret, digits, period and algorithm as `uri`, under this issuer and account. `uri` unchanged when it is
// not an otpauth TOTP URI with a secret.
export function relabelTotp(uri: string, issuer: string, account: string): string {
  let u: URL;
  try { u = new URL(uri); } catch { return uri; }
  const secret = u.searchParams.get('secret');
  if (u.protocol !== 'otpauth:' || u.host.toLowerCase() !== 'totp' || !secret) return uri;
  return totpUri({ issuer: issuerName(issuer), account, secret, digits: u.searchParams.get('digits'), period: u.searchParams.get('period'), algorithm: u.searchParams.get('algorithm') });
}

// The WebAuthn registration options with the panel's name as the relying party and the account's e-mail address as
// the user name (better-auth would take the passkey's own name from the request for it). The challenge, ids and
// everything else stay as they are.
export function relabelRegistration<T extends { rp?: Record<string, unknown>; user?: Record<string, unknown> }>(options: T, brand: string, user: { email: string; name?: string | null }): T {
  return { ...options, rp: { ...options.rp, name: issuerName(brand) }, user: { ...options.user, name: user.email, displayName: user.name?.trim() || user.email } };
}
