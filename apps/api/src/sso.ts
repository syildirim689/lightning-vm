// Single sign-on with OpenID Connect (Keycloak, Microsoft Entra ID, Okta, Google Workspace, Authentik, Zitadel...).
// better-auth's genericOAuth plugin runs the flow (discovery, PKCE, state, ID-token signature through the
// provider's keys); this file turns the admin's settings into its provider and keeps accounts in line:
// - SSO accounts are their own (auth_source 'oidc'): an existing panel or directory account is never taken over by
//   a provider that claims its e-mail address;
// - roles follow the provider's groups claim when groups are mapped; the role's address limits apply;
// - their password lives at the provider, so it is not set, changed or reset in the panel (directory-signin.ts).
import type { GenericOAuthConfig } from 'better-auth/plugins';
import { pool } from './db';
import { rolesFromGroups } from './ldap';
import { publishLive } from './live-bus';
import { ensureRoles, limitsOf, roles } from './permissions';
import { ipAllowed } from './role-limits';
import { decryptSecret } from './secrets';
import type { OidcSettings } from './settings-store';

export const providerId = 'oidc';
export const ssoSecretCtx = 'settings:oidc';
export const discoveryUrl = (issuer: string) => `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;

// The groups each person had in their last sign-in, from the profile the provider sent (read once, right after).
// shortcut: in memory, so the callback and session must run in one API process; fine while there is one.
const lastGroups = new Map<string, { groups: string[]; at: number }>();
const groupsOf = (claim: unknown) => (Array.isArray(claim) ? claim.map(String) : typeof claim === 'string' ? claim.split(/[,\s]+/).filter(Boolean) : []);

export function ssoProvider(s: OidcSettings): GenericOAuthConfig {
  return {
    providerId, name: s.name || 'SSO',
    discoveryUrl: discoveryUrl(s.issuer),
    requireIdTokenVerification: true,
    clientId: s.clientId,
    clientSecret: s.clientSecretEnc ? decryptSecret(s.clientSecretEnc, ssoSecretCtx) : undefined,
    scopes: s.scopes.split(/\s+/).filter(Boolean),
    pkce: true,
    disableSignUp: !s.autoCreate,
    mapProfileToUser: (p) => {
      const email = String(p.email ?? '').toLowerCase();
      if (email) lastGroups.set(email, { groups: groupsOf(p[s.groupsClaim]), at: Date.now() });
      for (const [k, v] of lastGroups) if (Date.now() - v.at > 300_000) lastGroups.delete(k);
      return { email, name: String(p.name ?? p.preferred_username ?? email) };
    },
  };
}

// A provider account may only belong to an account it created: never linked to a panel or directory account.
// A person the provider is creating right now is not visible yet (better-auth writes the user and the account in
// one transaction): that is the account being made, so it may.
export async function mayLink(userId: string) {
  const { rows: [u] } = await pool.query("SELECT auth_source, (SELECT count(*)::int FROM auth_accounts a WHERE a.user_id = users.id AND a.provider_id <> $2) AS others FROM users WHERE id = $1", [userId, providerId]);
  return !u || (u.others === 0 && u.auth_source !== 'ldap');
}

// Each SSO sign-in, before its session exists: the account becomes an SSO account, its roles follow the groups
// (when groups are mapped, or when it is new), and the role's address limits apply. false: no session.
export async function ssoSignedIn(s: OidcSettings, userId: string, ip: string) {
  const { rows: [u] } = await pool.query('SELECT email, role, auth_source FROM users WHERE id = $1', [userId]);
  if (!u) return false;
  const seen = lastGroups.get(u.email); lastGroups.delete(u.email);
  await ensureRoles();
  const wanted = rolesFromGroups(s, seen?.groups ?? []).filter((k) => roles.has(k));
  const fresh = u.auth_source !== 'oidc';
  const role = s.groupRoles.length || fresh ? (wanted.length ? wanted : ['user']).join(',') : u.role;
  // source_confirmed_at: the provider vouched for the account just now (its API tokens count from here: ldap.ts, tokenAsleep).
  await pool.query("UPDATE users SET auth_source = 'oidc', role = $2, source_confirmed_at = now(), updated_at = now() WHERE id = $1", [userId, role]);
  if (fresh) await pool.query("INSERT INTO audit_events (actor_id, action, outcome, metadata) VALUES ($1, 'auth.sso_user_created', 'success', $2)", [userId, { role }]);
  else if (role !== u.role) await publishLive(userId, 'access');
  return ipAllowed(limitsOf(role).allowedIps, ip);
}
