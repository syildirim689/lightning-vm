import { cookies } from 'next/headers';
import { cache } from 'react';

// permissions: the effective set from the API ('*' = administrator). impersonatedBy: a staff member signed in as this user.
// timeZone: the person's chosen zone, or null for their browser's.
export type User = { id: string; email: string; name: string; roles: string[]; permissions: string[]; locale: 'tr' | 'en'; timeZone: string | null; username: string | null; impersonatedBy: string | null;
  twoFactorEnabled: boolean; twoFactorRequired?: boolean; phoneNumber: string | null; phoneNumberVerified: boolean; emailVerified?: boolean; ip?: string };
export type Branding = { name: string; accent: string | null; logo: boolean; favicon: boolean; version: string };
export type CaptchaConfig = { provider: 'turnstile' | 'recaptcha-v2' | 'recaptcha-v3' | 'hcaptcha'; siteKey: string; use: { signIn: boolean; signUp: boolean; passwordReset: boolean } };
// emailVerification: the panel can mail address verification codes (mail works and that use of it is on).
export type PublicConfig = { branding: Branding; passwordReset: boolean; captcha: CaptchaConfig | null; phoneVerification: boolean; otpChannels: { sms: boolean; email: boolean }; emailCodeSignIn?: boolean; emailVerification?: boolean; registration?: boolean; sso?: { name: string } | null;
  signIn?: { social: string[]; magicLink: boolean; username: boolean; oneTap: { clientId: string } | null } };

// Server components talk to the API directly on the internal network, forwarding the session cookie.
const apiUrl = process.env.API_INTERNAL_URL || 'http://api:4000';

async function serverGet(path: string) {
  const cookie = (await cookies()).toString();
  return fetch(`${apiUrl}${path}`, { headers: { cookie }, cache: 'no-store' });
}

// Once per request: the panel layout, the admin layout and pages all ask, the API is asked once.
export const getUser = cache(async (): Promise<User | null> => {
  const res = await serverGet('/auth/me');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`auth/me failed: ${res.status}`);
  return res.json();
});

export async function getSetupStatus(): Promise<{ adminCreated: boolean; completed: boolean }> {
  const res = await serverGet('/setup/status');
  if (!res.ok) throw new Error(`setup/status failed: ${res.status}`);
  return res.json();
}

const fallback: PublicConfig = { branding: { name: 'Lightning VM', accent: null, logo: false, favicon: false, version: '0' }, passwordReset: false, captcha: null,
  phoneVerification: false, otpChannels: { sms: false, email: false } };
// Branding is needed on every page; if the API is down the page still renders with the defaults.
// A reseller's brand for the signed-in person (their customers see it instead of the operator's); empty when none.
export const getResellerBrand = cache(async (): Promise<{ name?: string; accent?: string | null }> => {
  try { const res = await serverGet('/reseller/brand'); return res.ok ? await res.json() : {}; } catch { return {}; }
});

export async function getPublicConfig(): Promise<PublicConfig> {
  try {
    const res = await fetch(`${apiUrl}/public/config`, { next: { revalidate: 30 } });
    return res.ok ? await res.json() : fallback;
  } catch { return fallback; }
}
