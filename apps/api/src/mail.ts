import { createTransport, type Transporter } from 'nodemailer';
import { config, mailEnabled } from './config';
import { logEvent } from './log';

let transport: Transporter | undefined;

// SMTP from SMTP_URL (smtp://user:pass@host:587 or smtps://...) and MAIL_FROM. Without them no mail
// is sent and the features that need mail (password reset) are hidden in the panel.
export async function sendMail(to: string, subject: string, text: string) {
  if (!mailEnabled()) throw new Error('mail is not configured');
  transport ??= createTransport(config.SMTP_URL!);
  try {
    await transport.sendMail({ from: config.MAIL_FROM, to, subject, text });
    logEvent('info', 'mail_sent', { subject });
  } catch (err) {
    logEvent('error', 'mail_failed', { error: err instanceof Error ? err.message : 'unknown' });
    throw err;
  }
}

const texts = {
  tr: { subject: 'Lightning VM parola sıfırlama', body: (url: string) => `Parolanızı sıfırlamak için bu bağlantıyı açın (1 saat geçerli):\n\n${url}\n\nBu isteği siz yapmadıysanız bu e-postayı yok sayın.` },
  en: { subject: 'Lightning VM password reset', body: (url: string) => `Open this link to reset your password (valid for 1 hour):\n\n${url}\n\nIf you did not ask for this, ignore this e-mail.` },
};

export function sendPasswordReset(to: string, locale: string | undefined, url: string) {
  const t = texts[locale === 'tr' ? 'tr' : 'en'];
  return sendMail(to, t.subject, t.body(url));
}
