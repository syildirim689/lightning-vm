import { getSettings, sendMail } from './settings-store';

export { sendMail };

const texts = {
  tr: {
    reset: { subject: (n: string) => `${n} parola sıfırlama`, body: (url: string) => `Parolanızı sıfırlamak için bu bağlantıyı açın (1 saat geçerli):\n\n${url}\n\nBu isteği siz yapmadıysanız bu e-postayı yok sayın.` },
    signIn: { subject: (n: string) => `${n}: hesabınıza yeni giriş`, body: (when: string, ip: string, agent: string) => `Hesabınıza yeni bir giriş yapıldı.\n\nZaman: ${when}\nIP: ${ip}\nCihaz: ${agent}\n\nBu siz değilseniz hemen parolanızı değiştirin ve Hesap sayfasından diğer oturumları kapatın.` },
    link: { subject: (n: string) => `${n} giriş bağlantınız`, body: (url: string) => `Panele giriş yapmak için bu bağlantıyı açın (10 dakika geçerli, bir kez kullanılabilir):\n\n${url}\n\nBu isteği siz yapmadıysanız bu e-postayı yok sayın; bağlantı olmadan kimse giriş yapamaz.` },
    otp: { subject: (n: string) => `${n} doğrulama kodu`, body: (code: string) => `Doğrulama kodunuz: ${code}\n\nKod 5 dakika geçerlidir. Kimseyle paylaşmayın.` },
  },
  en: {
    reset: { subject: (n: string) => `${n} password reset`, body: (url: string) => `Open this link to reset your password (valid for 1 hour):\n\n${url}\n\nIf you did not ask for this, ignore this e-mail.` },
    signIn: { subject: (n: string) => `${n}: new sign-in to your account`, body: (when: string, ip: string, agent: string) => `There was a new sign-in to your account.\n\nTime: ${when}\nIP: ${ip}\nDevice: ${agent}\n\nIf this was not you, change your password now and sign out other sessions on the Account page.` },
    link: { subject: (n: string) => `${n} sign-in link`, body: (url: string) => `Open this link to sign in to the panel (valid for 10 minutes, once):\n\n${url}\n\nIf you did not ask for this, ignore this e-mail; nobody can sign in without the link.` },
    otp: { subject: (n: string) => `${n} verification code`, body: (code: string) => `Your verification code: ${code}\n\nThe code is valid for 5 minutes. Do not share it.` },
  },
};
const lang = (locale?: string) => texts[locale === 'tr' ? 'tr' : 'en'];
const brand = async () => (await getSettings('branding')).name;

export async function sendPasswordReset(to: string, locale: string | undefined, url: string) {
  const t = lang(locale).reset;
  return sendMail(to, t.subject(await brand()), t.body(url));
}

export async function sendSignInAlert(to: string, locale: string | undefined, ip: string, agent: string) {
  const t = lang(locale).signIn;
  return sendMail(to, t.subject(await brand()), t.body(new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', ip || '-', agent || '-'));
}

export async function sendSignInLink(to: string, locale: string | undefined, url: string) {
  const t = lang(locale).link;
  return sendMail(to, t.subject(await brand()), t.body(url));
}

export async function sendOtpMail(to: string, locale: string | undefined, code: string) {
  const t = lang(locale).otp;
  return sendMail(to, t.subject(await brand()), t.body(code));
}

export const otpText = (locale: string | undefined, name: string, code: string) =>
  locale === 'tr' ? `${name} doğrulama kodunuz: ${code}. Kimseyle paylaşmayın.` : `${name} verification code: ${code}. Do not share it.`;
