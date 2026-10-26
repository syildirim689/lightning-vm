import { AccessibilityButton } from '../../components/accessibility';
import { LanguageMenu, ThemeToggle } from '../../components/chrome';
import { Brand } from '../../components/brand';
import { getPublicConfig } from '../../lib/session';

// The setup wizard gets the whole width (step list beside the step); the sign-in pages keep their brand panel.
export default async function SetupLayout({ children }: { children: React.ReactNode }) {
  const { branding } = await getPublicConfig();
  return <div className="relative flex min-h-dvh flex-col overflow-clip">
    <div aria-hidden className="auth-aurora pointer-events-none absolute inset-0"/>
    <header className="relative flex items-center justify-between gap-2 border-b border-separator bg-background/70 px-4 py-3 backdrop-blur md:px-8">
      <Brand branding={branding} href="/setup"/>
      <div className="flex items-center gap-1"><AccessibilityButton/><LanguageMenu/><ThemeToggle/></div>
    </header>
    <main className="relative flex flex-1 items-center justify-center px-4 py-6 md:px-8 md:py-10">{children}</main>
  </div>;
}
