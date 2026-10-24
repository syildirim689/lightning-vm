"use client";
import { useMutation, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from '@heroui/react';
import { apiFetch, useErrorText } from './api';

// GET through the API with React Query: shared cache per key, optional polling for live state.
export function useApiQuery<T>(key: QueryKey, path: string | null, opts: { refetchInterval?: number | false | ((data: T | undefined) => number | false); enabled?: boolean } = {}) {
  return useQuery<T>({
    queryKey: key,
    queryFn: ({ signal }) => apiFetch<T>(path!, { signal }),
    enabled: path !== null && opts.enabled !== false,
    refetchInterval: typeof opts.refetchInterval === 'function' ? ((f) => (query) => f(query.state.data as T | undefined))(opts.refetchInterval) : opts.refetchInterval,
  });
}

// A state-changing call: shows the translated error as a toast, an optional success toast, and refreshes
// the given cache keys so every view of that data updates.
export function useApiAction<V = void, R = unknown>(run: (vars: V) => Promise<R>, opts: { invalidate?: QueryKey[]; success?: string | ((r: R) => string); onSuccess?: (r: R) => void } = {}) {
  const client = useQueryClient();
  const { error } = useErrorText();
  return useMutation<R, unknown, V>({
    mutationFn: run,
    onSuccess: (r) => {
      opts.invalidate?.forEach((key) => client.invalidateQueries({ queryKey: key }));
      const text = typeof opts.success === 'function' ? opts.success(r) : opts.success;
      if (text) toast.success(text);
      opts.onSuccess?.(r);
    },
    onError: (e) => { toast.danger(error(e)); },
  });
}
