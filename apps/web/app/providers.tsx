"use client";
import WindowChrome from '../components/window-chrome';
import { I18nProvider, RouterProvider, Toast } from '@heroui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { ThemeProvider } from 'next-themes';
import { useRouter } from 'next/navigation';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { useState } from 'react';
import { AccessibilityRuntime } from '../components/accessibility';
import { useA11y } from '../lib/a11y';
import AutofillGuard from '../components/autofill-guard';
import PageLoader, { announceNavigation } from '../components/page-loader';
import { mayLeave } from '../lib/edits';

// Theme (class on <html>), server-state cache, URL state, React Aria locale for dates and numbers,
// client-side routing for every HeroUI href, motion that honours "reduce motion", toasts.
export default function Providers({ locale, loadingLabel, children }: { locale: string; loadingLabel: string; children: React.ReactNode }) {
  const router = useRouter();
  // The API is the source of truth: data is refetched on focus and retried once, never served stale for long.
  const motion = useA11y((s) => s.motion);
  // While the panel's server does not answer, reads pause (components/connection-banner.tsx sets the online state);
  // a change the person sends is never held back to run by itself later: it fails at once, says why, and the form
  // keeps what was typed (networkMode "always").
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 2_000, retry: 1, refetchOnWindowFocus: true }, mutations: { networkMode: 'always' } } }));
  return <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
    <QueryClientProvider client={client}>
      <NuqsAdapter>
        <I18nProvider locale={locale === 'tr' ? 'tr-TR' : 'en-US'}>
          <RouterProvider navigate={(href, opts) => { if (!mayLeave(String(href))) return; announceNavigation(String(href)); router.push(href, opts); }}>
            <MotionConfig reducedMotion={motion === 'reduce' ? 'always' : motion === 'allow' ? 'never' : 'user'}>
              {children}
              <AccessibilityRuntime/>
              <WindowChrome/>
              <PageLoader label={loadingLabel}/>
              <AutofillGuard/>
              <Toast.Provider placement="bottom end"/>
            </MotionConfig>
          </RouterProvider>
        </I18nProvider>
      </NuqsAdapter>
    </QueryClientProvider>
  </ThemeProvider>;
}
