// One designed layout for every e-mail the panel sends (mail.ts, notify.ts), with its plain-text twin. Table
// layout and inline styles only: mail clients (Outlook, Gmail) drop <style> blocks, flexbox and web fonts. Every
// value is escaped; nothing here comes from a template file. No database here: brandFor (mail.ts) reads the branding.
export type Tone = 'info' | 'success' | 'warning' | 'danger';
export type MailContent = {
  preheader: string;               // the inbox preview line
  label?: string;                  // a small tag above the heading: what kind of message this is
  tone?: Tone;                     // colours the tag, the card's top edge and the note's edge (default: the brand accent)
  heading: string;
  intro: string[];                 // paragraphs
  button?: { label: string; url: string };
  code?: string;                   // a one-time code, shown large
  details?: [string, string][];    // label / value rows
  note?: string;                   // the security line under everything
};
// panelUrl / settingsUrl: absolute links for the header and footer (null when no public address is set).
export type Brand = { name: string; accent: string; logoUrl: string | null; locale: 'tr' | 'en'; panelUrl?: string | null; settingsUrl?: string | null };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const fallbackAccent = '#f59e0b';
// Dark text on a light accent (the default amber), white on a dark one: WCAG relative luminance.
function onAccent(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111827' : '#ffffff';
}
// Edge colour, tag background and tag text per tone; "info" uses the brand accent.
const tones: Record<Exclude<Tone, 'info'>, [string, string, string]> = {
  success: ['#16a34a', '#dcfce7', '#166534'], warning: ['#d97706', '#fef3c7', '#92400e'], danger: ['#dc2626', '#fee2e2', '#991b1b'],
};
const words = {
  tr: { footer: (n: string) => `Bu e-posta ${n} tarafından otomatik olarak gönderildi; yanıtlamanıza gerek yok.`, link: 'Düğme çalışmazsa bu adresi tarayıcınıza yapıştırın:',
    panel: 'Panele git', settings: 'Bildirim ayarları' },
  en: { footer: (n: string) => `This e-mail was sent automatically by ${n}; there is no need to reply.`, link: 'If the button does not work, paste this address into your browser:',
    panel: 'Open the panel', settings: 'Notification settings' },
};

