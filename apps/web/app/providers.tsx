"use client";
import { I18nProvider, RouterProvider, Toast } from '@heroui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { ThemeProvider } from 'next-themes';
import { useRouter } from 'next/navigation';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { useState } from 'react';
import { AccessibilityRuntime } from '../components/accessibility';
import { useA11y } from '../lib/a11y';
import PageLoader, { announceNavigation } from '../components/page-loader';

// Theme (class on <html>), server-state cache, URL state, React Aria locale for dates and numbers,
// client-side routing for every HeroUI href, motion that honours "reduce motion", toasts.
export default function Providers({ locale, loadingLabel, children }: { locale: string; loadingLabel: string; children: React.ReactNode }) {
  const router = useRouter();
  // The API is the source of truth: data is refetched on focus and retried once, never served stale for long.
  const motion = useA11y((s) => s.motion);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 2_000, retry: 1, refetchOnWindowFocus: true } } }));
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <QueryClientProvider client={client}>
      <NuqsAdapter>
        <I18nProvider locale={locale === 'tr' ? 'tr-TR' : 'en-US'}>
          <RouterProvider navigate={(href, opts) => { announceNavigation(String(href)); router.push(href, opts); }}>
            <MotionConfig reducedMotion={motion === 'reduce' ? 'always' : motion === 'allow' ? 'never' : 'user'}>
              {children}
              <AccessibilityRuntime/>
              <PageLoader label={loadingLabel}/>
              <Toast.Provider placement="bottom end"/>
            </MotionConfig>
          </RouterProvider>
        </I18nProvider>
      </NuqsAdapter>
    </QueryClientProvider>
  </ThemeProvider>;
}
