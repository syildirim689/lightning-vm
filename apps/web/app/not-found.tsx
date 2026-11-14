import { getTranslations } from 'next-intl/server';
import { I } from '../components/icon';
import { ButtonLink } from '../components/ui';

// An address that leads nowhere: say so and offer the start page.
export default async function NotFound() {
  const t = await getTranslations('ErrorPage');
  return <main className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4 text-center">
    <span aria-hidden className="grid size-14 place-items-center rounded-2xl bg-default text-muted"><I name="map-pin-off" size={28}/></span>
    <h1 className="text-xl font-semibold">{t('notFound')}</h1>
    <p className="max-w-md text-sm text-muted">{t('notFoundBody')}</p>
    <ButtonLink href="/" className="mt-2"><I name="house" size={16}/>{t('home')}</ButtonLink>
  </main>;
}
