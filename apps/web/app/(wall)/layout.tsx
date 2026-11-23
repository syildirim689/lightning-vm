import { NextIntlClientProvider } from 'next-intl';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { loginFrom } from '../../lib/back-to';
import { getSetupStatus, getUser } from '../../lib/session';

// The live walls (/wall/*): full screen, without the panel's menu and bars, for a TV or a second screen. Signed in
// like the panel: a visitor without a session goes to the sign-in page and comes back here; an account that still
// has to set up its second step goes to the panel, which asks for it.
export default async function WallLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  if (!user) redirect((await getSetupStatus()).adminCreated ? loginFrom((await headers()).get('x-lvm-path') ?? '/') : '/setup');
  if (user.twoFactorRequired) redirect('/');
  return <NextIntlClientProvider>{children}</NextIntlClientProvider>;
}
