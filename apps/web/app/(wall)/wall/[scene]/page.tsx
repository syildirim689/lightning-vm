import type { Metadata } from 'next';
import NextLink from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getUser } from '../../../../lib/session';
import { canWall, isWallScene, wallPage, wallsFor } from '../../../../lib/wall-scenes';
import Wall from '../../../../components/wall/wall';

export async function generateMetadata({ params }: { params: Promise<{ scene: string }> }): Promise<Metadata> {
  const { scene } = await params;
  if (!isWallScene(scene)) return {};
  return { title: (await getTranslations('Wall'))(`title.${scene}`) };
}

// A wall shows what the page it belongs to shows, to the same people: anyone else gets the refusal the panel gives.
export default async function WallPage({ params }: { params: Promise<{ scene: string }> }) {
  const { scene } = await params;
  if (!isWallScene(scene)) notFound();
  const user = await getUser();
  if (!canWall(user?.permissions, scene)) {
    const t = await getTranslations('Wall');
    const te = await getTranslations('errors');
    return <main className="grid min-h-dvh place-items-center bg-background px-4 text-center">
      <div role="alert" className="max-w-md"><h1 className="text-5xl font-semibold text-muted">403</h1><p className="mt-2">{te('FORBIDDEN')}</p>
        <NextLink href="/" className="mt-6 inline-flex min-h-11 items-center rounded-xl border border-border px-4 font-medium hover:border-accent">{t('home')}</NextLink></div>
    </main>;
  }
  return <Wall scene={scene} scenes={wallsFor(user?.permissions)} back={wallPage[scene]} timeZone={user?.timeZone ?? null}/>;
}
