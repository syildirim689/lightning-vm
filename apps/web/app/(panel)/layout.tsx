import { NextIntlClientProvider } from 'next-intl';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { loginFrom } from '../../lib/back-to';
import { getPublicConfig, getResellerBrand, getSetupStatus, getUser } from '../../lib/session';
import { accentCss } from '../../components/brand';
import pkg from '../../package.json';
import Shell from './shell';
import TwoFactorGate from './two-factor-gate';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect((await getSetupStatus()).adminCreated ? loginFrom((await headers()).get('x-lvm-path') ?? '/') : '/setup');
  // The signed-in panel gets all translations (the root layout sends only the public pages' ones).
  if (user.twoFactorRequired) return <NextIntlClientProvider><TwoFactorGate/></NextIntlClientProvider>;
  // Asked together, not one after the other. A reseller's customers see the reseller's name and colour (no logo:
  // the operator's would be wrong).
  const [{ branding: operator }, brand] = await Promise.all([getPublicConfig(), getResellerBrand()]);
  const branding = brand.name ? { ...operator, name: brand.name, logo: false, accent: brand.accent ?? operator.accent } : operator;
  const css = brand.name ? accentCss(brand.accent ?? null) : '';
  // The installed release (vX.Y.Z or a commit); package.json's version when run outside Compose.
  const installed = process.env.APP_VERSION && process.env.APP_VERSION !== 'dev' ? process.env.APP_VERSION.replace(/^v/, '') : pkg.version;
  return <NextIntlClientProvider>{css && <style>{css}</style>}<Shell user={user} branding={branding} version={installed}>{children}</Shell></NextIntlClientProvider>;
}
