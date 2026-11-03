// One designed layout for every e-mail the panel sends (mail.ts, notify.ts), with its plain-text twin. Table
// layout and inline styles only: mail clients (Outlook, Gmail) drop <style> blocks, flexbox and web fonts. Every
// value is escaped; nothing here comes from a template file. No database here: brandFor (mail.ts) reads the branding.
export type MailContent = {
  preheader: string;               // the inbox preview line
  heading: string;
  intro: string[];                 // paragraphs
  button?: { label: string; url: string };
  code?: string;                   // a one-time code, shown large
  details?: [string, string][];    // label / value rows
  note?: string;                   // the security line under everything
};
export type Brand = { name: string; accent: string; logoUrl: string | null; locale: 'tr' | 'en' };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const fallbackAccent = '#f59e0b';
// Dark text on a light accent (the default amber), white on a dark one: WCAG relative luminance.
function onAccent(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#111827' : '#ffffff';
}
const footer = {
  tr: (n: string) => `Bu e-posta ${n} tarafından otomatik olarak gönderildi; yanıtlamanıza gerek yok.`,
  en: (n: string) => `This e-mail was sent automatically by ${n}; there is no need to reply.`,
};
const linkHelp = { tr: 'Düğme çalışmazsa bu adresi tarayıcınıza yapıştırın:', en: 'If the button does not work, paste this address into your browser:' };

export function mailHtml(c: MailContent, b: Brand) {
  const text = '#374151', muted = '#6b7280', line = '#e5e7eb', font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const p = (s: string) => `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:${text}">${esc(s)}</p>`;
  const header = b.logoUrl
    ? `<img src="${esc(b.logoUrl)}" alt="${esc(b.name)}" height="32" style="display:block;height:32px;width:auto;border:0">`
    : `<span style="font-size:18px;font-weight:700;color:#111827;letter-spacing:-0.2px">${esc(b.name)}</span>`;
  const button = c.button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr>
      <td style="border-radius:10px;background:${b.accent}"><a href="${esc(c.button.url)}" target="_blank"
        style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:${onAccent(b.accent)};text-decoration:none;border-radius:10px">${esc(c.button.label)}</a></td>
    </tr></table>` : '';
  const code = c.code ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr>
      <td style="padding:16px 28px;border:1px solid ${line};border-radius:12px;background:#f9fafb;font-family:'SFMono-Regular',Consolas,Menlo,monospace;font-size:30px;font-weight:700;letter-spacing:8px;color:#111827">${esc(c.code)}</td>
    </tr></table>` : '';
  const details = c.details?.length ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px;border:1px solid ${line};border-radius:12px;border-collapse:separate">
      ${c.details.map(([k, v], i) => `<tr><td style="padding:10px 16px;font-size:13px;color:${muted};width:34%;${i ? `border-top:1px solid ${line};` : ''}">${esc(k)}</td>
        <td style="padding:10px 16px;font-size:14px;color:#111827;word-break:break-word;${i ? `border-top:1px solid ${line};` : ''}">${esc(v)}</td></tr>`).join('')}
    </table>` : '';
  const fallback = c.button ? `<p style="margin:0 0 16px;font-size:12px;line-height:18px;color:${muted}">${esc(linkHelp[b.locale])}<br>
      <a href="${esc(c.button.url)}" style="color:${muted};word-break:break-all">${esc(c.button.url)}</a></p>` : '';
  const note = c.note ? `<p style="margin:8px 0 0;padding-top:16px;border-top:1px solid ${line};font-size:13px;line-height:20px;color:${muted}">${esc(c.note)}</p>` : '';
  return `<!doctype html>
<html lang="${b.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(c.heading)}</title></head>
<body style="margin:0;padding:0;background:#f3f4f6;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(c.preheader)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f3f4f6;font-family:${font}"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px">
    <tr><td style="padding:0 4px 16px">${header}</td></tr>
    <tr><td style="background:#ffffff;border:1px solid ${line};border-radius:16px;overflow:hidden">
      <div style="height:4px;background:${b.accent};font-size:0;line-height:0">&nbsp;</div>
      <div style="padding:32px 32px 28px">
        <h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:700;color:#111827">${esc(c.heading)}</h1>
        ${c.intro.map(p).join('')}${code}${button}${details}${fallback}${note}
      </div>
    </td></tr>
    <tr><td style="padding:20px 8px 0;text-align:center;font-size:12px;line-height:18px;color:#9ca3af">${esc(footer[b.locale](b.name))}</td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

export function mailText(c: MailContent, b: Brand) {
  return [c.heading, '', ...c.intro.flatMap((s) => [s, '']), ...(c.code ? [c.code, ''] : []), ...(c.button ? [`${c.button.label}: ${c.button.url}`, ''] : []),
    ...(c.details ?? []).map(([k, v]) => `${k}: ${v}`), ...(c.details?.length ? [''] : []), ...(c.note ? [c.note, ''] : []), '—', footer[b.locale](b.name)].join('\n');
}
