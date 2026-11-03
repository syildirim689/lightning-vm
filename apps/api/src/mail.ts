import { absolute } from './chat-delivery';
import { fallbackAccent, mailHtml, mailText, type Brand, type MailContent } from './mail-layout';
import { getSettings, sendMail } from './settings-store';

export { sendMail };

export async function brandFor(locale: string | undefined): Promise<Brand> {
  const b = await getSettings('branding');
  const accent = b.accent && /^#[0-9a-f]{6}$/i.test(b.accent) ? b.accent : fallbackAccent;
  return { name: b.name, accent, logoUrl: b.logo ? await absolute('/api/public/branding/logo') : null, locale: locale === 'tr' ? 'tr' : 'en' };
}

const texts = {
  tr: {
    reset: (n: string, url: string): [string, MailContent] => [`${n} parola sıfırlama`, {
      preheader: 'Parolanızı sıfırlamak için bağlantı (1 saat geçerli).', heading: 'Parolanızı sıfırlayın',
      intro: [`${n} hesabınız için parola sıfırlama isteği aldık. Yeni bir parola belirlemek için aşağıdaki düğmeye tıklayın.`, 'Bağlantı 1 saat geçerlidir.'],
      button: { label: 'Parolayı sıfırla', url }, note: 'Bu isteği siz yapmadıysanız bu e-postayı yok sayın; parolanız değişmez.' }],
    signIn: (n: string, when: string, ip: string, agent: string): [string, MailContent] => [`${n}: hesabınıza yeni giriş`, {
      preheader: `Hesabınıza ${ip} adresinden yeni bir giriş yapıldı.`, heading: 'Hesabınıza yeni bir giriş yapıldı',
      intro: [`${n} hesabınıza yeni bir cihazdan veya konumdan giriş yapıldı. Bu sizseniz bir şey yapmanız gerekmez.`],
      details: [['Zaman', when], ['IP adresi', ip], ['Cihaz', agent]],
      note: 'Bu siz değilseniz hemen parolanızı değiştirin ve Hesap sayfasından diğer oturumları kapatın.' }],
    link: (n: string, url: string): [string, MailContent] => [`${n} giriş bağlantınız`, {
      preheader: 'Tek kullanımlık giriş bağlantınız (10 dakika geçerli).', heading: 'Panele giriş yapın',
      intro: [`${n} paneline parola olmadan giriş yapmak için aşağıdaki düğmeye tıklayın.`, 'Bağlantı 10 dakika geçerlidir ve yalnızca bir kez kullanılabilir.'],
      button: { label: 'Giriş yap', url }, note: 'Bu isteği siz yapmadıysanız bu e-postayı yok sayın; bağlantı olmadan kimse giriş yapamaz.' }],
    otp: (n: string, code: string): [string, MailContent] => [`${n} doğrulama kodu`, {
      preheader: 'Tek kullanımlık doğrulama kodunuz (5 dakika geçerli).', heading: 'Doğrulama kodunuz',
      intro: [`${n} hesabınızda işlemi tamamlamak için bu kodu girin. Kod 5 dakika geçerlidir.`], code,
      note: 'Bu kodu kimseyle paylaşmayın; destek ekibi de dahil hiç kimse sizden bu kodu istemez.' }],
  },
  en: {
    reset: (n: string, url: string): [string, MailContent] => [`${n} password reset`, {
      preheader: 'A link to reset your password (valid for 1 hour).', heading: 'Reset your password',
      intro: [`We received a request to reset the password of your ${n} account. Choose a new password with the button below.`, 'The link is valid for 1 hour.'],
      button: { label: 'Reset password', url }, note: 'If you did not ask for this, ignore this e-mail; your password stays the same.' }],
    signIn: (n: string, when: string, ip: string, agent: string): [string, MailContent] => [`${n}: new sign-in to your account`, {
      preheader: `There was a new sign-in to your account from ${ip}.`, heading: 'New sign-in to your account',
      intro: [`Your ${n} account was signed in to from a new device or location. If this was you, there is nothing to do.`],
      details: [['Time', when], ['IP address', ip], ['Device', agent]],
      note: 'If this was not you, change your password now and sign out other sessions on the Account page.' }],
    link: (n: string, url: string): [string, MailContent] => [`${n} sign-in link`, {
      preheader: 'Your one-time sign-in link (valid for 10 minutes).', heading: 'Sign in to the panel',
      intro: [`Sign in to ${n} without a password with the button below.`, 'The link is valid for 10 minutes and works once.'],
      button: { label: 'Sign in', url }, note: 'If you did not ask for this, ignore this e-mail; nobody can sign in without the link.' }],
    otp: (n: string, code: string): [string, MailContent] => [`${n} verification code`, {
      preheader: 'Your one-time verification code (valid for 5 minutes).', heading: 'Your verification code',
      intro: [`Enter this code to finish in your ${n} account. It is valid for 5 minutes.`], code,
      note: 'Do not share this code; nobody, support included, will ever ask you for it.' }],
  },
};
const lang = (locale?: string) => texts[locale === 'tr' ? 'tr' : 'en'];

async function send(to: string, locale: string | undefined, make: (brand: string) => [string, MailContent]) {
  const b = await brandFor(locale);
  const [subject, content] = make(b.name);
  return sendMail(to, subject, mailText(content, b), mailHtml(content, b));
}

export const sendPasswordReset = (to: string, locale: string | undefined, url: string) => send(to, locale, (n) => lang(locale).reset(n, url));

export const sendSignInAlert = (to: string, locale: string | undefined, ip: string, agent: string) =>
  send(to, locale, (n) => lang(locale).signIn(n, new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC', ip || '-', agent || '-'));

export const sendSignInLink = (to: string, locale: string | undefined, url: string) => send(to, locale, (n) => lang(locale).link(n, url));

export const sendOtpMail = (to: string, locale: string | undefined, code: string) => send(to, locale, (n) => lang(locale).otp(n, code));

export const otpText = (locale: string | undefined, name: string, code: string) =>
  locale === 'tr' ? `${name} doğrulama kodunuz: ${code}. Kimseyle paylaşmayın.` : `${name} verification code: ${code}. Do not share it.`;
