"use client";
import { useApiQuery } from './query';
import type { User } from './session';

// The signed-in user as the API sees it (permissions, impersonation, 2FA), shared through React Query.
export const useMe = () => useApiQuery<User>(['me'], '/auth/me', { refetchInterval: 60_000 }).data;
