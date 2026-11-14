"use client";
import { passkeyClient } from '@better-auth/passkey/client';
import { adminClient, emailOTPClient, lastLoginMethodClient, magicLinkClient, phoneNumberClient, twoFactorClient, usernameClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { clearDrafts } from './drafts';

// Sessions are better-auth's, served by the API at /api/auth. No baseURL: the browser's own origin is used.
// The API's CSRF guard wants this header on every state-changing request.
export const authClient = createAuthClient({
  basePath: '/api/auth',
  fetchOptions: { headers: { 'x-lightning-csrf': '1' } },
  // The sign-in form handles the second step itself (twoFactorRedirect in the response), so no redirect here.
  plugins: [adminClient(), passkeyClient(), twoFactorClient(), phoneNumberClient(), lastLoginMethodClient(), emailOTPClient(), magicLinkClient(), usernameClient()],
});

// Signing out on purpose also forgets drafts typed here; a session that just ran out keeps them.
export const signOut = () => { clearDrafts(); return authClient.signOut(); };
