"use client";
import { passkeyClient } from '@better-auth/passkey/client';
import { adminClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

// Sessions are better-auth's, served by the API at /api/auth. No baseURL: the browser's own origin is used.
// The API's CSRF guard wants this header on every state-changing request.
export const authClient = createAuthClient({
  basePath: '/api/auth',
  fetchOptions: { headers: { 'x-lightning-csrf': '1' } },
  plugins: [adminClient(), passkeyClient()],
});

export const signOut = () => authClient.signOut();
