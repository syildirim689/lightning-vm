"use client";
// The way into a live wall from the page it belongs to: a small labelled button beside the page's status (on Admin →
// System right before "All good" / "N warnings"). Shown only to those who may open the wall.
import NextLink from 'next/link';
import { useTranslations } from 'next-intl';
import { I } from '../icon';
import { useMe } from '../../lib/me';
import { canWall, type WallScene } from '../../lib/wall-scenes';

export default function WallLink({ scene }: { scene: WallScene }) {
  const t = useTranslations('Wall');
  const me = useMe();
  if (!me || !canWall(me.permissions, scene)) return null;
  return <NextLink href={`/wall/${scene}`} data-testid="wall-link" aria-label={t('open', { name: t(`scene.${scene}`) })} title={t('openHint')}
    className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:border-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none">
    <I name="monitor-play" size={16}/>
  </NextLink>;
}
