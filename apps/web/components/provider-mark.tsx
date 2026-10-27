// The mark of a sign-in provider: Google's and Microsoft's own colours, the icon set's marks for GitHub, GitLab,
// Facebook and LinkedIn, and Discord's colour with its initial (no mark in the icon set). Decorative: the button
// beside it carries the name.
import { I } from './icon';

export const providerNames: Record<string, string> = { google: 'Google', microsoft: 'Microsoft', github: 'GitHub', gitlab: 'GitLab', discord: 'Discord', facebook: 'Facebook', linkedin: 'LinkedIn' };

export default function ProviderMark({ id, size = 18 }: { id: string; size?: number }) {
  if (id === 'google') return <svg aria-hidden width={size} height={size} viewBox="0 0 48 48">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
  </svg>;
  if (id === 'microsoft') return <svg aria-hidden width={size} height={size} viewBox="0 0 23 23">
    <path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#ffb900" d="M12 12h10v10H12z"/>
  </svg>;
  if (id === 'discord') return <span aria-hidden className="grid place-items-center rounded-md bg-[#5865F2] font-bold text-white" style={{ width: size, height: size, fontSize: size * 0.6 }}>D</span>;
  if (id === 'github') return <I name="github" size={size}/>;
  if (id === 'gitlab') return <I name="gitlab" size={size} className="text-[#FC6D26]"/>;
  if (id === 'facebook') return <I name="facebook" size={size} className="text-[#1877F2]"/>;
  if (id === 'linkedin') return <I name="linkedin" size={size} className="text-[#0A66C2]"/>;
  return <I name="key-round" size={size}/>;
}
