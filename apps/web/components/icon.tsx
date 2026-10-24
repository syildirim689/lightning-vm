"use client";
import { Icon, addCollection } from '@iconify/react/offline';
import icons from './icons.json';

addCollection(icons);

// Decorative Lucide icon from the bundled subset (scripts/icons.mjs); meaning always comes from nearby text.
export function I({ name, size = 18, className }: { name: string; size?: number; className?: string }) {
  return <Icon icon={`lucide:${name}`} width={size} height={size} className={className} aria-hidden/>;
}
