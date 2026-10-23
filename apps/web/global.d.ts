import type messages from './messages/en.json';
import type { Locale } from './i18n/config';

// Typed keys: using a key missing from en.json fails the build.
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
  }
}
