// Social providers for better-auth from the sign-in settings (no HTTP here; the settings page is sign-in-methods.ts).
import { decryptSecret } from './secrets';
import type { SignInSettings, SocialId } from './settings-store';

export const socialIds: SocialId[] = ['google', 'microsoft', 'github', 'gitlab', 'discord', 'facebook', 'linkedin'];
const secretCtx = (id: SocialId) => `settings:social:${id}`;

// better-auth's socialProviders option from the settings: only enabled providers with a client. New accounts
// through them only when the admin allows it and registration is open; existing accounts link only on purpose
// (Account → Security → Connected accounts), never by a matching e-mail address.
export function socialProviders(s: SignInSettings, registrationOpen: boolean) {
  const out: Record<string, Record<string, unknown>> = {};
  for (const id of socialIds) {
    const p = s.providers[id];
    if (!p?.enabled || !p.clientId || !p.clientSecretEnc) continue;
    out[id] = { clientId: p.clientId, clientSecret: decryptSecret(p.clientSecretEnc, secretCtx(id)), disableSignUp: !(s.socialSignUp && registrationOpen),
      ...(id === 'microsoft' && { tenantId: p.tenantId || 'common' }),
      ...(id === 'google' && { prompt: 'select_account', ...(p.hostedDomain && { hd: p.hostedDomain }) }) };
  }
  return out;
}
export const enabledSocial = (s: SignInSettings) => socialIds.filter((id) => s.providers[id]?.enabled && s.providers[id]?.clientId && s.providers[id]?.clientSecretEnc);

