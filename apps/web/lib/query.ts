"use client";
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from '@heroui/react';
import { apiFetch, useErrorText } from './api';
import type { Attention } from './attention';

// GET through the API with React Query: shared cache per key, optional polling for live state.
export function useApiQuery<T>(key: QueryKey, path: string | null, opts: { refetchInterval?: number | false | ((data: T | undefined) => number | false); enabled?: boolean } = {}) {
  return useQuery<T>({
    // A disabled caller (no path) gets its own entry: sharing the key would hand its path-less fetch to the real query.
    queryKey: path === null ? [...key, 'off'] : key,
    queryFn: ({ signal }) => apiFetch<T>(path!, { signal }),
    enabled: path !== null && opts.enabled !== false,
    refetchInterval: typeof opts.refetchInterval === 'function' ? ((f) => (query) => f(query.state.data as T | undefined))(opts.refetchInterval) : opts.refetchInterval,
  });
}

// Whether billing is on and how many invoices are open. Under ['notifications'], so a payment or a new invoice
// refreshes the count; the menu, the command palette and the "g b" shortcut all gate the billing page on it.
export const useBillingSummary = () => useApiQuery<{ enabled: boolean; open?: { n: number } }>(['notifications', 'billing-summary'], '/billing/summary', { refetchInterval: 60_000 }).data;
// Shown only to resellers: the summary answers 403 for everyone else.
export const useResellerAllocation = () => useApiQuery<{ allocation: object | null }>(['reseller', 'summary'], '/reseller/summary').data?.allocation;
// What waits for staff (payments to review, failed operations, abuse findings, a restore hold): one read every minute
// shared by the menu's counts and the hold bar, and none at all for customers. Under ['notifications'], so news
// refreshes it. An API without the endpoint (404) or a refusal (403) simply means nothing to show: no retry, and it
// is asked again only now and then.
export const attentionKey = ['notifications', 'attention'] as const;
export function useAttention(staff: boolean) {
  return useQuery<Attention>({
    queryKey: staff ? attentionKey : [...attentionKey, 'off'],
    queryFn: ({ signal }) => apiFetch<Attention>('/admin/attention', { signal }),
    enabled: staff,
    retry: false,
    refetchInterval: (query) => (query.state.status === 'error' ? 300_000 : 60_000),
  }).data;
}

// A state-changing call: shows the translated error as a toast, an optional success toast, and refreshes
// the given cache keys so every view of that data updates.
export function useApiAction<V = void, R = unknown>(run: (vars: V) => Promise<R>, opts: { invalidate?: QueryKey[]; success?: string | ((r: R) => string); onSuccess?: (r: R, vars: V) => void } = {}) {
  const client = useQueryClient();
  const { error } = useErrorText();
  return useMutation<R, unknown, V>({
    mutationFn: run,
    onSuccess: (r, vars) => {
      opts.invalidate?.forEach((key) => client.invalidateQueries({ queryKey: key }));
      const text = typeof opts.success === 'function' ? opts.success(r) : opts.success;
      if (text) toast.success(text);
      opts.onSuccess?.(r, vars);
    },
    onError: (e) => { toast.danger(error(e)); },
  });
}
