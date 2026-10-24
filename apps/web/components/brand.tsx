import NextLink from 'next/link';
import type { Branding } from '../lib/session';
import { I } from './icon';

// The operator's logo and name (Settings → Branding), or the default mark.
export function Brand({ branding, href = '/', size = 'md' }: { branding: Branding; href?: string; size?: 'md' | 'lg' }) {
  const box = size === 'lg' ? 'size-9' : 'size-8';
  return <NextLink href={href} className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 outline-offset-2">
    {branding.logo
      // eslint-disable-next-line @next/next/no-img-element -- served by the API, size limited on upload
      ? <img src={`/api/public/branding/logo?v=${branding.version}`} alt="" className={`${box} shrink-0 rounded-lg object-contain`}/>
      : <span aria-hidden className={`grid ${box} shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground`}><I name="zap" size={size === 'lg' ? 20 : 18}/></span>}
    <span className={`truncate font-semibold tracking-tight ${size === 'lg' ? 'text-lg' : 'text-[15px]'}`}>{branding.name}</span>
  </NextLink>;
}

// Readable text on the chosen accent: dark text on light colours, white on dark ones (WCAG relative luminance).
export function accentCss(hex: string | null) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return '';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const fg = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? 'oklch(0.2 0.03 60)' : 'oklch(0.99 0 0)';
  return `:root,[data-theme="light"],.dark,[data-theme="dark"]{--accent:${hex};--accent-foreground:${fg};--focus:${hex}}`;
}
