"use client";
import { passkeyClient } from '@better-auth/passkey/client';
import { adminClient, emailOTPClient, lastLoginMethodClient, magicLinkClient, phoneNumberClient, twoFactorClient, usernameClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { apiFetch } from './api';
import { disablePush } from './push';
import { hasLocalViews, uploadLocalViews } from './saved-views';
import { forgetLocal } from './session-end';

// Sessions are better-auth's, served by the API at /api/auth. No baseURL: the browser's own origin is used.
// The API's CSRF guard wants this header on every state-changing request.
export const authClient = createAuthClient({
  basePath: '/api/auth',
  fetchOptions: { headers: { 'x-lightning-csrf': '1' } },
  // The sign-in form handles the second step itself (twoFactorRedirect in the response), so no redirect here.
  plugins: [adminClient(), passkeyClient(), twoFactorClient(), phoneNumberClient(), lastLoginMethodClient(), emailOTPClient(), magicLinkClient(), usernameClient()],
});

// Saved views an earlier version kept in this browser are removed when a session ends. At a sign-out there still is
// a session to send them with, so the ones of the account that is signing out go to it first: the account is the one
// the API names for this session (not what the browser remembers), nothing is sent while a staff member is signed in
// as somebody (the API refuses it, and the views are not theirs), and it may take four seconds at most. Whatever
// could not be sent by then is removed unsent, as before.
async function keepViews() {
  if (!hasLocalViews()) return;
  const send = async () => {
    const me = await apiFetch<{ id?: string; impersonatedBy?: string | null }>('/auth/me');
    if (me?.id && !me.impersonatedBy) await uploadLocalViews(apiFetch, me.id);
  };
  await Promise.race([send().catch(() => undefined), new Promise((done) => setTimeout(done, 4000))]);
}

// Signing out forgets what this browser kept for the person (drafts, recent servers) and stops its notifications:
// the API drops the push subscription while there still is a session to ask with. A session that ran out is
// handled where that is noticed (sessionEnded).
export const signOut = async () => { await keepViews(); forgetLocal(); await disablePush().catch(() => undefined); return authClient.signOut(); };
