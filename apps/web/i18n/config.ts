export const locales = ['tr', 'en'] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = 'en';
export const localeCookie = 'NEXT_LOCALE';

export function isLocale(value: unknown): value is Locale {
  return locales.includes(value as Locale);
}

// Picks the highest-q supported language from an Accept-Language header.
export function negotiateLocale(header: string | null): Locale {
  const ranked = (header ?? '').split(',').map((part) => {
    const [tag, ...params] = part.trim().toLowerCase().split(';');
    const q = Number(params.find((p) => p.trim().startsWith('q='))?.trim().slice(2) ?? 1);
    return { lang: tag.split('-')[0], q: Number.isNaN(q) ? 0 : q };
  }).filter((x) => x.q > 0).sort((a, b) => b.q - a.q);
  return ranked.map((x) => x.lang).find(isLocale) ?? defaultLocale;
}