export function mailHtml(c: MailContent, b: Brand) {
  const ink = '#111827', text = '#374151', muted = '#6b7280', faint = '#9ca3af', line = '#e5e7eb', soft = '#f9fafb';
  const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const w = words[b.locale];
  const [edge, tagBg, tagInk] = c.tone && c.tone !== 'info' ? tones[c.tone] : [b.accent, '#f3f4f6', text];
  const p = (s: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${text}">${esc(s)}</p>`;
  // The brand: its logo, or a coloured square with its initial beside its name.
  const mark = b.logoUrl
    ? `<img src="${esc(b.logoUrl)}" alt="${esc(b.name)}" height="32" style="display:block;height:32px;width:auto;border:0">`
    : `<table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td width="32" height="32" align="center" valign="middle" style="width:32px;height:32px;border-radius:9px;background:${b.accent};font-size:16px;font-weight:700;color:${onAccent(b.accent)}">${esc(b.name.trim().charAt(0).toLocaleUpperCase(b.locale) || 'L')}</td>
        <td style="padding-left:10px;font-size:17px;font-weight:700;color:${ink};letter-spacing:-0.2px">${esc(b.name)}</td></tr></table>`;
  const panelLink = b.panelUrl ? `<a href="${esc(b.panelUrl)}" target="_blank" style="font-size:13px;font-weight:600;color:${muted};text-decoration:none">${esc(w.panel)} &rarr;</a>` : '';
  const tag = c.label ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px"><tr>
      <td style="padding:4px 10px;border-radius:999px;background:${tagBg};font-size:12px;font-weight:600;line-height:16px;color:${tagInk}"><span style="color:${edge}">&#9679;</span>&nbsp;${esc(c.label)}</td></tr></table>` : '';
  const button = c.button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr>
      <td style="border-radius:10px;background:${b.accent}"><a href="${esc(c.button.url)}" target="_blank"
        style="display:inline-block;padding:14px 28px;font-size:15px;font-weight:600;color:${onAccent(b.accent)};text-decoration:none;border-radius:10px">${esc(c.button.label)} &rarr;</a></td>
    </tr></table>` : '';
  const code = c.code ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:8px 0 24px"><tr>
      <td align="center" style="padding:20px 16px;border:1px dashed #d1d5db;border-radius:12px;background:${soft};font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:${ink}">${esc(c.code)}</td>
    </tr></table>` : '';
  const details = c.details?.length ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;border:1px solid ${line};border-radius:12px;border-collapse:separate;overflow:hidden">
      ${c.details.map(([k, v], i) => `<tr><td style="padding:11px 16px;font-size:13px;color:${muted};width:34%;background:${soft};${i ? `border-top:1px solid ${line};` : ''}">${esc(k)}</td>
        <td style="padding:11px 16px;font-size:14px;color:${ink};word-break:break-word;${i ? `border-top:1px solid ${line};` : ''}">${esc(v)}</td></tr>`).join('')}
    </table>` : '';
  const fallback = c.button ? `<p style="margin:0 0 4px;font-size:12px;line-height:18px;color:${muted}">${esc(w.link)}<br>
      <a href="${esc(c.button.url)}" style="color:${muted};word-break:break-all">${esc(c.button.url)}</a></p>` : '';
  const note = c.note ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:20px 0 0"><tr>
      <td style="padding:12px 14px;border-left:3px solid ${edge};border-radius:4px 10px 10px 4px;background:${soft};font-size:13px;line-height:20px;color:${muted}">${esc(c.note)}</td></tr></table>` : '';
  const links = [b.panelUrl && `<a href="${esc(b.panelUrl)}" style="color:${muted};text-decoration:underline">${esc(w.panel)}</a>`,
    b.settingsUrl && `<a href="${esc(b.settingsUrl)}" style="color:${muted};text-decoration:underline">${esc(w.settings)}</a>`].filter(Boolean).join(' &nbsp;&middot;&nbsp; ');
  return `<!doctype html>
<html lang="${b.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(c.heading)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(c.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f3f4f6;font-family:${font}"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:600px">
    <tr><td style="padding:0 4px 18px"><table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
      <td align="left" valign="middle">${mark}</td><td align="right" valign="middle">${panelLink}</td></tr></table></td></tr>
    <tr><td style="background:#ffffff;border:1px solid ${line};border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(17,24,39,0.06)">
      <div style="height:4px;background:${edge};font-size:0;line-height:0">&nbsp;</div>
      <div style="padding:34px 32px 30px">
        ${tag}<h1 style="margin:0 0 16px;font-size:23px;line-height:31px;font-weight:700;letter-spacing:-0.3px;color:${ink}">${esc(c.heading)}</h1>
        ${c.intro.map(p).join('')}${code}${button}${details}${fallback}${note}
      </div>
    </td></tr>
    <tr><td style="padding:22px 12px 0;text-align:center;font-size:12px;line-height:19px;color:${faint}">
      ${links ? `<p style="margin:0 0 8px">${links}</p>` : ''}<p style="margin:0">${esc(w.footer(b.name))}</p>
      <p style="margin:6px 0 0">&copy; ${new Date().getFullYear()} ${esc(b.name)}</p></td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

export function mailText(c: MailContent, b: Brand) {
  return [...(c.label ? [`[${c.label}]`] : []), c.heading, '', ...c.intro.flatMap((s) => [s, '']), ...(c.code ? [c.code, ''] : []), ...(c.button ? [`${c.button.label}: ${c.button.url}`, ''] : []),
    ...(c.details ?? []).map(([k, v]) => `${k}: ${v}`), ...(c.details?.length ? [''] : []), ...(c.note ? [c.note, ''] : []), '—', words[b.locale].footer(b.name), ...(b.panelUrl ? [b.panelUrl] : [])].join('\n');
}

// When something happened, in the account's time zone with the zone named (Turkey's when none is set; an unknown
// zone falls back to UTC). Explicit parts: dateStyle/timeStyle cannot be combined with timeZoneName (it throws).
export function eventTime(locale: 'tr' | 'en', timeZone?: string | null, now = new Date()) {
  const when = (tz: string) => new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: tz, timeZoneName: 'short' }).format(now);
  try { return when(timeZone || 'Europe/Istanbul'); } catch { return when('UTC'); }
}
