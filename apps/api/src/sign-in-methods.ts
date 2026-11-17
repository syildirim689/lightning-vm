// Settings → Sign-in methods: which ways into the panel exist besides the password. Social providers (Google,
// Microsoft, GitHub, GitLab, Discord, Facebook, LinkedIn) and Google One Tap through better-auth's own providers;
// a one-time sign-in link by e-mail (magic link); a user name instead of the e-mail address; and two checks on new
// passwords and addresses (known-leaked passwords through Have I Been Pwned, throwaway e-mail domains).
// better-auth is set up again when these change (reloadAuth), so no restart is needed.
import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { audit, type AuthedRequest } from './auth';
import { reloadAuth } from './better-auth';
import { apiError } from './errors';
import { assertAdmin, Can, PermissionGuard } from './rbac';
import { encryptSecret } from './secrets';
import { enabledSocial, socialIds } from './social-providers';
import { getSettings, saveSettings, type SignInSettings, type SocialId } from './settings-store';
const secretCtx = (id: SocialId) => `settings:social:${id}`;

type Input = Record<string, unknown>;
export function readSignIn(body: Input, saved: SignInSettings): SignInSettings {
  const fields: Record<string, string> = {};
  const bool = (k: string, d: boolean) => (typeof body[k] === 'boolean' ? body[k] as boolean : d);
  const providers = { ...saved.providers };
  const raw = (body.providers ?? {}) as Record<string, Input>;
  for (const id of socialIds) {
    const p = raw[id]; if (!p) continue;
    const prev = saved.providers[id] ?? { enabled: false, clientId: '', clientSecretEnc: null };
    const clientId = typeof p.clientId === 'string' ? p.clientId.trim().slice(0, 300) : prev.clientId;
    if (clientId && !/^[\w.@:/+-]{3,300}$/.test(clientId)) fields[`providers.${id}.clientId`] = 'INVALID_VALUE';
    const secret = typeof p.clientSecret === 'string' ? p.clientSecret.trim() : '';
    if (secret.length > 500) fields[`providers.${id}.clientSecret`] = 'INVALID_VALUE';
    const enabled = p.enabled === true;
    const clientSecretEnc = secret ? encryptSecret(secret, secretCtx(id)) : clientId ? prev.clientSecretEnc : null;
    if (enabled && (!clientId || !clientSecretEnc)) fields[`providers.${id}.clientId`] = 'REQUIRED';
    const tenantId = id === 'microsoft' ? (typeof p.tenantId === 'string' ? p.tenantId.trim() : prev.tenantId ?? '') : undefined;
    if (tenantId && !/^(common|organizations|consumers|[0-9a-f-]{36}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(tenantId)) fields[`providers.${id}.tenantId`] = 'INVALID_VALUE';
    const hostedDomain = id === 'google' ? (typeof p.hostedDomain === 'string' ? p.hostedDomain.trim().toLowerCase() : prev.hostedDomain ?? '') : undefined;
    if (hostedDomain && !/^(\*|([a-z0-9-]+\.)+[a-z]{2,})$/.test(hostedDomain)) fields[`providers.${id}.hostedDomain`] = 'INVALID_VALUE';
    providers[id] = { enabled, clientId, clientSecretEnc, ...(tenantId !== undefined && { tenantId }), ...(hostedDomain !== undefined && { hostedDomain }) };
  }
  const value: SignInSettings = { magicLink: bool('magicLink', saved.magicLink), username: bool('username', saved.username), oneTap: bool('oneTap', saved.oneTap),
    socialSignUp: bool('socialSignUp', saved.socialSignUp), pwnedPasswords: bool('pwnedPasswords', saved.pwnedPasswords), blockDisposable: bool('blockDisposable', saved.blockDisposable), providers };
  if (value.oneTap && !(value.providers.google?.enabled)) fields.oneTap = 'GOOGLE_REQUIRED';
  if (Object.keys(fields).length) throw apiError(400, 'VALIDATION_FAILED', 'Invalid input', fields);
  return value;
}

// What the settings page shows: everything but the secrets (only whether one is kept).
export function signInView(s: SignInSettings) {
  return { ...s, providers: Object.fromEntries(socialIds.map((id) => {
    const p = s.providers[id] ?? { enabled: false, clientId: '', clientSecretEnc: null };
    const { clientSecretEnc, ...rest } = p;
    return [id, { ...rest, clientSecretSet: !!clientSecretEnc }];
  })) };
}

@Controller('admin/settings/sign-in') @UseGuards(PermissionGuard)
export class SignInMethodsController {
  @Get() @Can('settings.view', 'settings.manage')
  async get() { return signInView(await getSettings('signIn')); }

  @Put() @Can('settings.manage')
  async save(@Req() req: AuthedRequest, @Body() body: Input) {
    const saved = await getSettings('signIn');
    const value = readSignIn(body ?? {}, saved);
    // Letting a link in a mailbox stand in for the password: administrators (as for the e-mail code, settings.ts).
    if (value.magicLink && !saved.magicLink) await assertAdmin(req);
    await saveSettings('signIn', value);
    await reloadAuth();
    await audit(req, 'settings.sign_in_methods', 'success', req.user.id, { social: enabledSocial(value), magicLink: value.magicLink, username: value.username, oneTap: value.oneTap,
      pwnedPasswords: value.pwnedPasswords, blockDisposable: value.blockDisposable, socialSignUp: value.socialSignUp });
    return signInView(value);
  }
}
