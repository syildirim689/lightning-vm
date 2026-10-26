"use client";
// A messaging app's mark: its brand colour behind a generic icon (no brand logos are bundled).
import { I } from './icon';

const color: Record<string, string> = { telegram: '#229ED9', whatsapp: '#25D366', slack: '#4A154B', discord: '#5865F2', teams: '#5059C9', googlechat: '#00AC47',
  mattermost: '#1E325C', rocketchat: '#F5455C', matrix: '#0DBD8B', ntfy: '#317F6F', gotify: '#3F51B5', pushover: '#249DF1', webhook: '#64748B' };

export function AppBadge({ app, size = 36 }: { app: string; size?: number }) {
  return <span className="grid shrink-0 place-items-center rounded-xl text-white shadow-sm" style={{ width: size, height: size, background: color[app] ?? '#64748B' }}>
    <I name={({ telegram: 'send', whatsapp: 'message-circle', slack: 'hash', discord: 'gamepad-2', teams: 'users', googlechat: 'message-square-text', mattermost: 'message-square',
      rocketchat: 'rocket', matrix: 'grid-3x3', ntfy: 'bell-ring', gotify: 'bell', pushover: 'smartphone', webhook: 'webhook' } as Record<string, string>)[app] ?? 'message-circle'} size={Math.round(size * 0.5)}/>
  </span>;
}
