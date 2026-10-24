"use client";
import { I18nProvider, RouterProvider, Toast } from '@heroui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { ThemeProvider } from 'next-themes';
import { useRouter } from 'next/navigation';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { useState } from 'react';

// Theme (class on <html>), server-state cache, URL state, React Aria locale for dates and numbers,
// client-side routing for every HeroUI href, motion that honours "reduce motion", toasts.
export default function Providers({ locale, children }: { locale: string; children: React.ReactNode }) {
  const router = useRouter();
  // The API is the source of truth: data is refetched on focus and retried once, never served stale for long.
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 2_000, retry: 1, refetchOnWindowFocus: true } } }));
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <QueryClientProvider client={client}>
      <NuqsAdapter>
        <I18nProvider locale={locale === 'tr' ? 'tr-TR' : 'en-US'}>
          <RouterProvider navigate={router.push}>
            <MotionConfig reducedMotion="user">
              {children}
              <Toast.Provider placement="bottom end"/>
            </MotionConfig>
          </RouterProvider>
        </I18nProvider>
      </NuqsAdapter>
    </QueryClientProvider>
  </ThemeProvider>;
}
