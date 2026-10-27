import { redirect } from 'next/navigation';
import { getPublicConfig, getResellerBrand, getSetupStatus, getUser } from '../../lib/session';
import { accentCss } from '../../components/brand';
import pkg from '../../package.json';
import Shell from './shell';
import TwoFactorGate from './two-factor-gate';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect((await getSetupStatus()).adminCreated ? '/login' : '/setup');
  if (user.twoFactorRequired) return <TwoFactorGate/>;
  const { branding: operator } = await getPublicConfig();
  // A reseller's customers see the reseller's name and colour (no logo: the operator's would be wrong).
  const brand = await getResellerBrand();
  const branding = brand.name ? { ...operator, name: brand.name, logo: false, accent: brand.accent ?? operator.accent } : operator;
  const css = brand.name ? accentCss(brand.accent ?? null) : '';
  // The installed release (vX.Y.Z or a commit); package.json's version when run outside Compose.
  const installed = process.env.APP_VERSION && process.env.APP_VERSION !== 'dev' ? process.env.APP_VERSION.replace(/^v/, '') : pkg.version;
  return <>{css && <style>{css}</style>}<Shell user={user} branding={branding} version={installed}>{children}</Shell></>;
}
