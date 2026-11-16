"use client";
// What a server's virtualisation platform can do. The API may send `platform` (the connection's kind) and
// `capabilities` on a server, a connection or an order location; a capability that is not there is unknown and
// everything behaves as before. Only an explicit `false` hides or disables a control, with a short reason.
import { useTranslations } from 'next-intl';
import { I } from './icon';

export type Capability = 'console' | 'firewall' | 'migrate' | 'image' | 'backup' | 'iso' | 'metrics';
export type Capabilities = Partial<Record<Capability, boolean>>;
export type Platformed = { platform?: string | null; capabilities?: Capabilities | null };

export const supports = (x: Platformed | null | undefined, what: Capability) => x?.capabilities?.[what] !== false;

// The one-line reason shown where a control is switched off.
export function PlatformHint({ className = '' }: { className?: string }) {
  const t = useTranslations('Capabilities');
  return <p className={`flex items-center gap-1.5 text-xs text-muted ${className}`}><I name="info" size={13} className="shrink-0"/>{t('unavailable')}</p>;
}

// For option lists (servers to attach a firewall to): the same reason as an option's description.
export const usePlatformHint = () => useTranslations('Capabilities')('unavailable');
